import { randomBytes } from 'node:crypto';
import type { SessionRef } from '../../core/session/store.js';
import type { SpanHandle } from '../../core/tracing/types.js';
import { ATTR } from '../../core/tracing/types.js';
import { CAPPED_MODEL, SCRIPT_MODEL } from '../../core/turns/store.js';
import type { TurnCounters, TurnRecord } from '../../core/turns/store.js';
import type { Message } from '../providers/types.js';
import { buildFreshCounters, evidenceForContinuation } from './continuation.js';
import { primoMessaggio } from './context.js';
import { closeRow } from './durability.js';
import { type DriveOptions, guidaIlTurno } from './engine.js';
import { ownerMessage } from './message-origin.js';
import { initialTaint, spendeIlBudget } from './permissions.js';
import { providerMessages } from './provider-checkpoint.js';
import {
  MAX_RESUMES,
  MAX_TRANSPORT_RETRIES,
  type LoopDeps,
  type ResumeRefusal,
  type ResumeStream,
  type TurnInput,
  type TurnResult,
} from './types.js';

/**
 * The ways in, and the funnel every one of them leaves through.
 *
 * Three doors — `enqueueTurn` writes a row and returns, `runTurn` opens one and
 * runs it, `resumeTurn` picks an existing one back up — plus the terminal
 * refusals that belong to the third, and `drive()`: the guardian that the
 * engine (`agent/loop/engine.ts`) runs inside.
 *
 * `drive()` is the shape the `/steer` invariant rests on, and it is why this
 * file exists apart from the engine. *A correction is never lost and never
 * arrives twice* used to be repaired by adding one more drain at one more exit,
 * and the list of exits grows with the code. Here the engine can only leave by
 * **returning** or by **throwing**, and both roads pass `scriviCorrezioniInSessione`
 * — so an exit somebody adds inside the engine tomorrow is covered by
 * construction rather than by remembering. `finish()` deliberately does not
 * drain: it is one of the engine's return paths, and draining there would put
 * the same correction into the session twice on the roads that already have a
 * better place for it (`agent/steer-imbuto.test.ts` counts the occurrences on
 * every road).
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
  deps.prepareTurn?.();
  const id = randomBytes(16).toString('hex');
  deps.turns.enqueue({
    id,
    principal: input.principal,
    tenant: input.tenant,
    surface: input.surface,
    sessionId: input.session.id,
    inputText: input.text,
    providerLease: { model: deps.model, checkpoint: [ownerMessage(primoMessaggio(input))] },
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
    truncationsUsed: 0,
    toolCallsMade: 0,
    nudgedForCompletion: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    spentUsd: 0,
    resumes: 0,
    contextBuilt: false,
    activeModelMs: 0,
  };
}

/** Freeze model-facing runtime facts with the provider/model/profile snapshot. */
function snapshotTurnDeps(deps: LoopDeps): LoopDeps {
  const profile = { ...deps.profile };
  return {
    ...deps,
    profile,
    ...(deps.runtimeInfo === undefined
      ? {}
      : { runtimeInfo: { ...deps.runtimeInfo, profile } }),
  };
}

