import { recall, recallTaint, renderForPrompt, type RecallDeps } from '../core/memory/recall.js';
import type { MemoryStore } from '../core/memory/store.js';
import type { Decide, PermissionSnapshot, Principal, TenantId, TrustTier } from '../core/policy/types.js';
import type { SessionMessage, SessionRef, SessionStore } from '../core/session/store.js';
import type { SpanHandle, Tracer } from '../core/tracing/types.js';
import { ATTR } from '../core/tracing/types.js';
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

export type SpendEntry = {
  tenant: string;
  capability: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
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
   * Bills a model call and returns what it cost. Absent in tests; absent in
   * production means the caps are decorative, which is why `doctor` reports it.
   */
  recordSpend?: ((entry: SpendEntry) => number) | undefined;
  /** Stable identity and persona, cached as a prefix. */
  systemPrompt: string;
  /**
   * Absent in tests and before M2 is configured. When present the turn both
   * remembers what was said and recalls what is relevant — and inherits the
   * taint of whatever it recalled.
   */
  memory?: { store: MemoryStore; recall: RecallDeps } | undefined;
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
  stopped: 'answered' | 'cap' | 'budget' | 'aborted' | 'error';
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
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
  // Permissions and taint are resolved before anything is generated, so a
  // decision never depends on what the model just said.
  const snapshot = makeSnapshot(deps.decide, input.principal, input.tenant);

  // Evidence first: what was said is recorded before anything is generated, so
  // a crash mid-turn cannot lose the input that caused it.
  if (deps.memory) {
    deps.memory.store.addEpisode({
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
      const result = await recall(deps.memory.recall, input.tenant, input.text);
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

  const exposed = deps.tools.slice(0, deps.profile.maxToolsExposed);
  const messages: Message[] = buildContext(deps, input, recalled);

  deps.sessions.append(input.session, {
    role: 'user',
    content: input.text,
    surface: input.surface,
    createdAt: now().toISOString(),
    traceId: turn.traceId,
  });

  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  let spentUsd = 0;
  const cap = iterationCap(deps.profile);
  let recoveriesLeft = deps.profile.recovery.length;
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
        system: [{ type: 'text', text: deps.systemPrompt, cache: 'stable' }],
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
          continue;
        }
        throw error;
      }

      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      usage.cacheReadTokens += result.usage.cacheReadTokens;

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
      for (const call_ of result.toolCalls) {
        results.push(await runTool(deps, snapshot, turn, call_, input));
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
): Promise<ContentBlock> {
  const span = deps.tracer.start('muffin.tool_call', { [ATTR.toolName]: call.name, [ATTR.toolCallId]: call.id }, parent);
  const tool = deps.tools.find((t) => t.spec.name === call.name);

  if (!tool) {
    // Not an exception: the model gets told, and gets to correct itself.
    span.end({ status: 'error', error: `unknown tool ${call.name}` });
    return {
      type: 'tool_result',
      toolCallId: call.id,
      content: `Tool "${call.name}" non esiste. Disponibili: ${deps.tools.map((t) => t.spec.name).join(', ')}.`,
      isError: true,
    };
  }

  const args = (call.args ?? {}) as Record<string, unknown>;
  const resource =
    typeof args['path'] === 'string'
      ? ({ kind: 'path', value: args['path'] } as const)
      : ({ kind: 'none' } as const);

  const decisionSpan = deps.tracer.start(
    'muffin.policy_decision',
    { [ATTR.capability]: tool.capability, [ATTR.taint]: snapshot.currentTaint() },
    span,
  );
  const decision = snapshot.check(tool.capability, resource, args);
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
        `"${tool.capability}" richiede una bozza revocabile e il registro di undo non esiste ancora. ` +
        `Non eseguito: dillo all'owner invece di riprovare.`,
      isError: true,
    };
  }
  if (decision.effect === 'ask') {
    // M1 has no approval channel yet; the honest answer is that it did not run.
    span.end({ status: 'error', error: 'ask_unavailable' });
    return {
      type: 'tool_result',
      toolCallId: call.id,
      content: `Serve l'approvazione dell'owner per "${tool.capability}", e in questa superficie non posso chiederla. Non eseguito.`,
      isError: true,
    };
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
  if (recalled.length > 0) messages.push({ role: 'user', content: recalled });
  messages.push({ role: 'user', content: [{ type: 'text', text: input.text }] });
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
