import { recall, recallTaint, renderForPrompt, type RecallDeps } from '../core/memory/recall.js';
import type { MemoryStore } from '../core/memory/store.js';
import type { Decide, PermissionSnapshot, Principal, TenantId, TrustTier } from '../core/policy/types.js';
import type { CapabilityDecl, CapabilityId, DecisionRequest } from '../core/policy/types.js';
import type { SessionMessage, SessionRef, SessionStore } from '../core/session/store.js';
import type { SpanHandle, Tracer } from '../core/tracing/types.js';
import { ATTR } from '../core/tracing/types.js';
import { checkCompletion, completionNudge } from './completion.js';
import { tenantClass, visibleTools, type SystemPrompts } from './context/assemble.js';
import { compactToolResults } from './context/compact.js';
import { iterationCap, type Profile } from './profiles/profile.js';
import {
  ProviderError,
  type ChatCall,
  type ContentBlock,
  type Message,
  type Provider,
  type ToolSpec,
} from './providers/types.js';

/**
 * The agent loop.
 *
 * One engine for every surface — CLI today, chat connectors in M4 — because the
 * alternative is two loops that drift, and the one that gets less use is the one
 * that breaks silently.
 *
 * Shape: a deterministic pre-loop, then tool calls until the model produces a
 * final answer. Nothing here classifies intent or routes between models: those
 * are the two pieces of scaffolding that most often end up fighting the model
 * instead of helping it.
 */

/**
 * What a handler is allowed to know about the turn it is running in.
 *
 * This exists because it was missing, and its absence was a cross-tenant leak
 * waiting for the second connector: the memory tool was registered with the
 * tenant baked in at wiring time, so a group member calling it would have been
 * served the owner's memory. A handler cannot read the tenant of the turn if
 * nobody hands it one — the comment claiming it did was aspirational.
 */
export type ToolContext = {
  tenant: string;
  principal: Principal;
};

/**
 * Clearable tool-result payload kept per turn, in characters (~4 per token, so
 * roughly 15k tokens). Hardcoded rather than configured: it is a property of how
 * much of a window is worth spending on results the model has already used, not
 * a preference, and a value in the environment is one that differs between the
 * laptop and the server and is discovered wrong months later.
 */
const TOOL_RESULT_BUDGET_CHARS = 60_000;

/**
 * Prior messages of the session replayed verbatim. Beyond this, recall is the
 * mechanism for reaching further back — that is what it is for.
 */
const MAX_HISTORY_TURNS = 40;

/**
 * How a surface asks the owner.
 *
 * The kernel can answer `ask`, and until now no surface could carry the
 * question: the loop turned every `ask` into a tool error saying it could not be
 * asked here. That made one of the four verdicts unreachable, which means the
 * matrix said things the runtime could not do.
 *
 * A surface that cannot ask does not get a placeholder that guesses. It gets no
 * approver, and the turn stops with `stopped: 'ask'` carrying what was wanted —
 * so a script exits 3 and a person can decide, instead of an agent quietly
 * doing nothing and reporting an error it invented.
 */
export type ApprovalRequest = {
  capability: string;
  /** The kernel's own wording, not a paraphrase. */
  prompt: string;
  resource?: string | undefined;
};

export type Approver = (request: ApprovalRequest) => Promise<'allow' | 'deny'>;

/** Thrown by a tool call that needs an approval this surface cannot obtain. */
class ApprovalRequired extends Error {
  constructor(readonly request: ApprovalRequest) {
    super(`approvazione richiesta per ${request.capability}`);
    this.name = 'ApprovalRequired';
  }
}

