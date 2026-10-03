import type { ApprovalRequest, TurnEvent } from '../../agent/loop.js';
import { toolPhrase, toolProgress } from '../../agent/tool-phrase.js';
import type { Negotiation } from '../../core/surface/types.js';
import { askHtml, askKeyboard, askPlain } from './approval.js';
import { TelegramError, type TelegramApiLike } from './api.js';
import { escapeHtml, splitHtml, TELEGRAM_MAX, toTelegramHtml } from './render.js';
import { richFitsHard, richFromHtml, thinkingRich, turnRichMessage, type OutboundRich } from './rich.js';

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
 * ## One durable message per turn; the process collapses into it
 *
 * In a **DM** the process is ephemeral. The model's preamble and the steps
 * accumulate in a `sendMessageDraft` (Bot API 10.2+) — the owner's Stop
 * control rides it — and **nothing persistent is created while the model
 * works**. The draft is built from the **same blocks as the final** (the
 * process in a `details` block, collapsed in both, the answer as native
 * blocks), so the swap at the end changes the summary line, not the
 * rendering; while the model thinks with nothing to show, the placeholder is
 * the Bot API 10.2 `thinking` block. When the answer is ready,
 * `connector.ts#deliverTo` sends one rich message of the same shape. A process that dies mid-turn leaves nothing
 * behind, and the chat keeps exactly one durable message per turn (choice B,
 * 2026-09-26; draft shape aligned 2026-09-27).
 *
 * In a **group** there is no draft, so the process *is* persisted: one
 * segment is one message, edited in place, and the answer extends that same
 * bubble. The bound is unchanged — a new segment opens only when the model
 * speaks again after tools — but the DM no longer needs it, because its draft
 * is a single, disposable surface.
 *
 * ## L'eccezione: la domanda di approvazione
 *
 * Una domanda di approvazione ha pulsanti, e una bozza effimera non può
 * portarli. Quando la fa una superficie a pulsanti, il turno apre il suo
 * messaggio vero **prima** del primo token (`ask()`), la domanda entra come
 * passo visibile con la tastiera attaccata, e da lì in poi vale la regola del
 * gruppo: la risposta che si forma edita quel messaggio, e la consegna finale
 * lo ripiega nel `details`. Una bolla sola per turno, anche quando chiede il
 * permesso (owner, 2026-09-29: quattro comandi, quattro bolle residue sotto
 * la risposta). Se nessun messaggio vivo può ospitarla, l'approvatore ripiega
 * sul messaggio autonomo: la domanda non resta mai muta.
 *
 * ## What is never done here
 *
 * - **Nothing is deleted.** In a group a segment, once sent, stays.
 * - **Nothing is retracted.** `spoke()` is called at a `boundary`, i.e. after
 *   the text is known to be preamble; in a group it lands in a real message
 *   and stays, in a DM it becomes part of the collapsed process.
 * - **Nothing is cut.** A preamble longer than one message is split with
 *   `splitHtml` into as many segments as it needs (group), and the DM preview
 *   drops whole leading lines to fit — never half a line; the final message
 *   always carries every word in its `details`.
 * - **A turn with no tool call opens no persistent message.** In a DM the
 *   ephemeral draft carries the status (`sto pensando · Ns`) from the first
 *   `round` event until the answer is delivered as one fresh message; in a
 *   group `sendChatAction` remains the only sign of life until real content.
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
  /** The same, unescaped — the process `details` block is plain text, not HTML. */
  plain: string;
  /** Running (`⏳`, with its own elapsed), or finished with a mark. */
  state: 'running' | 'done' | 'error' | 'waiting' | 'note';
  startedAt: number;
  /**
   * La capability che questa attesa riguarda, quando è una domanda di
   * approvazione. Serve a due cose sole: deduplicare il passo quando il loop
   * emette il suo evento `ask` *dopo* che la domanda è già stata mostrata
   * (`ask()`), e ritrovare il passo giusto quando l'owner risponde.
   */
  capability?: string;
  /**
   * L'approvazione che questa attesa riguarda, quando è una domanda. La
   * chiave è l'id, non la capability: due `sys.shell` su comandi diversi sono
   * due domande, con due passi e due tastiere (#745).
   */
  approvalId?: string;
};

/** The step's one text: the phrase and the tool's subject, never shortened. */
function stepOf(name: string, args: unknown): Pick<Step, 'line' | 'plain'> {
  const { phrase, subject } = toolProgress(name, args);
  const text = subject === '' ? phrase : `${phrase}: ${subject}`;
  return { line: escapeHtml(text), plain: text };
}

