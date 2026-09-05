import { randomBytes } from 'node:crypto';
import { recall, recallTaint, renderForPrompt, type RecallDeps } from '../core/memory/recall.js';
import type { MemoryStore } from '../core/memory/store.js';
import type { Principal, TenantId } from '../core/policy/types.js';
import type { CapabilityId, Decision, DecisionRequest } from '../core/policy/types.js';
import type { SessionRef, SessionStore } from '../core/session/store.js';
import type { UndoJournal } from '../core/undo/journal.js';
import { CAPPED_MODEL, SCRIPT_MODEL } from '../core/turns/store.js';
import type { TurnCounters, TurnRecord, TurnStopped, TurnStore } from '../core/turns/store.js';
import { planTaint } from '../core/turns/todo.js';
import { decodeWaitFor, satisfied, wakeReport } from '../core/turns/wait.js';
import type { ApprovalStore } from '../core/approvals/store.js';
import type { SpanHandle, Tracer } from '../core/tracing/types.js';
import { ATTR } from '../core/tracing/types.js';
import { memoryWriteCapability } from '../core/policy/doors.js';
import { isSensitiveResourceName } from '../core/tracing/redact.js';
import { tenantClass, visibleTools } from './context/assemble.js';
import { historyTaint, reinjectedHistory } from './context/history-taint.js';
import { iterationCap, type Profile } from './profiles/profile.js';
import type { ContentBlock, Message } from './providers/types.js';
import { buildContext, primoMessaggio, userAudios, userImages } from './loop/context.js';
import { announceEnd, checkpoint, closeRecord, closeRow, finish, reconcile } from './loop/durability.js';
import { runRounds, type RoundScope } from './loop/round.js';
import { denyText, initialTaint, makeSnapshot, spendeIlBudget } from './loop/permissions.js';
import { TurnRun } from './loop/run-state.js';
import {
  assertNever,
  MAX_HISTORY_TURNS,
  MAX_RESUMES,
  MAX_TRANSPORT_RETRIES,
  type LoopDeps,
  type ResumeRefusal,
  type ResumeStream,
  type ToolContext,
  type TurnDelta,
  type TurnEvent,
  type TurnInput,
  type TurnResult,
} from './loop/types.js';

export {
  MAX_RESUMES,
  type ApprovalRequest,
  type ApprovalWhere,
  type Approver,
  type LoopDeps,
  type RegisteredTool,
  type ResumeRefusal,
  type ResumeStream,
  type SpendEntry,
  type ToolContext,
  type ToolOutcome,
  type TurnDelta,
  type TurnEvent,
  type TurnInput,
  type TurnResult,
} from './loop/types.js';
export { denyText } from './loop/permissions.js';

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
 * Write the row, and let something else run it.
 *
 * This is the whole of B2 — *"un turno lungo restituisce entro ~500 ms e
 * consegna dopo"* — and it is deliberately one write and no `await`. The
 * tempting cure for a connector that blocks is to drop the `await` on
 * `runTurn`, and the design measured what that costs: a turn **in flight and
 * unrecorded**, invisible to the gateway's drain, outside the single model
 * lane, and with the inbox's at-least-once guarantee detached
 * (`docs/evidence/turno-sospendibile.md` §B2). Every one of those three repairs is
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
    messages: [{ role: 'user', content: primoMessaggio(input) }],
    taint: initialTaint(input),
    counters: freshCounters(),
    // Sulla riga, non solo nell'input: vedi `TurnRecord.jobId`.
    ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
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
  const turn = deps.tracer.start(
    'muffin.turn',
    {
      [ATTR.principalKind]: input.principal.kind,
      [ATTR.tenant]: input.tenant,
      [ATTR.surface]: input.surface,
      [ATTR.requestModel]: deps.model,
    },
    // `SimpleTracer.start` takes `traceId = parent?.traceId ?? id(16)` — handing
    // it `remoteParent(input.id)` is the one existing lever that makes the
    // trace id (and so `record.id` below) exactly `input.id` instead of a
    // freshly minted one. Reused rather than duplicated: this is not a resume,
    // but the tracer does not need to know that, and `resumeTurn` already
    // established that a handle carrying only a `traceId` is enough. The one
    // cosmetic cost is `parentSpanId` reading as the marker id instead of
    // `null` on this turn's very first span, in the trace JSONL only.
    input.id === undefined ? undefined : remoteParent(input.id),
  );

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
    messages: [{ role: 'user', content: primoMessaggio(input) }],
    taint: initialTaint(input),
    counters: freshCounters(),
    // Sulla riga, non solo nell'input: vedi `TurnRecord.jobId`.
    ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
    ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
  });

  return drive(deps, record, turn, {
    session: input.session,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.replyChannel !== undefined ? { replyChannel: input.replyChannel } : {}),
    ...(input.onDelta ? { onDelta: input.onDelta } : {}),
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    ...(input.steer ? { steer: input.steer } : {}),
  });
}

/** Il testo del primo messaggio utente, per dire *quale* script era partito. */
function textOfFirstUserMessage(messages: Message[]): string | null {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    for (const b of m.content) {
      if (b.type === 'text' && b.text) return b.text;
    }
  }
  return null;
}

/**
 * Le parole dell'owner che, su questa riga, nessun modello vedrà mai.
 *
 * Il buco che chiude: `guidaIlTurno` parcheggia una correzione `/steer` nei
 * `messages` persistiti del turno quando si sospende, che è il posto giusto
 * finché quel turno si risveglia. Ma `resumeTurn` può **rifiutare** la
 * ripresa — `model_changed`, `resumes_exhausted` — e allora `closeRow` chiude
 * la riga: la correzione è conservata e irraggiungibile, che è lo stesso
 * difetto con un vestito migliore.
 *
 * Il criterio è esatto, non euristico: il modello ha visto tutto fino
 * all'ultimo messaggio dell'assistente, perché quel messaggio *è* la sua
 * risposta all'ultimo contesto che ha ricevuto. Ciò che sta dopo, e non è un
 * risultato di tool, non è mai arrivato a nessuna chiamata. Senza almeno un
 * messaggio dell'assistente il turno non è mai partito: lì non c'è niente di
 * «non visto», c'è solo la domanda dell'owner, e il rifiuto la nomina già.
 *
 * **Vanno all'owner, non nella sessione**, ed è una scelta con un motivo: dopo
 * l'ultimo messaggio dell'assistente possono esserci anche frasi che il loop
 * ha scritto da sé — il rapporto di risveglio, un passo di `recover` — e
 * `Message` non porta nessuna provenienza con cui distinguerle. Appenderle
 * alla sessione come parole dell'owner metterebbe frasi di Muffin in bocca a
 * lui, e una bugia di provenienza costa più di una riga persa. Dentro il
 * rifiuto sono il turno che riferisce: la corsia lo consegna già
 * (`agent/turn-lane.ts`), quindi l'owner le rilegge davvero e decide lui se
 * rimandarle.
 */