export type SpendEntry = {
  tenant: string;
  capability: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type ToolHandler = (args: unknown, ctx: ToolContext) => Promise<ToolOutcome> | ToolOutcome;

export type ToolOutcome = {
  content: string;
  isError?: boolean;
  /** Tier of whatever this result dragged in. Web and third-party tools are 3. */
  tier?: TrustTier;
};

export type RegisteredTool = {
  spec: ToolSpec;
  capability: string;
  handler: ToolHandler;
  /**
   * This tool's output must survive context compaction.
   *
   * Set it for tools whose result *is* the grounding rather than something the
   * model can fetch again on a whim — recalled memory being the case that
   * matters. Declared next to the tool, like its capability, so adding a tool
   * means answering the question rather than discovering the answer later.
   */
  keepResult?: boolean;
};

export type LoopDeps = {
  provider: Provider;
  profile: Profile;
  model: string;
  tools: RegisteredTool[];
  decide: Decide;
  tracer: Tracer;
  sessions: SessionStore;
  budgetExhausted: () => boolean;
  /**
   * Asks the owner. Absent on a surface that cannot: the turn then stops with
   * `stopped: 'ask'` rather than pretending the tool failed.
   */
  approve?: Approver | undefined;
  /**
   * Bills a model call and returns what it cost. Absent in tests; absent in
   * production means the caps are decorative, which is why `doctor` reports it.
   */
  recordSpend?: ((entry: SpendEntry) => number) | undefined;
  /**
   * Stable identity and persona, one per tenant class, each cached as its own
   * prefix. Assembled once (`agent/context/assemble.ts`); the turn selects.
   *
   * A single string was the defect: it took no tenant, so a group turn was
   * handed the owner's `identity.md` and the persona block that tells the agent
   * to elicit personal facts.
   */
  systemPrompts: SystemPrompts;
  /**
   * Absent in tests and before M2 is configured. When present the turn both
   * remembers what was said and recalls what is relevant — and inherits the
   * taint of whatever it recalled.
   */
  memory?: { store: MemoryStore; recall: RecallDeps } | undefined;
  /**
   * The capability declarations, so the resource handed to the kernel comes
   * from `resourceKind`/`policyArgs` instead of a hardcoded argument name.
   * Optional only so existing tests can build a minimal deps object — and the
   * kernel refuses a url capability whose resource never arrived, so a runtime
   * that forgets to pass this degrades to refusals, not to unguarded allows.
   */
  capabilities?: ReadonlyMap<CapabilityId, CapabilityDecl> | undefined;
  now?: () => Date;
};

export type TurnInput = {
  principal: Principal;
  tenant: TenantId;
  surface: string;
  session: SessionRef;
  text: string;
  signal?: AbortSignal;
};

export type TurnResult = {
  text: string;
  iterations: number;
  traceId: string;
  stopped: 'answered' | 'cap' | 'budget' | 'aborted' | 'error' | 'ask';
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  /** Present when `stopped` is 'ask': what the turn wanted permission for. */
  pending?: ApprovalRequest;
};

export async function runTurn(deps: LoopDeps, input: TurnInput): Promise<TurnResult> {
  const now = deps.now ?? (() => new Date());
  const turn = deps.tracer.start('muffin.turn', {
    [ATTR.principalKind]: input.principal.kind,
    [ATTR.tenant]: input.tenant,
    [ATTR.surface]: input.surface,
    [ATTR.requestModel]: deps.model,
  });

  // ---- Pre-loop: deterministic, no model call. ------------------------------
  // Permissions, taint and *which context this turn gets* are resolved before
  // anything is generated, so none of them can depend on what the model just
  // said. The class is a pure function of the principal and the tenant the
  // gateway already resolved — the same two values the kernel decides on.
  const snapshot = makeSnapshot(deps.decide, input.principal, input.tenant);
  const turnClass = tenantClass(input.principal, input.tenant);

  // Evidence first: what was said is recorded before anything is generated, so
  // a crash mid-turn cannot lose the input that caused it.
  let currentEpisodeId: number | undefined;
  if (deps.memory) {
    currentEpisodeId = deps.memory.store.addEpisode({
      tenantId: input.tenant,
      connector: input.surface,
      threadKey: input.session.id,
      role: 'user',
      kind: 'message',
      content: input.text,
      trustTier: input.principal.kind === 'member' ? 2 : 0,
      createdAt: now().toISOString(),
    });
  }

  // Recall is deterministic and happens before the model sees anything. Its
  // taint is folded into the snapshot here, which is what closes the
  // remember-then-act path: a fact a stranger planted months ago raises the
  // taint of this turn exactly as if they had just spoken.
  const recalled: ContentBlock[] = [];
  if (deps.memory) {
    const recallSpan = deps.tracer.start('muffin.tool_call', { [ATTR.operationName]: 'memory.recall' }, turn);
    try {
      const result = await recall(
        deps.memory.recall,
        input.tenant,
        input.text,
        currentEpisodeId !== undefined ? { excludeEpisodeId: currentEpisodeId } : {},
      );
      const inherited = recallTaint(result);
      snapshot.raiseTaint(inherited);
      recallSpan.setAttributes({
        'muffin.memory.items': result.items.length,
        'muffin.memory.strategies': result.strategies.join(','),
        [ATTR.taint]: inherited,
      });
      const rendered = renderForPrompt(result);
      if (rendered !== '') recalled.push({ type: 'text', text: rendered });
      recallSpan.end();
    } catch (error) {
      // Recall is an improvement, not a precondition: a turn without memory is
      // worse, a turn that refuses to start is broken.
      recallSpan.end({ error });
    }
  }

  // What this turn is shown, decided from who is speaking and where — never
  // from what they said. Filter first, cap second: `slice` on registration
  // order applied to the full list would spend a weak model's ten slots on
  // tools the kernel is going to refuse this principal anyway.
  const exposed = visibleTools(deps.tools, input.principal, deps.capabilities).slice(
    0,
    deps.profile.maxToolsExposed,
  );
  turn.setAttributes({ 'muffin.context.class': turnClass, 'muffin.context.tools_exposed': exposed.length });

  const messages: Message[] = buildContext(deps, input, recalled);

  deps.sessions.append(input.session, {
    role: 'user',
    content: input.text,
    surface: input.surface,
    createdAt: now().toISOString(),
    traceId: turn.traceId,
  });

  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let spentUsd = 0;
  const cap = iterationCap(deps.profile);
  let recoveriesLeft = deps.profile.recovery.length;
  let toolCallsMade = 0;
  let nudgedForCompletion = false;
  let iterations = 0;

  try {
    while (iterations < cap) {
      if (deps.budgetExhausted()) {
        return finish(turn, 'budget', 'Budget esaurito: mi fermo prima di spendere altro.', iterations, usage);
      }
      if (input.signal?.aborted) {
        return finish(turn, 'aborted', 'Interrotto.', iterations, usage);
      }
      iterations += 1;

      // Old tool payloads are cleared before the request, not after: what goes
      // out is smaller, what is on record is whole. Nothing is removed, so every
      // `tool_use` keeps its `tool_result` and the request stays well-formed.
      const compacted = compactToolResults(messages, {
        budgetChars: TOOL_RESULT_BUDGET_CHARS,
        keep: (name) => deps.tools.find((t) => t.spec.name === name)?.keepResult === true,
      });
      if (compacted.clearedCount > 0) {
        turn.setAttributes({
          'muffin.context.cleared_results': compacted.clearedCount,
          'muffin.context.cleared_chars': compacted.clearedChars,
        });
      }

      const call: ChatCall = {
        model: deps.model,
        system: [{ type: 'text', text: deps.systemPrompts[turnClass], cache: 'stable' }],
        messages: compacted.messages,
        ...(exposed.length > 0 ? { tools: exposed.map((t) => t.spec), toolChoice: 'auto' as const } : {}),
        maxOutputTokens: 4096,
        temperature: 0,
        stream: false,
        ...(input.signal ? { signal: input.signal } : {}),
      };

      const chatSpan = deps.tracer.start(
        'muffin.chat_call',
        { [ATTR.requestModel]: deps.model, [ATTR.turnIteration]: iterations },
        turn,
      );

      let result;
      try {
        result = await deps.provider.chat(call);
      } catch (error) {
        chatSpan.end({ error });
        // The recovery cascade lives in the profile, not here: a weak model
        // needs more attempts than a strong one, and that is data.
        if (error instanceof ProviderError && error.retryable && recoveriesLeft > 0) {
          recoveriesLeft -= 1;
          // Backoff, because the retryable case is mostly 429 and hammering a
          // rate limit four times in a row is how a soft limit becomes a hard
          // one. Exponential with jitter: the jitter matters when several turns
          // are throttled at once and would otherwise retry in lockstep.
          const attempt = deps.profile.recovery.length - recoveriesLeft;
          await sleep(retryDelayMs(attempt), input.signal);
          continue;
        }
        throw error;
      }

      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      usage.cacheReadTokens += result.usage.cacheReadTokens;
      usage.cacheWriteTokens += result.usage.cacheWriteTokens;

      // Billed here, on every call, before anything else can go wrong with the
      // iteration. The engine, its caps and its tests all existed before this
      // line did, and without it `exhausted()` answered false for ever.
      const usd = deps.recordSpend?.({
        tenant: input.tenant,
        capability: 'llm.chat',
        model: result.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        cacheWriteTokens: result.usage.cacheWriteTokens,
      });
      if (usd !== undefined) {
        spentUsd += usd;
        // The budget is an input to the kernel, so a decision cached before the
        // cap was reached must not survive it.
        snapshot.invalidate();
      }
      chatSpan.setAttributes({
        [ATTR.responseModel]: result.model,
        [ATTR.usageInputTokens]: result.usage.inputTokens,
        [ATTR.usageOutputTokens]: result.usage.outputTokens,
        [ATTR.cacheReadTokens]: result.usage.cacheReadTokens,
        // The attribute existed with zero writers while the adapter hardcoded
        // the value to 0. Honesty note: no test asserts chat-span attributes
        // (this one or any other) — the pinned path for this number is
        // TurnResult and the spend record, not the trace.
        [ATTR.cacheWriteTokens]: result.usage.cacheWriteTokens,
        [ATTR.stopReason]: result.stopReason,
      });
      chatSpan.end();

      // Nothing at all: nudge rather than presenting silence as an answer.
      if (!result.text && result.toolCalls.length === 0) {
        if (recoveriesLeft > 0 && deps.profile.recovery.includes('nudge')) {
          recoveriesLeft -= 1;
          messages.push({
            role: 'user',
            content: [{ type: 'text', text: 'Non ho ricevuto risposta. Continua, oppure dimmi che hai finito.' }],
          });
          continue;
        }
        return finish(turn, 'error', 'Il modello non ha prodotto una risposta utilizzabile.', iterations, usage);
      }

      if (result.toolCalls.length === 0) {
        const text = result.text ?? '';

        // The completion gate: did the answer describe a call this turn never
        // made? Deterministic, tool-aware, and it only fires when *nothing* was
        // called — a denied or failed call is still a call, so a model saying
        // "non ho potuto usare fs_write" after a real refusal is out of scope.
        const completion = checkCompletion({
          text,
          available: exposed.map((t) => t.spec.name),
          toolCallsMade,
        });
        if (!completion.ok) {
          turn.setAttributes({ 'muffin.completion.named_uncalled': completion.named.join(',') });
          if (nudgedForCompletion === false) {
            // One attempt, with the specific tools named. Vague feedback gets a
            // vague retry, and this is measured as the highest-value check in the
            // design — but it is a nudge, never a rewrite of what the agent said.
            nudgedForCompletion = true;
            messages.push({ role: 'user', content: [{ type: 'text', text: completionNudge(completion.named) }] });
            continue;
          }
          // It stands. Recorded rather than corrected: silently editing the
          // answer would be a second dishonesty stacked on the first.
          turn.setAttributes({ 'muffin.completion.unresolved': true });
        }

        deps.sessions.append(input.session, {
          role: 'assistant',
          content: text,
          surface: input.surface,
          createdAt: now().toISOString(),
          traceId: turn.traceId,
        });
        if (deps.memory) {
          deps.memory.store.addEpisode({
            tenantId: input.tenant,
            connector: input.surface,
            threadKey: input.session.id,
            role: 'agent',
            kind: 'message',
            content: text,
            trustTier: 0,
            createdAt: now().toISOString(),
          });
        }
        return finish(turn, 'answered', text, iterations, usage);
      }

      // Model's turn goes into the transcript before the results, so a crash
      // between the two leaves a record that explains itself.
      messages.push({
        role: 'assistant',
        content: [
          ...(result.text ? [{ type: 'text' as const, text: result.text }] : []),
          ...result.toolCalls.map((c) => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: c.args })),
        ],
      });

      const results: ContentBlock[] = [];
      toolCallsMade += result.toolCalls.length;
      for (const call_ of result.toolCalls) {
        // Checked between tools, not only before the next model call: a Ctrl+C
        // during a run of tool calls used to do nothing visible until the batch
        // finished, which for a slow batch is indistinguishable from being
        // ignored.
        if (input.signal?.aborted) return finish(turn, 'aborted', 'Interrotto.', iterations, usage);
        try {
          results.push(await runTool(deps, snapshot, turn, call_, input, exposed));
        } catch (error) {
          if (error instanceof ApprovalRequired) {
            turn.setAttributes({ 'muffin.policy.approval': 'unavailable' });
            const stop = finish(
              turn,
              'ask',
              `Serve la tua approvazione per "${error.request.capability}"${error.request.resource ? ` su ${error.request.resource}` : ''}. Su questa superficie non posso chiederla.`,
              iterations,
              usage,
            );
            return { ...stop, pending: error.request };
          }
          throw error;
        }
      }
      messages.push({ role: 'user', content: results });
    }

    return finish(
      turn,
      'cap',
      `Mi sono fermato dopo ${cap} passaggi senza chiudere. Dimmi come restringere il compito.`,
      iterations,
      usage,
    );
  } catch (error) {
    turn.end({ error });
    throw error;
  }

  function finish(
    span: SpanHandle,
    stopped: TurnResult['stopped'],
    text: string,
    iters: number,
    used: TurnResult['usage'],
  ): TurnResult {
    span.setAttributes({ [ATTR.stopReason]: stopped, [ATTR.turnIteration]: iters });
    span.end({ status: stopped === 'error' ? 'error' : 'ok' });
    return { text, iterations: iters, traceId: span.traceId, stopped, usage: used };
  }
}

