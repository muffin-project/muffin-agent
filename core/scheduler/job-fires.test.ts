import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { JobStore } from './jobs.js';
import { JobFireStore } from './job-fires.js';
import { TurnStore } from '../turns/store.js';

const NOW = new Date('2026-06-15T06:00:00Z');
const SPEC = { cron: '0 8 * * *', timezone: 'Europe/Rome', goal: 'brief', channel: 'cli' };

function memStore(now = NOW): { db: DatabaseCtor.Database; fires: JobFireStore } {
  const db = new DatabaseCtor(':memory:');
  return { db, fires: new JobFireStore(db, () => now) };
}

describe('JobFireStore — the migration (§ "cosa costruire" 3)', () => {
  it('CREATE TABLE IF NOT EXISTS on a database that already has real jobs/turns rows loses nothing and adds no missing column', () => {
    // A stand-in for the owner's already-installed muffin.db: jobs and turns
    // exist and have real rows in them *before* job_fires is ever heard of.
    const db = new DatabaseCtor(':memory:');
    const jobs = new JobStore(db, () => NOW);
    const turns = new TurnStore(db, () => NOW);
    const job = jobs.add(SPEC);
    const turn = turns.create({
      id: 'pre-existing-turn',
      principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
      tenant: 'host',
      surface: 'cli',
      sessionId: 's1',
      model: 'test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ciao' }] }],
      taint: 0,
      counters: {
        iterations: 0,
        recoveriesUsed: 0,
        transportRetriesLeft: 2,
        truncationsUsed: 0,
        toolCallsMade: 0,
        nudgedForCompletion: false,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        spentUsd: 0,
        resumes: 0,
        contextBuilt: false,
      },
    });

    // Opening JobFireStore on the SAME connection is the "already-installed
    // database" case: no migration runner, just `db.exec(SCHEMA)`.
    const fires = new JobFireStore(db, () => NOW);

    // The table exists now, with exactly the columns the mandate asks for.
    const columns = (db.prepare(`PRAGMA table_info(job_fires)`).all() as { name: string }[]).map((c) => c.name);
    expect(columns.sort()).toEqual(['created_at', 'job_id', 'scheduled_for', 'settled_at', 'turn_id'].sort());

    // Nothing pre-existing was disturbed: same job, same turn, every column.
    expect(jobs.get(job.id)).toEqual(job);
    expect(turns.get(turn.id)).toEqual(turn);

    // And the new store works immediately on this same, previously-fireless database.
    const fire = fires.claim(job.id, job.nextFireAt.toISOString());
    expect(fire.turnId).toBeNull();
    expect(fire.settledAt).toBeNull();
  });
});

