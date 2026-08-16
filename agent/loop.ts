import { randomBytes } from 'node:crypto';
import { recall, recallTaint, renderForPrompt, type RecallDeps } from '../core/memory/recall.js';
import type { MemoryStore } from '../core/memory/store.js';
import type { Decide, PermissionSnapshot, Principal, TenantId, TrustTier } from '../core/policy/types.js';
import type { CapabilityDecl, CapabilityId, DecisionRequest } from '../core/policy/types.js';
import type { SessionMessage, SessionRef, SessionStore } from '../core/session/store.js';
import type { TurnCounters, TurnOutcome, TurnRecord, TurnStopped, TurnStore } from '../core/turns/store.js';
import type { TodoStore } from '../core/turns/todo.js';
import { decodeWaitFor, encodeWaitFor, satisfied, wakeReport, type WaitSpec } from '../core/turns/wait.js';
import type { SpanHandle, Tracer } from '../core/tracing/types.js';
import { ATTR } from '../core/tracing/types.js';
import { checkCompletion, completionNudge } from './completion.js';
import { tenantClass, todoSection, visibleTools, type SystemPrompts } from './context/assemble.js';
import { compactToolResults } from './context/compact.js';
import { iterationCap, type Profile } from './profiles/profile.js';
import { recoveryStep, type RecoveryFailure } from './profiles/recovery.js';
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
  /**
   * The row this call belongs to — `TurnResult.turnId`, and the trace id of the
   * turn that created it. A handler that wants durable state attached to the
   * turn it is running in has somewhere to attach it.
   */
  turnId: string;
  /**
   * The conversation. Multi-step work is scoped to this and never to the turn:
   * a plan that died with the turn that wrote it would not be a plan.
   */
  sessionId: string;
  /**
   * Arm the runtime's suspension barrier.
   *
   * **Armed, never immediate**, and that is the contract: the loop honours it
   * at the next suspension point — after the current batch of tool calls has
   * finished and every `tool_use` has its `tool_result`. A handler that could
   * suspend the turn from inside itself would leave the rest of its batch
   * unanswered, which is a malformed request to the next provider call; and it
   * is the same semantics the prior art landed on independently (Hermes parks
   * the *next* turn, ADR-0035's `steer` injects after the next tool call).
   *
   * Only `wait` calls it. It is on every context rather than injected into one
   * tool because a tool is registered once at boot and shared by every turn,
   * so the barrier has to travel with the turn — not with the tool.
   */
  suspend: (spec: WaitSpec) => void;
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
 * Re-attempts for a failure of the *transport* — 429, 502, a reset socket.
 *
 * A constant, and not `profile.recovery.length` as it used to be, because how
 * often to retry a rate limit is a property of the endpoint and never was a
 * crutch for a weak model. Tying the two together had one visible consequence
 * and one invisible one: a profile with the crutches off (`recovery: []`, the
 * neutral profile of 07 §3) got **zero** retries on a 502 — resilience removed
 * along with the scaffolding — and any transport hiccup silently ate a step of
 * the model-recovery cascade, so the empty turn that followed had nothing left
 * to spend.
 *
 * Two, matching what the shortest declared cascade bought before this split,
 * and small on purpose: both SDKs already retry twice underneath us
 * (`maxRetries ?? 2` — `@anthropic-ai/sdk/client.js`, `openai/client.js`) —
 * and those retries run INSIDE each provider.chat() call, so the budgets
 * multiply: on a persistent 502 this constant means 3 loop-level calls × 3
 * wire attempts = **9 requests**, of which our jitter governs 2 gaps and the
 * SDKs' own backoff the other 6. Stated because the first version of this
 * comment said "third and fourth attempt", which reads additive and is not.
 * If 9 is ever too many, the move is `maxRetries: 0` on both clients and the
 * loop owning the whole budget — its own slice, not a constant tweak.
 */
const MAX_TRANSPORT_RETRIES = 2;

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
  /**
   * Where the turn lives while it is happening.
   *
   * **Required, and that is the decision.** Every other durable seam in this
   * type is optional with a documented degradation, and every optional one has
   * at some point been left unwired in production while the tests stayed green
   * — `recordSpend` and `capabilities` both say so a few lines from here. A
   * turn without a record is not a degraded turn: it is a turn that cannot be
   * seen, resumed, or told apart from one that died mid-effect. So the type
   * refuses it, and a construction site that forgets it fails to build rather
   * than failing in six months on somebody's laptop.
   *
   * See `core/turns/store.ts` for the shape and why it is not the session file.
   */
  turns: TurnStore;
  /**
   * The plan. **Required, for the reason `turns` is.**
   *
   * A todo list is only a mechanism if every turn of the session is shown it
   * (`buildContext` below reads this on every turn, unconditionally). Made
   * optional it would be unwired on some surface, the tool would still write
   * rows, the tests would still be green, and the model would keep re-deriving
   * its plan from its own prose — which is the exact failure this store exists
   * to remove. So a construction site that forgets it fails to build.
   */
  todos: TodoStore;
  /**
   * Takes the tenant, and that is the whole fix: the signature used to be
   * `() => boolean`, so the per-tenant daily cap could not be consulted through
   * it even by someone trying. It was sealed, loaded, tested, reported healthy
   * by `doctor` — and asked by nobody.
   */
  budgetExhausted: (tenant: TenantId) => boolean;
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
   * that forgets to pass this degrades to refusals, not to unguarded allows —
   * for the RESOURCE consumer. The second consumer (`visibleTools`, filtering a
   * member's tool menu) degrades the other way on absence: no declarations, no
   * filtering, and a member sees host-only tools the kernel will refuse. Not an
   * allow, but a leaky menu — the omission price differs per consumer, and this
   * line is where a construction site learns both.
   */
  capabilities?: ReadonlyMap<CapabilityId, CapabilityDecl> | undefined;
  /**
   * The turn ended. **Synchronous, and it must not block.**
   *
   * The loop had no way to hand a finished turn to anything, which is why the
   * memory lane never started: `ingestPending` was correct and had one caller,
   * a person typing `muffin memory extract`. This is that missing seam, and its
   * contract is narrow on purpose — it is called from `finish`, microseconds
   * before the caller writes the reply, so anything that awaits here is
   * something the owner waits for. The implementation
   * (`core/memory/consolidator.ts`) arms a timer and returns.
   *
   * Deliberately **not** the closure-handed-back shape of
   * `agent/observe-run.ts`. There the write is withheld until delivery
   * succeeded, because an episode recorded for a message nobody received is
   * memory of something that did not happen. Here the episode is written at the
   * top of this function, before the model is called, so the trigger's input
   * exists whether or not the reply lands — withholding the notification would
   * only delay work already owed.
   *
   * Fires on every ending, `error` and `aborted` included: the owner's words
   * were recorded before the model was asked anything, so they are owed
   * extraction regardless of how the turn went.
   */
  onTurnEnd?: ((info: { tenant: TenantId; principal: Principal; stopped: TurnResult['stopped'] }) => void) | undefined;
  now?: () => Date;
};