async function runTool(
  deps: LoopDeps,
  snapshot: PermissionSnapshot,
  parent: SpanHandle,
  call: { id: string; name: string; args: unknown },
  input: TurnInput,
  /** What this turn was actually shown — the only list it may be told about. */
  exposed: RegisteredTool[],
): Promise<ContentBlock> {
  const span = deps.tracer.start('muffin.tool_call', { [ATTR.toolName]: call.name, [ATTR.toolCallId]: call.id }, parent);
  // Resolved against every registered tool, not against `exposed`, and that is
  // the load-bearing half of "defence in depth, not replacement": a member who
  // names a host-only tool anyway must meet `decide.ts:132` and be refused
  // `principal_forbidden` — a policy denial, on the trace, with a code. Looking
  // it up in the filtered list instead would answer "that tool does not exist",
  // which is both a lie and the kernel branch going quietly unexercised.
  const tool = deps.tools.find((t) => t.spec.name === call.name);

  if (!tool) {
    // Not an exception: the model gets told, and gets to correct itself.
    //
    // Listing `exposed` and not `deps.tools`: this message used to enumerate
    // every registered tool by name, so one hallucinated call handed a group
    // member the full host inventory — the host-only tools it may not have,
    // plus whatever fell past the profile's exposure cap.
    span.end({ status: 'error', error: `unknown tool ${call.name}` });
    return {
      type: 'tool_result',
      toolCallId: call.id,
      content: `Tool "${call.name}" non esiste. Disponibili: ${exposed.map((t) => t.spec.name).join(', ')}.`,
      isError: true,
    };
  }

  const args = (call.args ?? {}) as Record<string, unknown>;
  const capability = tool.capability;
  // The kernel decides on a *resource*, so anything it is supposed to gate has
  // to be lifted out of the args here. `url` was missing, and the consequence
  // was not a weaker check but no check at all: the egress branch in decide.ts
  // fires on `resource.kind === 'url'`, every tool call arrived as `none`, and
  // `http_get` skips the allowlist on its first hop precisely because it
  // believes the kernel already ruled on it. Both halves were correct and each
  // was waiting for the other, so an empty allowlist permitted every public
  // host — verified against the assembled runtime before this line existed.
  const resource = resourceFor(deps.capabilities?.get(capability), args);

  const decisionSpan = deps.tracer.start(
    'muffin.policy_decision',
    { [ATTR.capability]: capability, [ATTR.taint]: snapshot.currentTaint() },
    span,
  );
  const decision = snapshot.check(capability, resource, args);
  decisionSpan.setAttributes({
    [ATTR.policyEffect]: decision.effect,
    ...(decision.effect === 'deny' ? { [ATTR.policyDenyCode]: decision.code } : {}),
  });
  decisionSpan.end();

  if (decision.effect === 'deny') {
    span.end({ status: 'error', error: decision.code });
    return {
      type: 'tool_result',
      toolCallId: call.id,
      content: `Rifiutato dal kernel dei permessi (${decision.code}). Non insistere: serve una decisione dell'owner.`,
      isError: true,
    };
  }
  // `draft` means "do it, but reversibly, and tell the owner". There is no undo
  // journal yet, so the honest reading is `ask`: executing it as an allow was
  // the kernel emitting a verdict nobody implemented, which is worse than
  // refusing — the caller had already decided the write was reversible.
  if (decision.effect === 'draft') {
    span.end({ status: 'error', error: 'draft_unavailable' });
    return {
      type: 'tool_result',
      toolCallId: call.id,
      content:
        `"${capability}" richiede una bozza revocabile e il registro di undo non esiste ancora. ` +
        `Non eseguito: dillo all'owner invece di riprovare.`,
      isError: true,
    };
  }
  if (decision.effect === 'ask') {
    const request: ApprovalRequest = {
      capability,
      prompt: decision.ask.prompt,
      ...(resource.kind === 'path' ? { resource: resource.value } : {}),
    };
    if (!deps.approve) {
      // No channel on this surface: the turn stops and says what it wanted,
      // rather than the tool reporting a failure it did not have.
      span.end({ status: 'error', error: 'ask_unavailable' });
      throw new ApprovalRequired(request);
    }
    const answer = await deps.approve(request);
    span.setAttributes({ 'muffin.policy.approval': answer });
    if (answer === 'deny') {
      span.end({ status: 'error', error: 'ask_denied' });
      return {
        type: 'tool_result',
        toolCallId: call.id,
        content: `L'owner ha rifiutato "${capability}". Non insistere: prosegui senza, o spiega cosa ti manca.`,
        isError: true,
      };
    }
  }

  try {
    const outcome = await tool.handler(args, { tenant: input.tenant, principal: input.principal });
    if (outcome.tier !== undefined) snapshot.raiseTaint(outcome.tier);
    deps.sessions.append(input.session, {
      role: 'tool',
      content: outcome.content,
      toolCallId: call.id,
      toolName: call.name,
      surface: input.surface,
      createdAt: (deps.now ?? (() => new Date()))().toISOString(),
      traceId: parent.traceId,
    } satisfies SessionMessage);
    span.end({ status: outcome.isError ? 'error' : 'ok' });
    return {
      type: 'tool_result',
      toolCallId: call.id,
      content: outcome.content,
      ...(outcome.isError ? { isError: true } : {}),
    };
  } catch (error) {
    // A failing tool is information for the model, not a crash for the turn.
    const detail = error instanceof Error ? error.message : String(error);
    span.end({ status: 'error', error: detail });
    return { type: 'tool_result', toolCallId: call.id, content: detail, isError: true };
  }
}

