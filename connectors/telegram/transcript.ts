import type { TurnEvent } from '../../agent/loop.js';
import { toolPhrase, toolProgress } from '../../agent/tool-phrase.js';
import type { Negotiation } from '../../core/surface/types.js';
import type { TelegramApiLike } from './api.js';
import { escapeHtml, splitHtml, TELEGRAM_MAX, toTelegramHtml } from './render.js';
import { planRich, type OutboundRich } from './rich.js';

/**
 * What the agent said and did on its way to the answer, kept — DAY-1
 * requirements B11 and B13 as the owner actually wants them.
 *
 * This file replaces `progress.ts` (one status line, edited, **deleted** at
 * the end of the turn). The owner used Telegram on 02–03/09/2026 and said
 * three things about that design, recorded in
 * `docs/evidence/dogfood-superfici-2026-09-03.md` §1: *«non voglio perdere gli
 * step che ha fatto»*, they want *«una cosa alternata»* between what Muffin
 * says and what it does, and *«senza mandare 1000 messaggi»*. The old file
 * had chosen the opposite on purpose («never a history»), and it also wiped
 * the model's own preamble — the «leggo il file…» that precedes a tool call
 * — because `connector.ts` reset the draft at every `boundary`.
 *
 * ## One bubble per segment, not per event
 *
 * A **segment** is one Telegram message with this shape:
 *
 *     <what the model said before acting>          ← its own words, rendered
 *
 *     ✓ leggo un file: spesa.txt                    ← the steps, one line each
 *     ⏳ eseguo un comando: npm test · 12s          ← the one still running
 *
 * The rule that bounds the number of messages: **a new segment opens only
 * when the model speaks again after tools.** Rounds made of tool calls alone
 * append their lines to the segment that is already open, so a turn with
 * twelve tool calls and two sentences of commentary is two messages plus
 * the answer — never twelve.
 *
 * The answer is not a segment of its own, but it is not a message of its own
 * either (2026-09-04): `live()` streams the growing final round's text into
 * whichever segment is still open, the same real message the steps already
 * live in — B11's "as it forms" preview, now durable instead of a
 * `sendMessageDraft` bubble that expires if a process stops renewing it
 * (`docs/evidence/turno-sospendibile.md`). `connector.ts#deliverTo` then
 * `handoff()`s that same message and, when there is one, **extends** it
 * with the authoritative final text through the durable delivery
 * (`delivery.ts`) instead of sending a message beside it — one visible
 * response per turn, not two. A turn with no tool call and a fast answer
 * still opens exactly this one message; there is never a second one for the
 * answer to arrive in.
 *
 * ## What is never done here
 *
 * - **Nothing is deleted.** A segment, once sent, stays: it is the record
 *   of what happened, which is what the owner asked to keep. `stop()` makes
 *   a last edit that removes the live counter and marks a step the turn left
 *   running, and that is all.
 * - **Nothing is retracted.** `spoke()` is called at a `boundary`, i.e. after
 *   the text is known to be preamble; it lands in a real message and stays.
 *   The `'superseded'` case adds a line saying so instead of removing text.
 * - **Nothing is cut.** A preamble longer than one message is split with
 *   `splitHtml` into as many segments as it needs; a step that would push a
 *   segment past `TELEGRAM_MAX` opens the next one. The old draft *froze*
 *   past one message; the old ASK truncated at 220 characters. Neither
 *   survives.
 * - **A segment with nothing in it is not sent.** Until the model's own text
 *   starts arriving — via `spoke()` (it turned out to be preamble) or
 *   `live()` (it is still growing, fate unknown) — a turn produces no
 *   *persistent* message from this file. In a DM the ephemeral draft now
 *   carries the turn's status (`sto pensando · Ns`) from the first `round`
 *   event (2026-09-25): the first model call is no longer ~70 s of silence,
 *   and because the draft is not a message, a dead process still leaves
 *   nothing behind. In a group — no draft — `sendChatAction` remains the only
 *   sign of life until the first real content.
 *
 * ## Rate, and why the counter still moves
 *
 * Every edit is a Bot API request against a real per-chat limit (`api.ts`'s
 * own header: about one message a second to a chat, about twenty a minute
 * to a group). So: at most one call per `MIN_EDIT_MS`, coalescing whatever
 * arrived in the window into the edit that finally goes out, and never two
 * calls on the wire at once. But the owner also said *«anche i numeri …
 * dovrebbero essere in tempo reale»*, and the old status line only refreshed
 * when an event fired — a 40-second `shell_run` showed `· 2s` for forty
 * seconds. While a step is running the reporter ticks on its own, one edit
 * per window, so `· 12s` becomes `· 15s` without anything having to happen.
 *
 * Failures are swallowed and disable the rest of this turn's transcript,
 * exactly as `progress.ts` did: this is decoration on the real answer, and
 * an answer that fails because its transcript could not be edited would have
 * inverted that priority.
 */

