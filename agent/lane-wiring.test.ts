import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../cli/init.js';
import { paths } from '../core/config/config.js';
import { GatewayLock } from '../core/gateway/lock.js';
import { createNotifier } from '../core/gateway/notify.js';
import { Gateway } from '../core/gateway/service.js';
import { JobStore } from '../core/scheduler/jobs.js';
import { Scheduler } from '../core/scheduler/scheduler.js';
import { TurnLane } from '../core/turns/lane.js';
import type { TurnRecord } from '../core/turns/store.js';
import { enqueueTurn, type LoopDeps } from './loop.js';
import { buildRuntime } from './runtime.js';
import { makeLaneRunner } from './turn-lane.js';
import type { ChatResult, Provider } from './providers/types.js';

/**
 * The lane on the real path — and the two-phase delivery it makes possible.
 *
 * `core/turns/lane.test.ts` proves the lane's own decisions over the real store
 * with a faked runner. All of it would stay green if the gateway stopped
 * ticking it, or if `makeLaneRunner` stopped delivering: every suspended and
 * interrupted turn on the install would sit in `waiting`/`interrupted` for ever
 * with a green suite above it. So this file drives a **real** `Gateway` over a
 * **real** `buildRuntime`, and asserts on the row and on what the surface was
 * handed.
 *
 * One step is asserted by the type system rather than by a test, and that is
 * deliberate rather than a gap: `turnLane` is a **required** field of
 * `GatewayDeps`, so `cli/gateway.ts` cannot compile without constructing one.
 * A test that re-ran `cmdGatewayRun` would have to take the gateway lock, spawn
 * MCP children and start polling Telegram to prove something `tsc` already
 * refuses to let through.
 */

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  calls = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(): Promise<ChatResult> {
    const next = this.script[this.calls++];
    if (!next) throw new Error('lo script è finito');
    return next;
  }
}

const answer = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  stopReason: 'end',
  usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'test',
});

const call = (name: string, args: unknown = {}): ChatResult => ({
  text: null,
  toolCalls: [{ id: 'c1', name, args }],
  stopReason: 'tool_use',
  usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'test',
});

function bootHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'muffin-lanewire-'));
  runInit({ home, apiKey: 'sk-never-called' });
  return home;
}

const workspace = () => mkdtempSync(join(tmpdir(), 'muffin-lanewire-ws-'));
const owner = { kind: 'owner', connector: 'cli', externalId: 'local' } as const;

/**
 * A real gateway over a real runtime, with the lane wired exactly as
 * `cmdGatewayRun` wires it — one construction, so a divergence between this and
 * production is a divergence in two lines that sit next to each other.
 */
function gatewayOver(deps: LoopDeps, home: string, delivered: { turn: TurnRecord; text: string }[]) {
  const db = new DatabaseCtor(paths(home).db);
  const jobs = new JobStore(db);
  const lane = new TurnLane({
    turns: deps.turns,
    run: makeLaneRunner(deps, async (turn, text) => {
      delivered.push({ turn, text });
    }),
  });
  const gateway = new Gateway({
    lock: new GatewayLock(db, () => true),
    notify: createNotifier({}, () => {}),
    scheduler: new Scheduler(jobs, async () => ({ stopped: 'answered', text: '' }), async () => {}),
    turnLane: lane,
    jobs,
    close: () => {},
    log: () => {},
    pid: process.pid,
  });
  gateway.start();
  return { gateway, lane, close: () => db.close() };
}

