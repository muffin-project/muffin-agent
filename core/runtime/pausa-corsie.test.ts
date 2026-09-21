import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '../policy/types.js';
import { JobStore } from '../scheduler/jobs.js';
import { Scheduler, type SchedulerEvent } from '../scheduler/scheduler.js';
import { DELIVERED } from '../surface/types.js';
import { TurnLane, type LaneEvent } from '../turns/lane.js';
import { ModelLane } from '../turns/model-lane.js';
import { TurnStore, type NewTurn } from '../turns/store.js';
import { Pausa } from './pausa.js';

/**
 * La pausa ferma le due corsie che fanno partire lavoro (ADR-0054 §4), e il
 * lavoro resta dovuto: al `/resume` è ancora lì.
 *
 * MUTATION-worthy: togliere il ramo `paused` da `Scheduler.tick` o da
 * `TurnLane.tick` fa partire il job/il turno con la pausa attiva, e i due
 * test qui sotto diventano rossi.
 */

const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };
const flush = () => new Promise((r) => setImmediate(r));

const counters = () => ({
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
});
const spec = (id: string): NewTurn => ({
  id,
  principal: owner,
  tenant: 'host',
  surface: 'cli',
  sessionId: 's1',
  model: 'claude-opus-5',
  messages: [],
  taint: 0,
  counters: counters(),
});

describe('la corsia dei turni in pausa', () => {
  it('non prende una riga dovuta finché la pausa non si toglie', async () => {
    const db = new DatabaseCtor(':memory:');
    const store = new TurnStore(db);
    const pausa = new Pausa(db);
    const events: LaneEvent[] = [];
    const ran: string[] = [];
    const lane = new TurnLane({
      turns: store,
      run: async (turnId) => {
        ran.push(turnId);
        const claimed = store.claim(turnId);
        store.finish(turnId, { outcome: 'answered', messages: [], taint: 0, counters: counters() }, claimed?.claimToken ?? null);
        return { stopped: 'answered' };
      },
      paused: () => pausa.attiva(),
      onEvent: (e) => events.push(e),
      modelLane: new ModelLane(),
    });
    store.enqueue(spec('t-in-coda'));

    pausa.metti();
    lane.tick();
    await flush();
    expect(ran).toEqual([]);
    expect(events.at(-1)).toEqual({ kind: 'deferred', reason: 'paused' });

    pausa.togli();
    lane.tick();
    await flush();
    expect(ran).toEqual(['t-in-coda']);
  });
});

describe('lo scheduler in pausa', () => {
  it('non fa partire un job dovuto, e il job resta dovuto', async () => {
    const db = new DatabaseCtor(':memory:');
    let now = new Date('2026-06-15T05:00:00Z');
    const clock = () => now;
    const store = new JobStore(db, clock);
    const job = store.add({ cron: '0 8 * * *', timezone: 'Europe/Rome', goal: 'brief', channel: 'cli' });
    const pausa = new Pausa(db);
    const events: SchedulerEvent[] = [];
    const runJob = vi.fn(async () => ({ stopped: 'answered' as const, text: 'ecco', turnId: 'turn-1' }));
    const sched = new Scheduler(
      store,
      runJob,
      async () => DELIVERED,
      undefined,
      (e) => events.push(e),
      clock,
      undefined,
      undefined,
      new ModelLane(),
      undefined,
      undefined,
      () => pausa.attiva(),
    );
    now = new Date('2026-06-15T06:00:00Z');

    pausa.metti();
    sched.tick();
    await flush();
    expect(runJob).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ kind: 'deferred', reason: 'paused' });
    expect(store.due(now).map((j) => j.id)).toEqual([job.id]);

    pausa.togli();
    sched.tick();
    await flush();
    expect(runJob).toHaveBeenCalledOnce();
  });
});
