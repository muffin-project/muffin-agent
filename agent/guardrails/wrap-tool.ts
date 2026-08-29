import type { CapabilityDecl } from '../../core/policy/types.js';
import type { RegisteredTool, ToolOutcome } from '../loop.js';
import { ToolLoopGuardrail } from './tool-loop.js';

/**
 * Put the post-result guardrail around one registered tool without changing
 * policy or the tool's own handler contract.
 *
 * The wrapper sits *inside* `runTool`: the loop still performs the mandatory
 * policy decision and writes the effect intent before it ever reaches this
 * handler. This is intentional. A guardrail may tell the model “you are not
 * progressing”; it is not another way to authorize an effect.
 *
 * The same wrapper also sees automatic retries because `eseguiConRitentativi`
 * invokes `handler` for every attempt. That lets repeated transient failures be
 * counted without adding retry-specific state to the loop.
 */
export function withToolLoopGuardrail(
  tool: RegisteredTool,
  decl: CapabilityDecl | undefined,
  guardrail: ToolLoopGuardrail,
): RegisteredTool {
  const original = tool.handler;
  return {
    ...tool,
    handler: async (args, ctx) => {
      let outcome: ToolOutcome;
      try {
        outcome = await original(args, ctx);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const warning = guardrail.observe({
          turnId: ctx.turnId,
          tool: tool.spec.name,
          args,
          result: detail,
          isError: true,
          // A throw is a failed attempt, never a successful idempotent read.
          idempotentRead: false,
        });
        if (warning === null) throw error;

        // Preserve the original error as `cause` for diagnostics while making
        // the warning visible through the same error boundary the loop already
        // redacts, taints with `throwTier` and records durably.
        throw new Error(`${detail}\n\n${warning.message}`, { cause: error });
      }

      const warning = guardrail.observe({
        turnId: ctx.turnId,
        tool: tool.spec.name,
        args,
        result: outcome.content,
        isError: outcome.isError === true,
        idempotentRead: decl?.progress === 'idempotent_read',
      });
      if (warning === null) return outcome;

      return {
        ...outcome,
        content: `${outcome.content}\n\n${warning.message}`,
      };
    },
  };
}