/** How long `stop()` waits for the final edit before letting the answer go out anyway. */
const STOP_WAIT_MS = 2_000;

/**
 * `draft_id` deve essere non-zero e va riusato per tutta la vita di
 * un'anteprima (`api.ts#sendMessageDraft`). Un contatore di processo: due
 * turni nella stessa chat non devono mai riscrivere la stessa anteprima.
 */
let prossimoDraftId = 1;

/**
 * Telegram risponde 400 «message is not modified» a un edit identico. Non è
 * una consegna fallita: è la conferma che il messaggio è già come lo
 * volevamo. Trattarlo come errore spegneva la trascrizione per il resto del
 * turno (`disabled`), che è il difetto vero.
 */
function nonModificato(error: unknown): boolean {
  return /message is not modified/i.test(error instanceof Error ? error.message : String(error));
}

type Step = {
  /** Already escaped, and **whole**: the phrase plus the tool's full subject. */
  line: string;
  /** Running (`⏳`, with its own elapsed), or finished with a mark. */
  state: 'running' | 'done' | 'error' | 'waiting' | 'note';
  startedAt: number;
};

/** The step's one text: the phrase and the tool's subject, never shortened. */
function stepOf(name: string, args: unknown): Pick<Step, 'line'> {
  const { phrase, subject } = toolProgress(name, args);
  return { line: escapeHtml(subject === '' ? phrase : `${phrase}: ${subject}`) };
}

type Segment = {
  messageId: number | null;
  /** Rendered once at `spoke()`: what the model said before acting. */
  html: string;
  steps: Step[];
  /** The last text this segment was sent with, to skip a no-op edit. */
  shown: string | undefined;
  /** Final render already done — `stop()` or a later segment closed it. */
  closed: boolean;
};

export type Transcript = {
  /**
   * The model's text turned out to be preamble: a `boundary` arrived
   * (`TurnInput.onDelta`). `reason` says which — `'tool-call'` (it is about
   * to act) or `'superseded'` (that attempt was replaced). Empty text with
   * `'tool-call'` is a round that went straight to tools: nothing to show.
   */
  spoke(text: string, reason: 'tool-call' | 'superseded'): void;
  /** One fact about the turn's progress — see `TurnInput.onProgress`. */
  report(event: TurnEvent): void;
  /**
   * The wait `report`'s `'ask'` case opened is over — the owner answered,
   * from a button this transcript never sent (`cli/surface.ts`'s
   * `approvatoreTelegram`, a message of its own). Without this the `⏸ …
   * aspetto la tua approvazione` line freezes for the life of the segment,
   * which is exactly the «bolla che resta» the owner described
   * (`docs/evidence/forma-delle-superfici-2026-09-03.md` §4.2-§4.3): the
   * decision lands somewhere else entirely, and nothing ever tells *this*
   * step about it.
   *
   * Same vocabulary as `tool_end`, on purpose — an approval that resolves is
   * not a new kind of fact, it is the same `⏸`→done transition a running
   * tool already gets. Finds the **last** `'waiting'` step across every
   * still-open segment (never a closed one — `stop()` already finalised
   * those) and rewrites it in place; a segment with no such step does
   * nothing, which is the ordinary case for every step in every OTHER turn
   * that never asked.
   */
  resolveAsk(capability: string, allowed: boolean): void;
  /**
   * The turn's own words are still arriving and have not hit a `boundary`
   * yet — could still turn into preamble (`spoke()`), could still be the
   * final answer. `text` is the *whole* accumulation so far, replaced not
   * appended, mirroring `spoke()`'s own contract and the presence-draft
   * streaming this retires. Written into whichever segment is already open
   * (opening one, lazily, if this is the turn's first content at all) as a
   * trailing block, below any steps already there — never touches `seg.html`
   * or rotates a segment, so it cannot race `spoke()`'s own rotation logic.
   *
   * No-ops past this segment's `TELEGRAM_MAX` budget: what is already shown
   * stays, and `deliverTo`'s own render (through `renderForTelegram`, which
   * splits) is what makes the final, complete answer correct regardless.
   */
  live(text: string): void;
  /**
   * The message a finished turn's real answer should extend, if any —
   * `connector.ts#deliverTo`'s own seam. `null` when there is nothing to
   * extend: no segment ever got real content this turn (the ordinary,
   * tool-free case), or the one that did never actually reached Telegram (a
   * swallowed send failure disabled this transcript first). Meant to be read
   * once `stop()` has resolved, so `stepsText` is the segment's settled,
   * non-live rendering — steps and any spoken preamble, deliberately
   * *without* whatever `live()` last wrote, which `deliverTo` supplies fresh
   * and properly split from the turn's own authoritative final text.
   */
  handoff(): { messageId: number; stepsText: string } | null;
  /**
   * Last edit, then silence. Idempotent: the caller invokes it once right
   * after the turn and once more from its `finally`.
   */
  stop(): Promise<void>;
};

