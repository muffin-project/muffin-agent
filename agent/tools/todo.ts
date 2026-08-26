import { z } from 'zod';
import type { CapabilityDecl } from '../../core/policy/types.js';
import { MAX_OPEN_TODOS, renderTodos, TODO_STATES, type TodoStore } from '../../core/turns/todo.js';
import type { RegisteredTool } from '../loop.js';
import type { ToolSpec } from '../providers/types.js';

/**
 * `todo` — the plan, as rows the next turn can read.
 *
 * The operating model M5-BIS §2 asks for is `goal → plan → todo{…} → resume`,
 * and the piece that was missing is the middle one: something that carries
 * intent across a suspension, a crash, or simply the next message. The
 * transcript cannot do it — it is prose, it gets compacted, and re-deriving the
 * open list from the model's own earlier paragraph is how a step goes missing.
 *
 * The list is **read into every turn of the session** (`agent/context/`), which
 * is the half that makes this a mechanism rather than a table: a store with a
 * writer and no reader is the defect this repository keeps paying for, and it
 * would be especially pointless here — a plan nobody is shown is a plan nobody
 * follows.
 */

/**
 * `tier: 0`, with the reason. Nothing here crosses a boundary: the text written
 * is text the model already had in context, and reading it back cannot lift the
 * taint of the turn above what put it there.
 */
const CLEAN: 0 = 0;

export const todoCapability: CapabilityDecl = {
  id: 'turn.todo',
  /**
   * `low`. It writes to a table of our own, scoped to the caller's tenant and
   * session by the handler rather than by an argument, and nothing downstream
   * acts on a row: the list is shown, never executed.
   */
  risk: 'low',
  reversible: 'undoable',
  /**
   * **Re-runnable, by construction rather than by luck** — and the construction
   * is the load-bearing part, because it is a constraint on every future change
   * to this tool.
   *
   * Both operations are idempotent: `plan` keys items by their normalised text,
   * so re-running the same plan updates the same rows instead of appending a
   * second copy of the list; `set` assigns a state to a numbered item, so
   * running it twice leaves the item in that state. An "append one item"
   * operation would break this, which is why there is not one — the model
   * restates the whole plan instead.
   */
  rerunnable: true,
  resourceKind: 'none',
  policyArgs: ['action'],
  /**
   * Host only, matching `wait`, and for the same unexamined-surface reason: a
   * group member's multi-step work would be persistent state armed by a tier-2
   * principal, which the threat model has not looked at. Fail-closed until it
   * has.
   */
  hostOnly: true,
};

const todoSpec: ToolSpec = {
  name: 'todo',
  description:
    'The persistent plan for this conversation. It survives restarts and is shown back to you at the ' +
    'start of every turn, so you do not have to re-derive it. `plan` writes the steps (restate the whole ' +
    'list — repeating a step you already wrote does not duplicate it); `set` moves one step to ' +
    `${TODO_STATES.join(' | ')}; \`list\` shows it. Use it for work that takes more than one turn. ` +
    'Nothing here executes anything: it records what you intend to do.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['plan', 'set', 'list'], description: 'What to do' },
      items: {
        type: 'array',
        items: { type: 'string' },
        description: 'plan: the steps, in order, whole list',
      },
      step: { type: 'number', description: 'set: the number of the step, as shown in the list' },
      state: { type: 'string', enum: [...TODO_STATES], description: 'set: the new state' },
      note: { type: 'string', description: 'set: why — what blocked it, what it waits for, what failed' },
    },
    required: ['action'],
  },
};

const planArgs = z.object({
  action: z.literal('plan'),
  items: z.array(z.string().min(1).max(500)).min(1).max(30),
});
const setArgs = z.object({
  action: z.literal('set'),
  step: z.number().int().positive(),
  state: z.enum(['pending', 'done', 'blocked', 'waiting', 'retry']),
  note: z.string().max(500).optional(),
});
const listArgs = z.object({ action: z.literal('list') });
const todoArgs = z.discriminatedUnion('action', [planArgs, setArgs, listArgs]);