/**
 * The resource the kernel will decide on, taken from the capability's own
 * declaration rather than guessed from argument names.
 *
 * The guess was a second, divergent copy of something the declarations already
 * carried: `resourceKind` says what kind of thing this capability acts on and
 * `policyArgs` says which argument holds it. Both were documented as *the*
 * mechanism and read by nobody, while the loop hardcoded `path` then `url` —
 * and two places doing one job had already diverged. `outward.send` declares
 * `policyArgs: ['to']`, which the hardcoded chain would never have read, so the
 * highest-risk capability in the matrix was going to arrive with a gate that
 * silently did not fire.
 *
 * Only `url` and `path` are lifted. A `tenant` resource is not in the args —
 * it is the turn's tenant — and inventing one here would change what the kernel
 * decides for every memory read.
 */
function resourceFor(
  decl: CapabilityDecl | undefined,
  args: Record<string, unknown>,
): DecisionRequest['resource'] {
  if (!decl || (decl.resourceKind !== 'url' && decl.resourceKind !== 'path')) {
    return { kind: 'none' };
  }
  for (const name of decl.policyArgs) {
    const value = args[name];
    if (typeof value === 'string') return { kind: decl.resourceKind, value };
  }
  // Declared but absent. Returning `none` is deliberate: for a url capability
  // the kernel now refuses on exactly this, which is the visible failure.
  return { kind: 'none' };
}

