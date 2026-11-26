import { createHash } from 'node:crypto';
import type { TrustTier } from '../../core/policy/types.js';
import type { SessionMessage, SessionRef, SessionStore } from '../../core/session/store.js';
import { WORK_MESSAGE_TOOL_NAME } from '../tools/work-message.js';
import {
  type InterimSource,
  interimDestination,
  qualifyInterimPreamble,
} from './interim-preamble.js';
import type { LoopDeps, TurnEvent, TurnInput } from './types.js';

export type DeliveredInterimBudget = {
  preambles: number;
  lastAtMs: number | null;
  texts: string[];
};

/** Interims already written to the session for this turn — survives a resume. */
export function deliveredInterimBudget(
  sessions: SessionStore,
  session: SessionRef,
  traceId: string,
): DeliveredInterimBudget {
  const texts: string[] = [];
  let preambles = 0;
  let lastAtMs: number | null = null;
  for (const message of sessions.read(session)) {
    if (
      message.role !== 'assistant' ||
      message.traceId !== traceId ||
      message.interim === undefined
    )
      continue;
    texts.push(message.content);
    if (message.interim === 'preamble') preambles += 1;
    const at = Date.parse(message.createdAt);
    if (Number.isFinite(at) && (lastAtMs === null || at > lastAtMs)) lastAtMs = at;
  }
  return { preambles, lastAtMs, texts };
}

export function interimJournalId(turnId: string, text: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['preamble', turnId, text]))
    .digest('hex');
}

export function interimSessionMessage(input: {
  text: string;
  source: InterimSource;
  surface: string;
  createdAt: string;
  traceId: string;
  tier: TrustTier;
}): SessionMessage {
  return {
    role: 'assistant',
    content: input.text,
    surface: input.surface,
    createdAt: input.createdAt,
    traceId: input.traceId,
    interim: input.source,
    tier: input.tier,
  };
}

async function emitInterim(
  onProgress: ((event: TurnEvent) => void) | undefined,
  text: string,
  source: InterimSource,
): Promise<void> {
  // Surfaces may return a Promise despite the `void` callback type
  // (TypeScript's void-callback rule). Await it so a fresh DM draft
  // is on the wire before the next model call.
  await (onProgress?.({ type: 'interim', text, source }) as void | Promise<void>);
}

/** Persist and announce an interim only after it was actually delivered. */
export async function recordDeliveredInterim(
  deps: LoopDeps,
  input: TurnInput,
  args: {
    text: string;
    source: InterimSource;
    traceId: string;
    tier: TrustTier;
    createdAt: string;
  },
): Promise<void> {
  const already = deliveredInterimBudget(deps.sessions, input.session, args.traceId);
  if (already.texts.includes(args.text)) return;
  deps.sessions.append(
    input.session,
    interimSessionMessage({
      text: args.text,
      source: args.source,
      surface: input.surface,
      createdAt: args.createdAt,
      traceId: args.traceId,
      tier: args.tier,
    }),
  );
  await emitInterim(input.onProgress, args.text, args.source);
}

export function batchHasWorkMessage(toolCalls: readonly { name: string }[]): boolean {
  return toolCalls.some((call) => call.name === WORK_MESSAGE_TOOL_NAME);
}

/**
 * Pattern A: if this round's `result.text` qualifies, deliver it (Telegram
 * journal, or already-visible REPL text) and only then record it.
 */
export async function promoteQualifiedPreamble(input: {
  deps: LoopDeps;
  turnInput: TurnInput;
  turnId: string;
  traceId: string;
  text: string | null | undefined;
  sensitiveResourceEchoes: readonly string[];
  toolCalls: readonly { name: string }[];
  tier: TrustTier;
  now: Date;
}): Promise<void> {
  const raw = input.text ?? '';
  const destination = interimDestination({
    surface: input.turnInput.surface,
    promptMode: input.turnInput.promptMode,
    jobId: input.turnInput.jobId,
    hasLiveSink: input.turnInput.onDelta !== undefined,
  });
  const budget = deliveredInterimBudget(
    input.deps.sessions,
    input.turnInput.session,
    input.traceId,
  );
  const qualified = qualifyInterimPreamble({
    text: raw,
    sensitiveResourceEchoes: input.sensitiveResourceEchoes,
    boundary: 'tool-call',
    destination,
    workMessageInBatch: batchHasWorkMessage(input.toolCalls),
    preamblesAlreadyPromoted: budget.preambles,
    lastInterimAtMs: budget.lastAtMs,
    priorInterimTexts: budget.texts,
    nowMs: input.now.getTime(),
  });
  if (!qualified.ok) return;

  if (destination === 'telegram') {
    const send = input.deps.sendInterimMessage;
    if (send === undefined) return;
    const status = await send(
      input.turnId,
      interimJournalId(input.turnId, qualified.text),
      qualified.text,
    ).catch(() => 'possibly_sent' as const);
    if (status !== 'sent') return;
  } else if (destination !== 'repl') {
    return;
  }

  await recordDeliveredInterim(input.deps, input.turnInput, {
    text: qualified.text,
    source: 'preamble',
    traceId: input.traceId,
    tier: input.tier,
    createdAt: input.now.toISOString(),
  });
}