describe('JobFireStore.claim — fault point 1: crash before the fire → it gets created', () => {
  it('the occurrence exists after the first call, exactly once', () => {
    const { db, fires } = memStore();
    const fire = fires.claim('job-1', '2026-06-16T06:00:00.000Z');
    expect(fire).toEqual({ jobId: 'job-1', scheduledFor: '2026-06-16T06:00:00.000Z', turnId: null, settledAt: null });
    const rows = db.prepare(`SELECT count(*) AS n FROM job_fires`).get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('a retry after a (simulated) crash before the fire is a no-op, not a second row', () => {
    // The scenario the fault point names: the process died with nothing
    // written, and a fresh attempt runs `claim` again for the same key.
    const { db, fires } = memStore();
    fires.claim('job-1', '2026-06-16T06:00:00.000Z');
    const second = fires.claim('job-1', '2026-06-16T06:00:00.000Z');
    expect(second).toEqual({ jobId: 'job-1', scheduledFor: '2026-06-16T06:00:00.000Z', turnId: null, settledAt: null });
    const rows = db.prepare(`SELECT count(*) AS n FROM job_fires`).get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('two different occurrences of the same job get two different rows', () => {
    const { fires } = memStore();
    fires.claim('job-1', '2026-06-16T06:00:00.000Z');
    fires.claim('job-1', '2026-06-17T06:00:00.000Z');
    expect(fires.get('job-1', '2026-06-16T06:00:00.000Z')).not.toBeNull();
    expect(fires.get('job-1', '2026-06-17T06:00:00.000Z')).not.toBeNull();
  });

  it('the UNIQUE constraint is real, not just a convention `claim` happens to respect', () => {
    // Bypassing the store's own INSERT OR IGNORE to prove the schema itself
    // enforces one row per (job_id, scheduled_for) — a raw second INSERT must
    // throw, not silently duplicate.
    const { db, fires } = memStore();
    fires.claim('job-1', '2026-06-16T06:00:00.000Z');
    expect(() =>
      db
        .prepare(`INSERT INTO job_fires (job_id, scheduled_for, turn_id, settled_at, created_at) VALUES (?, ?, NULL, NULL, ?)`)
        .run('job-1', '2026-06-16T06:00:00.000Z', NOW.toISOString()),
    ).toThrow(/UNIQUE constraint failed/);
  });
});

describe('JobFireStore.bind — fault point 3: after turn creation, the same turn_id', () => {
  it('binds a fresh occurrence to the given turn id', () => {
    const { fires } = memStore();
    fires.claim('job-1', '2026-06-16T06:00:00.000Z');
    const winner = fires.bind('job-1', '2026-06-16T06:00:00.000Z', 'turn-a');
    expect(winner).toBe('turn-a');
    expect(fires.get('job-1', '2026-06-16T06:00:00.000Z')?.turnId).toBe('turn-a');
  });

  it('first writer wins: a second bind for the same occurrence returns the first id, never overwrites it', () => {
    const { fires } = memStore();
    fires.claim('job-1', '2026-06-16T06:00:00.000Z');
    const first = fires.bind('job-1', '2026-06-16T06:00:00.000Z', 'turn-a');
    // A second process racing on the same fire, minting its own id.
    const second = fires.bind('job-1', '2026-06-16T06:00:00.000Z', 'turn-b');
    expect(first).toBe('turn-a');
    // The loser gets told the winner's id back — never its own.
    expect(second).toBe('turn-a');
    expect(fires.get('job-1', '2026-06-16T06:00:00.000Z')?.turnId).toBe('turn-a');
  });

  it('binding the SAME id twice (a retried call) is idempotent', () => {
    const { fires } = memStore();
    fires.claim('job-1', '2026-06-16T06:00:00.000Z');
    fires.bind('job-1', '2026-06-16T06:00:00.000Z', 'turn-a');
    const again = fires.bind('job-1', '2026-06-16T06:00:00.000Z', 'turn-a');
    expect(again).toBe('turn-a');
  });
});

describe('JobFireStore.settle — fault point 7: settlement, then (and only then) the schedule advances', () => {
  it('marks settled_at, once', () => {
    const { fires } = memStore();
    fires.claim('job-1', '2026-06-16T06:00:00.000Z');
    fires.bind('job-1', '2026-06-16T06:00:00.000Z', 'turn-a');
    expect(fires.get('job-1', '2026-06-16T06:00:00.000Z')?.settledAt).toBeNull();
    fires.settle('job-1', '2026-06-16T06:00:00.000Z');
    const settledAt = fires.get('job-1', '2026-06-16T06:00:00.000Z')?.settledAt;
    expect(settledAt).toBe(NOW.toISOString());
  });

  it('a second settle (a delivery retry, a duplicate tick) never moves settled_at', () => {
    let now = NOW;
    const db = new DatabaseCtor(':memory:');
    const fires = new JobFireStore(db, () => now);
    fires.claim('job-1', '2026-06-16T06:00:00.000Z');
    fires.bind('job-1', '2026-06-16T06:00:00.000Z', 'turn-a');
    fires.settle('job-1', '2026-06-16T06:00:00.000Z');
    const first = fires.get('job-1', '2026-06-16T06:00:00.000Z')?.settledAt;

    now = new Date(NOW.getTime() + 60_000); // an hour of clock later, say
    fires.settle('job-1', '2026-06-16T06:00:00.000Z');
    const second = fires.get('job-1', '2026-06-16T06:00:00.000Z')?.settledAt;
    expect(second).toBe(first);
  });

  it('settle on an occurrence that was never claimed touches nothing (no row to settle)', () => {
    const { fires } = memStore();
    expect(() => fires.settle('ghost-job', '2026-06-16T06:00:00.000Z')).not.toThrow();
    expect(fires.get('ghost-job', '2026-06-16T06:00:00.000Z')).toBeNull();
  });
});
