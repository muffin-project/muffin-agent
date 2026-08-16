import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MAX_OPEN_TODOS, TodoStore } from '../../core/turns/todo.js';
import { toolContext } from '../fixtures/tool-context.js';
import { makeTodoTool, todoCapability } from './todo.js';

/**
 * The `todo` tool, at the two boundaries that can be got wrong silently.
 *
 * The first is scoping: which conversation, and whose. The memory tool learned
 * this the expensive way — a tenant baked in at wiring time served the owner's
 * rows to a group member — so the assertion is that the tenant and the session
 * come from the turn's context and that an argument naming somebody else's
 * cannot reach the store.
 *
 * The second is the declaration. `rerunnable: true` on this capability is a
 * promise a resume acts on: after a crash the loop re-runs a call whose outcome
 * was never recorded, and if `plan` appended instead of upserting, the resumed
 * turn would come back to a doubled list.
 */

function tool(): { handler: ReturnType<typeof makeTodoTool>['handler']; todos: TodoStore } {
  const todos = new TodoStore(new DatabaseCtor(':memory:'));
  return { handler: makeTodoTool(todos).handler, todos };
}

describe('il piano appartiene alla conversazione del turno', () => {
  it('scrive nel tenant e nella sessione del contesto, non in quelli degli argomenti', async () => {
    const { handler, todos } = tool();
    // A model naming somebody else's tenant is the attempt this closes. The
    // extra keys are simply not read — the store never sees them.
    await handler(
      { action: 'plan', items: ['uno'], tenant: 'host', sessionId: 's-altrui' },
      toolContext({ tenant: 'gruppo-7', sessionId: 's-mia' }),
    );
    expect(todos.list('gruppo-7', 's-mia').map((i) => i.text)).toEqual(['uno']);
    expect(todos.list('host', 's-altrui')).toEqual([]);
  });

  it('`list` legge la stessa coppia che `plan` ha scritto', async () => {
    const { handler } = tool();
    const ctx = toolContext({ tenant: 'gruppo-7', sessionId: 's-mia' });
    await handler({ action: 'plan', items: ['uno'] }, ctx);
    const mine = await handler({ action: 'list' }, ctx);
    const other = await handler({ action: 'list' }, toolContext({ tenant: 'host', sessionId: 's-mia' }));
    expect(mine.content).toContain('uno');
    expect(other.content).toMatch(/Nessun piano/);
  });
});

describe('le tre azioni', () => {
  it('plan scrive la lista intera e la rimanda numerata', async () => {
    const { handler } = tool();
    const out = await handler({ action: 'plan', items: ['leggere', 'rispondere'] }, toolContext());
    expect(out.content).toContain('1. [pending] leggere');
    expect(out.content).toContain('2. [pending] rispondere');
  });

  it('set muove un passo e restituisce il piano, così il modello vede il risultato', async () => {
    const { handler } = tool();
    const ctx = toolContext();
    await handler({ action: 'plan', items: ['leggere'] }, ctx);
    const out = await handler({ action: 'set', step: 1, state: 'blocked', note: 'manca la firma' }, ctx);
    expect(out.content).toContain('1. [blocked] leggere — manca la firma');
  });

  it('set su un numero che non c’è lo dice, invece di fingere di aver mosso qualcosa', async () => {
    const { handler } = tool();
    const out = await handler({ action: 'set', step: 4, state: 'done' }, toolContext());
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/nessun passo numero 4/);
  });

  it('argomenti illeggibili tornano come errore al modello, non come eccezione al turno', async () => {
    const { handler } = tool();
    for (const bad of [{}, { action: 'plan' }, { action: 'plan', items: [] }, { action: 'set', step: 0 }, { action: 'boh' }]) {
      const out = await handler(bad, toolContext());
      expect(out.isError, JSON.stringify(bad)).toBe(true);
    }
  });
});

