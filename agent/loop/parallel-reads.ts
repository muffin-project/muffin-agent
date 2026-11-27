import type { CapabilityDecl, Decision } from '../../core/policy/types.js';
import { WORK_MESSAGE_TOOL_NAME } from '../tools/work-message.js';

/**
 * Maximum number of pure read-only `allow` tool calls started at once.
 *
 * The three `web_search` calls that motivated this path were independent and
 * already allowed; running them together cuts wall time from a sum to a max.
 * A modest cap keeps a single completion from stampeding the same backend
 * if the model emits a much larger read-only batch.
 */
export const PARALLEL_READ_CONCURRENCY = 4;

/**
 * Context-row tools that still mutate turn or catalogue state. They stay
 * strictly sequential even when the kernel says `allow` and the capability
 * is `rerunnable`.
 */
const MUTATING_CONTEXT_TOOLS = new Set([
  'todo',
  'wait',
  'capability_search',
  'schedule',
  'schedule_recurring',
]);

/**
 * May this call join a concurrent read-only batch?
 *
 * Only a policy `allow` on a rerunnable egress/context tool with no write
 * or approval side-effect. Writes, `ask`/`draft`/`deny`, `work_message`,
 * and mutating context tools stay on the existing sequential path so
 * approval order and taint-dependent decisions do not change.
 */
export function isParallelReadAllow(args: {
  name: string;
  decl: CapabilityDecl | undefined;
  decision: Decision;
}): boolean {
  if (args.decision.effect !== 'allow') return false;
  if (args.name === WORK_MESSAGE_TOOL_NAME) return false;
  const decl = args.decl;
  if (decl === undefined) return false;
  if (decl.rerunnable !== true) return false;
  if (decl.effect !== 'egress' && decl.effect !== 'context') return false;
  if (MUTATING_CONTEXT_TOOLS.has(args.name)) return false;
  return true;
}
