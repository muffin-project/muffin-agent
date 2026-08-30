import type { ToolContext } from '../loop.js';

/**
 * A `ToolContext` for a test that is calling one handler directly.
 *
 * One place, and that is the point rather than the convenience: `ToolContext`
 * is what the loop hands every handler, and it grew three fields in one slice
 * (`turnId`, `sessionId`, `suspend`). Spread across seven test files as seven
 * hand-written literals, the next field added would be seven edits — and the
 * cheapest way through seven edits is `as unknown as ToolContext`, which is how
 * a test stops proving anything about the shape it is passing.
 *
 * Typed as `ToolContext` and **not** widened: a field added to the type still
 * breaks this file, which is the one edit we want to have to make.
 *
 * `suspend` throws by default. A handler that arms a wait is a handler under
 * test *for that*, and it must pass its own recorder — silently swallowing the
 * call would let `wait` look like it worked while the barrier went nowhere.
 */
export function toolContext(over: Partial<ToolContext> = {}): ToolContext {
  return {
    tenant: 'host',
    principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
    turnId: 'turn-under-test',
    sessionId: 'session-under-test',
    // Clean by default. A test about what a *tainted* turn writes passes its own.
    taint: () => 0,
    intrinsicTaint: () => 0,
    suspend: () => {
      throw new Error('questo tool non dovrebbe sospendere il turno');
    },
    ...over,
  };
}