/**
 * Context assembly, outermost-stable first: identity, then tool definitions,
 * then recalled memory, then the message. Variable content never precedes
 * stable content, or the cache prefix is invalidated on every turn.
 */
function buildContext(deps: LoopDeps, input: TurnInput, recalled: ContentBlock[]): Message[] {
  const history = deps.sessions.read(input.session);
  const spoken = history.filter((m) => m.role === 'user' || m.role === 'assistant');

  // A REPL session used all afternoon would otherwise grow until the provider
  // refuses the request — and then refuse it again on every following turn,
  // because the next turn reads the same oversized history. The session was
  // permanently dead and the only cure was guessing `/new`.
  //
  // The cut is at the front and it is announced, so the model knows there is a
  // before rather than believing the conversation started here. Recall is what
  // brings back the parts that mattered, which is the whole reason it exists.
  const kept = spoken.slice(-MAX_HISTORY_TURNS);
  const dropped = spoken.length - kept.length;

  const messages: Message[] = [];
  if (dropped > 0) {
    messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: `[${dropped} messaggi precedenti di questa sessione non sono nel contesto. Se ti serve qualcosa di prima, cercalo in memoria invece di indovinare.]`,
        },
      ],
    });
  }
  for (const m of kept) {
    messages.push({
      role: m.role as 'user' | 'assistant',
      content: [{ type: 'text' as const, text: m.content }],
    });
  }
  // Recalled memory rides in the same turn as the message it is context for, not
  // as a separate user turn the model might answer. It is already fenced and
  // framed as low-authority context (renderForPrompt); here it simply precedes
  // the actual words.
  messages.push({
    role: 'user',
    content:
      recalled.length > 0 ? [...recalled, { type: 'text', text: input.text }] : [{ type: 'text', text: input.text }],
  });
  return messages;
}