export type TranscriptOptions = {
  now?: () => number;
  /**
   * Cosa si può fare in **questa stanza** — `Surface.negotiate(place)`.
   *
   * Obbligatoria e senza default: fino al 06/09/2026 questo file leggeva un
   * `isPrivate?: boolean` opzionale e ne derivava da solo due pavimenti di
   * edit e il diritto di mostrare la risposta mentre si forma. Erano tre
   * decisioni sul *cosa può fare Telegram in una stanza* prese dentro il
   * renderer, e un default le rendeva anche saltabili. Ora arrivano dalla
   * porta, che è l'unica a saperle, e il compilatore chiede a ogni chiamante
   * di dire in che stanza sta.
   */
  negotiation: Negotiation;
  /** Il topic del forum, quando il turno è nato dentro uno. Vedi `SendOptions.threadId`. */
  threadId?: number;
  /** Traces a swallowed Bot API failure. Absent means silent. */
  log?: (line: string) => void;
};

export function startTranscript(api: TelegramApiLike, chatId: number, options: TranscriptOptions): Transcript {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((): void => {});
  const negotiation = options.negotiation;
  const minEditMs = negotiation.editEveryMs > 0 ? negotiation.editEveryMs : 1_000;
  const maxPerMinute = negotiation.maxEditsPerMinute;
  /**
   * Dove va il testo che sta ancora arrivando, deciso dalla testa della
   * catena e non da un booleano su «privato».
   *
   * - `'draft'` → l'anteprima effimera (`sendMessageDraft`), rinnovata dentro
   *   `draftTtlMs`. Non apre nessun messaggio vero, quindi un processo che
   *   muore non lascia niente: la bozza sparisce da sola, ed è la ragione per
   *   cui `docs/evidence/turno-sospendibile.md` la voleva morta *senza
   *   rinnovo* e non in assoluto.
   * - `'edit'` → la coda del segmento aperto, un messaggio vero (il
   *   comportamento del 04/09).
   * - `'off'` → niente in diretta.
   */
  const testaDelloStream = negotiation.stream[0] ?? 'off';
  const liveEnabled = testaDelloStream !== 'off';
  const draftEnabled = testaDelloStream === 'draft';
  /**
   * Ogni quanto ributtare l'anteprima sul filo. Il pavimento degli edit
   * (`editEveryMs`) è già molto dentro `draftTtlMs`, quindi lo stesso ritmo
   * aggiorna *e* rinnova: non serve un secondo timer che faccia la seconda
   * cosa, e un secondo timer sarebbe la «due meccanismi a ritmi diversi» che
   * questo file ha già pagato una volta.
   */
  const draftEveryMs = Math.max(1, Math.min(minEditMs, Math.floor(negotiation.draftTtlMs / 3) || minEditMs));
  const draftId = prossimoDraftId++;
  let draftText = '';
  /**
   * The rich preview, Bot API 10.1+. Mutually exclusive with `draftText` by
   * construction (each tick sets exactly one): a structurally rich partial
   * (a table taking shape, a checklist) previews as rich blocks, ordinary
   * prose as legacy text. A mid-stream switch changes method under the same
   * `draft_id` — the client replaces without animation, which is the honest
   * rendering of "the preview changed shape", and it is still ephemeral:
   * the final send is the only durable delivery either way.
   *
   * Bounded like the legacy preview (`TELEGRAM_MAX`): a preview is small by
   * nature, and a 400 on an oversized preview would disable previews for the
   * whole turn. The FINAL may ride rich up to the compat ceiling
   * (`rich.ts`); the preview never needs to.
   */
  let draftRich: OutboundRich | null = null;
  let draftTimer: NodeJS.Timeout | null = null;
  let draftDisabled = !draftEnabled;
  const turnStartedAt = now();

  const segments: Segment[] = [];
  let stopped = false;
  /** Set on the first failed send/edit. Never cleared. */
  let disabled = false;
  /** What the turn is doing when no step is running: `sto pensando`, `sto scrivendo la risposta`. */
  let status: string | null = null;
  /**
   * The current round's own text, not yet known to be preamble or the
   * answer — `live()`'s only state. Replaced whole on every call (same
   * coalescing shape `spoke()` gets from its caller), and cleared the moment
   * `spoke()` promotes it into `seg.html` — see that method.
   */
  let liveText = '';
  let lastCallAt = 0;
  /** Quando sono partite le chiamate dell'ultimo minuto, per il tetto della stanza. */
  const finestra: number[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  /** The call currently on the wire, so two never overlap and `messageId` is written by one send at a time. */
  let inFlight: Promise<void> | null = null;
  /**
   * A `sendMessage` for this turn has started (difetto B, forma forte). Set
   * synchronously next to the `finestra` push — i.e. at invocation, not at
   * completion — so it also covers a send whose response has not landed yet.
   * While false, `scheduleSoon()` owes the first paint with no timer at all;
   * once true, everything is throttled by the room's own floor (`schedule()`).
   */
  let everSent = false;

  function current(): Segment {
    const last = segments[segments.length - 1];
    if (last !== undefined && !last.closed) return last;
    const fresh: Segment = { messageId: null, html: '', steps: [], shown: undefined, closed: false };
    segments.push(fresh);
    return fresh;
  }

  function hasContent(seg: Segment): boolean {
    return seg.html !== '' || seg.steps.length > 0;
  }

  function running(seg: Segment): boolean {
    return seg.steps.some((s) => s.state === 'running');
  }

  /**
   * The message text. `live` includes the running counter and the status
   * line; the final render (`closed`) leaves only what happened. `tail` is
   * `live()`'s own, still-unsettled text — always last, below the steps,
   * because chronologically it is the newest thing happening.
   */
  function render(seg: Segment, live: boolean, at: number, tail = ''): string {
    const lines: string[] = [];
    for (const step of seg.steps) {
      switch (step.state) {
        case 'running': {
          const s = Math.max(0, Math.round((at - step.startedAt) / 1000));
          lines.push(live ? `⏳ ${step.line} · ${s}s` : `✗ ${step.line} — interrotto`);
          break;
        }
        case 'done':
          lines.push(`✓ ${step.line}`);
          break;
        case 'error':
          lines.push(`✗ ${step.line}`);
          break;
        case 'waiting':
          lines.push(`⏸ ${step.line}`);
          break;
        case 'note':
          lines.push(step.line);
          break;
      }
    }
    // Redundant once the tail itself is visible below: the status line is
    // for the gap before there is anything real to show.
    if (live && status !== null && !running(seg) && tail === '') {
      const s = Math.max(0, Math.round((at - turnStartedAt) / 1000));
      lines.push(`<i>${escapeHtml(status)} · ${s}s</i>`);
    }
    const stepsHtml = lines.join('\n');
    const base = seg.html === '' ? stepsHtml : stepsHtml === '' ? seg.html : `${seg.html}\n\n${stepsHtml}`;
    if (tail === '') return base;
    return base === '' ? tail : `${base}\n\n${tail}`;
  }

  /** Whether `seg` can take one more step without leaving one message. */
  function fits(seg: Segment, step: Step): boolean {
    const probe: Segment = { ...seg, steps: [...seg.steps, step] };
    return render(probe, true, now()).length <= TELEGRAM_MAX;
  }

  /** Whether `seg` can carry `tail` (`live()`'s candidate text) without leaving one message. */
  function fitsTail(seg: Segment, tail: string): boolean {
    return render(seg, true, now(), tail).length <= TELEGRAM_MAX;
  }

  function addStep(step: Step): void {
    // Il persistente vince sulla bozza: dal primo passo vero in poi il turno
    // possiede un messaggio reale, e rinnovare ancora l'anteprima effimera
    // significherebbe due superfici per lo stesso turno — quella che resta
    // appesa dopo la risposta (difetto A). Vedi `live()`: finché nessun
    // segmento ha contenuto la bozza è l'unica cosa viva; da qui in poi non
    // lo è più.
    if (draftEnabled) abbandonaDraft();
    let seg = current();
    if (hasContent(seg) && !fits(seg, step)) {
      seg.closed = true;
      seg = current();
    }
    seg.steps.push(step);
  }

  /** The one place that talks to Telegram for one segment. */
  async function sendSegment(seg: Segment, live: boolean, tail: string): Promise<void> {
    if (disabled || (!hasContent(seg) && tail === '')) return;
    const text = render(seg, live, now(), tail);
    if (text === seg.shown) return;
    lastCallAt = now();
    finestra.push(lastCallAt);
    everSent = true;
    try {
      if (seg.messageId === null) {
        const message = await api.sendMessage(chatId, text, {
          ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
        });
        seg.messageId = message.message_id;
      } else {
        await api.editMessageText(chatId, seg.messageId, text);
      }
      seg.shown = text;
    } catch (error) {
      // Un edit identico non è un guasto: il messaggio è già come lo
      // volevamo, quindi si registra come mostrato e si continua.
      if (nonModificato(error)) {
        seg.shown = text;
        return;
      }
      disabled = true;
      log(`telegram: trascrizione del turno sospesa — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * La bozza ha finito il suo lavoro: il testo ora vive (o vivrà) in un
   * messaggio vero. Ferma il rinnovo e dimentica il testo, così `pushDraft`
   * diventa un no-op e `scheduleDraft` non si ri-programma. Idempotente.
   */
  function abbandonaDraft(): void {
    draftText = '';
    draftRich = null;
    if (draftTimer !== null) {
      clearTimeout(draftTimer);
      draftTimer = null;
    }
  }

  /**
   * Manda (o rinnova) l'anteprima. Un guasto qui spegne **solo** l'anteprima:
   * la trascrizione vera e la risposta non dipendono da una bolla che scade
   * da sola.
   *
   * `canStop: true` su OGNI anteprima (Bot API 10.3): è il controllo Stop
   * dell'owner, e premerlo arriva come `stopped_message_generation` — un
   * segnale strutturale che il connettore instrada all'abort canonico del
   * turno (`connector.ts#handleStopGenerazione`), mai come testo.
   *
   * Finché non è arrivato nessun token, l'anteprima mostra lo **stato del
   * turno** («sto pensando · Ns») invece di restare invisibile: è il buco di
   * ~70 s chiuso il 2026-09-25, quando il primo giro del modello non produceva
   * né testo né una tool call e l'owner guardava il vuoto. Il testo che si
   * forma vince sullo stato appena arriva, e la riga di stato è la stessa che
   * la trascrizione persistente usa (`render`).
   */
  async function pushDraft(): Promise<void> {
    if (stopped || draftDisabled) return;
    const payload = draftText !== '' ? draftText : draftStatusText();
    if (payload === '' && draftRich === null) return;
    try {
      if (draftRich !== null) await api.sendRichMessageDraft(chatId, draftId, draftRich, { canStop: true });
      else await api.sendMessageDraft(chatId, draftId, payload, { canStop: true });
    } catch (error) {
      if (nonModificato(error)) return;
      draftDisabled = true;
      log(`telegram: anteprima del turno sospesa — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Lo stato del turno reso per l'anteprima: stessa forma della riga della trascrizione. */
  function draftStatusText(): string {
    if (status === null) return '';
    const s = Math.max(0, Math.round((now() - turnStartedAt) / 1000));
    return `<i>${escapeHtml(status)} · ${s}s</i>`;
  }

  /**
   * L'anteprima ha qualcosa da dire appena il turno inizia a pensare, non
   * solo al primo token: chiamata da `report` finché nessun segmento
   * persistente esiste. Un rinnovo già in corso basta — al prossimo giro
   * legge comunque lo stato aggiornato.
   */
  function ensureDraftStatus(): void {
    if (stopped || draftDisabled || !draftEnabled) return;
    if (segments.some(hasContent)) return;
    if (draftTimer !== null) return;
    void pushDraft().then(() => scheduleDraft());
  }

  /**
   * Il rinnovo. Riparte da solo finché c'è testo **o stato** da mostrare, e
   * questo è il punto dell'intera fetta: senza questa ri-programmazione
   * l'anteprima scade dopo `draftTtlMs` e l'owner guarda il vuoto — il difetto
   * misurato il 04/09 e chiuso allora togliendo la bolla invece che
   * rinnovandola.
   */
  function scheduleDraft(): void {
    if (stopped || draftDisabled || draftTimer !== null) return;
    if (draftText === '' && status === null) return;
    draftTimer = setTimeout(() => {
      draftTimer = null;
      void pushDraft().then(() => {
        if (!stopped && !draftDisabled && (draftText !== '' || status !== null)) scheduleDraft();
      });
    }, draftEveryMs);
  }

  /**
   * Bring every segment up to date, in order: closed ones with their final
   * render (a segment closed before its first send still gets sent, so the
   * order on screen is the order of events), the open one live — carrying
   * `liveText` as its tail, since that buffer only ever belongs to whichever
   * segment is still open.
   */
  async function syncAll(finalPass: boolean): Promise<void> {
    for (const seg of segments) {
      if (seg.closed) {
        await sendSegment(seg, false, '');
      } else {
        await sendSegment(seg, !finalPass, liveText);
        if (finalPass) seg.closed = true;
      }
      if (disabled) return;
    }
  }

  /** Serialised: never two calls on the wire at once. */
  function enqueue(work: () => Promise<void>): Promise<void> {
    const mine = (inFlight ?? Promise.resolve()).then(work, work);
    inFlight = mine;
    return mine.finally(() => {
      if (inFlight === mine) inFlight = null;
    });
  }

  async function flush(): Promise<void> {
    flushTimer = null;
    if (stopped || disabled) return;
    await enqueue(() => syncAll(false));
    // Keep the counter moving while something is running or the turn is
    // between steps: one edit per window, and nothing once it is quiet.
    if (!stopped && !disabled && (running(current()) || status !== null) && hasContent(current())) schedule();
  }

  /**
   * Quanto aspettare prima della prossima chiamata: il pavimento fra due
   * chiamate **e** il tetto sulla finestra di un minuto, che sono due limiti
   * diversi della Bot API con due orizzonti diversi (vedi `Negotiation`).
   * Prima del 06/09/2026 ne esisteva uno solo, e per stare dentro il tetto
   * di un gruppo il pavimento era stato alzato a 3 s — cioè si pagava il
   * tetto anche quando la finestra era vuota.
   */
  function attesa(): number {
    const t = now();
    while (finestra.length > 0 && t - finestra[0]! >= 60_000) finestra.shift();
    const pavimento = Math.max(0, minEditMs - (t - lastCallAt));
    if (maxPerMinute > 0 && finestra.length >= maxPerMinute) {
      return Math.max(pavimento, finestra[0]! + 60_000 - t);
    }
    return pavimento;
  }

  function schedule(): void {
    if (stopped || disabled || flushTimer !== null) return;
    flushTimer = setTimeout(() => void flush(), attesa());
  }

  /**
   * Come `schedule()`, ma la prima pittura non aspetta niente (difetto B,
   * forma forte — vedi `trySyncFirstPaint`).
   *
   * Il pavimento (`editEveryMs`) e il tetto (`maxEditsPerMinute`) limitano la
   * *frequenza* degli edit su un messaggio che esiste già; non devono
   * ritardare la *nascita* del primo messaggio di un turno. La prima chiamata
   * è una sola `sendMessage` — sempre dentro entrambi i limiti, perché la
   * finestra parte vuota — quindi non viola niente.
   */
  function scheduleSoon(): void {
    if (stopped || disabled || flushTimer !== null) return;
    if (!everSent) {
      // Prima del primo send il timer non esiste proprio: o la pittura parte
      // dentro questo stesso stack (`trySyncFirstPaint`), o — solo quando il
      // contenuto è spaccato su più segmenti e l'ordine sullo schermo chiede
      // la sequenza — parte accodata subito, senza finestra (`void flush()`).
      // Mai `schedule()`: un pavimento prima della nascita è il difetto.
      if (trySyncFirstPaint()) return;
      if (hasContent(current())) void flush();
      return;
    }
    schedule();
  }

  /**
   * The first visible send, invoked synchronously from the first durable
   * progress fact (difetto B, forma forte dell'owner, 2026-09-18).
   *
   * `runTool` emits `tool_start` synchronously and invokes the handler in the
   * same stack, right after `onProgress` returns — so anything deferred past
   * `report()`'s own stack (a `setTimeout` of any length, even 0, or even a
   * `.then()` microtask) has not run when a blocking handler takes the event
   * loop, and the first progress dies for exactly as long as the tool runs
   * (the owner's ~70 s). Hence this path calls `api.sendMessage` HERE, in
   * this stack: invocation — not completion — is what puts the request on the
   * wire before the handler can monopolise the loop.
   *
   * Narrow on purpose: exactly one open segment, never sent, never shown.
   * Anything else (a preamble split across messages, an in-flight first send
   * a racing event joined) keeps the immediate-but-sequenced `flush()` path,
   * so on-screen order and the never-two-on-the-wire rule never weaken.
   *
   * Completion still lands through `inFlight`, so a racing `flush()` chains
   * behind this send instead of doubling it: by the time it runs, `messageId`
   * is set and it edits. Failure disables the turn exactly like
   * `sendSegment`'s own failure — this IS the first send, not an extra one.
   */
  function trySyncFirstPaint(): boolean {
    if (segments.length !== 1) return false;
    const seg = segments[0]!;
    if (seg.closed || seg.messageId !== null || seg.shown !== undefined || !hasContent(seg)) return false;
    const text = render(seg, true, now(), liveText);
    if (text === '') return false;
    lastCallAt = now();
    finestra.push(lastCallAt);
    everSent = true;
    // Shown optimistically and first: a flush chaining behind this send must
    // see the paint as already started, never as a second message to create.
    seg.shown = text;
    let started: Promise<{ message_id: number }>;
    try {
      started = api.sendMessage(chatId, text, {
        ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
      }) as Promise<{ message_id: number }>;
    } catch (error) {
      // A synchronous throw (e.g. unserialisable payload) is a failed first
      // send like any other: decoration stays down, the answer does not.
      disabled = true;
      log(`telegram: trascrizione del turno sospesa — ${error instanceof Error ? error.message : String(error)}`);
      return true;
    }
    const occupant: Promise<void> = started.then(
      (message) => {
        seg.messageId = message.message_id;
        // The counter keeps moving exactly as after a `flush()`-driven first
        // paint — one edit per window while something runs.
        if (!stopped && !disabled && (running(current()) || status !== null) && hasContent(current())) schedule();
      },
      (error: unknown) => {
        if (nonModificato(error)) return;
        disabled = true;
        log(`telegram: trascrizione del turno sospesa — ${error instanceof Error ? error.message : String(error)}`);
      },
    );
    const tracked: Promise<void> = occupant.finally(() => {
      if (inFlight === tracked) inFlight = null;
    });
    inFlight = tracked;
    return true;
  }

  return {
    spoke(text, reason) {
      if (stopped || disabled) return;
      // Whatever `live()` was showing for this same round is now either
      // promoted into `seg.html` below (byte-identical — `text` is the same
      // accumulation `live()` was already fed) or, for an empty round, moot.
      // Cleared unconditionally and first, so a flush racing this call can
      // never render the tail a second time once it is also `seg.html`.
      liveText = '';
      // Quel testo ora vive in un messaggio vero: l'anteprima ha finito il
      // suo lavoro per questo giro e non va rinnovata oltre (ferma anche il
      // timer, non solo il testo — difetto A).
      abbandonaDraft();
      const trimmed = text.trim();
      if (trimmed !== '') {
        const parts = splitHtml(toTelegramHtml(trimmed));
        // Text after steps is the model speaking again: a new segment. Text
        // into an empty segment is that segment's own opening.
        let seg = current();
        if (hasContent(seg)) {
          seg.closed = true;
          seg = current();
        }
        // All but the last part are already full messages of their own.
        for (let i = 0; i < parts.length - 1; i++) {
          seg.html = parts[i]!;
          seg.closed = true;
          seg = current();
        }
        seg.html = parts[parts.length - 1] ?? '';
      }
      if (reason === 'superseded' && trimmed !== '') {
        addStep({ line: '↺ quel tentativo è stato sostituito', state: 'note', startedAt: now() });
      }
      scheduleSoon();
    },

    report(event) {
      if (stopped || disabled) return;
      switch (event.type) {
        case 'round':
          status = 'sto pensando';
          break;
        case 'model':
          status = event.stopReason === 'tool_use' ? 'ho deciso i prossimi passi' : 'sto scrivendo la risposta';
          break;
        case 'model_status':
          status = event.status === 'stalled' ? `nessuna attività del modello da ${Math.round(event.idleMs / 1000)}s` : event.status === 'thinking' ? 'sto pensando' : event.status === 'receiving' ? 'sto ricevendo la risposta' : 'aspetto il modello';
          break;
        case 'tool_start':
          status = null;
          addStep({ ...stepOf(event.name, event.args), state: 'running', startedAt: now() });
          break;
        case 'tool_retry': {
          const seg = current();
          const step = [...seg.steps].reverse().find((s) => s.state === 'running');
          const line = escapeHtml(`${toolPhrase(event.name)}: non risponde, riprovo (${event.attempt}/3)`);
          if (step) step.line = line;
          else addStep({ line, state: 'running', startedAt: now() });
          break;
        }
        case 'tool_end': {
          const seg = current();
          const step = [...seg.steps].reverse().find((s) => s.state === 'running');
          if (step) {
            step.state = event.isError ? 'error' : 'done';
            // A retry rewrote the line; the closing mark carries the tool,
            // not the wait — when the end event brings the arguments back, the
            // full command is what closes the step.
            if (event.args !== undefined) step.line = stepOf(event.name, event.args).line;
          } else {
            addStep({ ...stepOf(event.name, event.args), state: event.isError ? 'error' : 'done', startedAt: now() });
          }
          break;
        }
        case 'ask':
          status = null;
          addStep({ line: escapeHtml(`${toolPhrase(event.name)}: aspetto la tua approvazione`), state: 'waiting', startedAt: now() });
          break;
        default:
          return assertNever(event);
      }
      if (hasContent(current())) scheduleSoon();
      // Finché la superficie viva è l'anteprima (DM) e non c'è contenuto, lo
      // stato del turno la fa comparire subito: il primo giro del modello non
      // è più silenzio (2026-09-25).
      else ensureDraftStatus();
    },

    resolveAsk(capability, allowed) {
      if (stopped || disabled) return;
      // Dall'ultimo segmento al primo, perché è dove vive quasi sempre
      // l'unico passo `waiting` di un turno — ma non si assume: un turno può
      // aver chiesto due approvazioni prima che la prima tornasse.
      for (let i = segments.length - 1; i >= 0; i--) {
        const seg = segments[i]!;
        const step = [...seg.steps].reverse().find((s) => s.state === 'waiting');
        if (step === undefined) continue;
        step.state = allowed ? 'done' : 'error';
        step.line = escapeHtml(`${capability}: ${allowed ? 'consentito' : 'rifiutato'}`);
        scheduleSoon();
        return;
      }
    },

    live(text) {
      if (stopped || disabled || !liveEnabled) return;
      const trimmed = text.trim();
      // La bozza vive solo finché non esiste un messaggio vero (difetto A):
      // dal primo segmento con contenuto in poi il testo che si forma va nel
      // segmento persistente (edit), mai in una nuova bozza. Solo così la
      // risposta finale di un turno con tool non lascia un'anteprima appesa
      // che nessun `sendMessage` verrà a sostituire (`deliverTo` in quel caso
      // fa un edit, e un edit non tocca la bozza).
      if (draftEnabled && !segments.some(hasContent)) {
        // La stanza preferisce l'anteprima: il testo che sta arrivando non
        // tocca nessun messaggio vero, e la risposta finale resta l'unico
        // messaggio che la chat conserva.
        if (draftDisabled) return;
        const had = draftText !== '' || draftRich !== null;
        if (trimmed === '') {
          draftText = '';
          draftRich = null;
          return;
        }
        // Un parziale strutturalmente ricco (una tabella che prende forma)
        // merita l'anteprima ricca; la prosa resta testo legacy. Un parziale
        // a metà (tabella senza delimitatore, fence non chiuso) ricade da
        // solo sul legacy — `rich.ts` non emette mai strutture spezzate.
        const candidate = planRich(trimmed);
        if (candidate.mode === 'rich' && candidate.chars <= TELEGRAM_MAX) {
          draftText = '';
          draftRich = candidate.message;
        } else {
          const nuovo = toTelegramHtml(trimmed);
          if (nuovo.length > TELEGRAM_MAX) return;
          draftText = nuovo;
          draftRich = null;
        }
        if (!had) {
          // Subito, così l'anteprima compare al primo token invece che dopo
          // una finestra intera di attesa.
          void pushDraft().then(() => scheduleDraft());
          return;
        }
        scheduleDraft();
        return;
      }
      if (trimmed === '') {
        if (liveText !== '') {
          liveText = '';
          scheduleSoon();
        }
        return;
      }
      const rendered = toTelegramHtml(trimmed);
      const seg = current();
      // `'edit'` è, alla lettera, «riscrivere un messaggio **già inviato**»:
      // mostra la risposta che si forma dentro il messaggio che il turno
      // possiede già (il preambolo, i passi), e non ne apre uno solo per far
      // vedere un pezzo di frase. È ciò che tiene una stanza condivisa senza
      // un messaggio a metà che un processo morto lascerebbe lì — la stessa
      // ragione per cui l'anteprima, che non è un messaggio, può invece
      // partire dal nulla. In una DM dopo il primo passo vero è anche dove va
      // la risposta che si forma una volta che la bozza ha finito (vedi sopra).
      if (!hasContent(seg)) return;
      // Overflow: stay with whatever is already shown rather than force a
      // rotation mid-round — `deliverTo`'s own render is what makes the
      // final, complete, correctly-split answer right regardless.
      if (!fitsTail(seg, rendered)) return;
      liveText = rendered;
      scheduleSoon();
    },

    handoff() {
      if (disabled || segments.length === 0) return null;
      const seg = segments[segments.length - 1]!;
      if (seg.messageId === null) return null;
      return { messageId: seg.messageId, stepsText: render(seg, false, now()) };
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      // La bozza si spegne smettendo di rinnovarla, mai mandando un testo
      // vuoto (difetto A). Fatto API primario
      // (`core.telegram.org/bots/api#sendmessagedraft`, Bot API 10.0 del
      // 2026-05-08 «Allowed bots to pass an empty text in the method
      // sendMessageDraft»): `text` 0–4096 e un testo vuoto mostra il
      // placeholder «Thinking…», non cancella la bozza. La bozza è
      // un'anteprima effimera (~30 s): sparisce per TTL, o quando un normale
      // `sendMessage` arriva nella stessa chat/topic — un `editMessageText`
      // non la tocca. Quindi mandare `''` qui accendeva un «Thinking…»
      // post-risposta che, nei turni con tool (dove `deliverTo` fa un edit del
      // messaggio persistente invece di un send), niente veniva a sostituire.
      // Il ciclo corretto: un turno senza tool consegna con un `sendMessage`
      // che sostituisce la bozza da solo; un turno con tool ha già smesso di
      // rinnovarla dal primo passo vero (`addStep` → `abbandonaDraft`), e il
      // resto lo fa la scadenza.
      if (draftTimer !== null) {
        clearTimeout(draftTimer);
        draftTimer = null;
      }
      draftText = '';
      draftRich = null;
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      status = null;
      if (disabled || segments.length === 0) return;
      // The final edit: counter gone, a step the turn abandoned marked. It
      // goes on the same channel the real answer is about to use, so it is
      // bounded — past `STOP_WAIT_MS` the transcript stays as last shown
      // rather than holding the answer back (the same trade `progress.ts`
      // made for its cleanup).
      const done = enqueue(() => syncAll(true));
      try {
        await Promise.race([done, new Promise<void>((resolve) => setTimeout(resolve, STOP_WAIT_MS))]);
      } catch {
        // `sendSegment` already swallows and disables; nothing to add.
      }
    },
  };
}

/** Same guarantee `agent/loop.ts` gives `TurnEvent`'s union: an unhandled variant is a compile error here. */
function assertNever(x: never): never {
  throw new Error(`unreachable: unhandled variant ${JSON.stringify(x)}`);
}
