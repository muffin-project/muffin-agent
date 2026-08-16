import type Database from 'better-sqlite3';

/**
 * Multi-step work that survives the turn that planned it.
 *
 * The operating model is not `goal → turn → done` but
 * `goal → plan → todo{done|blocked|waiting|retry|pending} → resume`
 * (`docs/blueprint/M5-BIS.md` §2). Everything in that sentence except the plan
 * already existed: a turn is a record, a suspended turn resumes. What was
 * missing is the thing that carries *intent* across a suspension — the list of
 * what is still owed.
 *
 * ## Why a table and not the transcript
 *
 * The transcript already says what was planned, and that is precisely why it
 * cannot be the plan: it is the model's own prose, it gets compacted
 * (`agent/context/compact.ts`), and asking a model to re-read its own earlier
 * message for the list of open items is how a step goes missing between one
 * resume and the next. A row has a state that a `switch` can read.
 *
 * ## Read from the turn's context, or it is a table nobody looks at
 *
 * The open items are rendered into every turn of the session
 * (`agent/context/assemble.ts` → `agent/loop.ts` `buildContext`). This is the
 * load-bearing half and it is stated here because the alternative is this
 * repo's signature defect — a store with a writer, no reader, and green tests.
 * `todo.test.ts` and the loop's own wiring test both assert the read.
 *
 * ## The five states are closed, and the `CHECK` is why they are all here now
 *
 * Same trap as `episodes.kind` and `turns.status`: SQLite cannot alter a
 * `CHECK`, so a sixth state after day 1 of the fourteen costs a table rebuild.
 * The five come from M5-BIS verbatim, and there is deliberately **no**
 * "cancelled": an item that stopped mattering is `done` (it is finished with)
 * or `blocked` with the reason in its note (something stopped it). Adding a
 * state that means "never mind" would make the list a place where work
 * silently disappears, and rows are never deleted here (`AGENTS.md` §I-8) for
 * exactly the same reason.
 */

export type TodoState = 'pending' | 'done' | 'blocked' | 'waiting' | 'retry';

export const TODO_STATES: readonly TodoState[] = ['pending', 'done', 'blocked', 'waiting', 'retry'];

export type TodoItem = {
  /** Stable within the session, and what the model names when it updates one. */
  seq: number;
  text: string;
  state: TodoState;
  /** Why it is blocked, what it is waiting for, what failed. Free text, the model's. */
  note: string | null;
  createdAt: string;
  updatedAt: string;
};

export const TODO_SCHEMA = `
CREATE TABLE IF NOT EXISTS todos (
  tenant      TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  key         TEXT NOT NULL,
  text        TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('pending','done','blocked','waiting','retry')),
  note        TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (tenant, session_id, key)
);
CREATE INDEX IF NOT EXISTS idx_todos_open ON todos(tenant, session_id, state);
`;

/**
 * The identity of an item is its text, normalised.
 *
 * That is what makes `plan` idempotent, which is what makes the `todo` tool
 * honestly `rerunnable: true` — re-running the same plan after a crash writes
 * the same rows instead of a second copy of the list. Case and surrounding
 * whitespace are dropped because a model restating its plan does not restate it
 * byte for byte; interior punctuation is kept, because two steps that differ
 * only by a comma are two steps.
 */
function keyOf(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

export class TodoStore {
  private readonly upsertStmt: Database.Statement;
  private readonly nextSeqStmt: Database.Statement;
  private readonly setStateStmt: Database.Statement;
  private readonly listStmt: Database.Statement;
  private readonly openStmt: Database.Statement;
  private readonly bySeqStmt: Database.Statement;

  constructor(
    private readonly db: Database.Database,
    private readonly clock: () => Date = () => new Date(),
  ) {
    db.exec(TODO_SCHEMA);
    // `DO UPDATE` and never `DO NOTHING`: re-planning an item that is already
    // there must not resurrect it to `pending` (that would undo a `done` every
    // time the model restates the plan), but it must move `updated_at`, or an
    // item nobody has touched in a week is indistinguishable from one restated
    // a second ago. So the text is refreshed, the state is not.
    this.upsertStmt = db.prepare(
      `INSERT INTO todos (tenant, session_id, seq, key, text, state, note, created_at, updated_at)
       VALUES (@tenant, @sessionId, @seq, @key, @text, 'pending', NULL, @now, @now)
       ON CONFLICT(tenant, session_id, key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
    );
    this.nextSeqStmt = db.prepare(
      `SELECT coalesce(max(seq), 0) + 1 AS next FROM todos WHERE tenant = @tenant AND session_id = @sessionId`,
    );
    this.setStateStmt = db.prepare(
      `UPDATE todos SET state = @state, note = @note, updated_at = @now
       WHERE tenant = @tenant AND session_id = @sessionId AND seq = @seq`,
    );
    this.listStmt = db.prepare(
      `SELECT seq, text, state, note, created_at AS createdAt, updated_at AS updatedAt
       FROM todos WHERE tenant = @tenant AND session_id = @sessionId ORDER BY seq`,
    );
    this.openStmt = db.prepare(
      `SELECT seq, text, state, note, created_at AS createdAt, updated_at AS updatedAt
       FROM todos WHERE tenant = @tenant AND session_id = @sessionId AND state != 'done' ORDER BY seq`,
    );
    this.bySeqStmt = db.prepare(
      `SELECT seq FROM todos WHERE tenant = @tenant AND session_id = @sessionId AND seq = @seq`,
    );
  }

  /**
   * Write a plan. Existing items keep their identity, their number and their
   * state; new ones are appended.
   *
   * One transaction, because a plan that half-landed is worse than one that did
   * not: the model would see three of five steps and believe that was the plan.
   */
  plan(tenant: string, sessionId: string, texts: string[]): TodoItem[] {
    const now = this.clock().toISOString();
    const write = this.db.transaction(() => {
      for (const raw of texts) {
        const text = raw.trim();
        if (text === '') continue;
        const seq = (this.nextSeqStmt.get({ tenant, sessionId }) as { next: number }).next;
        this.upsertStmt.run({ tenant, sessionId, seq, key: keyOf(text), text, now });
      }
    });
    write();
    return this.list(tenant, sessionId);
  }

  /** Move one item. Returns false when there is no such number in this session. */
  setState(
    tenant: string,
    sessionId: string,
    seq: number,
    state: TodoState,
    note: string | null,
  ): boolean {
    if (this.bySeqStmt.get({ tenant, sessionId, seq }) === undefined) return false;
    this.setStateStmt.run({ tenant, sessionId, seq, state, note, now: this.clock().toISOString() });
    return true;
  }

  list(tenant: string, sessionId: string): TodoItem[] {
    return this.listStmt.all({ tenant, sessionId }) as TodoItem[];
  }

  /** What is still owed — the set the turn's context carries. */
  open(tenant: string, sessionId: string): TodoItem[] {
    return this.openStmt.all({ tenant, sessionId }) as TodoItem[];
  }
}

/**
 * One rendering of a list, used by the tool's answer and by the turn's context.
 *
 * Shared rather than written twice for the reason `describeInterrupted` is
 * shared: two places describing the same rows in different words is how a model
 * — or an owner — ends up believing they are two different lists.
 */
export function renderTodos(items: TodoItem[]): string {
  return items
    .map((i) => `${i.seq}. [${i.state}] ${i.text}${i.note === null || i.note === '' ? '' : ` — ${i.note}`}`)
    .join('\n');
}
