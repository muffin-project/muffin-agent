import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_ALREADY_RUNNING } from '../core/gateway/service.js';
import { mintHolderId } from '../core/lock/incarnation.js';
import { cmdGatewayUnlock } from './gateway.js';

/**
 * `muffin gateway unlock` on the production function, and once through
 * `cli/main.ts`, so a dispatch that forgot the verb cannot stay green.
 *
 * The live case is this process: it holds an incarnation file the way a
 * gateway does. The stale case is a file nobody holds, with this process's
 * pid written on the row, which is what a restarted container looks like.
 */

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-unlock-'));
  homes.push(dir);
  return dir;
}

function deadPid(): number {
  const { pid } = spawnSync('/bin/sh', ['-c', 'exit 0']);
  if (pid === undefined) throw new Error('spawnSync non ha dato un pid');
  return pid;
}

/** An incarnation file nobody holds. */
function deadIncarnation(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const database = new DatabaseCtor(join(dir, `${id}.db`));
  database.exec(`CREATE TABLE incarnation (pid INTEGER NOT NULL, started_at TEXT NOT NULL)`);
  database.close();
  return id;
}

function seedGateway(
  dir: string,
  row: { pid: number; holderId: string | null; takenAt: string; since: string },
): void {
  const database = new DatabaseCtor(join(dir, 'muffin.db'));
  database.exec(`
    CREATE TABLE gateway_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      pid INTEGER,
      taken_at TEXT,
      since TEXT,
      status TEXT,
      holder_id TEXT
    )
  `);
  database
    .prepare(
      `INSERT INTO gateway_lock (id, pid, taken_at, since, status, holder_id) VALUES (1, ?, ?, ?, 'serving', ?)`,
    )
    .run(row.pid, row.takenAt, row.since, row.holderId);
  database.close();
}

function readRow(dir: string): {
  pid: number | null;
  holder_id: string | null;
  since: string;
  taken_at: string;
} {
  const database = new DatabaseCtor(join(dir, 'muffin.db'), { readonly: true });
  try {
    return database
      .prepare(`SELECT pid, holder_id, since, taken_at FROM gateway_lock WHERE id = 1`)
      .get() as {
      pid: number | null;
      holder_id: string | null;
      since: string;
      taken_at: string;
    };
  } finally {
    database.close();
  }
}

describe('muffin gateway unlock', () => {
  it('refuses while the incarnation lock is held, and does not write', () => {
    const dir = home();
    const database = new DatabaseCtor(join(dir, 'muffin.db'));
    const holderId = mintHolderId(database);
    database.close();
    const since = '2026-11-14T08:00:00.000Z';
    const takenAt = '2026-11-15T08:00:00.000Z';
    // A dead pid on purpose: the refusal has to come from the incarnation,
    // not from `kill(pid, 0)` happening to succeed.
    const pid = deadPid();
    seedGateway(dir, { pid, holderId, takenAt, since });

    const lines: string[] = [];
    const code = cmdGatewayUnlock(dir, ['--confirm'], {
      out: (text) => lines.push(text),
      err: (text) => lines.push(text),
    });

    expect(code).toBe(EXIT_ALREADY_RUNNING);
    const text = lines.join('');
    expect(text).toContain('rifiutato');
    expect(text).toContain(holderId);
    expect(text).toContain(`pid: ${String(pid)}`);
    expect(readRow(dir)).toMatchObject({ pid, holder_id: holderId, since, taken_at: takenAt });
  });

  it('without --confirm still refuses a live incarnation and does not describe a removal', () => {
    const dir = home();
    const database = new DatabaseCtor(join(dir, 'muffin.db'));
    const holderId = mintHolderId(database);
    database.close();
    const since = '2026-11-14T08:00:00.000Z';
    const takenAt = '2026-11-15T08:00:00.000Z';
    seedGateway(dir, { pid: deadPid(), holderId, takenAt, since });

    const out: string[] = [];
    const err: string[] = [];
    const code = cmdGatewayUnlock(dir, [], {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    });

    expect(code).toBe(EXIT_ALREADY_RUNNING);
    expect(err.join('')).toContain('rifiutato');
    expect(out.join('')).not.toContain('non ho scritto nulla');
    expect(readRow(dir).holder_id).toBe(holderId);
  });

  it('without --confirm prints the stale row and leaves it', () => {
    const dir = home();
    const holderId = `${deadIncarnation(join(dir, 'incarnations'))}.${randomUUID()}`;
    const since = '2026-11-14T08:00:00.000Z';
    const takenAt = '2026-11-15T08:00:00.000Z';
    seedGateway(dir, { pid: process.pid, holderId, takenAt, since });

    const out: string[] = [];
    const err: string[] = [];
    const code = cmdGatewayUnlock(dir, [], {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    });

    expect(code).toBe(0);
    const printed = out.join('');
    expect(printed).toContain('non ho scritto nulla');
    expect(printed).toContain('--confirm');
    expect(printed).toContain(String(process.pid));
    expect(printed).toContain(holderId);
    expect(printed).toContain(takenAt);
    expect(err.join('')).not.toContain('claim rimosso');
    expect(readRow(dir).pid).toBe(process.pid);
  });

  it('with --confirm clears a stale row and logs what it removed', () => {
    const dir = home();
    const holderId = `${deadIncarnation(join(dir, 'incarnations'))}.${randomUUID()}`;
    const since = '2026-11-14T08:00:00.000Z';
    const takenAt = '2026-11-15T08:00:00.000Z';
    // The pid on the row is this process. The incarnation file is not locked,
    // which is the stale row a clock step leaves behind a dead holder.
    seedGateway(dir, { pid: process.pid, holderId, takenAt, since });

    const err: string[] = [];
    const out: string[] = [];
    const code = cmdGatewayUnlock(dir, ['--confirm'], {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    });

    expect(code).toBe(0);
    const logged = err.join('');
    expect(logged).toContain('GATEWAY UNLOCK: claim rimosso');
    expect(logged).toContain(`pid: ${String(process.pid)}`);
    expect(logged).toContain(`holder_id: ${holderId}`);
    expect(logged).toContain(`taken_at: ${takenAt}`);
    expect(logged).toContain(`since: ${since}`);
    expect(out.join('')).toContain('claim rimosso');
    expect(readRow(dir)).toMatchObject({ pid: null, holder_id: null, since, taken_at: takenAt });
  });

  it('the verb is the one `cli/main.ts` dispatches', () => {
    const dir = home();
    const holderId = `${deadIncarnation(join(dir, 'incarnations'))}.${randomUUID()}`;
    const since = '2026-11-14T08:00:00.000Z';
    const takenAt = '2026-11-15T08:00:00.000Z';
    seedGateway(dir, { pid: process.pid, holderId, takenAt, since });

    const cwd = mkdtempSync(join(process.cwd(), 'muffin-test-cwd-'));
    homes.push(cwd);
    const result = spawnSync(
      'node',
      ['--import', 'tsx', join(process.cwd(), 'cli/main.ts'), 'gateway', 'unlock', '--confirm'],
      {
        env: {
          ...process.env,
          MUFFIN_HOME: dir,
          HOME: dir,
          XDG_CONFIG_HOME: join(dir, '.config'),
          NO_COLOR: '1',
        },
        encoding: 'utf8',
        timeout: 60_000,
        cwd,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('GATEWAY UNLOCK: claim rimosso');
    expect(result.stderr).toContain(holderId);
    expect(readRow(dir)).toMatchObject({ pid: null, holder_id: null, since });
  });
});
