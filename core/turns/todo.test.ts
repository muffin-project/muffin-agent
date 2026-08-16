import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TodoStore, renderTodos, type TodoItem } from './todo.js';

/**
 * The plan, and the two things it has to survive: a restart, and the model
 * restating itself.
 *
 * `goal → plan → todo{done|blocked|waiting|retry|pending} → resume` (M5-BIS §2).
 * The transcript cannot carry this — it is prose, it gets compacted, and
 * re-deriving the open list from the model's own earlier paragraph is how a
 * step goes missing between one resume and the next.
 *
 * Idempotence is not tidiness here: it is what makes `rerunnable: true` on the
 * `todo` capability an honest declaration instead of a hopeful one. A resume
 * re-runs a `plan` call that may or may not have landed, and the test for
 * re-runnability is that one call and two identical calls leave the same rows.
 */

function fileStore(): { path: string; open: () => TodoStore } {
  const path = join(mkdtempSync(join(tmpdir(), 'muffin-todo-')), 'muffin.db');
  return { path, open: () => new TodoStore(new DatabaseCtor(path)) };
}

const texts = (items: TodoItem[]): string[] => items.map((i) => i.text);

describe('il piano sopravvive al processo che lo ha scritto', () => {
  it('si rilegge da una seconda connessione, dopo che la prima è chiusa', () => {
    const { open } = fileStore();
    const first = open();
    first.plan('host', 's1', ['leggere il contratto', 'rispondere a Marco']);
    first.setState('host', 's1', 1, 'done', null);

    // A second store over the same file is what a restart *is*. Building it
    // from the same handle would prove only that a Map works.
    const afterRestart = open();
    expect(texts(afterRestart.open('host', 's1'))).toEqual(['rispondere a Marco']);
    expect(afterRestart.list('host', 's1')[0]).toMatchObject({ seq: 1, state: 'done' });
  });
});

describe('ripetere il piano non lo duplica', () => {
  it('la stessa lista due volte lascia le stesse righe, con gli stessi numeri', () => {
    const todos = new TodoStore(new DatabaseCtor(':memory:'));
    const before = todos.plan('host', 's1', ['uno', 'due']);
    const after = todos.plan('host', 's1', ['uno', 'due']);
    expect(after).toEqual(before);
    expect(after.map((i) => i.seq)).toEqual([1, 2]);
  });

  it('riconosce lo stesso passo scritto con spazi e maiuscole diverse', () => {
    // A model restating its plan does not restate it byte for byte. Interior
    // punctuation is kept on purpose: two steps that differ by a comma are two
    // steps, and collapsing them would lose one.
    const todos = new TodoStore(new DatabaseCtor(':memory:'));
    todos.plan('host', 's1', ['Leggere il contratto']);
    todos.plan('host', 's1', ['  leggere   il contratto  ']);
    expect(todos.list('host', 's1')).toHaveLength(1);

    todos.plan('host', 's1', ['leggere, il contratto']);
    expect(todos.list('host', 's1')).toHaveLength(2);
  });

  it('non resuscita un passo già fatto quando il modello ripete il piano', () => {
    // The failure this prevents is the expensive one: the agent finishes a
    // step, restates the plan on the next turn, and does the step again — with
    // whatever effects it had.
    const todos = new TodoStore(new DatabaseCtor(':memory:'));
    todos.plan('host', 's1', ['mandare il bonifico']);
    todos.setState('host', 's1', 1, 'done', 'fatto alle 10:04');
    todos.plan('host', 's1', ['mandare il bonifico']);
    expect(todos.list('host', 's1')[0]).toMatchObject({ state: 'done', note: 'fatto alle 10:04' });
    expect(todos.open('host', 's1')).toEqual([]);
  });

  it('aggiunge in coda i passi nuovi, senza rinumerare quelli che c’erano', () => {
    const todos = new TodoStore(new DatabaseCtor(':memory:'));
    todos.plan('host', 's1', ['uno', 'due']);
    const grown = todos.plan('host', 's1', ['uno', 'due', 'tre']);
    // The number is what the model uses to move an item, so it may not shift
    // under it between one turn and the next.
    expect(grown.map((i) => [i.seq, i.text])).toEqual([
      [1, 'uno'],
      [2, 'due'],
      [3, 'tre'],
    ]);
  });

  it('ignora le righe vuote invece di scrivere un passo senza testo', () => {
    const todos = new TodoStore(new DatabaseCtor(':memory:'));
    expect(todos.plan('host', 's1', ['   ', 'vero', ''])).toHaveLength(1);
  });
});

