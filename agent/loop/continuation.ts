import { randomBytes } from 'node:crypto';
import type { Principal } from '../../core/policy/types.js';
import type { SessionRef, SessionStore } from '../../core/session/store.js';
import { tierOf } from '../../core/surface/types.js';
import type { StoredContinuationCandidate, TurnCounters, TurnRecord, TurnStore } from '../../core/turns/store.js';
import type { Message } from '../providers/types.js';
import { harnessMessage, splitWorkEvidence } from './message-origin.js';
import { MAX_TRANSPORT_RETRIES, type TurnResult } from './types.js';

/**
 * Conversational continuation on an explicit owner grant (P0-B).
 *
 * One surface-independent primitive set: surfaces (Telegram's claim,
 * `runWork`, `muffin resume`) invoke these, they never implement
 * continuation semantics themselves. The durable transition itself stays in
 * `TurnStore.grantContinuation`; what lives here is everything around it
 * that must also be single-owned:
 *
 * - `resolveContinuation`: which continuable row, if any, an owner message
 *   names — deterministic, conservative, no LLM, no memory.
 * - `buildFreshCounters`: THE lease-reset contract (see the table below).
 * - `splitWorkEvidence` reuse: expired harness control stays out of the new
 *   lease (archived in `turn_leases` at release time, never replayed).
 * - `explicitResumeMessage`: the harness-marked user turn for non-textual
 *   grants (`muffin resume`), so a lease renewal without owner words is
 *   still provenance-honest and still stripped at the next continuation.
 */

/** Only rows this recent may auto-continue: older work is ordinary conversation. */
export const CONTINUATION_TTL_MS = 24 * 60 * 60 * 1000;

/** A disambiguation question expires fast: it is transient UI state, not work. */
export const PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * The lease-reset contract, implemented once.
 *
 * - turn-cumulative: `iterations` (monotonic span numbering), preserved.
 * - lease-local, profile-fresh: `recoveriesUsed` 0, `transportRetriesLeft`
 *   MAX, `truncationsUsed` 0, `toolCallsMade` 0, `nudgedForCompletion`
 *   false, `usage`/`spentUsd`/`activeModelMs` zeroed. The length-continuation
 *   budget resets here for the same reason transport does: the grant is
 *   explicit, authenticated and human-rate-limited — the opposite of the
 *   crash loop `resumes` guards.
 * - preserved, never reset: `resumes` (crash-loop bound, counted separately
 *   in `lifetime.leases`), `contextBuilt` (the preamble ran in lease 0 and
 *   never re-runs — enforced by the caller refusing unstarted rows).
 */
export function buildFreshCounters(from: TurnCounters): TurnCounters {
  return {
    iterations: from.iterations,
    recoveriesUsed: 0,
    transportRetriesLeft: MAX_TRANSPORT_RETRIES,
    truncationsUsed: 0,
    toolCallsMade: 0,
    nudgedForCompletion: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    spentUsd: 0,
    resumes: from.resumes,
    contextBuilt: from.contextBuilt,
    activeModelMs: 0,
  };
}

/** A harness-marked user turn recording a non-textual lease grant. */
export function explicitResumeMessage(turnShortId: string): Message {
  return harnessMessage('user', [
    {
      type: 'text',
      text:
        `Continuazione esplicita del turno ${turnShortId} concessa dal proprietario ` +
        `(comando diretto, non messaggio in conversazione). Continua il lavoro interrotto senza ripetere gli effetti già registrati.`,
    },
  ]);
}

export type ContinuationCandidate = StoredContinuationCandidate;

export type ContinuationMatch =
  | { kind: 'single'; turnId: string }
  | { kind: 'ambiguous'; candidates: ContinuationCandidate[] }
  | { kind: 'none' };

const KEYWORDS = ['riprendi', 'continua', 'vai avanti', 'prosegui', 'riparti'] as const;

/** Tails that carry no new object: politeness, or a manner clause. Anything else is ordinary conversation. */
const POLITE_TAILS = ['per favore', 'per piacere', 'pure', 'ancora', 'dai', 'grazie'] as const;
const MANNER_HEADS = ['senza ', 'da dove', 'come ', 'dove ', 'dal punto in cui '] as const;

function normalizeText(text: string): string {
  // Commas never carry the new-object distinction in a two-word command;
  // stripping them keeps "riprendi, per favore" on the grant path while any
  // added noun ("riprendi quel testo") still fails the tail rule below.
  return text
    .toLowerCase()
    .replace(/,/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!.?…]+$/, '')
    .trim();
}

function stripPoliteTail(tail: string): string {
  let rest = tail;
  for (;;) {
    const hit = POLITE_TAILS.find((p) => rest === p || rest.endsWith(` ${p}`));
    if (hit === undefined) return rest;
    rest = rest.slice(0, rest.length - hit.length).trim();
  }
}