describe('il tetto cumulativo di sessione (N3, judge giro 2)', () => {
  /**
   * The per-call cap (30 items) was never the whole story: `plan` accumulates
   * across calls, keyed by normalised text, and `agent/context/assemble.ts`
   * renders every open row into every turn unconditionally. Nothing stopped a
   * model from calling `plan` again and again, each time under new keys.
   */
  const filler = (from: number, count: number): string[] =>
    Array.from({ length: count }, (_, i) => `passo ${from + i}`);

  it('un piano che resta sotto il tetto passa', async () => {
    const { handler, todos } = tool();
    const ctx = toolContext();
    const out = await handler({ action: 'plan', items: filler(1, 30) }, ctx);
    expect(out.isError).toBeUndefined();
    expect(todos.open('host', ctx.sessionId).length).toBe(30);
  });

  it('rifiuta il piano che porterebbe la sessione sopra MAX_OPEN_TODOS, col numero nel rifiuto', async () => {
    const { handler, todos } = tool();
    const ctx = toolContext();
    // Two calls of 30 distinct steps reach the cap exactly, without ever
    // tripping the *per-call* limit of 30.
    await handler({ action: 'plan', items: filler(1, 30) }, ctx);
    await handler({ action: 'plan', items: filler(31, 30) }, ctx);
    expect(todos.open('host', ctx.sessionId).length).toBe(MAX_OPEN_TODOS);

    const out = await handler({ action: 'plan', items: ['un passo di troppo'] }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).toContain(String(MAX_OPEN_TODOS));
    // The refused call must not have landed even partially — one all-or-nothing
    // step, the same guarantee `TodoStore.plan`'s own transaction gives.
    expect(todos.open('host', ctx.sessionId).length).toBe(MAX_OPEN_TODOS);
    expect(todos.list('host', ctx.sessionId).some((i) => i.text === 'un passo di troppo')).toBe(false);
  });

  it('restating an already-open step does not by itself cost room under the cap', async () => {
    // Conservative check (open-count + this call's size), so a call that only
    // restates existing steps can still be refused if it is large enough — the
    // safe direction, since the alternative risks letting one call cross the
    // cap. What must hold is the inverse: a *small* restating call must not be
    // permanently blocked once the session is merely near the ceiling.
    const { handler, todos } = tool();
    const ctx = toolContext();
    await handler({ action: 'plan', items: filler(1, 30) }, ctx);
    const out = await handler({ action: 'plan', items: filler(1, 30) }, ctx); // same 30 texts again
    expect(out.isError).toBeUndefined();
    expect(todos.open('host', ctx.sessionId).length).toBe(30); // no new rows
  });
});

describe('cosa dichiara', () => {
  it('ogni ritorno porta tier 0, compresi gli errori', async () => {
    // Nothing here crosses a boundary: the text written is text the model
    // already had, and reading it back cannot lift the turn's taint.
    const { handler } = tool();
    const ok = await handler({ action: 'plan', items: ['uno'] }, toolContext());
    const bad = await handler({ action: 'set', step: 9, state: 'done' }, toolContext());
    const junk = await handler({ action: 'boh' }, toolContext());
    expect([ok.tier, bad.tier, junk.tier]).toEqual([0, 0, 0]);
  });

  it('si dichiara ri-eseguibile, e le due operazioni lo sono davvero', async () => {
    expect(todoCapability.rerunnable).toBe(true);
    // This is the assertion the declaration is worth: a resume re-runs a call
    // whose outcome was never recorded, and both operations have to land twice
    // without changing anything the second time. An "append one item" action
    // would break it — which is why there is not one.
    const { handler, todos } = tool();
    const ctx = toolContext();
    // Compared on what re-runnability actually promises — the rows, their
    // numbers, their states and their notes. **Not** on `updated_at`, which
    // moves on purpose: a step restated a second ago and one nobody has touched
    // in a week are different facts, and the store keeps them apart
    // (`core/turns/todo.ts`, the `DO UPDATE` and never `DO NOTHING`).
    const shape = () =>
      todos.list('host', ctx.sessionId).map(({ seq, text, state, note }) => ({ seq, text, state, note }));

    await handler({ action: 'plan', items: ['uno', 'due'] }, ctx);
    await handler({ action: 'set', step: 2, state: 'done' }, ctx);
    const before = shape();

    await handler({ action: 'plan', items: ['uno', 'due'] }, ctx);
    await handler({ action: 'set', step: 2, state: 'done' }, ctx);
    expect(shape()).toEqual(before);
  });

  it('il risultato sopravvive alla compattazione, come la memoria richiamata', () => {
    // Same argument as `memory_search`: this output *is* the grounding of a
    // multi-step turn. Clearing it mid-turn to save context deletes the plan
    // the turn is executing, and the model then re-calls `todo list` — a round
    // trip to recover something we chose to throw away.
    expect(makeTodoTool(new TodoStore(new DatabaseCtor(':memory:'))).keepResult).toBe(true);
  });
});