describe('muovere un passo', () => {
  it('assegnare due volte lo stesso stato lascia il passo dov’è — è idempotente', () => {
    const todos = new TodoStore(new DatabaseCtor(':memory:'));
    todos.plan('host', 's1', ['uno']);
    expect(todos.setState('host', 's1', 1, 'blocked', 'aspetto la firma')).toBe(true);
    expect(todos.setState('host', 's1', 1, 'blocked', 'aspetto la firma')).toBe(true);
    expect(todos.list('host', 's1')[0]).toMatchObject({ state: 'blocked', note: 'aspetto la firma' });
  });

  it('dice di no su un numero che non esiste, invece di scrivere niente e tacere', () => {
    const todos = new TodoStore(new DatabaseCtor(':memory:'));
    todos.plan('host', 's1', ['uno']);
    expect(todos.setState('host', 's1', 9, 'done', null)).toBe(false);
  });

  it('il criterio di completamento è deterministico: si legge dalle righe', () => {
    // M5-BIS §2 asks for a deterministic completion criterion. This is it, and
    // it is the reason `open` exists: "finished" is a query, never the model
    // declaring itself done.
    const todos = new TodoStore(new DatabaseCtor(':memory:'));
    todos.plan('host', 's1', ['uno', 'due']);
    todos.setState('host', 's1', 1, 'done', null);
    expect(todos.open('host', 's1').map((i) => i.state)).toEqual(['pending']);
    todos.setState('host', 's1', 2, 'done', null);
    expect(todos.open('host', 's1')).toEqual([]);
  });

  it('blocked e waiting restano aperti — un passo fermo non è un passo finito', () => {
    const todos = new TodoStore(new DatabaseCtor(':memory:'));
    todos.plan('host', 's1', ['uno', 'due', 'tre']);
    todos.setState('host', 's1', 1, 'blocked', 'manca la password');
    todos.setState('host', 's1', 2, 'waiting', 'ho scritto, aspetto risposta');
    todos.setState('host', 's1', 3, 'retry', 'la prima volta ha dato 502');
    expect(todos.open('host', 's1')).toHaveLength(3);
  });
});

describe('il piano è di una conversazione, non del processo', () => {
  it('due sessioni non si vedono, e due tenant nemmeno', () => {
    // The scoping is the same rule the memory tool learned the hard way: a
    // tenant baked in at wiring time served the owner's rows to a group member.
    const todos = new TodoStore(new DatabaseCtor(':memory:'));
    todos.plan('host', 's1', ['roba dell’owner']);
    todos.plan('host', 's2', ['altra conversazione']);
    todos.plan('gruppo-7', 's1', ['roba del gruppo']);

    expect(texts(todos.list('host', 's1'))).toEqual(['roba dell’owner']);
    expect(texts(todos.list('host', 's2'))).toEqual(['altra conversazione']);
    expect(texts(todos.list('gruppo-7', 's1'))).toEqual(['roba del gruppo']);
    // …and the numbering restarts per conversation, so "passo 1" is unambiguous
    // inside the only place it is ever said.
    expect(todos.list('gruppo-7', 's1')[0]?.seq).toBe(1);
  });
});

describe('come viene reso', () => {
  it('numero, stato, testo e la nota quando c’è', () => {
    const todos = new TodoStore(new DatabaseCtor(':memory:'));
    todos.plan('host', 's1', ['uno', 'due']);
    todos.setState('host', 's1', 2, 'blocked', 'manca la firma');
    expect(renderTodos(todos.list('host', 's1'))).toBe(
      '1. [pending] uno\n2. [blocked] due — manca la firma',
    );
  });
});
