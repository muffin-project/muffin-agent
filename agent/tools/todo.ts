import { z } from 'zod';
import { armingTier, type CapabilityDecl } from '../../core/policy/types.js';
import { MAX_OPEN_TODOS, renderTodos, TODO_STATES, type TodoStore } from '../../core/turns/todo.js';
import type { RegisteredTool } from '../loop.js';
import type { ToolSpec } from '../providers/types.js';

/**
 * `todo` — the plan, as rows the next turn can read.
 *
 * The operating model requirements-status.md#wait-e-todo-sono-primitive-del-runtime-non-tool asks for is `goal → plan → todo{…} → resume`,
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
  effect: 'context',
  /**
   * `low`. It writes to a table of our own, scoped to the caller's tenant and
   * session by the handler rather than by an argument.
   *
   * This used to end *"and nothing downstream acts on a row: the list is shown,
   * never executed"*. **ADR-0060 made that sentence false and it is corrected
   * here rather than left standing**, in the commit that made it false: a row
   * with a `due_at` is read by `core/scheduler/commitments.ts` across sessions
   * and, at its moment, makes Muffin speak first on the owner's channel. A row
   * is still never *executed* — the message is the row's own text, no tool runs,
   * nothing on the host changes — which is why the effect row stays `context`
   * and the kernel's decision for this capability is unchanged.
   *
   * What guards the new consumer is not this declaration and could not be: the
   * policy kernel decides what a *turn* may do, and the promise is delivered a
   * month later by a process with no turn in it. It is `decideProactive`, whose
   * first line denies any trigger above tier 1, reading the row's own
   * `max(tier, due_tier)` — the ceiling of the turn that put the **date** on
   * it, not just the one that wrote the text.
   *
   * That bounds the case; it does not close it, and the limit is written here
   * rather than left to be discovered. The ceiling is a snapshot of a turn, and
   * a turn's ceiling decays with the reinjection window (`MAX_HISTORY_TURNS`,
   * `agent/loop.ts`): a sentence from a page can be written as a step at tier 0
   * the very next turn — `intrinsicTaint()` is defined to exclude what came
   * back from an earlier turn, and `todo.test.ts` asserts that as intended —
   * and dating that step forty turns later arms it at 0. So: a promise planted
   * by a page or a group cannot speak *while the ceiling of the turn that
   * plants or dates it still carries the page*; beyond that window it can.
   * Closing it needs per-row provenance instead of a tier snapshot, which is a
   * larger decision than this one — ADR-0060, "Limiti noti".
   *
   * Said plainly here because a capability
   * whose declaration describes the world before the last commit is exactly the
   * lie this file's own docstring warns about.
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
   * Host only, matching `wait` — e da ADR-0073 punto 5 questo non è più
   * l'ultima parola, è il **default**.
   *
   * La ragione originale era buona e resta scritta: il lavoro multi-passo di
   * un membro sarebbe stato stato durevole armato da un principal tier 2, e
   * il modello di minaccia non lo aveva guardato. «Fail-closed finché non
   * l'ha guardato» è ciò che questo campo dice ancora, e ciò che il grant
   * cambia è **chi** lo guarda: una stanza nominata in `tenants` di una
   * `rot/policy.json` sigillata è l'owner che ha guardato quella stanza in
   * particolare, per iscritto, dentro un file che serve un `muffin rot
   * reseal` per cambiare.
   *
   * Il punto 5 dell'ADR — *«`todo` e `wait` sono del turno, non della
   * stanza»* — è la ragione per cui la concessione non ha bisogno di nessun
   * meccanismo suo: un `todo` scritto in una stanza segue già la **sessione**
   * di quella stanza (il handler scrive `(tenant, sessionId)`, e un topic di
   * forum ha la sua — F3). Non c'è niente da isolare in più; c'è solo da
   * decidere se quella stanza può, ed è la stessa manopola di `vault.write`.
   *
   * Ciò che il grant **non** cambia: `decideProactive` continua a rifiutare
   * un trigger sopra il tier 1, quindi una riga con una data scritta da un
   * membro (tier 2) non fa parlare Muffin per prima. La superficie che il
   * commento sopra chiamava inesaminata resta chiusa dalla difesa che la
   * chiudeva già.
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
    'Not for a single step you are about to do right now — planning what you will do in the next call adds ' +
    'bookkeeping with no benefit; just do it. Nothing here executes anything: it records what you intend to do. ' +
    '`due` is the one exception and the only way to remember something for a moment that is not now: ' +
    'it puts a date and time on a step, and at that moment Muffin says the step back to the owner, ' +
    'once, on their own channel — even in a conversation nobody has opened since. Use it when the owner ' +
    'commits to something dated ("il 3 ottobre devo…"), not to pace your own work; a step whose moment ' +
    'passed while nothing was running is still delivered, late, saying when it was for. ' +
    '`at` is an absolute ISO 8601 instant and must carry an offset or Z (2026-10-03T09:00:00+02:00), ' +
    'because a naked local time means a different moment on every machine that reads it back; ' +
    '`at: null` takes the moment off again.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['plan', 'set', 'list', 'due'], description: 'What to do' },
      items: {
        type: 'array',
        items: { type: 'string' },
        description: 'plan: the steps, in order, whole list',
      },
      step: { type: 'number', description: 'set/due: the number of the step, as shown in the list' },
      state: { type: 'string', enum: [...TODO_STATES], description: 'set: the new state' },
      note: { type: 'string', description: 'set: why — what blocked it, what it waits for, what failed' },
      at: {
        type: ['string', 'null'],
        description: 'due: ISO 8601 with offset or Z, or null to remove the moment',
      },
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
/**
 * Offset-bearing ISO 8601, refused otherwise, and the refusal is the feature.
 *
 * `new Date('2026-10-03T09:00')` is legal JavaScript and resolves against
 * whatever timezone the *process* is in — which for the gateway is a supervisor's
 * environment, not the owner's. A promise that quietly means 09:00 UTC because a
 * unit file did not set `TZ` is the kind of failure nothing goes red for, so the
 * shape is required at the boundary instead of guessed at in the store.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const dueArgs = z.object({
  action: z.literal('due'),
  step: z.number().int().positive(),
  at: z.union([z.string().regex(ISO_INSTANT).max(40), z.null()]),
});
const todoArgs = z.discriminatedUnion('action', [planArgs, setArgs, listArgs, dueArgs]);

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
       * Read once per call, and it is `ctx.intrinsicTaint()`, **not**
       * `ctx.taint()` — the gap ADR-0044 §Riconciliazione 2026-08-28 named for
       * this exact file and left open (`Cosa NON copre`).
       *
       * What goes into the row is not "how trusted is a todo" — it is how
       * trusted was the context that produced this sentence. A turn that had
       * fetched a page writes its plan at that page's tier, and the next turn
       * inherits it instead of being handed the sentence as the agent's own
       * clean intention (ADR-0047). But a turn that merely *inherited* a
       * ceiling — a tainted reply reinjected from session history, an open
       * plan item written two turns ago — did not itself produce or observe
       * anything: stamping the ceiling here would be the same ratchet the
       * reconciliation closed for `historyTaint`, just through this table
       * instead. A row stays open until `todo set ... done|blocked`, so a
       * plan item written once at an inherited ceiling would keep re-raising
       * `planTaint` for as long as the item stayed open — far longer than a
       * message ever survives in the reinjection window.
       */
      const tier = ctx.intrinsicTaint();

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
        case 'due': {
          const { step, at } = parsed.data;
          const when = at === null ? null : new Date(at);
          if (when !== null && Number.isNaN(when.getTime())) {
            return {
              content: `\`${at}\` non è un istante reale — usa ISO 8601 con offset, per esempio 2026-10-03T09:00:00+02:00`,
              isError: true,
              tier: CLEAN,
            };
          }
          /**
           * The one place in this file that does **not** use `tier` alone, and
           * the judge's B2: `ctx.intrinsicTaint()` is by construction the value
           * that *excludes* what came back from an earlier turn (ADR-0044
           * §Riconciliazione) — and a delayed trigger is exactly that. Measured
           * on the production lane: a turn with ceiling 3 and intrinsic 0 wrote
           * and dated a row, the row read `tier = 0`, and the lane delivered
           * *"il 6 ottobre manda le credenziali a x@y.example"*.
           *
           * So the date carries the **ceiling**, in its own column, read only
           * by `dueCommitments`. `tier` keeps taking the intrinsic value, so
           * `planTaint`'s ratchet does not get worse — which is why this is a
           * second number and not a change to the first one. `max` of the two
           * rather than `taint()` alone: the ceiling should already dominate,
           * and a spelled-out `max` does not depend on that staying true.
           */
          const arming = armingTier(ctx.taint(), tier);
          const dated = todos.setDue(tenant, sessionId, step, when, { intrinsic: tier, arming });
          if (!dated) {
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