export type TurnInput = {
  principal: Principal;
  tenant: TenantId;
  surface: string;
  session: SessionRef;
  text: string;
  signal?: AbortSignal;
  /**
   * Where the answer has to go, for a surface that delivers **out of band**.
   *
   * Opaque here on purpose: the loop must not learn what a chat id is — that is
   * the boundary the previous system lost when its gateway started building
   * Telegram-shaped footers. Each surface owns the shape and validates its own.
   * Absent means the caller of `runTurn` is holding the answer itself, and
   * there is no second step that can fail.
   */
  replyTo?: Record<string, unknown> | undefined;
};

export type TurnResult = {
  text: string;
  iterations: number;
  traceId: string;
  /**
   * The turn's row, which is also `traceId` — one identity, so "what did it do"
   * and "why did it do that" are a join rather than a correlation. Returned so
   * a surface can record how the *delivery* went, which is a second outcome and
   * never the same one as `stopped`.
   */
  turnId: string;
  /**
   * Referenced, not re-declared. This union had three literal copies — here,
   * `core/turns/store.ts` and `core/scheduler/scheduler.ts` — and the design
   * that produced the record named the divergence as this repo's typical defect
   * before it happened. `suspended` is the arm this slice adds, and adding it in
   * one place is how every consumer had to answer for it.
   */
  stopped: TurnStopped;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  /** Present when `stopped` is 'ask': what the turn wanted permission for. */
  pending?: ApprovalRequest;
  /** Present when `stopped` is 'suspended': when it comes back, and why. */
  suspendedUntil?: WaitSpec;
};

/**
 * How many times a row may be picked back up before we stop trying.
 *
 * Three, and the bound exists because the failure it guards is one this record
 * makes *more* likely, not less: a turn whose resume kills the process would be
 * retried by every boot for ever, and the process that dies is never the one
 * that can count. Three is enough to survive a laptop closing, a `systemctl
 * restart` and one genuine crash; a fourth attempt is evidence about the turn,
 * not about the infrastructure.
 */
export const MAX_RESUMES = 3;

/**
 * Write the row, and let something else run it.
 *
 * This is the whole of B2 — *"un turno lungo restituisce entro ~500 ms e
 * consegna dopo"* — and it is deliberately one write and no `await`. The
 * tempting cure for a connector that blocks is to drop the `await` on
 * `runTurn`, and the design measured what that costs: a turn **in flight and
 * unrecorded**, invisible to the gateway's drain, outside the single model
 * lane, and with the inbox's at-least-once guarantee detached
 * (`research/turno-sospendibile.md` §B2). Every one of those three repairs is
 * "record the turn somewhere durable", so the row is the cure and not a
 * bookkeeping side-effect of it.
 *
 * The transcript starts as the owner's own words and nothing else. That is not
 * a placeholder: it is the minimum a resume needs to be able to assemble the
 * rest, and it is why nothing here calls recall — recall is an embedder plus a
 * reranking model call, which is precisely the latency this function exists to
 * keep off the connector's thread. The lane assembles the context on the first
 * step, and `counters.contextBuilt` is how it knows it has not yet.
 */
export function enqueueTurn(deps: LoopDeps, input: TurnInput): string {
  const id = randomBytes(16).toString('hex');
  deps.turns.enqueue({
    id,
    principal: input.principal,
    tenant: input.tenant,
    surface: input.surface,
    sessionId: input.session.id,
    model: deps.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: input.text }] }],
    taint: input.principal.kind === 'member' ? 2 : 0,
    counters: freshCounters(),
    ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
  });
  return id;
}

/** The counters of a turn that has not started. */
function freshCounters(): TurnCounters {
  return {
    iterations: 0,
    recoveriesUsed: 0,
    transportRetriesLeft: MAX_TRANSPORT_RETRIES,
    toolCallsMade: 0,
    nudgedForCompletion: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    spentUsd: 0,
    resumes: 0,
    contextBuilt: false,
  };
}

