import { replyCapability } from '../../core/policy/doors.js';
import type { RegisteredTool, ToolOutcome } from '../loop/types.js';

export const WORK_MESSAGE_TOOL_NAME = 'work_message';
export const MAX_WORK_MESSAGE_CHARS = 1000;

export function parseWorkMessageArgs(
  args: unknown,
): { text: string; wait_for_reply?: boolean } | null {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null;
  const a = args as Record<string, unknown>;
  if (
    Object.keys(a).some((key) => key !== 'text' && key !== 'wait_for_reply') ||
    typeof a.text !== 'string' ||
    a.text.length > MAX_WORK_MESSAGE_CHARS
  )
    return null;
  if (!('wait_for_reply' in a)) return { text: a.text };
  if (typeof a.wait_for_reply !== 'boolean') return null;
  return { text: a.text, wait_for_reply: a.wait_for_reply };
}

export function isWorkQuestion(args: unknown): boolean {
  return (
    args !== null &&
    typeof args === 'object' &&
    'wait_for_reply' in args &&
    args.wait_for_reply === true
  );
}

export function makeWorkMessageTool(): RegisteredTool {
  return {
    capability: replyCapability.id,
    throwTier: 0,
    spec: {
      name: WORK_MESSAGE_TOOL_NAME,
      description:
        'Send an optional short message to the owner in the chat where this work started. ' +
        'A brief acknowledgment before long work can be useful; update only when something material changes. ' +
        'If blocked on a decision or missing information, ask one focused question with wait_for_reply=true, alone in its tool batch. ' +
        'Skip performative chatter. Reply with the final result normally; it is delivered automatically.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1, maxLength: MAX_WORK_MESSAGE_CHARS },
          wait_for_reply: {
            type: 'boolean',
            description:
              'Set true only to wait for the owner’s reply to a blocking question. Otherwise send and continue.',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      const refuse = (content: string): ToolOutcome => ({ content, tier: 0, isError: true });
      const port = ctx.workMessage;
      if (port === undefined || !port.available()) {
        return refuse('Work messages are unavailable on this turn.');
      }
      const a = parseWorkMessageArgs(args);
      if (a === null) {
        return refuse(
          `Provide text (up to ${MAX_WORK_MESSAGE_CHARS} characters) and, optionally, a boolean wait_for_reply.`,
        );
      }
      const wait = a.wait_for_reply === true;
      if (wait && !port.solo) {
        return refuse('Ask the question in a tool batch by itself. No question was sent.');
      }
      if (!port.withinBudget)
        return refuse('Work-message limit reached. Continue without another work message.');
      const text = port.sanitize(a.text).trim();
      if (text.length === 0 || text.length > MAX_WORK_MESSAGE_CHARS) {
        return refuse('The safe message must be nonempty and within the length limit.');
      }

      if (wait) {
        const wakeAt = port.questionWakeAt();
        if (wakeAt === null) return refuse('Cannot wait for another owner reply on this turn.');
        ctx.suspend({
          wakeAt,
          waitFor: { kind: 'owner_reply', id: port.messageId, question: text },
        });
        return { content: 'Waiting for owner input. Do not repeat the question.', tier: 0 };
      }

      // An exception can happen after a request went out. Neither that nor a
      // deferred/uncertain receipt grants the model a confirmed delivery.
      const status = await port.send(text).catch(() => 'possibly_sent' as const);
      if (status === 'sent') return { content: 'Work message sent.', tier: 0 };
      return refuse(
        status === 'deferred'
          ? 'Work-message delivery was deferred and is not confirmed. Continue without retrying it.'
          : 'The work message may have been sent, but delivery is not confirmed. Continue without retrying it.',
      );
    },
  };
}