function makeSnapshot(decide: Decide, principal: Principal, tenant: TenantId): PermissionSnapshot {
  // Taint starts from who is speaking; in M1 nothing else can raise it yet
  // except a tool that says so. From M2 the recall raises it too.
  let taint: TrustTier = principal.kind === 'member' ? 2 : 0;
  const cache = new Map<string, ReturnType<Decide>>();
  return {
    principal,
    tenant,
    currentTaint: () => taint,
    raiseTaint(tier) {
      if (tier > taint) {
        taint = tier;
        cache.clear(); // decisions taken at a lower taint no longer apply
      }
    },
    invalidate: () => cache.clear(),
    check(capability, resource, args) {
      const key = `${capability}:${resource.kind}:${'value' in resource ? resource.value : ''}:${taint}`;
      const cached = cache.get(key);
      if (cached) return cached;
      const decision = decide({ principal, tenant, capability, resource, args, taint });
      cache.set(key, decision);
      return decision;
    },
  };
}

/**
 * Exponential backoff with full jitter. `attempt` is 1-based.
 *
 * Full jitter rather than a fixed multiple: when several turns are throttled at
 * the same moment, a deterministic delay makes them retry in lockstep and the
 * limit trips again on the same tick.
 */
function retryDelayMs(attempt: number): number {
  const ceiling = Math.min(8_000, 500 * 2 ** (attempt - 1));
  return Math.floor(Math.random() * ceiling);
}

/** Sleeps, unless the turn is abandoned first. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
