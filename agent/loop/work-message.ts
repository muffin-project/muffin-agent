import { createHash } from 'node:crypto';
import { redactText, scrubResourceEchoes } from '../../core/tracing/redact.js';
import type { TurnRecord } from '../../core/turns/store.js';
import { MAX_SUSPENDED_PER_TENANT } from '../../core/turns/wait.js';
import {
  isWorkQuestion,
  parseWorkMessageArgs,
  WORK_MESSAGE_TOOL_NAME,
} from '../tools/work-message.js';
import type { TurnRun } from './run-state.js';
import { type LoopDeps, MAX_RESUMES, type ToolContext, type TurnInput } from './types.js';

type WorkCall = { id: string; name: string; args: unknown };
export type WorkMessageBatch = { record: TurnRecord; run: TurnRun; size: number; index: number };

const OWNER_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_PROGRESS_MESSAGES = 2;

/** The reply address is authoritative only when it agrees with the current owner binding. */
export function workMessagesAvailable(deps: LoopDeps, input: TurnInput): boolean {
  const { principal, replyTo } = input;
  const chatId = replyTo?.chatId;
  const messageId = replyTo?.messageId;
  if (
    deps.sendWorkMessage === undefined ||
    deps.workMessageOwner === undefined ||
    input.surface !== 'telegram' ||
    input.tenant !== 'host' ||
    input.jobId !== undefined ||
    input.promptMode === 'minimal' ||
    principal.kind !== 'owner' ||
    principal.connector !== 'telegram' ||
    typeof chatId !== 'number' ||
    !Number.isSafeInteger(chatId) ||
    chatId <= 0 ||
    typeof messageId !== 'number' ||
    !Number.isSafeInteger(messageId) ||
    messageId <= 0 ||
    replyTo?.channel !== `telegram:${chatId}` ||
    replyTo.threadId !== undefined ||
    replyTo.scheduledDeliveryVersion !== undefined
  )
    return false;

  try {
    const { userId, chatId: ownerChatId = userId } = deps.workMessageOwner();
    return chatId === userId && chatId === ownerChatId && principal.externalId === String(userId);
  } catch {
    return false;
  }
}

function safeText(run: TurnRun, text: string): string {
  return scrubResourceEchoes(redactText(text), run.sensitiveResourceEchoes);
}

/** Scrub before the assistant tool_use is checkpointed, not only at send time. */
export function sanitizeWorkCall(run: TurnRun, call: WorkCall): WorkCall {
  if (call.name !== WORK_MESSAGE_TOOL_NAME) return call;
  const args = parseWorkMessageArgs(call.args);
  // Keep malformed calls invalid without persisting arbitrary argument values.
  return { ...call, args: args === null ? {} : { ...args, text: safeText(run, args.text) } };
}

export function workMessagePort(
  deps: LoopDeps,
  input: TurnInput,
  call: WorkCall,
  { record, run, size, index }: WorkMessageBatch,
): NonNullable<ToolContext['workMessage']> {
  // Canonical Work id and durable lease index (not the ephemeral claim token),
  // plus the call id used by the effect WAL. The array makes the tuple unambiguous.
  const messageId = createHash('sha256')
    .update(JSON.stringify([WORK_MESSAGE_TOOL_NAME, record.id, record.leaseIndex, call.id]))
    .digest('hex');

  // Count attempts conservatively, from the same transcript on live/recovery
  // paths. A malformed mixed question does not consume the one solo question.
  let priorQuestion = false;
  let progress = 0;
  for (const [offset, message] of run.messages.entries()) {
    if (message.role !== 'assistant') continue;
    const batch = message.content.filter((block) => block.type === 'tool_use');
    const prior = offset === run.messages.length - 1 ? batch.slice(0, index) : batch;
    for (const block of prior) {
      if (block.name !== WORK_MESSAGE_TOOL_NAME) continue;
      const args = parseWorkMessageArgs(block.input);
      if (args === null) continue;
      if (args.wait_for_reply !== true) progress += 1;
      else if (batch.length === 1) priorQuestion = true;
    }
  }

  return {
    available: () => {
      if (input.signal?.aborted || !workMessagesAvailable(deps, input)) return false;
      const current = deps.turns.get(record.id);
      return (
        record.claimToken !== null &&
        current?.status === 'running' &&
        current.claimToken === record.claimToken
      );
    },
    messageId,
    solo: size === 1,
    withinBudget: isWorkQuestion(call.args) ? !priorQuestion : progress < MAX_PROGRESS_MESSAGES,
    sanitize: (text) => safeText(run, text),
    questionWakeAt: () => {
      if (
        run.barrier !== null ||
        run.resumes >= MAX_RESUMES ||
        deps.approvals?.open(record.id) != null ||
        deps.turns.countSuspended(input.tenant) >= MAX_SUSPENDED_PER_TENANT
      )
        return null;
      return new Date(
        (deps.now ?? (() => new Date()))().getTime() + OWNER_REPLY_WINDOW_MS,
      ).toISOString();
    },
    send: async (text) => (await deps.sendWorkMessage?.(record.id, messageId, text)) ?? 'deferred',
  };
}
