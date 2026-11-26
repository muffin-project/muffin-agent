import { redactText, scrubResourceEchoes } from '../../core/tracing/redact.js';

/** Longest conversational preamble that may become a durable mid-turn message. */
export const MAX_PREAMBLE_CHARS = 280;
/** A preamble is at most two complete sentences. */
export const MAX_PREAMBLE_SENTENCES = 2;
/** Minimum gap between two durable interims (preamble or work_message) in one turn. */
export const INTERIM_COOLDOWN_MS = 8_000;
/** At most one promoted Pattern-A preamble per turn. */
export const MAX_PREAMBLES_PER_TURN = 1;

export type InterimSource = 'preamble' | 'work_message';

/** Where a qualified preamble may be delivered. */
export type InterimDestination = 'telegram' | 'repl' | 'none';

export type QualifyInterimPreambleInput = {
  /** Raw model text from this round (`result.text`), before this helper scrubs it. */
  text: string;
  sensitiveResourceEchoes: readonly string[];
  /** Only `tool-call` may promote; `superseded` is a replaced attempt. */
  boundary: 'tool-call' | 'superseded';
  destination: InterimDestination;
  workMessageInBatch: boolean;
  preamblesAlreadyPromoted: number;
  lastInterimAtMs: number | null;
  priorInterimTexts: readonly string[];
  nowMs: number;
};

export type QualifyInterimPreambleResult =
  | { ok: true; text: string }
  | { ok: false; reason: QualifyInterimRejectReason };

export type QualifyInterimRejectReason =
  | 'empty'
  | 'superseded'
  | 'destination'
  | 'work_message_in_batch'
  | 'budget'
  | 'cooldown'
  | 'dedup'
  | 'too_long'
  | 'too_many_sentences'
  | 'open_ended'
  | 'code'
  | 'partial_answer'
  | 'secret_trace';

/**
 * Map a turn onto the one destination that may receive a durable preamble.
 * Jobs, `minimal` prompts, and surfaces without a live conversational sink are `none`.
 */
export function interimDestination(input: {
  surface: string;
  promptMode?: 'interactive' | 'minimal' | undefined;
  jobId?: string | undefined;
  hasLiveSink: boolean;
}): InterimDestination {
  if (input.jobId !== undefined || input.promptMode === 'minimal') return 'none';
  if (input.surface === 'telegram') return 'telegram';
  if (input.surface === 'cli' && input.hasLiveSink) return 'repl';
  return 'none';
}

/**
 * Pure Pattern-A gate. Applies `redactText` + `scrubResourceEchoes` first.
 * Never inspects thinking/reasoning blocks — the caller must pass `result.text` only.
 */
export function qualifyInterimPreamble(
  input: QualifyInterimPreambleInput,
): QualifyInterimPreambleResult {
  if (input.boundary !== 'tool-call') return fail('superseded');
  if (input.destination === 'none') return fail('destination');
  if (input.workMessageInBatch) return fail('work_message_in_batch');
  if (input.preamblesAlreadyPromoted >= MAX_PREAMBLES_PER_TURN) return fail('budget');
  if (input.lastInterimAtMs !== null && input.nowMs - input.lastInterimAtMs < INTERIM_COOLDOWN_MS) {
    return fail('cooldown');
  }

  const text = scrubResourceEchoes(redactText(input.text), input.sensitiveResourceEchoes).trim();
  if (text === '') return fail('empty');
  if (hasSecretTrace(text)) return fail('secret_trace');
  if (input.priorInterimTexts.some((prior) => prior === text)) return fail('dedup');
  if ([...text].length > MAX_PREAMBLE_CHARS) return fail('too_long');
  if (looksLikeCode(text)) return fail('code');
  if (endsOpen(text)) return fail('open_ended');
  if (sentenceCount(text) > MAX_PREAMBLE_SENTENCES) return fail('too_many_sentences');
  if (isPartialAnswerOpener(text)) return fail('partial_answer');
  return { ok: true, text };
}

function fail(reason: QualifyInterimRejectReason): QualifyInterimPreambleResult {
  return { ok: false, reason };
}

function hasSecretTrace(text: string): boolean {
  if (text.includes('«redacted:')) return true;
  // URL with userinfo (https://user:pass@host) — never promote a credential echo.
  return /https?:\/\/[^/\s]*:[^/\s]*@/i.test(text);
}

function looksLikeCode(text: string): boolean {
  if (text.includes('```')) return true;
  return /^(?: {4,}|\t)\S/m.test(text);
}

function endsOpen(text: string): boolean {
  const trimmed = text.trimEnd();
  if (trimmed.endsWith(':') || trimmed.endsWith('：')) return true;
  if (/(?:\n\s*[-*+]\s*|\n\s*\d+[.)]\s*)$/.test(trimmed)) return true;
  return false;
}

function sentenceCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  const parts = trimmed
    .split(/(?<=[.!?…])(?:\s+|$)/u)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  return Math.max(1, parts.length);
}

/**
 * Complements that are already the start of the final answer, not an acknowledgment.
 * The streaming regression fixture `Ecco cosa ho trovato` must stay in this set.
 */
function isPartialAnswerOpener(text: string): boolean {
  const folded = text
    .trim()
    .replace(/[.!…]+$/u, '')
    .trim();
  return PARTIAL_ANSWER_OPENERS.some((pattern) => pattern.test(folded));
}

const PARTIAL_ANSWER_OPENERS: readonly RegExp[] = [
  /^ecco cosa ho trovato\b/iu,
  /^ecco (?:il|lo|la|i|gli|le|quanto|come|cos')\b/iu,
  /^ecco i risultati\b/iu,
  /^here's what i (?:found|got|have)\b/iu,
  /^here is what i (?:found|got|have)\b/iu,
  /^this is what i (?:found|got|have)\b/iu,
  /^i found the following\b/iu,
  /^ho trovato(?:\s|:|$)/iu,
];