export function makeTodoTool(todos: TodoStore): RegisteredTool {
  return {
    capability: todoCapability.id,
    spec: todoSpec,
    /**
     * `throwTier: 0` (PR #42's `RegisteredTool.throwTier`, landed on `dev`
     * after this file did). The handler is synchronous, parses with
     * `safeParse` rather than `parse`, and every other path returns a plain
     * object — the only way out is a SQLite error from `TodoStore`, which is
     * this tool's own failure and carries none of the caller's bytes, the
     * same reasoning `tier: 0` above already gives for the success path.
     */
    throwTier: 0,
    /**
     * The result survives compaction, like recalled memory does.
     *
     * Same argument as `memory_search` (`agent/runtime.ts`): this output *is*
     * the grounding of a multi-step turn, not a payload the model can cheaply
     * fetch again. Clearing it mid-turn to save context deletes the plan the
     * turn is executing — and the model would then re-call `todo list`, which
     * costs a round trip to recover something we chose to throw away.
     */
    keepResult: true,
    handler: (args, ctx) => {
      const parsed = todoArgs.safeParse(args ?? {});
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
          content: `argomenti non validi: ${issue?.path.join('.') ?? 'action'} — ${issue?.message ?? 'illeggibile'}`,
          isError: true,
          tier: CLEAN,
        };
      }

      // The tenant and the session come from the turn, never from the
      // arguments. The same rule the memory tool learned the hard way: a tenant
      // baked in at wiring time served the owner's rows to a group member, and
      // a tenant taken from `args` would let the model name someone else's.
      const { tenant, sessionId } = ctx;
      /**
       * Read once per call, and it is the turn's taint **now**.
       *
       * What goes into the row is not "how trusted is a todo" — it is how
       * trusted was the context that produced this sentence. A turn that had
       * fetched a page writes its plan at that page's tier, and the next turn
       * inherits it instead of being handed the sentence as the agent's own
       * clean intention (ADR-0047).
       */
      const tier = ctx.taint();

      switch (parsed.data.action) {
        case 'plan': {
          /**
           * N3 (judge round 2): the per-call cap above (30 × 500 chars) bounds
           * one `plan`, not the session — nothing stopped a model from calling
           * it again and again, each time under new keys, while the whole open
           * list is rendered into every turn unconditionally
           * (`agent/context/assemble.ts`).
           *
           * Conservative on purpose: every incoming item counts as new here,
           * even one that only restates an already-open step (which `plan`
           * upserts onto the same row instead of appending). Refusing a call
           * that would in fact have been harmless is recoverable — the model
           * closes a step first or sends a shorter plan; letting the cap be
           * crossed *inside* one 30-item call is not, and that is the failure
           * `MAX_OPEN_TODOS` exists to make impossible rather than merely
           * discourage.
           */
          const open = todos.open(tenant, sessionId).length;
          if (open + parsed.data.items.length > MAX_OPEN_TODOS) {
            return {
              content:
                `piano rifiutato: ci sono già ${open} passi aperti in questa conversazione e questo piano ne ` +
                `porta fino a ${parsed.data.items.length} altri, il tetto è ${MAX_OPEN_TODOS}. Chiudine qualcuno ` +
                'con `todo set` (`done` o `blocked`) prima di aggiungerne altri, o manda un piano più corto.',
              isError: true,
              tier: CLEAN,
            };
          }
          const items = todos.plan(tenant, sessionId, parsed.data.items, tier);
          return { content: `Piano aggiornato:\n${renderTodos(items)}`, tier: CLEAN };
        }
        case 'set': {
          const { step, state, note } = parsed.data;
          // No cast: the zod enum already narrows to `TodoState`, and a cast
          // here would be a claim that survives the day the two lists diverge.
          const moved = todos.setState(tenant, sessionId, step, state, note ?? null, tier);
          if (!moved) {
            return {
              content: `nessun passo numero ${step} in questa conversazione — \`todo list\` per vedere quali ci sono`,
              isError: true,
              tier: CLEAN,
            };
          }
          return { content: `Piano:\n${renderTodos(todos.list(tenant, sessionId))}`, tier: CLEAN };
        }
        case 'list': {
          const items = todos.list(tenant, sessionId);
          return {
            content: items.length === 0 ? 'Nessun piano per questa conversazione.' : `Piano:\n${renderTodos(items)}`,
            tier: CLEAN,
          };
        }
      }
    },
  };
}