/**
 * Whether this message asks to continue previous work, without naming new
 * work. Conservative by construction: a tail with a direct object
 * ("riprendi quel testo e riscrivilo") or any new task framing is ordinary
 * conversation, never a grant.
 */
export function isContinuationAsk(text: string): boolean {
  const line = normalizeText(text);
  const keyword = KEYWORDS.find((k) => line === k || line.startsWith(`${k} `));
  if (keyword === undefined) return false;
  const tail = stripPoliteTail(line.slice(keyword.length).trim());
  if (tail === '') return true;
  return MANNER_HEADS.some((h) => tail.startsWith(h));
}

export function describeCandidate(reason: TurnRecord['continuableReason'], updatedAt: string): string {
  const when = updatedAt.slice(0, 16).replace('T', ' ');
  if (reason === null) return `turno interrotto (${when})`;
  const done = reason.completed !== undefined ? `, ${reason.completed.toolCalls} tool call completate` : '';
  return `turno ${reason.class} (${when}${done})`;
}

/**
 * Deterministic resolution of an owner message against continuable work.
 *
 * Exactly one eligible, recent row in the same owner/session → single (the
 * caller auto-continues, no confirmation). Zero → none (ordinary
 * conversation). More than one → ambiguous (the caller asks, never guesses).
 * Messages with attachments carry new content and never resolve.
 */
export function resolveContinuation(input: {
  turns: Pick<TurnStore, 'continuableFor'>;
  principal: Principal;
  sessionId: string;
  text: string;
  hasAttachment: boolean;
  nowMs: number;
}): ContinuationMatch {
  if (input.hasAttachment || !isContinuationAsk(input.text)) return { kind: 'none' };
  const since = new Date(input.nowMs - CONTINUATION_TTL_MS).toISOString();
  const rows = input.turns.continuableFor(input.sessionId, input.principal, since);
  if (rows.length === 0) return { kind: 'none' };
  if (rows.length === 1) return { kind: 'single', turnId: rows[0]!.id };
  return {
    kind: 'ambiguous',
    candidates: rows.map((r) => ({ id: r.id, updatedAt: r.updatedAt, summary: describeCandidate(r.reason, r.updatedAt) })),
  };
}

/**
 * Resolve "il primo" / "2" / an id prefix against the newest live ambiguity
 * question, read back from the durable store.
 *
 * Durability is the point: the question and its ordered candidates are frozen
 * on the question turn (`TurnStore.setContinuationCandidates`), so the answer
 * resolves after a gateway restart or from a second process over the same home
 * — the RAM map this replaces lost the question on every restart, and the
 * owner typed the number into a Muffin that had already forgotten it
 * (2026-09-25). The TTL still bounds it: an expired or absent question is
 * `null`, and the message proceeds as ordinary conversation. Because the list
 * is frozen, a candidate appearing or completing between question and answer
 * cannot shift the numbering.
 */
export function resolveFollowup(
  turns: Pick<TurnStore, 'latestContinuationQuestion'>,
  sessionId: string,
  text: string,
  nowMs: number,
): { turnId: string } | null {
  const since = new Date(nowMs - PENDING_TTL_MS).toISOString();
  const pending = turns.latestContinuationQuestion(sessionId, since);
  if (pending === null) return null;
  const line = normalizeText(text);
  const positionals: Record<string, number> = {
    'il primo': 0,
    'la prima': 0,
    primo: 0,
    prima: 0,
    '1': 0,
    'il secondo': 1,
    'la seconda': 1,
    secondo: 1,
    seconda: 1,
    '2': 1,
    'il terzo': 2,
    'la terza': 2,
    terzo: 2,
    terza: 2,
    '3': 2,
  };
  const at = positionals[line];
  if (at !== undefined) {
    const hit = pending.candidates[at];
    return hit === undefined ? null : { turnId: hit.id };
  }
  if (/^[0-9a-f]{6,32}$/.test(line)) {
    const hit = pending.candidates.find((c) => c.id.startsWith(line));
    return hit === undefined ? null : { turnId: hit.id };
  }
  return null;
}

/** Split the durable transcript for a new lease: evidence continues, harness control stays archived. */
export function evidenceForContinuation(messages: readonly Message[]): Message[] {
  return splitWorkEvidence(messages).evidence;
}

/**
 * The bind-time answer: which existing row should own this event, if any.
 *
 * Followups first ("il primo" answering an ambiguity question), then the
 * direct single match. Ambiguity itself returns null here — the event keeps
 * a fresh identity and `runWork` asks the question instead. Both layers
 * re-verify at execution time; this only routes the binding.
 */
