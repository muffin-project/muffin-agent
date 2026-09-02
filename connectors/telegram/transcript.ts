import type { TurnEvent } from '../../agent/loop.js';
import { toolLine, toolPhrase } from '../../agent/tool-phrase.js';
import type { TelegramApiLike } from './api.js';
import { escapeHtml, splitHtml, TELEGRAM_MAX, toTelegramHtml } from './render.js';

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
 * the answer — never twelve. The answer itself is not a segment: it goes
 * through the durable delivery (`delivery.ts`) exactly as before, and in a
 * private chat it previews in the draft (`presence.ts`) exactly as before.
 * What this file owns is everything *between* the question and the answer.
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
 * - **A segment with nothing in it is not sent.** A turn that answers
 *   without a single tool call produces no message from this file at all —
 *   the draft is its liveness in private, `sendChatAction` in groups.
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

/** Edit floor in a private chat — inside the per-chat ceiling with margin. */
const MIN_EDIT_PRIVATE_MS = 1_500;
/** Edit floor in a group — one per 3 s is the documented group ceiling. */
const MIN_EDIT_GROUP_MS = 3_000;
/** How long `stop()` waits for the final edit before letting the answer go out anyway. */
const STOP_WAIT_MS = 2_000;

type Step = {
  /** Already escaped: built from `toolLine`, which carries model-written arguments. */
  line: string;
  /** Running (`⏳`, with its own elapsed), or finished with a mark. */
  state: 'running' | 'done' | 'error' | 'waiting' | 'note';
  startedAt: number;
};

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
   * Last edit, then silence. Idempotent: the caller invokes it once right
   * after the turn and once more from its `finally`.
   */
  stop(): Promise<void>;
};

export type TranscriptOptions = {
  now?: () => number;
  /** Groups get the slower edit floor. Default: private. */
  isPrivate?: boolean;
  /** Traces a swallowed Bot API failure. Absent means silent. */
  log?: (line: string) => void;
};

export function startTranscript(api: TelegramApiLike, chatId: number, options: TranscriptOptions = {}): Transcript {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((): void => {});
  const minEditMs = options.isPrivate === false ? MIN_EDIT_GROUP_MS : MIN_EDIT_PRIVATE_MS;
  const turnStartedAt = now();

  const segments: Segment[] = [];
  let stopped = false;
  /** Set on the first failed send/edit. Never cleared. */
  let disabled = false;
  /** What the turn is doing when no step is running: `sto pensando`, `sto scrivendo la risposta`. */
  let status: string | null = null;
  let lastCallAt = 0;
  let flushTimer: NodeJS.Timeout | null = null;
  /** The call currently on the wire, so two never overlap and `messageId` is written by one send at a time. */
  let inFlight: Promise<void> | null = null;

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
   * line; the final render (`closed`) leaves only what happened.
   */
  function render(seg: Segment, live: boolean, at: number): string {
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
    if (live && status !== null && !running(seg)) {
      const s = Math.max(0, Math.round((at - turnStartedAt) / 1000));
      lines.push(`<i>${escapeHtml(status)} · ${s}s</i>`);
    }
    const stepsHtml = lines.join('\n');
    if (seg.html === '') return stepsHtml;
    return stepsHtml === '' ? seg.html : `${seg.html}\n\n${stepsHtml}`;
  }

  /** Whether `seg` can take one more step without leaving one message. */
  function fits(seg: Segment, step: Step): boolean {
    const probe: Segment = { ...seg, steps: [...seg.steps, step] };
    return render(probe, true, now()).length <= TELEGRAM_MAX;
  }

  function addStep(step: Step): void {
    let seg = current();
    if (hasContent(seg) && !fits(seg, step)) {
      seg.closed = true;
      seg = current();
    }
    seg.steps.push(step);
  }

  /** The one place that talks to Telegram for one segment. */
  async function sendSegment(seg: Segment, live: boolean): Promise<void> {
    if (disabled || !hasContent(seg)) return;
    const text = render(seg, live, now());
    if (text === seg.shown) return;
    lastCallAt = now();
    try {
      if (seg.messageId === null) {
        const message = await api.sendMessage(chatId, text);
        seg.messageId = message.message_id;
      } else {
        await api.editMessageText(chatId, seg.messageId, text);
      }
      seg.shown = text;
    } catch (error) {
      disabled = true;
      log(`telegram: trascrizione del turno sospesa — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Bring every segment up to date, in order: closed ones with their final
   * render (a segment closed before its first send still gets sent, so the
   * order on screen is the order of events), the open one live.
   */
  async function syncAll(finalPass: boolean): Promise<void> {
    for (const seg of segments) {
      if (seg.closed) {
        await sendSegment(seg, false);
      } else {
        await sendSegment(seg, !finalPass);
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

  function schedule(): void {
    if (stopped || disabled || flushTimer !== null) return;
    const wait = Math.max(0, minEditMs - (now() - lastCallAt));
    flushTimer = setTimeout(() => void flush(), wait);
  }

  return {
    spoke(text, reason) {
      if (stopped || disabled) return;
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
      schedule();
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
        case 'tool_start':
          status = null;
          addStep({ line: escapeHtml(toolLine(event.name, event.args)), state: 'running', startedAt: now() });
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
            // not the wait — when the end event brings the arguments back.
            if (event.args !== undefined) step.line = escapeHtml(toolLine(event.name, event.args));
          } else {
            addStep({ line: escapeHtml(toolLine(event.name, event.args)), state: event.isError ? 'error' : 'done', startedAt: now() });
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
      if (hasContent(current())) schedule();
    },

    async stop() {
      if (stopped) return;
      stopped = true;
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
