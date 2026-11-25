import type { ContentBlock } from '../providers/types.js';
import type { TurnScope } from './durability.js';
import { runTool } from './tool-call.js';

type ToolUse = Extract<ContentBlock, { type: 'tool_use' }>;
type ToolResult = Extract<ContentBlock, { type: 'tool_result' }>;

/**
 * Interpret consent only against this turn's persisted tool use. A replayed
 * outcome replaces the waiting result before the provider sees the checkpoint.
 */
export async function resumeApprovedInvocations(
  scope: TurnScope,
): Promise<Map<string, ContentBlock>> {
  const { deps, record, run, snapshot, turn, input, exposed, toolContext } = scope;
  const recovered = new Map<string, ContentBlock>();
  const approvals = deps.approvals?.decidedInvocations(record.id) ?? [];
  if (approvals.length === 0 || input.signal?.aborted) return recovered;

  const calls = new Map<string, ToolUse | null>();
  const answers = new Map<string, { content: ContentBlock[]; index: number; result: ToolResult }>();
  for (const message of run.messages) {
    for (const [index, block] of message.content.entries()) {
      if (message.role === 'assistant' && block.type === 'tool_use') {
        calls.set(block.id, calls.has(block.id) ? null : block);
      } else if (message.role === 'user' && block.type === 'tool_result') {
        answers.set(block.toolCallId, { content: message.content, index, result: block });
      }
    }
  }

  const recorded = deps.turns.recordedOutcomes(record.id);
  const uncertain = new Set(deps.turns.uncertainCalls(record.id).map((call) => call.callId));
  for (const approval of approvals) {
    if (input.signal?.aborted) break;
    const callId = approval.invocation?.callId;
    if (callId === undefined || recovered.has(callId)) continue;
    const original = calls.get(callId);
    if (original === undefined) continue;
    const answer = answers.get(callId);
    if (answer !== undefined && answer.result.deferredApprovalId !== approval.id) continue;

    const errorResult = (content: string): ToolResult => ({
      type: 'tool_result',
      toolCallId: callId,
      content,
      isError: true,
    });
    let result: ContentBlock;
    const previous = recorded.get(callId);
    if (original === null) {
      result = errorResult('La chiamata approvata è ambigua. Non è stata eseguita.');
    } else if (previous !== undefined) {
      if (previous.tier !== null) snapshot.raiseTaint(previous.tier, 'un risultato già registrato');
      result = {
        type: 'tool_result',
        toolCallId: callId,
        content: previous.content,
        ...(previous.isError ? { isError: true } : {}),
      };
    } else if (uncertain.has(callId)) {
      result = errorResult(
        "Non posso verificare se la chiamata approvata abbia avuto effetto. Non l'ho ripetuta.",
      );
    } else if (approval.consumedAt !== null) {
      result = errorResult(
        approval.decision === 'deny'
          ? "L'owner ha rifiutato la chiamata. Non è stata eseguita."
          : "L'approvazione è già stata consumata. Non ho eseguito nuovamente la chiamata.",
      );
    } else {
      const call = { id: original.id, name: original.name, args: original.input };
      result = await runTool(deps, snapshot, turn, call, input, exposed, toolContext, {
        replay: { approvalId: approval.id, claimToken: record.claimToken },
      });
    }
    if (original !== null) {
      scope.noteSensitiveResourceEcho({ name: original.name, args: original.input }, result);
    }
    recovered.set(callId, result);
    if (answer !== undefined) answer.content[answer.index] = result;
  }
  return recovered;
}