function messaggiMaiVisti(messages: Message[]): string[] {
  let ultimoAssistente = -1;
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role === 'assistant') ultimoAssistente = i;
  }
  if (ultimoAssistente < 0) return [];
  const fuori: string[] = [];
  for (const m of messages.slice(ultimoAssistente + 1)) {
    if (m.role !== 'user') continue;
    // Un messaggio di risultati di tool è la risposta del turno a sé stesso,
    // non parole di nessuno: il loop li spinge come **un** messaggio a parte.
    if (m.content.some((b) => b.type === 'tool_result')) continue;
    for (const b of m.content) {
      if (b.type === 'text' && b.text !== '') fuori.push(b.text);
    }
  }
  return fuori;
}

/** La coda che un rifiuto di ripresa aggiunge al suo `detail`. Vuota se non c'è niente. */
function codaMaiVista(record: TurnRecord): string {
  const fuori = messaggiMaiVisti(record.messages);
  if (fuori.length === 0) return '';
  return (
    `\n\nQuesto turno si portava dietro parole tue che il modello non ha mai visto — di solito una ` +
    `correzione \`/steer\` arrivata mentre si sospendeva. Su questa riga non arriveranno più a nessun ` +
    `modello, quindi te le rimetto qui: se servono ancora, rimandamele.\n\n` +
    fuori.map((testo) => `> ${testo}`).join('\n')
  );
}


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
  /**
   * The wiring `docs/evidence/forma-delle-superfici-2026-09-03.md` §4.3 found
   * missing: absent, a resumed turn streams nothing until it finishes, exactly
   * the "quella bolla lì" the owner is describing. Optional because not every
   * caller of `resumeTurn` has a live surface to attach — a headless retry, a
   * test — and an absent sink is silence, not an error.
   */
  stream?: ResumeStream,
): Promise<TurnResult | ResumeRefusal> {
  const existing = deps.turns.get(turnId);
  if (existing === null) {
    return { turnId, why: 'not_found', detail: `nessun turno ${turnId}` };
  }
  if (existing.status === 'done') {
    return { turnId, why: 'finished', detail: `il turno ${turnId} è già chiuso (${existing.outcome ?? '?'})` };
  }
  /**
   * Questo turno sta tornando da una sospensione?
   *
   * **Non lo dice lo stato.** Un turno svegliato da un *evento* — la lane che
   * chiama `wake` perché la barriera si è soddisfatta — arriva qui come
   * `runnable`, esattamente come uno che non ha mai aspettato: leggere solo lo
   * stato voleva dire che un `wait` finito per evento riprendeva **senza dire
   * al modello perché**, e con le approvazioni sarebbe stato lo stesso silenzio
   * proprio nel momento in cui l'owner ha appena risposto.
   *
   * Lo dice la barriera: se la riga ne porta ancora una, questa ripresa è la
   * sua. Vale una volta sola perché `claim`, subito qui sotto, la spegne.
   */
  const wasWaiting = existing.status === 'waiting' || existing.waitFor !== null || existing.wakeAt !== null;

  /**
   * Is this picking work **back** up, or running it for the first time?
   *
   * The distinction is the resume budget, and getting it wrong is expensive in
   * the quiet direction: a row `enqueueTurn` wrote (B2) has never executed, so
   * counting its first execution as a resume spends a third of `MAX_RESUMES`
   * before the turn has run once — and a turn that then legitimately waits
   * twice is refused as "already resumed three times and not closing".
   *
   * `contextBuilt` is the signal, not the status. A row woken from `waiting`
   * comes back as `runnable` (that is what `wake` writes), so status alone
   * cannot tell "enqueued and never run" from "suspended and now due". Having
   * built its context is exactly "this turn has already started".
   *
   * `interrupted` counts regardless, and that arm is what keeps the bound a
   * bound: a row that kills the process *during* its preamble never sets
   * `contextBuilt`, and without this it would be retried by every boot for ever
   * — which is the failure the counter exists for.
   */
  const firstAttempt = existing.status === 'runnable' && !existing.counters.contextBuilt;


  const record = deps.turns.claim(turnId, process.pid, (deps.now ?? (() => new Date()))());
  if (record === null) {
    // Not an error: two lanes over one database is the normal case for the
    // seconds a REPL and a gateway overlap, and the loser has nothing to do.
    return { turnId, why: 'claimed', detail: `il turno ${turnId} è stato preso da un altro processo` };
  }

  /**
   * Un turno che il modello non ha mai visto non si riprende col modello.
   *
   * Un job `script` scrive una riga in `turns` come qualsiasi altro lavoro —
   * è ciò che gli dà identità durevole — ma non c'è nessuna inferenza da
   * riprendere: la riga porta un comando, non una conversazione. Senza questa
   * guardia un crash a metà script finiva alla lane, che lo riprendeva
   * chiamando il modello con `script: echo …` come se fosse una richiesta
   * dell'owner: un costo, una risposta inventata, e consegnata.
   *
   * E non si riesegue nemmeno lo script. `sys.shell` dichiara
   * `rerunnable: false` perché un comando *"may have sent something, moved
   * something, or charged something"*: dopo un crash lo stato non è "non
   * fatto" né "fatto" ma **forse fatto**, ed è ciò che va detto invece di
   * scegliere una delle due e sbagliare a caso.
   */
  /**
   * Lo stesso principio, per l'altra riga che il modello non ha mai visto: un
   * giro di job rifiutato dal proprio tetto di spesa (`CAPPED_MODEL`).
   *
   * La finestra è stretta — `create` e `finish` sono due scritture sincrone
   * consecutive in `agent/scheduler-run.ts`, senza I/O in mezzo — ma se un
   * crash ci atterra la riga resta `running`, e senza questa guardia la lane
   * la riprenderebbe **chiamando il modello**: cioè spendendo esattamente i
   * soldi che il tetto aveva appena rifiutato. Il rifiuto si chiude, non si
   * riprende.
   */
  if (record.model === CAPPED_MODEL) {
    deps.turns.finish(
      record.id,
      { outcome: 'budget', messages: record.messages, taint: record.taint, counters: record.counters },
      record.claimToken,
    );
    return {
      turnId: record.id,
      traceId: record.id,
      stopped: 'budget',
      text: `Questo giro era già stato fermato dal tetto di spesa del job: non l'ho ripreso.`,
      taint: record.taint,
      iterations: 0,
      usage: record.counters.usage,
    };
  }
  if (record.model === SCRIPT_MODEL) {
    const comando = textOfFirstUserMessage(record.messages);
    const testo =
      `Un job script era partito quando il processo è morto, e non è ri-eseguibile: ` +
      `**non posso sapere se ha avuto effetto**. Non l'ho rifatto.` +
      (comando ? `\n\n${comando}` : '') +
      `\n\nControlla lo stato prima di rilanciarlo.`;
    deps.turns.finish(
      record.id,
      { outcome: 'error', messages: record.messages, taint: record.taint, counters: record.counters },
      record.claimToken,
    );
    return {
      turnId: record.id,
      traceId: record.id,
      stopped: 'error',
      text: testo,
      taint: record.taint,
      iterations: 0,
      usage: record.counters.usage,
    };
  }

  const span = deps.tracer.start(
    'muffin.turn',
    {
      [ATTR.principalKind]: record.principal.kind,
      [ATTR.tenant]: record.tenant,
      [ATTR.surface]: record.surface,
      [ATTR.requestModel]: record.model,
      [ATTR.turnId]: record.id,
      // What the counter will be after this attempt, so a trace of a first
      // execution reads 0 rather than claiming a resume that did not happen.
      [ATTR.turnResume]: record.counters.resumes + (spendeIlBudget(!firstAttempt, wasWaiting) ? 1 : 0),
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
      `non dà un errore — dà un agente peggiore in silenzio (ADR-0037).` +
      codaMaiVista(record);
    span.setAttributes({ 'muffin.turn.resume_refused': 'model_changed' });
    closeRow(deps, span, record, 'error', detail);
    span.end({ status: 'error', error: 'model_changed' });
    return { turnId, why: 'model_changed', detail };
  }

  if (record.counters.resumes >= MAX_RESUMES) {
    const detail =
      `il turno ${record.id.slice(0, 12)} è già stato ripreso ${record.counters.resumes} volte e non si chiude: ` +
      `mi fermo invece di riprovare all'infinito.` +
      codaMaiVista(record);
    span.setAttributes({ 'muffin.turn.resume_refused': 'exhausted' });
    closeRow(deps, span, record, 'error', detail);
    span.end({ status: 'error', error: 'resumes_exhausted' });
    return { turnId, why: 'exhausted', detail };
  }

  // La stessa stanza dove il turno era stato aperto, letta dal `replyTo`
  // durevole invece che da un chiamante che qui non esiste più: `runFresh`
  // (CLI e Telegram) scrive sempre `channel` dentro `replyTo` insieme a
  // `chatId`/`messageId`, proprio perché un giorno un resume ne avrebbe avuto
  // bisogno (`agent/turn-lane.ts`, commento su `LaneDeliver`). Un tool che
  // indirizza una consegna di metà turno (`send_file`) durante una ripresa
  // trova quindi la stessa stanza, non `undefined`.
  const replyChannelAlRisveglio =
    typeof record.replyTo?.['channel'] === 'string' ? (record.replyTo['channel'] as string) : undefined;

  return drive(deps, record, span, {
    resumed: !firstAttempt,
    wokenFromWait: wasWaiting,
    // La barriera letta **prima** del claim, che è ciò che la spegne. `record`
    // qui sotto è la riga già reclamata: chiederla a lui vorrebbe dire dire
    // sempre «è passato il tempo», anche quando a svegliare il turno è stata
    // una risposta dell'owner arrivata un istante fa.
    waitForAtWake: existing.waitFor,
    ...(replyChannelAlRisveglio === undefined ? {} : { replyChannel: replyChannelAlRisveglio }),
    // Il filo che `docs/evidence/forma-delle-superfici-2026-09-03.md` §4.3
    // trovava reciso: `drive` li accetta già da sempre (`options.onDelta`/
    // `options.onProgress` qui sotto), mancava solo chi li passasse fin qui.
    ...(stream?.onDelta ? { onDelta: stream.onDelta } : {}),
    ...(stream?.onProgress ? { onProgress: stream.onProgress } : {}),
    // Lo stesso filo, per `/stop` e `/steer` invece che per lo streaming —
    // vedi il commento su `ResumeStream` qui sopra. `drive` li legge già
    // (`options.signal`/`options.steer`); prima di questa riga nessuno li
    // passava fin qui per un turno ripreso dalla corsia.
    ...(stream?.signal ? { signal: stream.signal } : {}),
    ...(stream?.steer ? { steer: stream.steer } : {}),
  });
}

/**
 * The engine, over a row that is already claimed.
 *
 * One body for a fresh turn and for a resumed one, because two would drift and
 * the resumed one is the one nobody watches. What differs is only the *start
 * state*: a fresh turn assembles its context here, a resumed one restores it
 * from the record and repairs whatever the crash left half-said.
 */
/**
 * `DriveOptions` — estratto perché adesso lo condividono due funzioni: il
 * guardiano (`drive`) e il motore (`guidaIlTurno`). Vedi il commento su
 * `drive` per il perché di questa separazione (ADR-0054 §2, emendamento
 * 03/09c — l'imbuto).
 */
type DriveOptions = {
  signal?: AbortSignal | undefined;
  resumed?: boolean;
  wokenFromWait?: boolean;
  /** La barriera com'era prima del claim: vedi `resumeTurn`. */
  waitForAtWake?: string | null;
  /** The ref the caller already opened. Absent on a resume — see `input.session`. */
  session?: SessionRef | undefined;
  /**
   * The caller's `TurnInput.replyChannel`.
   *
   * Not persisted on `TurnRecord` as its own column — by design, per
   * `ToolContext.replyChannel`'s own docstring — but `runFresh` on both
   * surfaces already writes it *inside* `replyTo` (`{ chatId, messageId,
   * channel }`), so `resumeTurn` derives it from there rather than needing
   * a caller with a live stack. `runTurn` still passes its own live value
   * directly for a fresh turn; a resume reads the durable copy. `string |
   * undefined`, matching `TurnInput`'s own field exactly — `null` is
   * `ToolContext`'s vocabulary, applied once, where `toolContext` is built
   * below.
   */
  replyChannel?: string | undefined;
  /**
   * The surface's own live sink, when one is attached.
   *
   * Always present on a fresh turn (`runTurn`'s caller holds the surface
   * directly). On a resume it is present only when the caller of
   * `resumeTurn` built one — see `ResumeStream` and
   * `docs/evidence/forma-delle-superfici-2026-09-03.md` §4.3: a process
   * that picks a suspended turn back up (the gateway's lane) is not the
   * one that *received* the previous attempt's `onDelta`, but it can be
   * the one that opens a fresh sink addressed at the durable `replyTo` —
   * which is exactly what `agent/turn-lane.ts`'s `makeLaneRunner` now does
   * for Telegram. Still absent for a caller with no surface to attach (a
   * headless retry, a test), and that absence is silence, not a gap the
   * owner notices, because there was nothing streaming before either.
   */
  onDelta?: ((delta: TurnDelta) => void) | undefined;
  /** Same story as `onDelta`, immediately above. See `TurnInput.onProgress`. */
  onProgress?: ((event: TurnEvent) => void) | undefined;
  /**
   * Vivo solo su un turno fresco — a differenza di `onDelta`/`onProgress`
   * qui sopra, questo non ha un indirizzo durevole da cui ricostruirsi su
   * una ripresa: chi riprende un turno non ha la chat che lo corregge, solo
   * l'indirizzo dove mandare la risposta.
   */
  steer?: (() => string[]) | undefined;
};

/**
 * Le correzioni che nessun giro ha consumato, scritte in conversazione come
 * parole dell'owner (ADR-0054 §2, emendamento 03/09).
 *
 * Fuori da `drive`'s closure e non più dentro `guidaIlTurno`: è l'imbuto a
 * chiamarla, su ogni strada, e un solo chiamante è ciò che rende «una
 * correzione ha una provenienza sola» un fatto di forma invece che una
 * convenzione fra due copie.
 *
 * **Torna quelle che non è riuscita a scrivere** invece di ingoiare l'errore:
 * chi chiama deve poterlo dire all'owner. Fuori da qualunque `try` del
 * chiamante: una scrittura di sessione che fallisce non deve trasformare un
 * turno riuscito in un errore.
 */
function scriviCorrezioniInSessione(
  deps: LoopDeps,
  span: SpanHandle,
  session: SessionRef,
  record: TurnRecord,
  correzioni: readonly string[],
): string[] {
  const now = deps.now ?? (() => new Date());
  const nonScritte: string[] = [];
  for (const residua of correzioni) {
    try {
      deps.sessions.append(session, {
        role: 'user',
        content: residua,
        surface: record.surface,
        createdAt: now().toISOString(),
        traceId: span.traceId,
        // Parole dell'owner, come il messaggio che ha aperto il turno:
        // `record.taint` — lo stesso valore, e per la stessa ragione, che
        // l'append del messaggio utente nel preambolo usa al posto di
        // `initialTaint(input)` (che su un turno ripreso non vedrebbe
        // `contentTaint`). Mai il taint corrente del turno: la correzione è
        // testo dell'owner, non qualcosa che il turno ha derivato.
        tier: record.taint,
      });
    } catch (error) {
      span.setAttributes({ 'muffin.turn.steer_residuo_error': error instanceof Error ? error.message : String(error) });
      nonScritte.push(residua);
    }
  }
  return nonScritte;
}

/**
 * L'imbuto: **una** uscita sola per le correzioni dell'owner.
 *
 * L'invariante promessa all'owner è una riga: *una correzione `/steer` non si
 * perde mai e non arriva mai due volte*. Era stata riparata tre volte
 * aggiungendo un drain a un'uscita in più — la cima del giro, poi `finish`,
 * poi la sospensione — e ogni volta ne restava scoperta un'altra (il rethrow
 * del provider, per esempio, e una ripresa rifiutata). Enumerare le uscite non
 * converge: sono una lista che cresce con il codice.
 *
 * Quindi la garanzia non sta più su una lista di siti ma sulla **forma**: il
 * motore (`guidaIlTurno`) gira dentro questo guardiano, e può uscire soltanto
 * *tornando* o *lanciando*. Su entrambe le strade l'imbuto svuota la porta di
 * steer e scrive ciò che resta dove l'owner lo vede. Un'uscita aggiunta domani
 * dentro il motore passa di qui per costruzione, senza che nessuno se ne
 * ricordi.
 *
 * I drain già presenti nel motore **restano**, e solo dove piazzano la
 * correzione *meglio* di quanto farebbe l'imbuto:
 *
 *  - in cima al giro, che la fa vedere al modello di **questo** turno;
 *  - nella sospensione, che la mette nei `messages` persistiti del turno,
 *    così è quel turno a vederla al risveglio (`resumeTurn`/`codaMaiVista`
 *    coprono il caso in cui la ripresa è rifiutata).
 *
 * Sono sicuri esattamente perché la porta è **distruttiva** (`splice(0)` nel
 * connettore): un sito che ha già drenato lascia all'imbuto un no-op, quindi
 * «non si perde» e «non arriva due volte» sono la stessa proprietà e non due
 * in tensione — misurato, non assunto (`agent/steer-imbuto.test.ts` conta le
 * occorrenze su ogni strada).
 *
 * L'unica eccezione è deliberata: su `aborted` non si recupera niente, perché
 * l'owner ha detto `/stop`. L'imbuto la svuota e la butta — ripescarla sarebbe
 * l'opposto di ciò che ha chiesto — invece di saltare il drain, così la porta
 * è vuota su **ogni** strada e nessuno può ripescarla più tardi.
 */
async function drive(deps: LoopDeps, record: TurnRecord, turn: SpanHandle, options: DriveOptions = {}): Promise<TurnResult> {
  /**
   * La sessione risolta **una volta sola**, qui, e passata al motore.
   *
   * L'imbuto deve poter scrivere in conversazione anche quando il motore è
   * uscito lanciando, cioè senza aver restituito niente da cui dedurre dove
   * scrivere. Risolverla due volte (una qui e una dentro) vorrebbe dire due
   * `open` per lo stesso turno; risolverla qui e passarla giù ne lascia una.
   */
  const session = options.session ?? deps.sessions.open(record.sessionId);
  /**
   * Le correzioni che il motore ha già tolto dalla porta ma non è riuscito a
   * mettere da nessuna parte — oggi solo il ramo che fallisce la scrittura di
   * sospensione. Le rende all'imbuto invece di scriverle da sé, così **un
   * solo** punto in tutto il file parla alla conversazione, ed è lo stesso
   * punto che sa dirlo all'owner quando la scrittura fallisce.
   */
  const recupero: string[] = [];
  const opzioni: DriveOptions = { ...options, session };

  /**
   * Ciò che resta da salvare quando il motore ha finito, su qualunque strada.
   * `recupero` per primo: è uscito dalla porta prima di ciò che l'imbuto trova
   * ancora dentro.
   */
  const residue = (): string[] => [...recupero.splice(0), ...(options.steer?.() ?? [])];

  let risultato: TurnResult;
  try {
    risultato = await guidaIlTurno(deps, record, turn, opzioni, recupero);
  } catch (error) {
    // Il rethrow: il provider ha esaurito i ritentativi, `finish` non viene
    // mai raggiunto e il `finally` del connettore sta per cancellare la voce
    // `vivi` con dentro la correzione. Qui la correzione esce dalla porta e
    // entra in conversazione, da dove la prende il turno dopo. Non c'è nessun
    // testo di turno su cui appoggiare un avviso — il turno sta lanciando —
    // quindi un fallimento di scrittura resta sullo span e basta: è l'unico
    // caso in cui l'owner non può essere avvisato dal turno stesso, perché il
    // turno non ha più una voce.
    scriviCorrezioniInSessione(deps, turn, session, record, residue());
    throw error;
  }

  // `aborted`: svuotata e buttata, di proposito. Vedi il commento sul tipo.
  if (risultato.stopped === 'aborted') {
    residue();
    return risultato;
  }

  const nonScritte = scriviCorrezioniInSessione(deps, turn, session, record, residue());
  if (nonScritte.length === 0) return risultato;
  /**
   * Una scrittura fallita **non è silenziosa**.
   *
   * Prima finiva su un attributo di span: l'owner restava con un «ricevuto»
   * che nessuno aveva onorato, e nessun modo di saperlo. Il canale onesto è il
   * testo del turno stesso — lo stesso che si usa quando non riesce a salvare
   * lo stato di una sospensione — e costa una frase solo nel turno in cui la
   * scrittura è davvero fallita: gli altri non diventano un rapporto.
   *
   * Non su `suspended`: quel risultato non ha testo e la corsia non lo
   * consegna (`agent/turn-lane.ts`), quindi appenderci una frase parlerebbe a
   * nessuno.
   */
  if (risultato.stopped === 'suspended') return risultato;
  const avviso =
    "Non sono riuscito a salvare la correzione che mi hai mandato mentre rispondevo, " +
    "quindi al prossimo turno non ce l'avrò: rimandamela.\n\n" +
    nonScritte.map((testo) => `> ${testo}`).join('\n');
  return { ...risultato, text: risultato.text === '' ? avviso : `${risultato.text}\n\n${avviso}` };
}

/**
 * The engine, over a row that is already claimed.
 *
 * One body for a fresh turn and for a resumed one, because two would drift and
 * the resumed one is the one nobody watches. What differs is only the *start
 * state*: a fresh turn assembles its context here, a resumed one restores it
 * from the record and repairs whatever the crash left half-said.
 *
 * Non si chiama mai direttamente: si entra da `drive`, che è l'imbuto — vedi
 * il suo commento.
 */
async function guidaIlTurno(
  deps: LoopDeps,
  record: TurnRecord,
  turn: SpanHandle,
  options: DriveOptions,
  /** Ciò che è già uscito dalla porta di steer e non ha trovato una riga (vedi `drive`). */
  recupero: string[],
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
    // Riprese **dal record**, esattamente come il testo qui sopra, e per la
    // stessa ragione: `drive` non riceve il `TurnInput` originale — lo
    // ricostruisce — quindi tutto cio' che il modello deve vedere deve essere
    // passato dal record. Metterle solo nel `TurnInput` di `runTurn` le faceva
    // sparire fra le due funzioni, senza errori: il modello rispondeva «non
    // vedo nessuna immagine» a una domanda su una foto arrivata davvero
    // (misurato contro il modello vero il 28/08/2026). Passare dal record e'
    // anche cio' che fa sopravvivere l'immagine a una ripresa dopo un crash.
    ...(userImages(record.messages).length > 0 ? { images: userImages(record.messages) } : {}),
    // Stessa strada delle immagini, e non per simmetria: e' la riga che quel
    // commento qui sopra dice di non dimenticare. Un audio passato solo nel
    // `TurnInput` di `runTurn` sparirebbe fra le due funzioni senza un errore,
    // e il modello risponderebbe a una nota vocale che non ha mai sentito.
    ...(userAudios(record.messages).length > 0 ? { audios: userAudios(record.messages) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    // **Dal record**, come il testo e le immagini qui sopra, e non dal
    // `TurnInput` di `runTurn`: `drive` ricostruisce l'input, quindi un
    // `jobId` passato solo là sparirebbe qui in silenzio — e le righe di
    // `spend` di questo turno non apparterrebbero a nessun job. È il guasto
    // che il test «la spesa di un giro di job finisce nel registro attribuita
    // a QUEL job» ha misurato prima che questa riga esistesse; passare dal
    // record è anche ciò che fa sopravvivere l'attribuzione a una ripresa.
    ...(record.jobId === null ? {} : { jobId: record.jobId }),
    ...(record.replyTo === null ? {} : { replyTo: record.replyTo }),
    ...(options.replyChannel !== undefined ? { replyChannel: options.replyChannel } : {}),
    ...(options.onDelta ? { onDelta: options.onDelta } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.steer ? { steer: options.steer } : {}),
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
  // La prima cosa entrata in questo turno: le parole della persona. Un URL che
  // l'owner incolla lui stesso non è «scelto dal modello», ed è il caso più
  // ovvio che il gate sui parametri trattava come tale.
  snapshot.recordInput(input.text);
  const turnClass = tenantClass(input.principal, input.tenant);

  /**
   * The two doors the turn walks through without a tool — the reply and the
   * episode — asked of the kernel the same way a tool call is (ADR-0055).
   *
   * Same span name and attributes as `runTool`'s decision below, so a trace
   * reader sees one vocabulary: `muffin.policy_decision` with the capability,
   * the taint it was decided at, and the effect. The shipped floor answers
   * `allow` on both rows at every taint, and the memoised `check` makes the
   * per-round question free; what this buys is a decision that *exists* — a
   * sealed policy.json that tightens the row is obeyed, and the eval seam can
   * put a sink scene on a capability production really declares.
   */
  const door = (capability: CapabilityId, resource: DecisionRequest['resource']): Decision => {
    const span = deps.tracer.start(
      'muffin.policy_decision',
      { [ATTR.capability]: capability, [ATTR.taint]: snapshot.currentTaint() },
      turn,
    );
    const decision = snapshot.check(capability, resource, {});
    span.setAttributes({
      [ATTR.policyEffect]: decision.effect,
      ...(decision.effect === 'deny' ? { [ATTR.policyDenyCode]: decision.code } : {}),
    });
    span.end();
    return decision;
  };
  /**
   * Open, or the refusal that closed it — a `switch` over the closed union,
   * with `assertNever` in `default`, exactly like `runTool`'s.
   *
   * Anything but `allow` is a no: neither `draft` nor `ask` has a meaning on
   * these two rows (see `doors.ts`), so both refuse. What the `switch` buys
   * over `decision.effect !== 'allow'` is the fifth verdict: an inequality
   * treats a variant nobody wrote a branch for as a refusal and carries on,
   * which is the same silent fall-through — one sign flipped — that let
   * `draft` run as an implicit allow for a year. Here it breaks the build the
   * day the union grows, and throws if a value ever reaches it having
   * bypassed the type checker.
   */
  const doorRefusal = (decision: Decision): Exclude<Decision, { effect: 'allow' }> | undefined => {
    switch (decision.effect) {
      case 'allow':
        return undefined;
      case 'deny':
      case 'ask':
      case 'draft':
        return decision;
      default:
        return assertNever(decision);
    }
  };
  /** What a refusal is called on a span: the deny code when there is one, the verdict otherwise. */
  const refusalLabel = (refusal: Exclude<Decision, { effect: 'allow' }>): string =>
    refusal.effect === 'deny' ? refusal.code : refusal.effect;
  /**
   * May this turn write an episode into its tenant's memory right now?
   *
   * The refusal is counted on the turn, not swallowed: an episode that was
   * not written is a fact about this turn a reader of the trace must be able
   * to see.
   */
  const memoryDoorOpen = (): boolean => {
    const refusal = doorRefusal(door(memoryWriteCapability.id, { kind: 'tenant', value: input.tenant }));
    if (refusal === undefined) return true;
    turn.setAttributes({ 'muffin.memory.write_refused': refusalLabel(refusal) });
    return false;
  };

  /**
   * Tutto cio' che cambia dentro questo turno, in un oggetto solo.
   *
   * Era una dozzina di `let` tenuti insieme dalla chiusura di questa funzione;
   * e' un oggetto perche' le prossime fette portano `checkpoint`/`suspendHere`
   * e il corpo di giro **fuori** da qui, e una chiusura non attraversa un
   * confine di modulo — una firma a dieci parametri si', ed e' il posto dove
   * si scambia un contatore con un altro senza che niente diventi rosso.
   *
   * Le garanzie (`resumes` in sola lettura, `counters()` che copia,
   * `contextBuilt` che viene dai contatori e non dallo status) stanno su
   * `agent/loop/run-state.ts`, dove il test gemello le misura.
   */
  const run = new TurnRun(record, {
    resumed: options.resumed === true,
    wokenFromWait: options.wokenFromWait === true,
  });
  const cap = iterationCap(deps.profile);

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
    taint: () => snapshot.currentTaint(),
    intrinsicTaint: () => snapshot.intrinsicTaint(),
    suspend: (spec) => {
      run.barrier = spec;
    },
    // `input.replyChannel` threaded through, per `ToolContext.replyChannel`'s
    // own docstring: the one field `send_file` (DAY-1 requirement B14) reads, absent
    // everywhere else.
    replyChannel: input.replyChannel ?? null,
  };

  /**
   * Tool names whose single argument (`path` or `url`) names one resource
   * and whose successful result *is* that resource's content — as opposed to
   * `fs_write` (same `path` shape, opposite direction: nothing to echo from
   * an argument the tool never reads back) or `fs_search`/`web_search` (many
   * results, no single resource this call named).
   */
  const RESOURCE_READ_TOOLS = new Set(['fs_read', 'http_get', 'document_read', 'skill_read']);
  const noteSensitiveResourceEcho = (call: { name: string; args: unknown }, outcome: ContentBlock): void => {
    if (!RESOURCE_READ_TOOLS.has(call.name)) return;
    if (outcome.type !== 'tool_result' || outcome.isError) return;
    const args = (call.args ?? {}) as Record<string, unknown>;
    const resourceId = typeof args.path === 'string' ? args.path : typeof args.url === 'string' ? args.url : undefined;
    if (resourceId === undefined || !isSensitiveResourceName(resourceId)) return;
    if (typeof outcome.content === 'string') run.sensitiveResourceEchoes.push(outcome.content);
  };

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

  /**
   * Ciò che le scritture durevoli e il corpo del giro leggevano per chiusura,
   * in un valore solo.
   *
   * `checkpoint`, `suspendHere`, `reconcile`, `closeRecord`, `announceEnd` e
   * `finish` vivono in `agent/loop/durability.ts`; `runRounds` e `recover` in
   * `agent/loop/round.ts`. Nessuno dei due vede più questa funzione: ricevono
   * questo oggetto. Nulla qui è copiato — `run` è lo stesso `TurnRun` che il
   * corpo del giro muta, `recupero` lo stesso array che `drive` svuota —
   * perché il punto è che le due metà restino la stessa cosa.
   *
   * Un oggetto solo, non due: `RoundScope` **estende** `TurnScope` con i sette
   * binding che il pre-loop risolve e che solo il giro legge, così la porta di
   * risposta che il giro chiede e la riga che `finish` scrive non possono
   * guardare due copie diverse dello stesso turno.
   */
  const scope: RoundScope = {
    deps,
    record,
    turn,
    input,
    run,
    snapshot,
    recupero,
    exposed,
    toolContext,
    noteSensitiveResourceEcho,
    cap,
    turnClass,
    now,
    door,
    doorRefusal,
    refusalLabel,
    memoryDoorOpen,
  };

  if (!run.contextBuilt) {
    /**
     * La finestra di history, letta **prima** del recall e non dopo.
     *
     * E lo stesso taglio che `buildContext` renderizza piu sotto — calcolato
     * una volta sola perche i due non possano mai dissentire su cosa voglia
     * dire "reinjected" (`agent/context/history-taint.ts`). Sale qui, e non
     * cambia di contenuto salendo: la riga dell owner di questo turno viene
     * appesa alla sessione piu sotto, quindi `spoken` non l ha mai vista.
     *
     * Cosa ci guadagna il recall: i `traceId` che questa finestra porta sono
     * esattamente i turni che il modello ha gia davanti, e sono cio che il
     * recall deve smettere di ripescare.
     */
    const spoken = reinjectedHistory(deps.sessions.read(input.session), MAX_HISTORY_TURNS);
    /**
     * I turni gia nel contesto: quelli della finestra, piu **questo**.
     *
     * `record.id` e nell elenco perche gli episodi di questo turno sono gia
     * scritti quando il recall gira — quello dell owner un attimo fa, e al
     * resume anche quello dell agente. Ripescarli sarebbe far rileggere al
     * modello cio che ha appena detto come se qualcun altro l avesse
     * confermato.
     */
    const turniInContesto = [
      record.id,
      ...spoken.kept.map((m) => m.traceId).filter((id): id is string => id !== undefined),
    ];

    // Evidence first: what was said is recorded before anything is generated, so
    // a crash mid-turn cannot lose the input that caused it.
    let currentEpisodeId: number | undefined;
    if (deps.memory && memoryDoorOpen()) {
      currentEpisodeId = deps.memory.store.addEpisode({
        tenantId: input.tenant,
        connector: input.surface,
        threadKey: input.session.id,
        role: 'user',
        kind: 'message',
        content: input.text,
        // `record.taint`, not `initialTaint(input)`: the `input` in scope
        // here is `drive`'s own reconstruction from `record` a few dozen
        // lines up, which has no `contentTaint` to read (resume has none to
        // reconstruct, so it is not carried). `record.taint` is the value
        // `enqueueTurn`/`runTurn` already computed with `initialTaint` at
        // creation — a forwarded message's episode is the exact "enters
        // memory at the owner's tier" step the audit named (DAY-1 requirement B16), and
        // this is the row this slice exists to stop writing at tier 0 for
        // content nobody at tier 0 actually said.
        trustTier: record.taint,
        createdAt: now().toISOString(),
        // Il turno che l ha prodotto — lo stesso valore che la history porta
        // come `traceId`, cosi "l ho gia davanti" e un confronto di identita e
        // non di testo.
        turnId: record.id,
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
          {
            excludeTurnIds: turniInContesto,
            // Tenuto accanto al lineage e non sostituito da lui: e la garanzia
            // che non dipende dalla colonna nuova, quindi vale anche su una
            // riga che il lineage non ce l ha.
            ...(currentEpisodeId !== undefined ? { excludeEpisodeId: currentEpisodeId } : {}),
          },
        );
        const inherited = recallTaint(result);
        snapshot.raiseTaint(inherited);
        recallSpan.setAttributes({
          'muffin.memory.items': result.items.length,
          'muffin.memory.strategies': result.strategies.join(','),
          [ATTR.taint]: inherited,
          // Il reranker chiama il modello dentro questo span, e fino a qui non
          // compariva da nessuna parte: un recall lento si leggeva come un
          // recall lento, mai come «dentro c'è un giro di modello». Sale col
          // risultato invece che da un tracer perché `recall()` non ne ha uno,
          // e darglielo sarebbe plumbing attraverso quattro file per un numero.
          ...(result.rerankUsage === undefined
            ? {}
            : {
                [ATTR.usageInputTokens]: result.rerankUsage.inputTokens,
                [ATTR.usageOutputTokens]: result.rerankUsage.outputTokens,
                [ATTR.cacheReadTokens]: result.rerankUsage.cacheReadTokens,
              }),
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

    /**
     * The plan, and the taint that comes with it — in that order.
     *
     * `raiseCeiling` **before** the rows reach the transcript, because the
     * whole property is that the turn is *decided* at the tier of everything in
     * its context — a plan written by a turn that had read the web is model
     * text shaped by that page, and this turn may not act as if it were not.
     *
     * `raiseCeiling`, not `raiseTaint` (ADR-0044 §Riconciliazione 2026-08-28):
     * the plan item is *this turn's own reinjected past*, not something this
     * turn did. Stamping this turn's own fresh output at the plan's inherited
     * tier is what kept a session dirty long after the item that dirtied it —
     * every clean answer re-poisoning the window it was meant to age out of.
     */
    const open = deps.todos.open(input.tenant, input.session.id);
    snapshot.raiseCeiling(planTaint(open));

    /**
     * The session transcript, and the taint that comes with it — same order,
     * same reason, one line down from the plan above (ADR-0044 §Revisione,
     * "la history non lava la provenienza"; a DAY-1 readiness invariant).
     *
     * `reinjectedHistory` is the same cut `buildContext` renders — computed
     * once here so the two can never disagree about what "reinjected" means
     * (`agent/context/history-taint.ts`'s own docstring). `taintForIds` is one
     * query for every `traceId` this window carries, not one per message: a
     * long session can hand this dozens of rows to resolve.
     *
     * `raiseCeiling`, same reasoning as the plan above, and the exact gap the
     * 17/08 revision's own "Cosa NON copre" named and left open: without it, a
     * clean turn two messages after a `fs_read` was still marked as tainted as
     * the read that never aged out of the window, because every turn's own
     * reply re-entered as new history at the tier it had merely *inherited*.
     * The 17/08 fix stays — a turn sitting on tainted reinjected history still
     * cannot act as if it were clean, `currentTaint()` still says so to every
     * `check()` below — only the *stamp this turn leaves for the next one* no
     * longer inherits a tier this turn did not itself produce.
     */
    const traceIdsInWindow = spoken.kept.map((m) => m.traceId).filter((id): id is string => id !== undefined);
    const taintByTrace = deps.turns.taintForIds(traceIdsInWindow);
    snapshot.raiseCeiling(historyTaint(spoken.kept, taintByTrace));

    /**
     * D11's other half: which turns in this window `muffin undo` has already
     * put back. Resolved through the same `traceId` join as `taintByTrace`
     * immediately above, one query for the whole window, and read by
     * `buildContext` so a turn re-reading its own past does not believe an
     * effect that is no longer on disk (`docs/work/day1/critical-path.md`
     * §"Chiudere la compensazione, non solo il restore").
     */
    const undoneTraceIds = deps.turns.undoneTraceIds(traceIdsInWindow);

    run.messages.length = 0;
    run.messages.push(
      ...buildContext(
        input,
        recalled,
        open,
        spoken,
        now(),
        deps.model,
        deps.profile.name,
        deps.istanza?.(),
        deps.timeZone,
        undoneTraceIds,
      ),
    );

    // `record.taint`, the same substitution and for the same reason as the
    // episode write above: `initialTaint(input)` here would read `drive`'s
    // own reconstructed `input`, which never carries `contentTaint`.
    // `record.taint` is what `enqueueTurn`/`runTurn` already computed with
    // `initialTaint` at creation — never a literal 0 that would make a group
    // turn's own user line, or a forwarded message's (DAY-1 requirement B16), read as
    // clean once a later turn in the same conversation reinjects it
    // (`agent/context/history-taint.ts`, ADR-0044 §"la history non lava la
    // provenienza").
    deps.sessions.append(input.session, {
      role: 'user',
      content: input.text,
      surface: input.surface,
      createdAt: now().toISOString(),
      traceId: turn.traceId,
      tier: record.taint,
    });
    // Marked before the first model call, so a crash inside recall replays the
    // preamble (one duplicated episode, absorbed by consolidation) while a
    // crash anywhere after it does not. The window is the microseconds between
    // two synchronous SQLite writes.
    run.contextBuilt = true;
    // Lost the claim before the turn even got going — reachable only if
    // `resumeTurn`'s own `claim()` won a row a steal then immediately took
    // back, a vanishingly narrow window. `finish` re-attempts its own fenced
    // write, finds the same fencing failure, and returns the honest
    // lost-claim result without pretending anything was said.
    if (!checkpoint(scope)) return finish(scope, 'error', '');
  } else if (options.resumed === true) {
    // A resumed turn re-enters a transcript that a crash may have left with a
    // question and no answer. Repairing it is not optional: a `tool_use` block
    // without its `tool_result` is a malformed request, and the provider says
    // so on the very first call.
    const lostClaim = await reconcile(scope);
    if (lostClaim !== null) return lostClaim;
    if (options.wokenFromWait === true) {
      const waitFor = decodeWaitFor(options.waitForAtWake ?? record.waitFor);
      // Lo stesso giudizio che dà la lane quando sceglie chi svegliare, con lo
      // stesso registro sotto: senza `answered` una barriera d'approvazione
      // risulterebbe non soddisfatta qui, e il turno si risveglierebbe con
      // «non hai risposto» proprio nel momento in cui la risposta è arrivata.
      const why =
        waitFor !== null &&
        satisfied(waitFor, {
          ...(deps.approvals === undefined ? {} : { answered: (id: string) => deps.approvals?.answered(id) === true }),
        })
          ? 'event'
          : 'timer';
      turn.setAttributes({ 'muffin.turn.woken_by': why });
      run.messages.push({ role: 'user', content: [{ type: 'text', text: wakeReport(waitFor, why) }] });
    }
  }

  try {
    return await runRounds(scope);
  } catch (error) {
    turn.end({ error });
    // Same reason `announceEnd` is repeated here: a provider that exhausted its
    // retries never reaches `finish`, and a row left `running` by a turn that
    // is definitely over would be reclaimed as *interrupted* — "we do not know
    // whether it ran" — when we know exactly how it ended.
    closeRecord(scope, 'error');
    // A turn that threw still recorded the owner's words at the top of this
    // function, so they are still owed extraction. Announced here as well as in
    // `finish` because a provider that exhausted its retries never reaches
    // `finish` at all, and "the memory lane starts only when the model behaves"
    // is not a property anyone would have chosen.
    announceEnd(scope, 'error');
    throw error;
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