export function routeContinuationTarget(input: {
  turns: Pick<TurnStore, 'continuableFor' | 'latestContinuationQuestion'>;
  principal: Principal;
  sessionId: string;
  text: string;
  hasAttachment: boolean;
  nowMs: number;
}): string | null {
  const follow = resolveFollowup(input.turns, input.sessionId, input.text, input.nowMs);
  if (follow !== null) return follow.turnId;
  const match = resolveContinuation(input);
  return match.kind === 'single' ? match.turnId : null;
}

/**
 * The continuation target vanished between bind and execution — completed
 * elsewhere, or claimed by a racing drain. Never recompute: the router
 * defers the event and `recover` resolves it against the durable row
 * (already → done, still running → later), without a second model call.
 */
export class ContinuationGone extends Error {
  constructor(readonly workId: string) {
    super(`continuation target gone for ${workId}`);
    this.name = 'ContinuationGone';
  }
}

/**
 * Ask which continuable work to continue, without calling the model.
 *
 * More than one eligible row is genuine ambiguity: guessing would continue
 * the wrong work. The deterministic question lists the candidates (short
 * id + summary) and records them, in order, on the question row itself so a
 * numeric answer can resolve them after a restart; the row it writes
 * is an ordinary answered turn, so delivery, settle and session history
 * behave exactly like any other exchange. The followup ("il primo", "2",
 * an id prefix) then routes through the normal continuation path.
 */
export async function askWhichContinuation(
  deps: {
    turns: TurnStore;
    sessions: SessionStore;
    model: string;
    now?: () => Date;
  },
  opts: {
    principal: Principal;
    tenant: string;
    surface: string;
    sessionId: string;
    session: SessionRef;
    text: string;
    replyTo?: Record<string, unknown>;
    candidates: ContinuationCandidate[];
  },
): Promise<TurnResult> {
  const now = deps.now ?? (() => new Date());
  const at = now();
  const lines = opts.candidates.map(
    (c, i) => `${i + 1}. turno ${c.id.slice(0, 12)} — ${c.summary}`,
  );
  const text =
    `Ho trovato ${opts.candidates.length} lavori continuabili in questa conversazione — dimmi quale continuo:\n` +
    lines.join('\n') +
    `\nRispondi con il numero o con l'inizio dell'id. Oppure scrivi altro per cambiare argomento.`;
  const id = randomBytes(16).toString('hex');
  const taint = tierOf(opts.principal);
  const record = deps.turns.create(
    {
      id,
      principal: opts.principal,
      tenant: opts.tenant,
      surface: opts.surface,
      sessionId: opts.sessionId,
      inputText: opts.text,
      providerLease: {
        model: deps.model,
        checkpoint: [{ role: 'user', content: [{ type: 'text', text: opts.text }] }],
      },
      taint,
      counters: {
        iterations: 0,
        recoveriesUsed: 0,
        transportRetriesLeft: MAX_TRANSPORT_RETRIES,
        truncationsUsed: 0,
        toolCallsMade: 0,
        nudgedForCompletion: false,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        spentUsd: 0,
        resumes: 0,
        // No preamble ever runs for this row (no model call, no recall), so
        // no lease ever starts executing: the terminal finish below folds
        // nothing and the open lease-0 audit row stays open-ended.
        contextBuilt: false,
        activeModelMs: 0,
      },
      ...(opts.replyTo === undefined ? {} : { replyTo: opts.replyTo }),
    },
    process.pid,
  );
  // Freeze the ordered candidates on the question row itself, in the same home
  // the answer will be read from. Durable so the numeric answer resolves after
  // a restart; a newer question shadows this one by `created_at`.
  deps.turns.setContinuationCandidates(record.id, opts.candidates);
  try {
    deps.sessions.append(opts.session, {
      role: 'user',
      content: opts.text,
      surface: opts.surface,
      createdAt: at.toISOString(),
      traceId: id,
      tier: taint,
    });
    deps.sessions.append(opts.session, {
      role: 'assistant',
      content: text,
      surface: opts.surface,
      createdAt: at.toISOString(),
      traceId: id,
      tier: taint,
    });
  } catch {
    // The row below is the durable half; a session write that fails leaves
    // the question deliverable but unrecorded, never a lost turn.
  }
  deps.turns.finish(
    id,
    {
      outcome: 'answered',
      messages: [
        { role: 'user', content: [{ type: 'text', text: opts.text }] },
        { role: 'assistant', content: [{ type: 'text', text }] },
      ],
      taint,
      counters: record.counters,
    },
    record.claimToken,
  );
  return {
    text,
    iterations: 0,
    traceId: id,
    turnId: id,
    stopped: 'answered',
    taint,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}