export async function runTurn(deps: LoopDeps, input: TurnInput): Promise<TurnResult> {
  deps.prepareTurn?.();
  // Provider/model/profile are one per-turn snapshot. Runtime refreshes may
  // replace them for the next turn, but never move a retry or later round.
  deps = snapshotTurnDeps(deps);
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
    inputText: input.text,
    // Pinned here and never re-derived: a resume onto a different model sends
    // back thinking signatures it cannot read, and ADR-0037 records that this
    // fails silently rather than loudly.
    providerLease: { model: deps.model, checkpoint: [ownerMessage(primoMessaggio(input))] },
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
  const fuori = messaggiMaiVisti(providerMessages(record));
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
  deps.prepareTurn?.();
  deps = snapshotTurnDeps(deps);
  const existing = deps.turns.get(turnId);
  if (existing === null) {
    return { turnId, why: 'not_found', detail: `nessun turno ${turnId}` };
  }
  if (existing.status === 'done') {
    return { turnId, why: 'finished', detail: `il turno ${turnId} è già chiuso (${existing.outcome ?? '?'})` };
  }
  /**
   * A continuable row is not resumed — it is continued, which is a different
   * primitive (`continueTurn` below): a new execution lease with fresh
   * budgets, not a crash/wait recovery of the current one. Routing a
   * continuable row through `resumeTurn` would inherit spent recovery
   * budgets and skip the owner-grant accounting. Refused loudly, row left
   * intact for the real primitive.
   */
  if (existing.status === 'continuable') {
    return {
      turnId,
      why: 'continuable',
      detail:
        `il turno ${turnId} ha una lease esaurita ma il lavoro è continuabile ` +
        `(${existing.continuableReason?.class ?? 'motivo ignoto'}): non si riprende, si continua ` +
        `con una nuova lease esplicita (messaggio "riprendi" o \`muffin resume ${turnId.slice(0, 12)}\`)`,
    };
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
  if (firstAttempt && existing.providerLease.model !== deps.model) {
    // No provider state exists yet to resume. Move only this untouched queued
    // row to the model selected at the turn boundary; suspended/started rows
    // stay pinned and are refused below if their model differs.
    deps.turns.reassignUnstartedModel(turnId, existing.providerLease.model, deps.model);
  }

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
  if (record.providerLease.model === CAPPED_MODEL) {
    deps.turns.finish(
      record.id,
      { outcome: 'budget', messages: providerMessages(record), taint: record.taint, counters: record.counters },
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
  if (record.providerLease.model === SCRIPT_MODEL) {
    const comando = textOfFirstUserMessage(providerMessages(record));
    const testo =
      `Un job script era partito quando il processo è morto, e non è ri-eseguibile: ` +
      `**non posso sapere se ha avuto effetto**. Non l'ho rifatto.` +
      (comando ? `\n\n${comando}` : '') +
      `\n\nControlla lo stato prima di rilanciarlo.`;
    deps.turns.finish(
      record.id,
      { outcome: 'error', messages: providerMessages(record), taint: record.taint, counters: record.counters },
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
      [ATTR.requestModel]: record.providerLease.model,
      [ATTR.turnId]: record.id,
      'muffin.turn.lease': record.leaseIndex,
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

  if (record.providerLease.model !== deps.model) {
    // Explicit, and terminal. Retrying would mean a row that wakes every boot
    // to be refused again, which is the silent-forever failure this whole
    // record was built to stop producing.
    const detail =
      `il turno ${record.id.slice(0, 12)} è stato aperto su ${record.providerLease.model} e adesso il modello è ${deps.model}: ` +
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
 * Why a continuation could not be granted. Never a throw: the caller has to
 * be able to say so, and the row is always left intact for another attempt.
 */
export type ContinuationRefusal = {
  turnId: string;
  why: 'not_found' | 'not_continuable' | 'claimed' | 'model_changed' | 'unstarted';
  detail: string;
};

function ownerMessageText(message: Message): string {
  return message.content
    .filter((b): b is Extract<(typeof message.content)[number], { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * Continue a continuable turn on an explicit grant: the one
 * surface-independent primitive for minting the next execution lease.
 *
 * Grant (filtered evidence + the grant message + fresh lease-local budgets,
 * persisted atomically by the store) then `drive` on the claimed row — the
 * same funnel every other entry uses, so `/steer` corrections landing
 * mid-lease behave identically. Crash/wait recovery stays in `resumeTurn`;
 * the two never share a path, which is what keeps a continuation from
 * inheriting spent budgets and a resume from minting leases.
 *
 * The grant message is the owner's actual words on the conversational path,
 * or the harness-marked resume marker on the explicit-command path — either
 * way appended to the durable transcript (so the model sees why it is back)
 * and to the session (so the conversation record stays complete). Failure
 * diagnostics are never appended: execution truth travels structurally, on
 * the row and in the delivered text, not as something Muffin supposedly
 * said.
 */
export async function continueTurn(
  deps: LoopDeps,
  turnId: string,
  opts: {
    message: Message;
    session?: SessionRef;
    signal?: AbortSignal;
    steer?: () => string[];
    onDelta?: (delta: import('./types.js').TurnDelta) => void;
    onProgress?: (event: import('./types.js').TurnEvent) => void;
    replyChannel?: string;
  },
): Promise<TurnResult | ContinuationRefusal> {
  deps.prepareTurn?.();
  deps = snapshotTurnDeps(deps);
  const now = deps.now ?? (() => new Date());
  const existing = deps.turns.get(turnId);
  if (existing === null) {
    return { turnId, why: 'not_found', detail: `nessun turno ${turnId}` };
  }
  if (existing.status !== 'continuable') {
    return {
      turnId,
      why: 'not_continuable',
      detail: `il turno ${turnId} non è continuabile (stato ${existing.status})`,
    };
  }
  if (existing.providerLease.model !== deps.model) {
    return {
      turnId,
      why: 'model_changed',
      detail:
        `il turno ${turnId.slice(0, 12)} è stato aperto su ${existing.providerLease.model} e adesso il modello è ${deps.model}: ` +
        `non è una continuazione. La riga resta continuabile per il modello originale.`,
    };
  }
  if (!existing.counters.contextBuilt) {
    // The preamble never ran, so there is no transcript worth continuing —
    // only the owner's question. Refused rather than rebuilt here: rebuilding
    // would duplicate the episode and session lines the preamble writes.
    return {
      turnId,
      why: 'unstarted',
      detail: `il turno ${turnId} non ha mai avviato il contesto: niente da continuare, apri un turno nuovo.`,
    };
  }
  const session = opts.session ?? deps.sessions.open(existing.sessionId);
  const granted = deps.turns.grantContinuation(
    turnId,
    {
      messages: [...evidenceForContinuation(providerMessages(existing)), opts.message],
      taint: existing.taint,
      counters: buildFreshCounters(existing.counters),
      newLeaseStartedAt: now().toISOString(),
    },
    process.pid,
  );
  if (granted === null) {
    return { turnId, why: 'claimed', detail: `il turno ${turnId} è stato preso da un altro processo` };
  }
  const span = deps.tracer.start(
    'muffin.turn',
    {
      [ATTR.principalKind]: granted.principal.kind,
      [ATTR.tenant]: granted.tenant,
      [ATTR.surface]: granted.surface,
      [ATTR.requestModel]: granted.providerLease.model,
      [ATTR.turnId]: granted.id,
      [ATTR.turnResume]: granted.counters.resumes,
      'muffin.turn.lease': granted.leaseIndex,
      'muffin.turn.continued': true,
    },
    remoteParent(granted.id),
  );
  try {
    deps.sessions.append(session, {
      role: 'user',
      content: ownerMessageText(opts.message),
      surface: granted.surface,
      createdAt: now().toISOString(),
      traceId: granted.id,
      tier: existing.taint,
    });
  } catch (error) {
    span.setAttributes({ 'muffin.turn.session_append_error': error instanceof Error ? error.message : String(error) });
  }
  return drive(deps, granted, span, {
    resumed: true,
    continued: true,
    wokenFromWait: false,
    session,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.replyChannel !== undefined ? { replyChannel: opts.replyChannel } : {}),
    ...(opts.onDelta ? { onDelta: opts.onDelta } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    ...(opts.steer ? { steer: opts.steer } : {}),
  });
}

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