type Segment = {
  messageId: number | null;
  /** Rendered once at `spoke()`: what the model said before acting. */
  html: string;
  /** The same preamble, unescaped — what the collapsed process block shows. */
  plain: string;
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
   * The wait `report`'s `'ask'` case opened is over — the owner answered.
   *
   * Dal 2026-09-29 il pulsante vive **su questo stesso messaggio** (`ask()`
   * gliel'ha attaccato): qui si toglie la tastiera per costruzione e si
   * risolve il passo, così il verdetto e il contenuto della domanda restano
   * nel Processo e nessuna bolla separata resta nella chat. Prima di allora
   * la decisione arrivava da un messaggio che questa trascrizione non aveva
   * mai mandato (`cli/surface.ts`'s `approvatoreTelegram`, una bolla a
   * parte), e la riga `⏸ … aspetto la tua approvazione` si congelava per
   * sempre — la «bolla che resta» di
   * `docs/evidence/forma-delle-superfici-2026-09-03.md` §4.2-§4.3.
   *
   * Same vocabulary as `tool_end`, on purpose — an approval that resolves is
   * not a new kind of fact, it is the same `⏸`→done transition a running
   * tool already gets. Finds the `'waiting'` step **by approval id** across
   * every still-open segment (never a closed one — `stop()` already finalised
   * those) and rewrites it in place; a segment with no such step does
   * nothing, which is the ordinary case for every step in every OTHER turn
   * that never asked.
   */
  resolveAsk(ask: { approvalId: string; capability: string }, allowed: boolean): void;
  /**
   * La domanda di approvazione, **dentro il messaggio del turno**.
   *
   * Chiamata dall'approvatore di Telegram *prima* che il loop emetta il suo
   * evento `ask` (l'approvatore parla per primo). Apre il messaggio vero del
   * turno — anche in una stanza che preferirebbe la bozza, perché i pulsanti
   * non vivono su un'anteprima effimera — scrive la domanda come passo in
   * attesa (visibile: `render` la mostra, il rich finale la ripiega nel
   * Processo) e le attacca la tastiera.
   *
   * `true` quando la domanda è stata presa; `false` quando nessun messaggio
   * vivo può ospitarla (trascrizione spenta o già fallita) e il chiamante deve
   * ripiegare sul messaggio autonomo — la garanzia che la domanda esista
   * sempre, anche dove il messaggio del turno non c'è.
   */
  ask(input: { request: ApprovalRequest; approvalId: string }): Promise<boolean>;
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
   * The process a finished turn should collapse, and the message it should
   * extend, if any — `connector.ts#deliverTo`'s own seam. Meant to be read
   * once `stop()` has resolved.
   *
   * `messageId` is a real message only in a room with no draft (a group):
   * there the steps were sent as a persistent, silent trail and the answer
   * extends that same bubble. In a DM it is `null` — the process only ever
   * lived in the ephemeral draft and nothing was persisted, so the final
   * message is a fresh send whose `details` block carries `process`.
   *
   * `process` is plain text, one entry per line (the preamble, then the
   * steps with their marks), for the `details` block. `processHtml` is the
   * legacy-rendered trail, used only when the group answer extends the
   * message in place.
   */
  handoff(): { messageId: number | null; process: string[]; processHtml: string } | null;
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
  /**
   * La domanda si è mostrata sul messaggio del turno (#784).
   *
   * Chiamata da `ask()` quando la domanda è presa, con l'id
   * dell'approvazione e quello del messaggio che la ospita: chi registra lo
   * scrive nel registro durevole, così la chiusura terminale del turno può
   * toglierle la tastiera anche dopo un riavvio — quando questa trascrizione
   * non esiste più. Mai chiamata quando `ask()` torna `false` (nessun
   * messaggio vivo: il chiamante ripiega sul messaggio autonomo, che
   * registra da sé). Non deve lanciare: la trascrizione la chiama protetta.
   */
  onAsked?: (mostrata: { approvalId: string; messageId: number }) => void;
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
  /**
   * Il rinnovo della bozza ha un ritmo **suo**, non quello degli edit
   * persistenti: gli edit costano un messaggio vero e stanno dentro il
   * pavimento della stanza, le bozze sono anteprime animate e il loro
   * streaming deve scorrere. 1,5 s faceva arrivare il testo a scatti.
   */
  const DRAFT_TICK_MS = 350;
  const draftEveryMs = Math.max(1, Math.floor(negotiation.draftTtlMs / 3) || DRAFT_TICK_MS) < DRAFT_TICK_MS
    ? Math.max(1, Math.floor(negotiation.draftTtlMs / 3) || DRAFT_TICK_MS)
    : DRAFT_TICK_MS;
  const draftId = prossimoDraftId++;
  let draftText = '';
  /**
   * La bozza costruita come **gli stessi blocchi** del messaggio finale
   * (processo in `details` chiuso + risposta nativa), quando la risposta si
   * può strutturare. Ha precedenza su `draftText` (fallback HTML): così il
   * passaggio bozza → finale è una piega del processo, non un secondo
   * rendering — la lamentela dell'owner del 2026-09-27.
   */
  let draftRich: OutboundRich | null = null;
  let draftTimer: NodeJS.Timeout | null = null;
  let draftDisabled = !draftEnabled;
  /**
   * La bozza ha già mostrato **contenuto vero** (un passo o il preambolo), non
   * solo lo stato del turno. Distingue la prima pittura del processo — che
   * deve partire subito, nello stack di `report()` — dal rinnovo che coagula.
   */
  let draftPaintedContent = false;
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
  /** Lo stesso testo della risposta che si forma, **markdown grezzo**: è ciò
   * che alimenta i blocchi della bozza (`buildBlocks`), mentre `liveText` è la
   * sua resa HTML per il fallback legacy. */
  let liveMarkdown = '';
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
  /**
   * The transcript rides rich (Bot API 10.1+) like everything else on this
   * surface. A **deterministic** refusal (a `TelegramError` with a status)
   * flips this off for the rest of the turn, and every later send/edit goes
   * back to the legacy methods — a transport refusal must never cost the owner
   * the transcript. An ambiguous status-0 failure (the request may already
   * have landed) does NOT flip it and does not re-send: the turn disables the
   * transcript instead of risking a duplicate.
   */
  let richTransport = true;
  /**
   * La domanda di approvazione in attesa: capability, id già nel registro e
   * segmento che la ospita. Finché è viva, ogni edit del segmento ripassa la
   * tastiera (la pagina ufficiale non promette cosa succede se `reply_markup`
   * è omesso); quando l'owner risponde (`resolveAsk`) o il turno si ferma
   * (`stop`) la tastiera si toglie per costruzione.
   */
  const pendingAsks: { capability: string; approvalId: string; seg: Segment }[] = [];
  /**
   * Il turno ha aperto il suo messaggio vero, anche in una stanza che
   * preferirebbe la bozza.
   *
   * Eccezione deliberata alla scelta B (2026-09-26): una domanda di
   * approvazione ha pulsanti, e una bozza effimera non può portarli. Da qui
   * in poi il turno vive sul messaggio — la risposta che si forma lo edita e
   * la consegna finale lo ripiega nel Processo — invece di lasciare la bolla
   * della domanda accanto a un secondo messaggio (l'owner, 2026-09-29:
   * quattro comandi, quattro bolle residue).
   */
  let messaggioDelTurno = false;

  /** Send or edit the transcript message, rich first, legacy as the fallback. */
  async function sendHtml(
    kind: 'send' | 'edit',
    messageId: number | null,
    html: string,
    keyboard?: ReturnType<typeof askKeyboard>,
  ): Promise<{ message_id: number } | boolean> {
    const rich = richFromHtml(html);
    if (richTransport) {
      try {
        if (kind === 'send') {
          return await api.sendRichMessage(chatId, rich, {
            ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
            ...(keyboard === undefined ? {} : { keyboard }),
          });
        }
        return await api.editMessageRichText(chatId, messageId!, rich, keyboard === undefined ? {} : { keyboard });
      } catch (error) {
        if (nonModificato(error)) throw error;
        // Fall back ONLY on a deterministic refusal (a status > 0). A status-0
        // failure is ambiguous — Telegram may already have accepted the
        // message — and re-sending here would duplicate the transcript. This
        // mirrors `delivery.ts`, which records `possibly_sent` and does not
        // retry. The caller disables the transcript on the rethrow.
        if (!(error instanceof TelegramError && error.status > 0)) throw error;
        richTransport = false;
        log(`telegram: trasporto rich rifiutato, torno a legacy — ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (kind === 'send') {
      return await api.sendMessage(chatId, html, {
        ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
        ...(keyboard === undefined ? {} : { keyboard }),
      });
    }
    return await api.editMessageText(chatId, messageId!, html, keyboard === undefined ? {} : { keyboard });
  }

  function current(): Segment {
    const last = segments[segments.length - 1];
    if (last !== undefined && !last.closed) return last;
    const fresh: Segment = { messageId: null, html: '', plain: '', steps: [], shown: undefined, closed: false };
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

  /**
   * Il processo del turno, separato in due parti — la forma che l'owner ha
   * chiesto il 2026-09-27: **quello che sta succedendo adesso** sta sotto
   * «Processo» (visibile), **quello già successo** entra dentro il `details`
   * (chiuso). Il consuntivo per il finale (`settled`) non ha un passo in
   * corso: un passo lasciato a metà diventa «interrotto», come nella
   * trascrizione persistente.
   */
  function turnProcess(settled: boolean): { done: string[]; running: string | null } {
    const done: string[] = [];
    let running: string | null = null;
    for (const seg of segments) {
      if (seg.plain.trim() !== '') done.push(...seg.plain.trim().split('\n'));
      for (const step of seg.steps) {
        const mark =
          step.state === 'running'
            ? '⏳'
            : step.state === 'done'
              ? '✓'
              : step.state === 'error'
                ? '✗'
                : step.state === 'waiting'
                  ? '⏸'
                  : null;
        if (step.state === 'running') {
          if (settled) {
            done.push(`✗ ${step.plain} — interrotto`);
          } else {
            const s = Math.max(0, Math.round((now() - step.startedAt) / 1000));
            running = `⏳ ${step.plain} · ${s}s`;
          }
          continue;
        }
        done.push(mark === null ? step.plain : `${mark} ${step.plain}`);
      }
    }
    return { done, running };
  }

  function addStep(step: Step): void {
    // Il processo non apre più un messaggio vero quando la stanza ha la
    // bozza: i passi restano nella bozza effimera (sotto il preambolo, sopra
    // la risposta che si forma) e nessun `sendMessage` li persiste. È la
    // scelta B: un turno che muore non lascia una bolla a metà, e la sola
    // cosa durevole del turno è la risposta finale.
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
    // Finché la domanda è in attesa, la tastiera viaggia con **ogni** edit del
    // segmento che la ospita: omesso, `reply_markup` non ha una semantica
    // promessa dalla pagina ufficiale, e un edit del processo non deve poter
    // far sparire i pulsanti.
    const inAttesa = [...pendingAsks].reverse().find((p) => p.seg === seg);
    const keyboard = inAttesa === undefined ? undefined : askKeyboard(inAttesa.capability, inAttesa.approvalId);
    lastCallAt = now();
    finestra.push(lastCallAt);
    everSent = true;
    try {
      if (seg.messageId === null) {
        const message = (await sendHtml('send', null, text, keyboard)) as { message_id: number };
        seg.messageId = message.message_id;
      } else {
        await sendHtml('edit', seg.messageId, text, keyboard);
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
    if (draftTimer !== null) {
      clearTimeout(draftTimer);
      draftTimer = null;
    }
  }

  /**
   * La bozza tiene la **coda** del turno quando il processo intero non ci
   * sta: si lasciano cadere righe intere dalla testa (i passi più vecchi),
   * mai una riga tagliata a metà. La risposta completa resta comunque nel
   * messaggio finale; l'anteprima è effimera e mostra il presente.
   */
  /**
   * La coda del markdown resa leggibile quando il rendering HTML eccede il
   * limite di un messaggio: si tengono le ultime righe **intere** che ci
   * stanno. È un'anteprima, non il messaggio: il finale resta completo.
   */
  function legacyTail(markdown: string): string {
    const lines = markdown.trim().split('\n');
    const kept: string[] = [];
    let size = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i] ?? '';
      if (size + line.length + 1 > TELEGRAM_MAX - 64) break;
      kept.unshift(line);
      size += line.length + 1;
    }
    const text = kept.join('\n');
    return text === '' ? '' : toTelegramHtml(text);
  }

  function boundDraft(html: string): string {
    if (html.length <= TELEGRAM_MAX) return html;
    const lines = html.split('\n');
    while (lines.length > 1 && lines.join('\n').length > TELEGRAM_MAX) lines.shift();
    const last = lines[lines.length - 1] ?? '';
    return last.length <= TELEGRAM_MAX ? last : '';
  }

  /**
   * L'unico scrittore della bozza in modalità draft: rende il processo
   * accumulato (preambolo + passi) più la risposta che si forma, e lo manda
   * come anteprima. Sostituisce, in DM, sia `syncAll` sia la vecchia logica
   * «draft finché non c'è un messaggio vero»: qui non nasce mai un messaggio
   * vero.
   */
  function refreshDraft(push: boolean): void {
    if (stopped || draftDisabled || messaggioDelTurno) return;
    // Dentro il `details` i passi già fatti (senza contatore); sotto, la riga
    // di quello che sta succedendo adesso, col suo tempo. Il presente si
    // vede, il consuntivo si può chiudere.
    const { done, running } = turnProcess(false);
    const answer = liveMarkdown;
    const hasContentNow = done.length > 0 || running !== null || answer !== '';
    // La prima pittura di contenuto va sul filo subito (deve battere un
    // handler che blocca il loop), il resto si coagula col timer.
    const firstContent = hasContentNow && !draftPaintedContent;
    draftPaintedContent = draftPaintedContent || hasContentNow;

    if (!hasContentNow) {
      // Nessun contenuto ancora: il segnaposto è il blocco `thinking` (Bot API
      // 10.2, valido solo nelle bozze), non una riga corsiva. `draftText` resta
      // il gemello di testo: un rifiuto rich non deve spegnere l'anteprima.
      const s = draftStatusText();
      if (s === '') {
        draftText = '';
        draftRich = null;
        return;
      }
      draftText = s;
      draftRich = thinkingRich(s);
      if (push) void pushDraft().then(() => scheduleDraft());
      else scheduleDraft();
      return;
    }

    // La stessa forma del finale: `details` **chiuso** come nel messaggio
    // finale, con il passo in corso nella riga sempre visibile (`summary`) +
    // i blocchi della risposta. Così il passaggio bozza → finale cambia una
    // riga di riepilogo, non il rendering.
    const turn = turnRichMessage({ process: done, running, answer });
    // Il rendering HTML resta calcolato sempre: è il fallback se i blocchi
    // vengono rifiutati, e la forma per un parziale non strutturabile.
    const rendered = boundDraft(render(current(), true, now(), liveText));
    // La famiglia la decide lo stesso criterio del finale: se il turno supera
    // il tetto di protocollo, **entrambi** restano legacy — la bozza non tiene
    // i blocchi mentre il finale li perde, perché sarebbe di nuovo il cambio
    // forma al momento dello swap. È l'unica eccezione a «sempre blocchi», ed
    // è la stessa su tutte e due le superfici.
    if (turn !== null && richFitsHard(turn) === null) {
      draftText = rendered;
      draftRich = turn;
    } else {
      // Famiglia legacy: il testo (HTML) del processo, o la coda intera del
      // markdown quando il rendering HTML non è disponibile (testo che supera
      // il limite di un messaggio). Righe intere, mai tagliate a metà.
      const legacy = rendered !== '' ? rendered : legacyTail(answer);
      if (legacy === '') {
        draftText = '';
        draftRich = null;
        return;
      }
      draftText = legacy;
      draftRich = null;
    }
    if (push || firstContent) void pushDraft().then(() => scheduleDraft());
    else scheduleDraft();
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
    if (stopped || draftDisabled || messaggioDelTurno) return;
    const payload = draftText;
    if (payload === '' && draftRich === null) return;
    try {
      if (draftRich !== null && richTransport) {
        // La bozza strutturata: la stessa famiglia di blocchi del finale.
        await api.sendRichMessageDraft(chatId, draftId, draftRich, { canStop: true });
      } else if (richTransport) {
        await api.sendRichMessageDraft(chatId, draftId, richFromHtml(payload), { canStop: true });
      } else {
        await api.sendMessageDraft(chatId, draftId, payload, { canStop: true });
      }
    } catch (error) {
      if (nonModificato(error)) return;
      // Un rifiuto deterministico non spegne l'anteprima: `draftText` è sempre
      // il gemello di testo (anche della bozza a blocchi e del `thinking`), e
      // si riprova su quello.
      if (richTransport) {
        richTransport = false;
        if (payload !== '') {
          try {
            await api.sendMessageDraft(chatId, draftId, payload, { canStop: true });
            return;
          } catch (legacyError) {
            if (nonModificato(legacyError)) return;
          }
        }
      }
      draftDisabled = true;
      log(`telegram: anteprima del turno sospesa — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Lo stato del turno, testo semplice: è il contenuto del blocco `thinking`. */
  function draftStatusText(): string {
    if (status === null) return '';
    const s = Math.max(0, Math.round((now() - turnStartedAt) / 1000));
    return `${status} · ${s}s`;
  }

  /**
   * L'anteprima ha qualcosa da dire appena il turno inizia a pensare, non
   * solo al primo token: chiamata da `report` finché nessun segmento
   * persistente esiste. Un rinnovo già in corso basta — al prossimo giro
   * legge comunque lo stato aggiornato.
   */
  function ensureDraftStatus(): void {
    if (stopped || draftDisabled || !draftEnabled || messaggioDelTurno) return;
    if (segments.some(hasContent)) return;
    if (draftTimer !== null) return;
    refreshDraft(true);
  }

  /**
   * Il rinnovo. Riparte da solo finché c'è testo **o stato** da mostrare, e
   * questo è il punto dell'intera fetta: senza questa ri-programmazione
   * l'anteprima scade dopo `draftTtlMs` e l'owner guarda il vuoto — il difetto
   * misurato il 04/09 e chiuso allora togliendo la bolla invece che
   * rinnovandola.
   */
  function scheduleDraft(): void {
    if (stopped || draftDisabled || messaggioDelTurno || draftTimer !== null) return;
    if (draftText === '' && draftRich === null && status === null) return;
    draftTimer = setTimeout(() => {
      draftTimer = null;
      // Ricalcola, non rimpiazzare: il contatore di un passo che gira deve
      // avanzare anche se nessun evento lo tocca (era il difetto «· 2s per
      // quaranta secondi»).
      refreshDraft(true);
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
    // In DM il processo vive solo nella bozza: nessun send/edit persistente —
    // finché una domanda di approvazione non ha aperto il messaggio del turno.
    if (draftEnabled && !messaggioDelTurno) return;
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
    // In una stanza a bozza, finché la domanda non apre il messaggio vero:
    // da lì in poi gli edit vanno sul segmento persistente come in un gruppo.
    if (draftEnabled && !messaggioDelTurno) return;
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
    // In DM non c'è un primo send da far nascere: il processo va in bozza e
    // basta. `refreshDraft` è l'unico scrittore lì — finché una domanda di
    // approvazione non apre il messaggio del turno.
    if (draftEnabled && !messaggioDelTurno) {
      refreshDraft(false);
      return;
    }
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
      started = sendHtml('send', null, text) as Promise<{ message_id: number }>;
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
      liveMarkdown = '';
      // In DM il preambolo è parte del processo: resta nella bozza, che
      // `refreshDraft` ricompone subito con le sue righe. Solo in una stanza
      // senza bozza — o dopo che una domanda ha aperto il messaggio del
      // turno — il testo passa davvero in un messaggio e l'anteprima ha
      // finito il suo lavoro (difetto A).
      if (!draftEnabled || messaggioDelTurno) abbandonaDraft();
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
        // The whole preamble, unescaped, once — even when it spans several
        // messages, so the collapsed process keeps every word.
        seg.plain = trimmed;
      }
      if (reason === 'superseded' && trimmed !== '') {
        addStep({ line: '↺ quel tentativo è stato sostituito', plain: '↺ quel tentativo è stato sostituito', state: 'note', startedAt: now() });
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
        case 'model_retry':
          // Un retry silenzioso è indistinguibile da uno stallo: l'attesa è
          // dichiarata, e la ragione dice quale budget si sta spendendo.
          status =
            event.class === 'provider_empty'
              ? `il provider ha risposto vuoto — riprovo (${event.attempt}/${event.max}) tra ${Math.max(1, Math.round(event.inMs / 1000))}s`
              : `il provider non ha risposto — riprovo (${event.attempt}/${event.max}) tra ${Math.max(1, Math.round(event.inMs / 1000))}s`;
          break;
        case 'tool_start':
          status = null;
          addStep({ ...stepOf(event.name, event.args), state: 'running', startedAt: now() });
          break;
        case 'tool_retry': {
          const seg = current();
          const step = [...seg.steps].reverse().find((s) => s.state === 'running');
          const retry = `${toolPhrase(event.name)}: non risponde, riprovo (${event.attempt}/3)`;
          if (step) {
            step.line = escapeHtml(retry);
            step.plain = retry;
          } else addStep({ line: escapeHtml(retry), plain: retry, state: 'running', startedAt: now() });
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
            if (event.args !== undefined) {
              const settled = stepOf(event.name, event.args);
              step.line = settled.line;
              step.plain = settled.plain;
            }
          } else {
            addStep({ ...stepOf(event.name, event.args), state: event.isError ? 'error' : 'done', startedAt: now() });
          }
          break;
        }
        case 'ask':
          status = null;
          // La domanda può essere già stata mostrata da `ask()` — l'approvatore
          // di Telegram parla *prima* che il loop emetta questo evento: stesso
          // passo, mai due.
          if ([...current().steps].reverse().some((s) => s.state === 'waiting' && s.capability === event.capability)) break;
          addStep({ line: escapeHtml(`${toolPhrase(event.name)}: aspetto la tua approvazione`), plain: `${toolPhrase(event.name)}: aspetto la tua approvazione`, state: 'waiting', startedAt: now(), capability: event.capability });
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

    resolveAsk(ask, allowed) {
      if (stopped || disabled) return;
      // La tastiera appartiene alla trascrizione finché **quella** domanda è
      // in attesa: si toglie per costruzione, e il messaggio resta con il
      // passo risolto. Con più domande sullo stesso segmento la tastiera
      // passa a quella ancora aperta. La chiave è l'id dell'approvazione, non
      // la capability: due `sys.shell` su comandi diversi sono due domande, e
      // risolverne una non deve toccare la tastiera o il passo dell'altra
      // (#745).
      const voce = pendingAsks.findIndex((p) => p.approvalId === ask.approvalId);
      if (voce !== -1) {
        const { seg } = pendingAsks[voce]!;
        pendingAsks.splice(voce, 1);
        if (seg.messageId !== null) {
          const ultima = [...pendingAsks].reverse().find((p) => p.seg === seg);
          void api
            .editMessageReplyMarkup(chatId, seg.messageId, ultima === undefined ? [] : askKeyboard(ultima.capability, ultima.approvalId))
            .catch((error: unknown) => {
              log(`telegram: tastiera non rimossa — ${error instanceof Error ? error.message : String(error)}`);
            });
        }
      }
      for (let i = segments.length - 1; i >= 0; i--) {
        const seg = segments[i]!;
        const step = [...seg.steps].reverse().find((s) => s.state === 'waiting' && s.approvalId === ask.approvalId);
        if (step === undefined) continue;
        step.state = allowed ? 'done' : 'error';
        // Il contenuto della domanda (prompt, descrizione, comando) **resta**
        // nel passo: il Processo è dove la domanda si ripiega, e sostituirla
        // con la sola parola «consentito» perderebbe l'unica traccia visibile
        // di cosa è stato approvato.
        const resolved = `${ask.capability}: ${allowed ? 'consentito' : 'rifiutato'}`;
        step.line = escapeHtml(`${step.plain}\n${resolved}`);
        step.plain = `${step.plain}\n${resolved}`;
        scheduleSoon();
        return;
      }
    },

    async ask({ request, approvalId }) {
      if (stopped || disabled) return false;
      let seg = current();
      let esistente: { seg: Segment; step: Step } | undefined;
      for (let i = segments.length - 1; i >= 0 && esistente === undefined; i--) {
        const s = segments[i]!;
        const step = [...s.steps].reverse().find((x) => x.state === 'waiting' && x.approvalId === approvalId);
        if (step !== undefined) esistente = { seg: s, step };
      }
      if (esistente === undefined) {
        addStep({ line: askHtml(request), plain: askPlain(request), state: 'waiting', startedAt: now(), capability: request.capability, approvalId });
        // `addStep` può aver ruotato il segmento (overflow): la domanda vive
        // dove è stata scritta davvero.
        seg = current();
      } else {
        seg = esistente.seg;
      }
      // La tastiera non vive su un'anteprima effimera: da qui in poi il turno
      // ha il suo messaggio vero, e la risposta che si forma lo edita.
      messaggioDelTurno = true;
      abbandonaDraft();
      // Una voce per **approvazione**: un re-ask della stessa domanda (stesso
      // id, riusato dallo store) riusa la voce e la sposta in coda; una
      // seconda domanda della stessa capability su un'altra risorsa è
      // un'altra voce, con la sua riga e la sua tastiera (#745).
      const voce = pendingAsks.findIndex((p) => p.approvalId === approvalId);
      const pending = { capability: request.capability, approvalId, seg };
      if (voce !== -1) pendingAsks.splice(voce, 1);
      pendingAsks.push(pending);
      // Serializzata col writer, e **dopo** una prima pittura in volo: in un
      // gruppo/topic il primo tool può aver già avviato la sua `sendMessage`
      // (`trySyncFirstPaint`), e senza aspettarla questa domanda ne manderebbe
      // una seconda invece di editarla — e scriverebbe l'id sbagliato nel
      // segmento (review 2026-09-29).
      const shownPrima = seg.shown;
      await enqueue(async () => {
        await sendSegment(seg, true, '');
      });
      if (disabled || seg.messageId === null) {
        // Nessun messaggio vivo: il chiamante ripiega sul messaggio autonomo.
        const i = pendingAsks.indexOf(pending);
        if (i !== -1) pendingAsks.splice(i, 1);
        return false;
      }
      // La tastiera si (ri)attacca quando nessun edit è partito — testo
      // identico, cioè il re-ask della stessa capability dopo una decisione:
      // `sendSegment` esce senza toccare il filo e la domanda resterebbe
      // visibile ma muta.
      if (seg.shown === shownPrima) {
        try {
          await api.editMessageReplyMarkup(chatId, seg.messageId, askKeyboard(request.capability, approvalId));
        } catch (error) {
          if (!nonModificato(error)) {
            log(`telegram: tastiera della domanda non attaccata — ${error instanceof Error ? error.message : String(error)}`);
            const i = pendingAsks.indexOf(pending);
            if (i !== -1) pendingAsks.splice(i, 1);
            return false;
          }
        }
      }
      // La domanda è sul messaggio del turno: chi registra la scrive nel
      // registro durevole (#784). Protetta: la domanda è già mostrata, e un
      // gancio che lancia non deve trasformarla in un ripiego.
      try {
        options.onAsked?.({ approvalId, messageId: seg.messageId });
      } catch (error) {
        log(`telegram: domanda non registrata — ${error instanceof Error ? error.message : String(error)}`);
      }
      return true;
    },

    live(text) {
      if (stopped || disabled || !liveEnabled) return;
      const trimmed = text.trim();
      // La bozza vive solo finché non esiste un messaggio vero (difetto A):
      // dal primo segmento con contenuto in poi il testo che si forma va nel
      // segmento persistente (edit), mai in una nuova bozza. Solo così la
      // risposta finale di un turno con tool non lascia un'anteprima appesa
      // che nessun `sendMessage` verrà a sostituire (`deliverTo` in quel caso
      // fa un edit, e un edit non tocca la bozza). Una domanda di
      // approvazione apre quel messaggio prima del primo token: da lì in poi
      // vale la stessa regola.
      if (draftEnabled && !messaggioDelTurno) {
        // La stanza preferisce l'anteprima: il testo che sta arrivando non
        // tocca nessun messaggio vero, e la risposta finale resta l'unico
        // messaggio che la chat conserva. Il processo accumulato (`render`)
        // sta sopra la coda che si forma, così la bozza mostra l'uno e
        // l'altra insieme.
        if (draftDisabled) return;
        if (trimmed === '') {
          liveText = '';
          liveMarkdown = '';
          refreshDraft(false);
          return;
        }
        // Il markdown intero guida i blocchi; il gemello HTML solo finché ci
        // sta. Oltre, `refreshDraft` decide la famiglia sul turno completo
        // (blocchi se ci sta nel protocollo, legacy altrimenti) — mai una
        // bozza a blocchi con un finale legacy.
        const rendered = toTelegramHtml(trimmed);
        liveText = rendered.length <= TELEGRAM_MAX ? rendered : '';
        liveMarkdown = trimmed;
        refreshDraft(false);
        return;
      }
      if (trimmed === '') {
        liveMarkdown = '';
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
      const process = turnProcess(true).done;
      if (draftEnabled && !messaggioDelTurno) {
        // Niente messaggio persistente da estendere: il processo è la bozza
        // (effimera) e `deliverTo` manderà un messaggio nuovo con il blocco
        // `details`. `null` solo quando non c'è proprio niente da collassare.
        //
        // `processHtml` copre **tutti** i segmenti: è il fallback legacy, e un
        // rifiuto rich non deve far sparire il preambolo o i passi dei
        // segmenti precedenti (il solo `process` non basta — è testo semplice).
        const processHtml = segments
          .map((s) => render(s, false, now()))
          .filter((t) => t !== '')
          .join('\n\n');
        if (process.length === 0 && processHtml === '') return null;
        return { messageId: null, process, processHtml };
      }
      if (seg.messageId === null) return null;
      return { messageId: seg.messageId, process, processHtml: render(seg, false, now()) };
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      // Un turno che finisce con domande ancora in attesa non deve lasciare
      // pulsanti vivi su richieste che nessuno deciderà più.
      if (pendingAsks.length > 0) {
        const conTastiera = new Set(pendingAsks.map((p) => p.seg));
        pendingAsks.length = 0;
        for (const seg of conTastiera) {
          if (seg.messageId === null) continue;
          void api.editMessageReplyMarkup(chatId, seg.messageId).catch((error: unknown) => {
            log(`telegram: tastiera non rimossa — ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      }
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
      liveMarkdown = '';
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      status = null;
      // In DM non c'è nessun messaggio persistente da finalizzare: la bozza
      // smette solo di rinnovarsi e sparisce per TTL. La risposta finale è
      // l'unica cosa che resta. Con il messaggio del turno aperto da una
      // domanda, invece, si finalizza come in un gruppo.
      if (draftEnabled && !messaggioDelTurno) return;
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