export async function runTurn(deps: LoopDeps, input: TurnInput): Promise<TurnResult> {
  const turn = deps.tracer.start('muffin.turn', {
    [ATTR.principalKind]: input.principal.kind,
    [ATTR.tenant]: input.tenant,
    [ATTR.surface]: input.surface,
    [ATTR.requestModel]: deps.model,
  });

  /**
   * The record, before anything happens — and **not** inside a try.
   *
   * A row that cannot be written stops the turn here, with nothing done: no
   * episode, no session line, no model call, no spend. That order is the whole
   * point of the failure path. The alternative — start anyway and record later
   * — is a log of what already happened, and the property being bought is that
   * the row exists while the work is still owed.
   *
   * Above the episode write in `drive` below, deliberately, and the two are not
   * in conflict: an owner's words that were never recorded are re-delivered by
   * whatever surface still holds them (a Telegram update stays pending), while
   * an episode written for a turn that never started is memory of something
   * that did not happen.
   *
   * The transcript is the owner's words and nothing else — the same shape
   * `enqueueTurn` writes, so a crash between this line and the first checkpoint
   * leaves a row a resume can still assemble a context for. It used to be `[]`,
   * which lost the question along with the answer.
   */
  const record = deps.turns.create({
    id: turn.traceId,
    principal: input.principal,
    tenant: input.tenant,
    surface: input.surface,
    sessionId: input.session.id,
    // Pinned here and never re-derived: a resume onto a different model sends
    // back thinking signatures it cannot read, and ADR-0037 records that this
    // fails silently rather than loudly.
    model: deps.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: input.text }] }],
    taint: input.principal.kind === 'member' ? 2 : 0,
    counters: freshCounters(),
    ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
  });

  return drive(deps, record, turn, {
    session: input.session,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

/** Why a resume could not happen. Never a throw: the caller has to be able to say so. */
export type ResumeRefusal = {
  turnId: string;
  why: 'not_found' | 'claimed' | 'model_changed' | 'exhausted' | 'finished';
  detail: string;
};

/**
 * Pick a turn back up — after a wait, after a crash, or after a connector
 * handed it over without running it.
 *
 * Three refusals live here, and none of them is a convenience:
 *
 *  1. **The model is pinned.** A `thinking` block carries a signature belonging
 *     to the model that produced it, and ADR-0037 records that sending one to a
 *     model that cannot read it makes **no noise**: the server strips it or
 *     turns thinking off, and the symptom is a worse agent. So a resume on a
 *     different model is refused *and said*, and the row is closed rather than
 *     left to be retried by every boot for ever.
 *  2. **The taint comes off the row.** Rebuilding it from the principal would
 *     restart at tier 0 a turn that had already read the web — the
 *     fetch-then-act pattern the kernel exists to close, reopened by a new
 *     door. It is a column precisely so that this function cannot derive it.
 *  3. **`rerunnable` decides what may be repeated.** A call with an intent row
 *     and no outcome row is re-executed only when its capability declared it
 *     re-runnable; otherwise the turn resumes **declaring** that the call may
 *     have happened. Never pretending it did not.
 */
export async function resumeTurn(
  deps: LoopDeps,
  turnId: string,
): Promise<TurnResult | ResumeRefusal> {
  const existing = deps.turns.get(turnId);
  if (existing === null) {
    return { turnId, why: 'not_found', detail: `nessun turno ${turnId}` };
  }
  if (existing.status === 'done') {
    return { turnId, why: 'finished', detail: `il turno ${turnId} è già chiuso (${existing.outcome ?? '?'})` };
  }
  const wasWaiting = existing.status === 'waiting';

  const record = deps.turns.claim(turnId, process.pid, (deps.now ?? (() => new Date()))());
  if (record === null) {
    // Not an error: two lanes over one database is the normal case for the
    // seconds a REPL and a gateway overlap, and the loser has nothing to do.
    return { turnId, why: 'claimed', detail: `il turno ${turnId} è stato preso da un altro processo` };
  }

  const span = deps.tracer.start(
    'muffin.turn',
    {
      [ATTR.principalKind]: record.principal.kind,
      [ATTR.tenant]: record.tenant,
      [ATTR.surface]: record.surface,
      [ATTR.requestModel]: record.model,
      [ATTR.turnId]: record.id,
      [ATTR.turnResume]: record.counters.resumes + 1,
    },
    // A remote parent: the record's id *is* the trace id of the turn's first
    // span, so a resume is a child of the trace it belongs to rather than a
    // second, unrelated trace. Handing `start` a handle whose only real field
    // is the trace id is what the OTel model calls a remote parent context, and
    // it is the one thing this interface needs it for.
    remoteParent(record.id),
  );

  if (record.model !== deps.model) {
    // Explicit, and terminal. Retrying would mean a row that wakes every boot
    // to be refused again, which is the silent-forever failure this whole
    // record was built to stop producing.
    const detail =
      `il turno ${record.id.slice(0, 12)} è stato aperto su ${record.model} e adesso il modello è ${deps.model}: ` +
      `non è un resume. Le firme di thinking appartengono al modello che le ha prodotte, e rimandarle a un altro ` +
      `non dà un errore — dà un agente peggiore in silenzio (ADR-0037).`;
    span.setAttributes({ 'muffin.turn.resume_refused': 'model_changed' });
    closeRow(deps, span, record, 'error', detail);
    span.end({ status: 'error', error: 'model_changed' });
    return { turnId, why: 'model_changed', detail };
  }

  if (record.counters.resumes >= MAX_RESUMES) {
    const detail =
      `il turno ${record.id.slice(0, 12)} è già stato ripreso ${record.counters.resumes} volte e non si chiude: ` +
      `mi fermo invece di riprovare all'infinito.`;
    span.setAttributes({ 'muffin.turn.resume_refused': 'exhausted' });
    closeRow(deps, span, record, 'error', detail);
    span.end({ status: 'error', error: 'resumes_exhausted' });
    return { turnId, why: 'exhausted', detail };
  }

  return drive(deps, record, span, { resumed: true, wokenFromWait: wasWaiting });
}

/**
 * The engine, over a row that is already claimed.
 *
 * One body for a fresh turn and for a resumed one, because two would drift and
 * the resumed one is the one nobody watches. What differs is only the *start
 * state*: a fresh turn assembles its context here, a resumed one restores it
 * from the record and repairs whatever the crash left half-said.
 */
async function drive(
  deps: LoopDeps,
  record: TurnRecord,
  turn: SpanHandle,
  options: {
    signal?: AbortSignal | undefined;
    resumed?: boolean;
    wokenFromWait?: boolean;
    /** The ref the caller already opened. Absent on a resume — see `input.session`. */
    session?: SessionRef | undefined;
  } = {},
): Promise<TurnResult> {
  const now = deps.now ?? (() => new Date());
  const input: TurnInput = {
    principal: record.principal,
    tenant: record.tenant,
    surface: record.surface,
    /**
     * The caller's own ref when there is one, reopened from the id when there
     * is not — and **never** rebuilt by hand.
     *
     * A `SessionRef` is `{ id, file }` and only `SessionStore.open` knows the
     * second half. This line used to be `{ id: record.sessionId } as
     * SessionRef`: a cast, which is a claim and not a check, and the claim was
     * false — every `sessions.append` in the turn then wrote to `undefined` and
     * threw. A resume has no caller holding a ref, so it derives one; a fresh
     * turn passes the ref it already opened, which is the stronger of the two
     * because it cannot disagree with the caller about where the transcript is.
     */
    session: options.session ?? deps.sessions.open(record.sessionId),
    text: lastUserText(record.messages),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(record.replyTo === null ? {} : { replyTo: record.replyTo }),
  };

  // ---- Pre-loop: deterministic, no model call. ------------------------------
  // Permissions, taint and *which context this turn gets* are resolved before
  // anything is generated, so none of them can depend on what the model just
  // said. The class is a pure function of the principal and the tenant the
  // gateway already resolved — the same two values the kernel decides on.
  //
  // The taint comes from the **record**, not from the principal: see
  // `resumeTurn` §2. On a fresh turn the two agree by construction, which is
  // exactly why deriving it looked safe for as long as nothing resumed.
  const snapshot = makeSnapshot(deps.decide, input.principal, input.tenant, record.taint);
  const turnClass = tenantClass(input.principal, input.tenant);

  const usage = { ...record.counters.usage };
  let spentUsd = record.counters.spentUsd;
  const cap = iterationCap(deps.profile);
  /**
   * How far down the profile's declared cascade this turn has walked. An index,
   * not a budget: attempt N runs strategy N.
   */
  let recoveriesUsed = record.counters.recoveriesUsed;
  /** The other budget. See MAX_TRANSPORT_RETRIES for why it is not the same one. */
  let transportRetriesLeft = record.counters.transportRetriesLeft;
  let toolCallsMade = record.counters.toolCallsMade;
  let nudgedForCompletion = record.counters.nudgedForCompletion;
  let iterations = record.counters.iterations;
  let contextBuilt = record.counters.contextBuilt;
  const resumes = record.counters.resumes + (options.resumed === true ? 1 : 0);
  const counters = (): TurnCounters => ({
    iterations,
    recoveriesUsed,
    transportRetriesLeft,
    toolCallsMade,
    nudgedForCompletion,
    usage,
    spentUsd,
    resumes,
    contextBuilt,
  });

  /**
   * The barrier `wait` arms, honoured between iterations and never inside one.
   *
   * `null` until a handler asks. See `ToolContext.suspend` for why it is armed
   * rather than thrown.
   */
  let barrier: WaitSpec | null = null;

  /**
   * What every handler is told about the turn it is running in — built once,
   * because the barrier has to be the same object across the whole turn.
   *
   * Declared **here**, above every use, and not next to the closures at the
   * bottom of this function: `const` is not hoisted the way a `function`
   * declaration is, so a copy sitting after the loop would sit in its temporal
   * dead zone for the entire turn and throw `ReferenceError` on the first tool
   * call. The build said so; the runtime would have said so on message one.
   */
  const toolContext: ToolContext = {
    tenant: input.tenant,
    principal: input.principal,
    turnId: record.id,
    sessionId: input.session.id,
    suspend: (spec) => {
      barrier = spec;
    },
  };

  const messages: Message[] = [...record.messages];

  // What this turn is shown, decided from who is speaking and where — never
  // from what they said. Filter first, cap second: `slice` on registration
  // order applied to the full list would spend a weak model's ten slots on
  // tools the kernel is going to refuse this principal anyway.
  //
  // Recomputed on a resume rather than persisted, and it is correct to: it is a
  // pure function of the principal and the profile, and the profile follows the
  // model, which the row pins. The legitimate direction of change in between —
  // a tightened permission matrix — is one a resume should *inherit*, not one
  // it should carry a stale copy past.
  const exposed = visibleTools(deps.tools, input.principal, deps.capabilities).slice(
    0,
    deps.profile.maxToolsExposed,
  );
  turn.setAttributes({ 'muffin.context.class': turnClass, 'muffin.context.tools_exposed': exposed.length });

  if (!contextBuilt) {
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

    messages.length = 0;
    messages.push(...buildContext(deps, input, recalled));

    deps.sessions.append(input.session, {
      role: 'user',
      content: input.text,
      surface: input.surface,
      createdAt: now().toISOString(),
      traceId: turn.traceId,
    });
    // Marked before the first model call, so a crash inside recall replays the
    // preamble (one duplicated episode, absorbed by consolidation) while a
    // crash anywhere after it does not. The window is the microseconds between
    // two synchronous SQLite writes.
    contextBuilt = true;
    checkpoint();
  } else if (options.resumed === true) {
    // A resumed turn re-enters a transcript that a crash may have left with a
    // question and no answer. Repairing it is not optional: a `tool_use` block
    // without its `tool_result` is a malformed request, and the provider says
    // so on the very first call.
    await reconcile();
    if (options.wokenFromWait === true) {
      const waitFor = decodeWaitFor(record.waitFor);
      const why = waitFor !== null && satisfied(waitFor) ? 'event' : 'timer';
      turn.setAttributes({ 'muffin.turn.woken_by': why });
      messages.push({ role: 'user', content: [{ type: 'text', text: wakeReport(waitFor, why) }] });
    }
  }

  try {
    while (iterations < cap) {
      // Suspension point 1 (design §T3): nothing is in flight, so everything
      // worth keeping is in the variables above. This is where a `wait` armed
      // during the previous batch is honoured — the state goes to disk, the
      // status becomes `waiting`, and this function **returns**, which is the
      // half that distinguishes a wait from an `await sleep()`: the runtime is
      // released and nothing holds it while the deadline runs.
      if (barrier !== null) return suspendHere(barrier);
      // Written every iteration rather than only at the end, because the state
      // this saves is the state a process that dies here would otherwise take
      // with it — the transcript, the taint it has climbed to, and how much of
      // each budget is spent.
      checkpoint();
      if (deps.budgetExhausted(input.tenant)) {
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
        // The profile decides both, and until this slice neither reached the
        // wire: `thinking` was declared in every profile and passed by nobody
        // (the ninth "mechanism with no caller" in this repo's list), and
        // `temperature: 0` was hardcoded here — a 400 on every model
        // frontier.json matches, on the config `muffin init` writes by default.
        //
        // Spread rather than `temperature: profile.sampling === ... ? 0 :
        // undefined`, because under exactOptionalPropertyTypes an explicit
        // `undefined` is not the same as an absent field, and the difference is
        // exactly what the newest models reject.
        ...(deps.profile.sampling === 'deterministic' ? { temperature: 0 } : {}),
        // D2 (judge, 2026-08-13): this was `thinking: deps.profile.thinking`
        // unconditionally, so ADR-0037's own documented escape hatch — "si
        // spegne il campo (`thinking` assente resta una forma valida e
        // l'adapter la supporta già)" — was unreachable from any profile:
        // `Profile.thinking` was a required two-value field and this line
        // never omitted it. 'unset' is the profile value that reaches the
        // branch below; spread rather than `thinking: … ? undefined : …` for
        // the same exactOptionalPropertyTypes reason as `temperature` above —
        // an explicit `undefined` can still be a key on the wire, an absent
        // key never is.
        ...(deps.profile.thinking !== 'unset' ? { thinking: deps.profile.thinking } : {}),
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
        // Two failures wearing one type, and they take different doors.
        //
        // `output` is the model's own doing — arguments the adapter could not
        // parse — so it goes to the profile's cascade, which is where the step
        // written for almost-JSON lives. Backing off would only wait for the
        // same JSON to come back.
        //
        // `transport` is a 429 or a 502, and it gets its own budget: the
        // recovery cascade lives in the profile because a weak model needs more
        // attempts than a strong one, and a rate limit is not a fact about the
        // model at all.
        if (error instanceof ProviderError && error.retryable) {
          if (error.source === 'output') {
            if (recover('malformed')) continue;
          } else if (transportRetriesLeft > 0) {
            transportRetriesLeft -= 1;
            // Backoff, because the retryable case is mostly 429 and hammering a
            // rate limit four times in a row is how a soft limit becomes a hard
            // one. Exponential with jitter: the jitter matters when several turns
            // are throttled at once and would otherwise retry in lockstep.
            const attempt = MAX_TRANSPORT_RETRIES - transportRetriesLeft;
            await sleep(retryDelayMs(attempt), input.signal);
            continue;
          }
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

      // Nothing at all: recover rather than presenting silence as an answer.
      if (!result.text && result.toolCalls.length === 0) {
        if (recover('empty')) continue;
        return finish(turn, 'error', 'Il modello non ha prodotto una risposta utilizzabile.', iterations, usage);
      }

      if (result.toolCalls.length === 0) {
        const text = result.text ?? '';

        // The completion gate: did the answer describe a call this turn never
        // made? Deterministic, tool-aware, and it only fires when *nothing* was
        // called — a denied or failed call is still a call, so a model saying
        // "non ho potuto usare fs_write" after a real refusal is out of scope.
        //
        // Its own flag, deliberately outside the profile's cascade: this check
        // is durable (07 classifies the profiles as impalcatura and says
        // nothing of it), it answers a false-success rate measured on every
        // model family including the reasoning ones, and a profile that
        // declares no crutches must still get it. One nudge, always available.
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
      //
      // Reasoning first, unmodified, ahead of the `tool_use` blocks it came
      // with. This is the half the API calls **Required** — "within a tool-use
      // turn, pass thinking blocks back" — and the half that was missing: this
      // array used to be rebuilt from `text` + `toolCalls`, so whatever the
      // model thought was gone by iteration 2 of every tool-using turn. No 400
      // was ever going to tell us; the server strips or disables instead, so
      // the symptom was a worse agent and a colder cache, not an error.
      //
      // Spread of `result.thinking`, never a map or a filter: their order is
      // the model's and the contents are opaque. A `?? []` because an adapter
      // may legitimately have none (openai-compat says so with `[]`), not
      // because absence is expected here.
      messages.push({
        role: 'assistant',
        content: [
          ...(result.thinking ?? []),
          ...(result.text ? [{ type: 'text' as const, text: result.text }] : []),
          ...result.toolCalls.map((c) => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: c.args })),
        ],
      });
      // Checkpointed **here**, and not only at the top of the next iteration.
      //
      // This one line is what makes a resume able to tell a question from an
      // answer. Without it the persisted transcript stops at the start of the
      // iteration, so a process that dies mid-batch leaves a record with no
      // `tool_use` blocks in it — and `reconcile` below would have nothing to
      // repair, while the intent rows in `turn_tool_calls` described calls the
      // transcript did not contain. Two records of one batch, disagreeing.
      checkpoint();

      const results: ContentBlock[] = [];
      toolCallsMade += result.toolCalls.length;
      for (const call_ of result.toolCalls) {
        // Checked between tools, not only before the next model call: a Ctrl+C
        // during a run of tool calls used to do nothing visible until the batch
        // finished, which for a slow batch is indistinguishable from being
        // ignored.
        if (input.signal?.aborted) return finish(turn, 'aborted', 'Interrotto.', iterations, usage);
        try {
          results.push(await runTool(deps, snapshot, turn, call_, input, exposed, toolContext));
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
    // Same reason `announceEnd` is repeated here: a provider that exhausted its
    // retries never reaches `finish`, and a row left `running` by a turn that
    // is definitely over would be reclaimed as *interrupted* — "we do not know
    // whether it ran" — when we know exactly how it ended.
    closeRecord('error');
    // A turn that threw still recorded the owner's words at the top of this
    // function, so they are still owed extraction. Announced here as well as in
    // `finish` because a provider that exhausted its retries never reaches
    // `finish` at all, and "the memory lane starts only when the model behaves"
    // is not a property anyone would have chosen.
    announceEnd('error');
    throw error;
  }

  /**
   * The turn's state, saved at a point where nothing is in flight.
   *
   * Swallowed, and this is the one place in this file where swallowing is the
   * right call — with the reason, because "caught and ignored" is how guards
   * here have died before. A checkpoint that fails leaves the row **stale**,
   * not wrong: the next one overwrites it, and a process that dies before then
   * is reclaimed as interrupted, which is exactly what it was. Rethrowing would
   * instead take down a turn that is still perfectly able to answer, over a
   * write whose only job is to make a *future* failure cheaper. `Gateway.drain`
   * closing the database under a long turn is not hypothetical — it is the
   * measured crash in `core/scheduler/scheduler.ts:174-181`.
   *
   * The failure is on the span, so "the record stopped being written" is
   * visible in a trace instead of being inferred from a stale row.
   */
  function checkpoint(): void {
    try {
      deps.turns.checkpoint(record.id, { messages, taint: snapshot.currentTaint(), counters: counters() });
    } catch (error) {
      turn.setAttributes({ 'muffin.turn.record_error': error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * The turn releases the runtime. **Not** an ending — see `TurnStopped`.
   *
   * The write is a single statement (`TurnStore.suspend`) for ADR-0035 §1's
   * reason, restated on this table: one write advances the state, so a second
   * writer added later cannot move a turn past a suspension nobody recorded.
   * A failure here is the one case that must **not** be swallowed the way a
   * checkpoint is: if the row did not become `waiting`, nothing will ever wake
   * it, and returning `suspended` would be a promise made to a caller that
   * cannot be kept. So it falls back to finishing the turn and saying so.
   */
  function suspendHere(spec: WaitSpec): TurnResult {
    const wrote = (() => {
      try {
        return deps.turns.suspend(record.id, {
          messages,
          taint: snapshot.currentTaint(),
          counters: counters(),
          wakeAt: spec.wakeAt,
          waitFor: spec.waitFor === null ? null : encodeWaitFor(spec.waitFor),
        });
      } catch (error) {
        turn.setAttributes({ 'muffin.turn.record_error': error instanceof Error ? error.message : String(error) });
        return false;
      }
    })();

    if (!wrote) {
      return finish(
        turn,
        'error',
        'Volevo sospendermi e aspettare, ma non sono riuscito a salvare lo stato del turno: ' +
          'se aspettassi comunque non mi sveglierebbe nessuno. Mi fermo qui e te lo dico.',
        iterations,
        usage,
      );
    }

    turn.setAttributes({
      [ATTR.stopReason]: 'suspended',
      [ATTR.turnIteration]: iterations,
      'muffin.turn.wake_at': spec.wakeAt,
      ...(spec.waitFor === null ? {} : { 'muffin.turn.wait_for': encodeWaitFor(spec.waitFor) }),
    });
    turn.end({ status: 'ok' });
    // No `announceEnd`: the memory lane is told when a turn *ends*, and this
    // one has not. Waking the consolidator here would mean extracting from a
    // half-finished conversation every time the agent decided to wait.
    return {
      text: '',
      iterations,
      traceId: turn.traceId,
      turnId: record.id,
      stopped: 'suspended',
      usage,
      suspendedUntil: spec,
    };
  }

  /**
   * Repair a transcript a crash left mid-batch, using the two-phase tool record.
   *
   * The tail test is exact rather than heuristic: the loop pushes the results
   * of a batch as **one** user message after the whole batch, so a transcript
   * whose last message is an assistant turn carrying `tool_use` blocks is
   * precisely a batch that was never answered. There is no partial results
   * message to disambiguate.
   *
   * Three states, from the pair of rows, and the third is the one that only
   * exists because the intent row does (`ADR-0042`):
   *
   *  - **done** — an outcome was recorded. Replay it. This is Temporal's
   *    property in our own words: during replay the recorded result is reused,
   *    not recomputed. Its tier is replayed too, or a turn that had read the
   *    web would come back believing it had not.
   *  - **maybe done** — an intent row, no outcome. `rerunnable` decides, and
   *    nothing else may: `reversible` answers a different question (`fs.write`
   *    is `undoable` and perfectly safe to repeat; a message is neither).
   *    Where it says no, the turn resumes **declaring** that the call may have
   *    landed — never pretending it did not, and never claiming it did.
   *  - **not started** — neither row. Run it, through the same kernel path as
   *    any other call, because the permission matrix may have tightened while
   *    the turn was dead and a resume should inherit that.
   */
  async function reconcile(): Promise<void> {
    const last = messages[messages.length - 1];
    if (last === undefined || last.role !== 'assistant') return;
    const pending = last.content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
    if (pending.length === 0) return;

    const recorded = deps.turns.recordedOutcomes(record.id);
    const uncertain = new Map(deps.turns.uncertainCalls(record.id).map((c) => [c.callId, c]));
    const repaired: ContentBlock[] = [];
    turn.setAttributes({ 'muffin.turn.reconciled': pending.length });

    for (const block of pending) {
      const done = recorded.get(block.id);
      if (done !== undefined) {
        // The taint the recorded result carried has to come back with it: this
        // is the same "the two facts must not land apart" the outcome write
        // enforces in a transaction.
        if (done.tier !== null) snapshot.raiseTaint(done.tier);
        repaired.push({
          type: 'tool_result',
          toolCallId: block.id,
          content: done.content,
          ...(done.isError ? { isError: true } : {}),
        });
        continue;
      }

      const open = uncertain.get(block.id);
      if (open !== undefined && !open.rerunnable) {
        repaired.push({
          type: 'tool_result',
          toolCallId: block.id,
          content:
            `Questa chiamata a ${block.name} era partita quando il processo è morto, e non è dichiarata ` +
            `ri-eseguibile: **non è possibile sapere se ha avuto effetto**. Non l'ho rifatta. ` +
            `Verifica lo stato prima di riprovarla, e dillo a chi ti ha chiesto la cosa.`,
          isError: true,
        });
        continue;
      }

      // Either re-runnable and uncertain, or never started at all. Both go
      // through `runTool`, so the kernel rules on them again and the intent row
      // is written again — `ON CONFLICT DO NOTHING` absorbs the second write.
      try {
        repaired.push(
          await runTool(
            deps,
            snapshot,
            turn,
            { id: block.id, name: block.name, args: block.input },
            input,
            exposed,
            toolContext,
          ),
        );
      } catch (error) {
        // An `ask` that cannot be asked on this surface is not a reason to
        // abandon a repair half-done: the block gets an honest result and the
        // turn continues to the normal `ask` handling on its next call.
        repaired.push({
          type: 'tool_result',
          toolCallId: block.id,
          content: error instanceof ApprovalRequired
            ? `Ripresa: ${block.name} vuole un'approvazione che qui non posso chiedere.`
            : error instanceof Error
              ? error.message
              : String(error),
          isError: true,
        });
      }
    }

    messages.push({ role: 'user', content: repaired });
    checkpoint();
  }

  /** The single write that ends the row. Same swallow, same reason, one caveat. */
  function closeRecord(outcome: TurnOutcome): void {
    try {
      deps.turns.finish(record.id, {
        outcome,
        messages,
        taint: snapshot.currentTaint(),
        counters: counters(),
      });
    } catch (error) {
      // The caveat: unlike a checkpoint, nothing comes after this one. The row
      // stays `running` and the next boot reclaims it as interrupted — a turn
      // that answered, reported as "we cannot say". That is the safe direction
      // of the two, and it is not silent: the attribute below is the trace's
      // record that the outcome could not be written.
      turn.setAttributes({ 'muffin.turn.record_error': error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Tells the background lane a turn is over, and refuses to let it matter.
   *
   * Swallowed rather than propagated: this hook exists to start work *after*
   * the answer, and a background lane that can turn a good turn into an
   * exception would be a worse bug than the one it fixes. There is nothing for
   * the owner to do about it either, which is the test for whether an error
   * belongs on their screen.
   */
  function announceEnd(stopped: TurnOutcome): void {
    try {
      deps.onTurnEnd?.({ tenant: input.tenant, principal: input.principal, stopped });
    } catch {
      /* a lane that runs after the reply may not take the reply down with it */
    }
  }

  /**
   * One step down the cascade the profile declared, or false when it is spent.
   *
   * Attempt N runs strategy N, in the order the JSON lists them — the property
   * this function exists to hold. What each strategy *does* is in
   * `agent/profiles/recovery.ts`; nothing here knows a strategy by name, so a
   * profile can reorder or drop steps and the loop is unaffected, and turning
   * every crutch off (`recovery: []`) is a profile edit rather than a code path
   * (07 §3).
   *
   * Not the same mechanism as the completion gate below, which nudges once when
   * an answer narrates a call the turn never made: that one is durable, applies
   * to every model, keeps its own flag, and a profile may not decline it.
   */
  function recover(failure: RecoveryFailure): boolean {
    const strategy = deps.profile.recovery[recoveriesUsed];
    if (strategy === undefined) return false;
    recoveriesUsed += 1;
    const step = recoveryStep(strategy, { failure, tools: exposed.map((t) => t.spec.name) });
    if (step.message !== undefined) {
      messages.push({ role: 'user', content: [{ type: 'text', text: step.message }] });
    }
    turn.setAttributes({
      'muffin.recovery.attempt': recoveriesUsed,
      'muffin.recovery.strategy': strategy,
      'muffin.recovery.failure': failure,
    });
    return true;
  }

  function finish(
    span: SpanHandle,
    stopped: TurnOutcome,
    text: string,
    iters: number,
    used: TurnResult['usage'],
  ): TurnResult {
    span.setAttributes({ [ATTR.stopReason]: stopped, [ATTR.turnIteration]: iters });
    // Before the span ends and before the hook fires: the row is the durable
    // half, and a background lane must never be able to run while the record
    // still says a live process is executing this turn.
    closeRecord(stopped);
    span.end({ status: stopped === 'error' ? 'error' : 'ok' });
    // Last thing before the return, so the span is closed and the result is
    // built: the hook is not allowed to see a half-finished turn, and it is not
    // allowed to delay this return.
    announceEnd(stopped);
    return { text, iterations: iters, traceId: span.traceId, turnId: record.id, stopped, usage: used };
  }
}

/**
 * Close a row from outside the engine, for the two refusals that happen before
 * it starts.
 *
 * A refused resume has no transcript to write and no counters to advance — it
 * has a row that must stop being picked up, and a reason the owner can read. It
 * writes the reason into the transcript so the surface delivering the turn has
 * something to say, which is the difference between "the turn ended" and "the
 * turn vanished".
 */
function closeRow(
  deps: LoopDeps,
  span: SpanHandle,
  record: TurnRecord,
  outcome: TurnOutcome,
  detail: string,
): void {
  try {
    deps.turns.finish(record.id, {
      outcome,
      messages: [...record.messages, { role: 'assistant', content: [{ type: 'text', text: detail }] }],
      taint: record.taint,
      counters: record.counters,
    });
  } catch (error) {
    span.setAttributes({ 'muffin.turn.record_error': error instanceof Error ? error.message : String(error) });
  }
}

/**
 * A parent handle that carries only a trace id.
 *
 * `Tracer.start` derives the trace id from its parent, and a resumed turn has
 * to land in the trace its record is named after — the record's id **is** that
 * trace id, so "what did it do" and "why" stay one join rather than two traces
 * correlated by hand. This is the remote-parent case of the OTel model: the
 * parent span belongs to a process that is gone, and only its identity crossed
 * the boundary. Nothing ever ends it, because nothing here started it.
 */
function remoteParent(traceId: string): SpanHandle {
  return {
    traceId,
    spanId: '0000000000000000',
    setAttributes: () => {},
    end: () => {},
  };
}

/** The words the turn was started with — the last thing the owner said. */
function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== 'user') continue;
    const text = message.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (text !== '') return text;
  }
  return '';
}

/**
 * Compile-time exhaustiveness, not a runtime nicety.
 *
 * Called only from a `switch`'s `default` after every real case of a closed
 * union has its own `case`. If the switch stays exhaustive, TypeScript
 * narrows the switched value to `never` at that `default`, so `x` type-checks
 * against the `never` parameter here and the file compiles. The day a case is
 * added to the union without a matching `case` in that switch, `x` is no
 * longer `never` there and the build breaks — on the addition, not on
 * whatever depended on the branch nobody wrote. If it is somehow still
 * reached at runtime (a value that bypassed the type checker: a cast, a
 * dependency built from a different commit, a persisted record replayed after
 * a schema change), it throws loudly instead of letting the caller silently
 * treat the unrecognised value as whichever branch happens to be last.
 */
function assertNever(x: never): never {
  throw new Error(`unreachable: unhandled variant ${JSON.stringify(x)}`);
}

async function runTool(
  deps: LoopDeps,
  snapshot: PermissionSnapshot,
  parent: SpanHandle,
  call: { id: string; name: string; args: unknown },
  input: TurnInput,
  /** What this turn was actually shown — the only list it may be told about. */
  exposed: RegisteredTool[],
  /** The turn a handler is running in: identity, and the suspension barrier. */
  ctx: ToolContext,
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

  // A `switch` over `decision.effect` with an explicit `default`, not the
  // `if`-chain this used to be. The chain fell through to execution for
  // anything it did not have a branch for — which is exactly how `draft` used
  // to run as an implicit allow, before the case below existed (ADR-0022's
  // undo model landed after this file did). `Decision['effect']` is a closed
  // union, but a closed union is only as safe as its last consumer: nothing
  // stopped it from growing a fifth member with nobody touching this
  // function, and the chain would have handed that verdict the tool exactly
  // as it once handed `draft` the write. `assertNever` in `default` turns that
  // into a compile error the day the union grows, instead of a silent allow
  // the day someone forgets this file exists — the same guarantee
  // `core/policy/decide.ts`'s own `switch (decl.risk)` already gets for free
  // from its non-void return type; this one needs to say so, because `ask`'s
  // approved path does not return here, it falls through to execution below.
  switch (decision.effect) {
    case 'deny':
      span.end({ status: 'error', error: decision.code });
      return {
        type: 'tool_result',
        toolCallId: call.id,
        content: `Rifiutato dal kernel dei permessi (${decision.code}). Non insistere: serve una decisione dell'owner.`,
        isError: true,
      };
    case 'draft':
      // `draft` means "do it, but reversibly, and tell the owner". There is no
      // undo journal yet, so the honest reading is `ask`: executing it as an
      // allow was the kernel emitting a verdict nobody implemented, which is
      // worse than refusing — the caller had already decided the write was
      // reversible.
      span.end({ status: 'error', error: 'draft_unavailable' });
      return {
        type: 'tool_result',
        toolCallId: call.id,
        content:
          `"${capability}" richiede una bozza revocabile e il registro di undo non esiste ancora. ` +
          `Non eseguito: dillo all'owner invece di riprovare.`,
        isError: true,
      };
    case 'ask': {
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
      break; // approved: fall through to execution below, same as 'allow'
    }
    case 'allow':
      break;
    default:
      return assertNever(decision);
  }

  /**
   * Intent, written **before** the handler can touch the world.
   *
   * This is the half that does not exist today: the loop records the outcome
   * afterwards (the session append below), so an invocation that started and
   * died leaves no trace at all and a restart cannot tell "done" from "maybe
   * done". Two rows make three states — intent+outcome is *done*, intent alone
   * is *maybe done*, neither is *not started*.
   *
   * `rerunnable` is copied from the declaration as it reads right now, not
   * looked up at resume time: what the code says six months from now is not
   * what was true when the effect may have landed. Missing declarations answer
   * `false`, which is the direction that does not re-send a message.
   *
   * Written after the kernel has ruled, because a denied call never reaches the
   * world and an intent row for it would be a lie about what was attempted.
   */
  const decl = deps.capabilities?.get(capability);
  recordIntent(deps, ctx.turnId, span, {
    callId: call.id,
    tool: call.name,
    capability,
    rerunnable: decl?.rerunnable === true,
    args,
  });

  try {
    const outcome = await tool.handler(args, ctx);
    if (outcome.tier !== undefined) snapshot.raiseTaint(outcome.tier);
    // The outcome and the taint it dragged in, in one transaction: a tier-3
    // result raises the turn's taint, and the two facts must not be able to
    // land apart — a record that had read the web at a tier saying it had not
    // is the privilege escalation this table exists to prevent.
    recordOutcome(deps, ctx.turnId, span, call.id, {
      content: outcome.content,
      isError: outcome.isError === true,
      tier: outcome.tier,
    });
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
    // And an outcome all the same: a handler that threw *came back*, so the
    // call is decided, not uncertain. Leaving the intent row open here would
    // make every failed tool call look like one that might still have landed.
    recordOutcome(deps, ctx.turnId, span, call.id, { content: detail, isError: true, tier: undefined });
    span.end({ status: 'error', error: detail });
    return { type: 'tool_result', toolCallId: call.id, content: detail, isError: true };
  }
}

/**
 * The two record writes, with their failure swallowed for the same reason
 * `checkpoint` swallows its own: a tool that worked must not be turned into a
 * failed turn by a bookkeeping write. What a lost write costs is stated where
 * it lands — a missing intent row reads as "not started" (the resume calls the
 * handler again, which for a non-re-runnable tool is the very thing the row
 * exists to prevent), a missing outcome row reads as "maybe done" (the resume
 * is too careful, which is the harmless direction).
 */
function recordIntent(
  deps: LoopDeps,
  turnId: string,
  span: SpanHandle,
  call: { callId: string; tool: string; capability: string; rerunnable: boolean; args: unknown },
): void {
  try {
    deps.turns.startToolCall(turnId, call);
  } catch (error) {
    span.setAttributes({ 'muffin.turn.record_error': error instanceof Error ? error.message : String(error) });
  }
}

function recordOutcome(
  deps: LoopDeps,
  turnId: string,
  span: SpanHandle,
  callId: string,
  result: { content: string; isError: boolean; tier: TrustTier | undefined },
): void {
  try {
    deps.turns.endToolCall(turnId, callId, result);
  } catch (error) {
    span.setAttributes({ 'muffin.turn.record_error': error instanceof Error ? error.message : String(error) });
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
  /**
   * The plan, on every turn of the session, whether or not anyone asked.
   *
   * This is the read half of `todo`, and its placement is the decision: **not**
   * in `systemPrompts`, which is assembled once at boot and is the cacheable
   * prefix — a list that changes every turn would go in front of the stable
   * text and cost the warm prefix on every message, which is the mistake
   * `research/m3-caching-and-per-connector-timing.md` records the peers
   * avoiding. So it rides in the volatile tail, next to recalled memory, for
   * the same reason recall does.
   *
   * Unconditional, and that is the point: a plan the model has to remember to
   * ask for is a plan it forgets the moment its own earlier prose is compacted.
   */
  const plan = todoSection(deps.todos.open(input.tenant, input.session.id));

  // Recalled memory rides in the same turn as the message it is context for, not
  // as a separate user turn the model might answer. It is already fenced and
  // framed as low-authority context (renderForPrompt); here it simply precedes
  // the actual words.
  messages.push({
    role: 'user',
    content: [
      ...recalled,
      ...(plan === '' ? [] : [{ type: 'text' as const, text: plan }]),
      { type: 'text', text: input.text },
    ],
  });
  return messages;
}

/**
 * `from` is the turn's recorded taint, and it is a parameter rather than a
 * derivation for the reason ADR-0042 gives: a resume that rebuilt the taint
 * from the principal would restart at tier 0 a turn that had already
 * downloaded a web page — the fetch-then-act pattern the kernel exists to
 * close, reopened by a new door. On a fresh turn it equals what the old
 * derivation produced, which is exactly why deriving it looked safe for as long
 * as nothing resumed.
 */
function makeSnapshot(
  decide: Decide,
  principal: Principal,
  tenant: TenantId,
  from: TrustTier,
): PermissionSnapshot {
  // Taint starts from where the record says the turn had climbed to; on a turn
  // that has not started, that is who is speaking. From M2 the recall raises it
  // too, and a tool result raises it further — monotonically, never down.
  let taint: TrustTier = from;
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