/** Lets the background run the lane started finish, without a fixed sleep. */
async function settle(lane: TurnLane): Promise<void> {
  for (let i = 0; i < 200 && lane.isRunning(); i++) await new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('B2 · il turno torna subito, e la risposta arriva dopo', () => {
  it('enqueueTurn scrive la riga senza chiamare il modello, e la corsia la esegue', async () => {
    const home = bootHome();
    const runtime = buildRuntime(home, workspace());
    const provider = new Scripted([answer('ecco la risposta lunga')]);
    const deps: LoopDeps = { ...runtime.deps, provider };
    const delivered: { turn: TurnRecord; text: string }[] = [];

    const started = Date.now();
    const turnId = enqueueTurn(deps, {
      principal: owner,
      tenant: 'host',
      surface: 'telegram',
      session: deps.sessions.open('telegram:7'),
      text: 'fai la cosa lunga',
      replyTo: { chatId: 7, messageId: 11 },
    });
    const elapsed = Date.now() - started;

    // The property B2 asks for, at its strongest: the caller's thread never
    // touched the model at all. A 500 ms budget is what ADR-0035 §revisione
    // asks; zero model calls is why this one cannot creep up to it.
    expect(elapsed).toBeLessThan(500);
    expect(provider.calls).toBe(0);

    const queued = deps.turns.get(turnId)!;
    expect(queued.status).toBe('runnable');
    // Nobody is executing it, so nobody's pid is on it — a pid here would be
    // reclaimed as *interrupted* the moment that process exited, reporting a
    // crash for work that had not started.
    expect(queued.claimedBy).toBeNull();
    // The address travelled with it, and so did the second outcome, at pending.
    expect(queued.replyTo).toEqual({ chatId: 7, messageId: 11 });
    expect(queued.delivery).toBe('pending');

    const g = gatewayOver(deps, home, delivered);
    g.gateway.tick();
    await settle(g.lane);
    // Read the row BEFORE the teardown: `runtime.close()` closes the handle
    // this store is on, and a test that asserts after it is asserting on a dead
    // connection rather than on the database.
    const done = deps.turns.get(turnId)!;
    g.close();
    runtime.close();

    // The rest arrived from the lane.
    expect(provider.calls).toBe(1);
    expect(delivered.map((d) => d.text)).toEqual(['ecco la risposta lunga']);
    expect(delivered[0]?.turn.replyTo).toEqual({ chatId: 7, messageId: 11 });

    expect(done.status).toBe('done');
    expect(done.outcome).toBe('answered');
    // Two outcomes, two columns. They are never merged: a failed delivery must
    // not re-run the work, because that doubles it.
    expect(done.delivery).toBe('sent');
    // **Zero**, and this number is load-bearing. Running an enqueued row for the
    // first time is not picking it *back* up: counting it would spend a third of
    // `MAX_RESUMES` before the turn had run once, and a turn that then waited
    // twice would be refused as "already resumed three times and not closing".
    expect(done.counters.resumes).toBe(0);
  });

  it('una consegna fallita lascia la riga chiusa e la consegna marcata, senza rifare il lavoro', async () => {
    const home = bootHome();
    const runtime = buildRuntime(home, workspace());
    const provider = new Scripted([answer('risposta')]);
    const deps: LoopDeps = { ...runtime.deps, provider };

    const turnId = enqueueTurn(deps, {
      principal: owner,
      tenant: 'host',
      surface: 'telegram',
      session: deps.sessions.open('telegram:8'),
      text: 'ciao',
      replyTo: { chatId: 8 },
    });

    const db = new DatabaseCtor(paths(home).db);
    const jobs = new JobStore(db);
    const lane = new TurnLane({
      turns: deps.turns,
      run: makeLaneRunner(deps, async () => {
        throw new Error('telegram giù');
      }),
    });
    lane.tick();
    await settle(lane);
    const row = deps.turns.get(turnId)!;
    db.close();
    runtime.close();

    expect(row.status).toBe('done');
    expect(row.outcome).toBe('answered');
    expect(row.delivery).toBe('failed:telegram giù');
    // The model was paid once. Retrying the *turn* to fix a *delivery* is the
    // duplication `Scheduler.run` already learned not to do for jobs.
    expect(provider.calls).toBe(1);
  });
});

describe('B3 · un turno sospeso si risveglia dalla corsia del gateway', () => {
  it('il gateway lo lascia dormire, poi lo riprende alla scadenza e consegna', async () => {
    const home = bootHome();
    const runtime = buildRuntime(home, workspace());
    const provider = new Scripted([call('wait', { seconds: 3600 }), answer('ora te lo dico')]);
    const deps: LoopDeps = { ...runtime.deps, provider };
    const delivered: { turn: TurnRecord; text: string }[] = [];

    const turnId = enqueueTurn(deps, {
      principal: owner,
      tenant: 'host',
      surface: 'telegram',
      session: deps.sessions.open('telegram:9'),
      text: 'controlla fra un’ora',
      replyTo: { chatId: 9 },
    });

    const g = gatewayOver(deps, home, delivered);
    // First beat: the turn runs, asks to wait, and releases the runtime.
    g.gateway.tick();
    await settle(g.lane);

    const waiting = deps.turns.get(turnId)!;
    expect(waiting.status).toBe('waiting');
    expect(waiting.wakeAt).not.toBeNull();
    // Nothing was said yet — an empty message here would read as an answer.
    expect(delivered).toEqual([]);

    // A beat before the deadline changes nothing.
    g.gateway.tick(new Date(Date.parse(waiting.wakeAt!) - 1000));
    await settle(g.lane);
    expect(deps.turns.get(turnId)?.status).toBe('waiting');
    expect(provider.calls).toBe(1);

    // A beat after it, and the turn comes back on its own.
    g.gateway.tick(new Date(Date.parse(waiting.wakeAt!) + 1000));
    await settle(g.lane);
    const done = deps.turns.get(turnId)!;
    g.close();
    runtime.close();

    expect(provider.calls).toBe(2);
    expect(delivered.map((d) => d.text)).toEqual(['ora te lo dico']);

    expect(done.status).toBe('done');
    expect(done.delivery).toBe('sent');
    expect(done.counters.resumes).toBe(1);
  });
});

describe('B5 · un turno interrotto viene ripreso dalla corsia', () => {
  it('una riga interrupted torna a girare e la risposta arriva', async () => {
    const home = bootHome();
    const ws = workspace();
    const first = buildRuntime(home, ws);
    // A row claimed by a pid that is not running it — what a dead process
    // leaves. `reclaim` at the next boot marks it, and until this slice nothing
    // ever read it back.
    first.deps.turns.create(
      {
        id: 'interrotto',
        principal: owner,
        tenant: 'host',
        surface: 'telegram',
        sessionId: 'telegram:10',
        model: first.config.models.main,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'a che ora è il treno?' }] }],
        taint: 0,
        counters: {
          iterations: 0,
          recoveriesUsed: 0,
          transportRetriesLeft: 2,
          toolCallsMade: 0,
          nudgedForCompletion: false,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          spentUsd: 0,
          resumes: 0,
          contextBuilt: false,
        },
        replyTo: { chatId: 10 },
      },
      999_999,
    );
    first.close();

    // The next boot marks it, exactly as production does.
    const runtime = buildRuntime(home, ws);
    expect(runtime.bootLines.join('\n')).toContain('interrotto');
    expect(runtime.deps.turns.get('interrotto')?.status).toBe('interrupted');

    const provider = new Scripted([answer('alle 9:42')]);
    const deps: LoopDeps = { ...runtime.deps, provider };
    const delivered: { turn: TurnRecord; text: string }[] = [];
    const g = gatewayOver(deps, home, delivered);
    g.gateway.tick();
    await settle(g.lane);
    const done = deps.turns.get('interrotto')!;
    g.close();
    runtime.close();

    // This is the line M5-BIS B5 asks for: it died in the middle, and it
    // resumed — with the answer reaching the surface the row named.
    expect(delivered.map((d) => d.text)).toEqual(['alle 9:42']);

    expect(done.status).toBe('done');
    expect(done.delivery).toBe('sent');
    expect(done.counters.resumes).toBe(1);
  });
});
