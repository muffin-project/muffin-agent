import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { Principal } from '../policy/types.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { JobStore } from '../scheduler/jobs.js';
import { ModelLane } from './model-lane.js';
import { TurnLane, type LaneEvent } from './lane.js';
import { TurnStore, type NewTurn } from './store.js';
import { encodeWaitFor } from './wait.js';
import { DELIVERED } from '../surface/types.js';

/**
 * The lane, over the real store.
 *
 * A fake store would prove the branching and nothing else, and the interesting
 * half is precisely the query: `due` returns three different producers as one
 * queue — a row a surface enqueued (B2), a row whose deadline passed (B3), a row
 * a dead process left (B5) — and until this file existed nothing read it back.
 * So the store is real and only the *runner* is faked, because running a turn
 * means a model.
 */

const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };

const counters = () => ({
  iterations: 0,
  recoveriesUsed: 0,
  transportRetriesLeft: 2,
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

function world(over: { alive?: (pid: number) => boolean } = {}) {
  const store = new TurnStore(new DatabaseCtor(':memory:'));
  const events: LaneEvent[] = [];
  const ran: string[] = [];
  let resolveRun: (() => void) | null = null;
  let block = false;

  const lane = new TurnLane({
    turns: store,
    run: async (turnId) => {
      ran.push(turnId);
      if (block) await new Promise<void>((r) => (resolveRun = r));
      // The runner owns claiming — `resumeTurn` does it. Here the row simply
      // leaves the due set, the way a real run leaves it.
      const claimed = store.claim(turnId);
      store.finish(turnId, { outcome: 'answered', messages: [], taint: 0, counters: counters() }, claimed?.claimToken ?? null);
      return { stopped: 'answered' as const };
    },
    onEvent: (e) => events.push(e),
    // A fresh token: this lane's own concurrency-with-itself is what these
    // cases exercise, not sharing with a scheduler — that has its own describe
    // block below.
    modelLane: new ModelLane(),
    ...(over.alive ? { alive: over.alive } : {}),
  });

  return {
    store,
    lane,
    events,
    ran,
    hold: () => {
      block = true;
    },
    release: () => {
      block = false;
      resolveRun?.();
    },
  };
}

/** Waits for the background run the lane started, without a fixed sleep. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

describe('la corsia prende le tre code in una', () => {
  it('esegue un turno che una superficie ha registrato e non ha eseguito (B2)', async () => {
    const w = world();
    w.store.enqueue(spec('t-enqueued'));
    w.lane.tick();
    await settle();
    expect(w.ran).toEqual(['t-enqueued']);
  });

  it('esegue un turno interrotto da un processo morto (B5)', async () => {
    const w = world();
    // Claimed by a pid that is not running it, then reclaimed — the state a
    // crash really leaves.
    w.store.create(spec('t-dead'), 999_999);
    expect(w.store.reclaim().map((t) => t.id)).toEqual(['t-dead']);
    w.lane.tick();
    await settle();
    expect(w.ran).toEqual(['t-dead']);
  });

  it('non tocca un turno sospeso prima della sua scadenza, e lo prende dopo (B3)', async () => {
    const w = world();
    const created = w.store.create(spec('t-waiting'));
    w.store.suspend(
      't-waiting',
      { messages: [], taint: 0, counters: counters(), wakeAt: '2026-08-16T11:00:00.000Z', waitFor: null },
      created.claimToken,
    );

    w.lane.tick(new Date('2026-08-16T10:59:59.000Z'));
    await settle();
    expect(w.ran).toEqual([]);

    w.lane.tick(new Date('2026-08-16T11:00:00.000Z'));
    await settle();
    expect(w.ran).toEqual(['t-waiting']);
  });
});

describe('le barriere a evento', () => {
  it('sveglia in anticipo il turno il cui processo è uscito', async () => {
    // `alive` says no for this pid, which is what "the process exited" is.
    const w = world({ alive: () => false });
    const created = w.store.create(spec('t-armed'));
    w.store.suspend(
      't-armed',
      {
        messages: [],
        taint: 0,
        counters: counters(),
        // A week away: only the event can be what woke it.
        wakeAt: '2026-08-23T10:00:00.000Z',
        waitFor: encodeWaitFor({ kind: 'process_exit', pid: 4242 }),
      },
      created.claimToken,
    );

    w.lane.tick(new Date('2026-08-16T10:00:00.000Z'));
    await settle();
    expect(w.events.some((e) => e.kind === 'woken' && e.turnId === 't-armed')).toBe(true);
    expect(w.ran).toEqual(['t-armed']);
  });

  it('lascia dormire il turno il cui processo è ancora vivo', async () => {
    const w = world({ alive: () => true });
    const created = w.store.create(spec('t-armed'));
    w.store.suspend(
      't-armed',
      {
        messages: [],
        taint: 0,
        counters: counters(),
        wakeAt: '2026-08-23T10:00:00.000Z',
        waitFor: encodeWaitFor({ kind: 'process_exit', pid: 4242 }),
      },
      created.claimToken,
    );
    w.lane.tick(new Date('2026-08-16T10:00:00.000Z'));
    await settle();
    expect(w.ran).toEqual([]);
    expect(w.store.get('t-armed')?.status).toBe('waiting');
  });

  it('una barriera illeggibile degrada alla scadenza invece di far cadere la corsia', async () => {
    const w = world({ alive: () => false });
    const created = w.store.create(spec('t-junk'));
    // A row from a future version, or edited by hand. The lane may not throw on
    // it: one bad row would stop every suspended turn on the machine.
    w.store.suspend(
      't-junk',
      { messages: [], taint: 0, counters: counters(), wakeAt: '2026-08-23T10:00:00.000Z', waitFor: 'file_changed:/tmp/x' },
      created.claimToken,
    );
    expect(() => w.lane.tick(new Date('2026-08-16T10:00:00.000Z'))).not.toThrow();
    await settle();
    expect(w.ran).toEqual([]);
    expect(w.store.get('t-junk')?.status).toBe('waiting');
  });
});

describe('una corsia sola, e non si incastra', () => {
  it('un turno alla volta: il secondo tick differisce invece di raddoppiare', async () => {
    const w = world();
    w.hold();
    w.store.enqueue(spec('t-1'));
    w.store.enqueue(spec('t-2'));

    w.lane.tick();
    await settle();
    w.lane.tick();
    await settle();
    // The second tick found the lane busy. Running both would mean two turns
    // over one model lane, which is the duplication the record exists to stop.
    expect(w.ran).toEqual(['t-1']);
    expect(w.events.some((e) => e.kind === 'deferred' && e.reason === 'in_flight')).toBe(true);
    expect(w.lane.isRunning()).toBe(true);

    w.release();
    await settle();
    expect(w.lane.isRunning()).toBe(false);
  });

  it('le barriere si valutano anche mentre un turno è in volo', async () => {
    // Waking is a single UPDATE that starts nothing, so a turn whose process
    // exited during a long turn must not have to wait for its deadline.
    const w = world({ alive: () => false });
    w.hold();
    w.store.enqueue(spec('t-long'));
    w.lane.tick();
    await settle();

    const created = w.store.create(spec('t-armed'));
    w.store.suspend(
      't-armed',
      {
        messages: [],
        taint: 0,
        counters: counters(),
        wakeAt: '2026-08-23T10:00:00.000Z',
        waitFor: encodeWaitFor({ kind: 'process_exit', pid: 4242 }),
      },
      created.claimToken,
    );

    w.lane.tick();
    await settle();
    expect(w.store.get('t-armed')?.status).toBe('runnable');
    w.release();
  });

  it('un turno che esplode non porta giù la corsia', async () => {
    const store = new TurnStore(new DatabaseCtor(':memory:'));
    const events: LaneEvent[] = [];
    const lane = new TurnLane({
      turns: store,
      run: async () => {
        throw new Error('il turno è esploso');
      },
      onEvent: (e) => events.push(e),
      modelLane: new ModelLane(),
    });
    store.enqueue(spec('t-boom'));
    lane.tick();
    await settle();
    expect(events.some((e) => e.kind === 'failed' && e.error === 'il turno è esploso')).toBe(true);
    // …and it is free again, so the next row is not starved by the bad one.
    expect(lane.isRunning()).toBe(false);
  });

  it('cede quando un altro processo ha preso lo store, senza nemmeno guardare le righe', async () => {
    const store = new TurnStore(new DatabaseCtor(':memory:'));
    const ran: string[] = [];
    const lane = new TurnLane({
      turns: store,
      run: async (id) => (ran.push(id), { stopped: 'answered' as const }),
      standDown: () => true,
      modelLane: new ModelLane(),
    });
    store.enqueue(spec('t-theirs'));
    lane.tick();
    await settle();
    expect(ran).toEqual([]);
  });

  it('cede al foreground: il modello è una corsia sola, come per i job', async () => {
    const store = new TurnStore(new DatabaseCtor(':memory:'));
    const ran: string[] = [];
    const lane = new TurnLane({
      turns: store,
      run: async (id) => (ran.push(id), { stopped: 'answered' as const }),
      gate: { isActive: () => true, signal: () => undefined },
      modelLane: new ModelLane(),
    });
    store.enqueue(spec('t-later'));
    lane.tick();
    await settle();
    expect(ran).toEqual([]);
  });
});

describe('una corsia del modello sola, per davvero', () => {
  /**
   * The claim at the top of `lane.ts` — that this and `Scheduler` share the
   * model lane — used to be true of each of them **separately**: a private
   * `running` flag each, and `Gateway.tick` drives both in the same beat. A
   * job and a resumed turn therefore ran at the same moment, against one
   * provider and one budget, while both files said they could not.
   *
   * So the assertion is a **measured maximum concurrency**, not a flag: both
   * lanes are armed with work and told to tick the way the gateway ticks them.
   */
  it('con entrambe le corsie cariche, la concorrenza massima è 1', async () => {
    const db = new DatabaseCtor(':memory:');
    const store = new TurnStore(db);
    const jobs = new JobStore(db);
    const modelLane = new ModelLane();

    let live = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    const hold = async (): Promise<void> => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise<void>((r) => release.push(r));
      live -= 1;
    };

    const scheduler = new Scheduler(
      jobs,
      async () => {
        await hold();
        return { stopped: 'answered' as const, text: 'job', turnId: null };
      },
      async () => DELIVERED,
      undefined,
      () => {},
      undefined,
      undefined,
      undefined,
      modelLane,
    );
    const lane = new TurnLane({
      turns: store,
      run: async (turnId) => {
        await hold();
        const claimed = store.claim(turnId);
        store.finish(turnId, { outcome: 'answered', messages: [], taint: 0, counters: counters() }, claimed?.claimToken ?? null);
        return { stopped: 'answered' as const };
      },
      modelLane,
    });

    jobs.add({ cron: '* * * * *', timezone: 'Europe/Rome', goal: 'un job', channel: 'cli' });
    store.enqueue(spec('t-1'));

    // Exactly what `Gateway.tick` does, twice, so both lanes get their chance.
    const beat = new Date(Date.now() + 120_000);
    scheduler.tick(beat);
    lane.tick(beat);
    await settle();
    scheduler.tick(beat);
    lane.tick(beat);
    await settle();

    expect(peak).toBe(1);
    // …and it really was contended: something was held the whole time.
    expect(live).toBe(1);

    for (const r of release) r();
    await settle();
  });

  it('quando la prima lascia, la seconda parte al battito dopo', async () => {
    // A serialiser that never let the other side run would also score 1.
    const db = new DatabaseCtor(':memory:');
    const store = new TurnStore(db);
    const modelLane = new ModelLane();
    const ran: string[] = [];
    let release: (() => void) | null = null;

    const lane = new TurnLane({
      turns: store,
      run: async (turnId) => {
        ran.push(turnId);
        const claimed = store.claim(turnId);
        store.finish(turnId, { outcome: 'answered', messages: [], taint: 0, counters: counters() }, claimed?.claimToken ?? null);
        return { stopped: 'answered' as const };
      },
      modelLane,
    });

    // The scheduler is holding it.
    expect(modelLane.take('jobs')).toBeNull();
    store.enqueue(spec('t-later'));
    lane.tick();
    await settle();
    expect(ran).toEqual([]);

    modelLane.release('jobs');
    release = null;
    expect(release).toBeNull();
    lane.tick();
    await settle();
    expect(ran).toEqual(['t-later']);
  });
});
