import DatabaseCtor from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { DELIVERED } from '../core/surface/types.js';
import { loadConfig, paths, saveConfig } from '../core/config/config.js';
import { GatewayLock, readGateway, STALE_AFTER_MS } from '../core/gateway/lock.js';
import { describeSupervision } from '../core/gateway/notify.js';
import { LAUNCHD_LABEL } from '../core/gateway/unit.js';
import { HARD_STALE_MULTIPLIER } from '../core/lock/durable.js';
import { JobStore } from '../core/scheduler/jobs.js';
import { Scheduler, type SchedulerEvent } from '../core/scheduler/scheduler.js';
import type { TurnLane } from '../core/turns/lane.js';
import { ModelLane } from '../core/turns/model-lane.js';
import { TurnStore } from '../core/turns/store.js';
import { gatewayStandDown } from './repl.js';
import { cmdGatewayInstall, cmdGatewayStatus, EXIT_NOT_ACTIVATED } from './gateway.js';
import { cmdGatewayRestart, cmdGatewayRun, stopCaveat, tickMsFromEnv } from './gateway.js';
import { runInit } from './init.js';

/**
 * The wiring, from the command line the owner actually types.
 *
 * `docs/JUDGE.md`: *"parti dal punto d'ingresso di produzione e prova a
 * raggiungere il meccanismo. Se non riesci a dimostrare il percorso, la
 * garanzia è non provata."* Every test here spawns the real `cli/main.ts` — the
 * unit tests already prove the lock refuses a second holder, and none of them
 * would notice if `cli/repl.ts` stopped consulting it.
 *
 * The child is a real process for a second reason: the property under test is
 * "two schedulers must never run", and a live holder needs a pid that is really
 * alive. The test runner's own pid is the honest one to use.
 */

const homes: string[] = [];
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-gw-cli-'));
  homes.push(dir);
  runInit({ home: dir, apiKey: 'sk-never-called' });
  return dir;
}

/** Flip a fixture home to the systemd backend (explicit, like the CLI does). */
function flipBackendSystemd(dir: string): void {
  const config = loadConfig(dir);
  saveConfig({ ...config, secrets: { backend: 'systemd' } }, dir);
}

/** Pretend a gateway is up, held by this very process — a pid that is alive. */
function holdGateway(dir: string, status = 'in attesa'): void {
  const db = new DatabaseCtor(paths(dir).db);
  const outcome = new GatewayLock(db).claim(new Date(), status, process.pid);
  if (!('release' in outcome)) throw new Error('la fixture non è riuscita a prendere il lock');
  db.close();
}

/**
 * A job that came due while nothing was running — the catch-up case `markRan`
 * is written for, and the only way to have one: `JobStore.add` computes the
 * first fire from now, so no cron expression is ever already due. The fire time
 * is moved back by hand rather than the clock forward, because the process
 * under test is a real one and does not share a clock with us.
 */
function overdueJob(dir: string): string {
  const db = new DatabaseCtor(paths(dir).db);
  try {
    const job = new JobStore(db).add({ cron: '0 8 * * *', timezone: 'Europe/Rome', goal: 'brief', channel: 'cli' });
    db.prepare(`UPDATE jobs SET next_fire_at = ? WHERE id = ?`).run(new Date(Date.now() - 60_000).toISOString(), job.id);
    return job.id;
  } finally {
    db.close();
  }
}

/**
 * A `waiting` turn nobody is running, already past its deadline — `due()`'s
 * second disjunct (`status = 'waiting' AND wake_at <= now`), the one B3 route
 * `TurnLane` reads and `overdueJob` above has no equivalent of. Written
 * through the real `TurnStore` rather than by hand so the JSON columns and the
 * fencing token are exactly what production writes.
 */
function waitingTurn(dir: string): string {
  const db = new DatabaseCtor(paths(dir).db);
  try {
    const id = 'turno-in-attesa';
    const counters = {
      iterations: 1,
      recoveriesUsed: 0,
      transportRetriesLeft: 2,
      toolCallsMade: 0,
      nudgedForCompletion: false,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      spentUsd: 0,
      resumes: 0,
      contextBuilt: true,
    };
    const created = new TurnStore(db).create(
      {
        id,
        principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
        tenant: 'host',
        surface: 'cli',
        sessionId: 'cli:stillowner',
        // The runtime's own pinned model, not a literal: a resume refuses
        // outright on a mismatch (`resumeTurn`, ADR-0037), which would prove
        // the refusal path rather than `stillOwner`.
        model: loadConfig(dir).models.main,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'controlla più tardi' }] }],
        taint: 0,
        counters,
      },
      process.pid,
    );
    new TurnStore(db).suspend(
      id,
      { messages: [], taint: 0, counters, wakeAt: new Date(Date.now() - 60_000).toISOString(), waitFor: null },
      created.claimToken,
    );
    return id;
  } finally {
    db.close();
  }
}

function jobRow(dir: string, id: string): { last_run_at: string | null; next_fire_at: string } {
  const db = new DatabaseCtor(paths(dir).db, { readonly: true });
  try {
    return db.prepare(`SELECT last_run_at, next_fire_at FROM jobs WHERE id = ?`).get(id) as {
      last_run_at: string | null;
      next_fire_at: string;
    };
  } finally {
    db.close();
  }
}

function muffin(
  dir: string,
  args: string[],
  stdin = '',
  extraEnv: Record<string, string> = {},
  timeout = 60_000,
): { code: number; out: string; err: string } {
  // Il figlio gira in una directory vuota, mai nel checkout: vedi il commento
  // dentro l'oggetto qui sotto. La directory si registra per la pulizia come
  // le home. Sta DENTRO la radice del repo, non in /tmp: `node --import tsx`
  // risolve il pacchetto dalla cwd verso l'alto e in /tmp il figlio muore con
  // ERR_MODULE_NOT_FOUND; il loader `.env` legge solo `${cwd}/.env`, mai i
  // genitori, quindi la sottodirectory fresca non ha nessun `.env`.
  const cwd = mkdtempSync(join(process.cwd(), 'muffin-test-cwd-'));
  homes.push(cwd);
  const result = spawnSync('node', ['--import', 'tsx', join(process.cwd(), 'cli/main.ts'), ...args], {
    // HOME and XDG_CONFIG_HOME are redirected into the temp home so `install
    // --write` can never put a real service unit in the owner's `~/Library` or
    // `~/.config`. It did exactly that once, and the file outlived the run
    // because the cleanup was after a failing assertion.
    //
    // Il figlio gira in una directory vuota, mai nel checkout: `cli/main.ts`
    // carica `${cwd}/.env` quando c'è, e un `.env` del founder nella radice
    // del repo avvelenava lo scenario "off a terminal" con il messaggio di
    // rifiuto della chiave invece del comando stampato (18/09/2026, stessa
    // radice dei 18 rossi di `cli/main.test.ts`, verdi in CI).
    env: { ...process.env, MUFFIN_HOME: dir, HOME: dir, XDG_CONFIG_HOME: join(dir, '.config'), NO_COLOR: '1', ...extraEnv },
    input: stdin,
    encoding: 'utf8',
    timeout,
    cwd,
  });
  return { code: result.status ?? -1, out: result.stdout ?? '', err: result.stderr ?? '' };
}

describe('muffin gateway status', () => {
  it('says nothing is running, and exits non-zero, on a fresh home', () => {
    const r = muffin(home(), ['gateway', 'status']);
    expect(r.out).toContain('nessun gateway attivo');
    // Scriptable "is it up", the shape `systemctl is-active` has. Zero here
    // would make a dead gateway succeed in a shell conditional.
    expect(r.code).toBe(1);
  });

  it('reports the pid, since when, and what it is doing', () => {
    const dir = home();
    holdGateway(dir, 'job in corso');
    const r = muffin(dir, ['gateway', 'status']);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`pid ${process.pid}`);
    expect(r.out).toContain('job in corso');
    expect(r.out).toMatch(/dal \d/);
  });
});

describe('two schedulers must never run', () => {
  it('the REPL keeps the ticker when nothing else owns it', () => {
    // The control. Without it the next test passes on a REPL that never
    // schedules anything at all, which would be the opposite failure.
    const r = muffin(home(), ['repl'], '/exit\n');
    expect(r.err).toContain('scheduler: in questa sessione');
  });

  it('the REPL hands the scheduler to a running gateway and stays interactive', () => {
    // The wiring assertion of this whole slice. `cli/repl.ts` derives this line
    // from the timer it actually created, so it cannot say one thing while the
    // ticker does another.
    const dir = home();
    holdGateway(dir);
    const r = muffin(dir, ['repl'], '/exit\n');

    expect(r.err).toContain(`scheduler: del gateway (pid ${process.pid})`);
    expect(r.err).not.toContain('scheduler: in questa sessione');
    // Still a REPL: the session ran and exited cleanly, it did not refuse to
    // start because something else was up.
    expect(r.err).toContain('ciao.');
    expect(r.code).toBe(0);
  });

  it('a second gateway refuses with EX_TEMPFAIL and names the first', () => {
    const dir = home();
    holdGateway(dir);
    const r = muffin(dir, ['gateway', 'run']);
    expect(r.err).toContain(`pid ${process.pid}`);
    // 75, not a generic failure: the supervisor should retry this one, which is
    // the opposite of what it must do for a bad API key.
    expect(r.code).toBe(75);
  });

  it('the REPL fires an overdue job when nobody owns the store', () => {
    // The control for the next test, and it has to come first: without it, "the
    // REPL did not fire it" passes on a REPL that fires nothing ever, which is
    // the opposite defect and indistinguishable from the fix.
    const dir = home();
    overdueJob(dir);
    const r = muffin(dir, ['repl'], '/exit\n');
    expect(r.err).toContain('scheduler: in questa sessione');
    // The delivery marker. The turn itself dies on the database this same
    // `/exit` just closed — which is fine and is the point: what is under test
    // is whether the tick reached the job at all.
    expect(r.out).toContain('⏰');
    expect(r.code).toBe(0);
  });

  it('the REPL does not fire a job the gateway owns — asked per tick, not once at startup', () => {
    // The wiring assertion for `standDown`. `cli/repl.ts` read the claim once,
    // at startup, and never again; the timer existing *was* the answer. Now the
    // timer always exists and the claim decides every tick, so this is the test
    // that fails when the `standDown` argument is dropped from the Scheduler in
    // `runRepl` — with the old shape nothing would have noticed, because with a
    // gateway up there was no ticker to be wrong.
    const dir = home();
    const id = overdueJob(dir);
    holdGateway(dir);

    const r = muffin(dir, ['repl'], '/exit\n');

    expect(r.err).toContain(`scheduler: del gateway (pid ${process.pid})`);
    expect(r.out).not.toContain('⏰');
    // And it stayed due. A stand-down that consumed the fire would be the same
    // lost job as a duplicate run, just quieter.
    const row = jobRow(dir, id);
    expect(row.last_run_at).toBeNull();
    expect(Date.parse(row.next_fire_at)).toBeLessThan(Date.now());
    expect(r.code).toBe(0);
  });
});

/**
 * `cmdGatewayRun`'s own assembly — the one thing none of the tests above
 * reaches.
 *
 * Every test up to here either spawns `muffin gateway run` and asserts on the
 * lock/lease (never a due job actually settling), or drives `Gateway` in
 * isolation with a hand-built `Scheduler` (`core/gateway/service.test.ts` —
 * real coverage of the *class*, but of a `Scheduler` that test constructs
 * itself). Nothing exercised whether `cmdGatewayRun` threads
 * `runtime.deps.turns.delivered` into the `Scheduler` it builds, or the
 * `SurfaceRegistry` from `connectSurfaces` into the `deliver` the scheduler
 * calls — the exact wiring `docs/work/day1/requirements-status.md` B8 is about. Checked by
 * hand first: commenting out the `recordDelivery` argument in `cli/gateway.ts`
 * left every other test in this file and in `core/gateway/service.test.ts`
 * green.
 *
 * Getting a due job through a real model call needs a real `Provider`, and
 * `buildRuntime` only ever constructs one from config — there is no seam to
 * hand it a fake in-process. So this drives the actual seam that exists: an
 * `openai-compat` `baseUrl` pointed at a local HTTP server that speaks just
 * enough of the Chat Completions shape to answer. No token spent, no network
 * beyond localhost.
 */
function fakeCompletionsServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'fake-1',
            model: 'fake',
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'fatto.' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        );
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') throw new Error('no port assigned');
      resolve({
        url: `http://127.0.0.1:${addr.port}/v1`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe("cmdGatewayRun's own assembly", () => {
  it('records a real delivery onto the turn it just ran, through the actual production wiring', async () => {
    const fake = await fakeCompletionsServer();
    try {
      const dir = mkdtempSync(join(tmpdir(), 'muffin-gw-wiring-'));
      homes.push(dir);
      runInit({ home: dir, provider: 'openai-compat', baseUrl: fake.url, apiKey: 'sk-fake-local-server' });
      overdueJob(dir);

      const signals = new EventEmitter();
      const done = cmdGatewayRun(dir, { signals, tickMs: 5, sleep: () => new Promise((r) => setTimeout(r, 1)) });

      // Poll for the fire rather than a fixed sleep: the tick is 5ms but the
      // real HTTP round trip to `fake` is not free, and a flat sleep either
      // wastes time or races it.
      const db = new DatabaseCtor(paths(dir).db, { readonly: true });
      try {
        await vi.waitFor(
          () => {
            const row = db.prepare(`SELECT delivery FROM turns LIMIT 1`).get() as { delivery: string } | undefined;
            expect(row?.delivery).toBe('sent');
          },
          { timeout: 5000, interval: 10 },
        );
      } finally {
        db.close();
      }

      signals.emit('SIGTERM');
      await done;
    } finally {
      await fake.close();
    }
  });

  /**
   * DAY-1 requirement B14's wiring, the same standard as B8 just above: checked by hand
   * first — commenting out `attachSendFile(runtime, home, surfaces.registry)`
   * in both `cli/gateway.ts` and `cli/repl.ts` left the entire suite green,
   * `send_file`'s own unit tests included (they drive `makeSendFileTool`
   * directly, which proves the tool's logic, not that any production entry
   * point ever constructs and registers one).
   *
   * The fake server scripts a tool call on the first turn — `send_file` on a
   * file this test writes into the vault first — then a plain answer once the
   * tool result comes back, and captures every request body so the second one
   * can be inspected for what the model was actually handed back.
   */
  function fakeToolCallServer(toolName: string, argsJson: string): Promise<{ url: string; requests: unknown[]; close: () => Promise<void> }> {
    const requests: unknown[] = [];
    return new Promise((resolve) => {
      let call = 0;
      const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
          call += 1;
          res.writeHead(200, { 'content-type': 'application/json' });
          const message =
            call === 1
              ? { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: toolName, arguments: argsJson } }] }
              : { role: 'assistant', content: 'fatto.' };
          res.end(
            JSON.stringify({
              id: `fake-${call}`,
              model: 'fake',
              choices: [{ index: 0, finish_reason: call === 1 ? 'tool_calls' : 'stop', message }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
          );
        });
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr === null || typeof addr === 'string') throw new Error('no port assigned');
        resolve({ url: `http://127.0.0.1:${addr.port}/v1`, requests, close: () => new Promise((r) => server.close(() => r())) });
      });
    });
  }

  it('reaches send_file for real: a job can attach a vault file, through the actual production wiring', async () => {
    const fake = await fakeToolCallServer('send_file', JSON.stringify({ path: 'report.txt' }));
    try {
      const dir = mkdtempSync(join(tmpdir(), 'muffin-gw-sendfile-'));
      homes.push(dir);
      runInit({ home: dir, provider: 'openai-compat', baseUrl: fake.url, apiKey: 'sk-fake-local-server' });
      // The file send_file will be asked to attach — written before the job
      // fires, exactly like a prior tool call (fs_write, an ingest) would have
      // left it for a real turn to pick up.
      writeFileSync(join(paths(dir).vault, 'report.txt'), 'contenuto finto\n');
      overdueJob(dir);

      const signals = new EventEmitter();
      const done = cmdGatewayRun(dir, { signals, tickMs: 5, sleep: () => new Promise((r) => setTimeout(r, 1)) });

      const db = new DatabaseCtor(paths(dir).db, { readonly: true });
      try {
        await vi.waitFor(
          () => {
            const row = db.prepare(`SELECT delivery FROM turns LIMIT 1`).get() as { delivery: string } | undefined;
            expect(row?.delivery).toBe('sent');
          },
          { timeout: 5000, interval: 10 },
        );
      } finally {
        db.close();
      }

      // The second request is the one that carries the tool's own result back
      // to the model — inspecting it is the only way to see, from outside the
      // process, whether `send_file` actually ran (and succeeded) rather than
      // the model merely claiming it would in the final text.
      expect(fake.requests).toHaveLength(2);
      const second = fake.requests[1] as { messages: { role: string; content?: unknown; tool_call_id?: string }[] };
      const toolResult = second.messages.find((m) => m.role === 'tool' || 'tool_call_id' in m);
      expect(JSON.stringify(toolResult)).toContain('inviato: report.txt');

      signals.emit('SIGTERM');
      await done;
    } finally {
      await fake.close();
    }
  });

  /**
   * A completions server that answers only once released — the seam this next
   * test needs to steal the gateway's claim *while* a job is genuinely in
   * flight, the exact window P20 is about: `Gateway.tick` used to beat once
   * and then run both lanes to completion with nothing re-checking ownership
   * inside.
   */
  function gatedCompletionsServer(): Promise<{ url: string; requests: number; release: () => void; close: () => Promise<void> }> {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const state = { requests: 0 };
    return new Promise((resolve) => {
      const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          state.requests += 1;
          void gate.then(() => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                id: 'fake-1',
                model: 'fake',
                choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'fatto.' } }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
              }),
            );
          });
        });
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr === null || typeof addr === 'string') throw new Error('no port assigned');
        resolve({
          url: `http://127.0.0.1:${addr.port}/v1`,
          get requests() {
            return state.requests;
          },
          release,
          close: () => new Promise((r) => server.close(() => r())),
        });
      });
    });
  }

  it('a claim stolen while a job is in flight is caught before delivery — stillOwner (P20)', async () => {
    const fake = await gatedCompletionsServer();
    try {
      const dir = mkdtempSync(join(tmpdir(), 'muffin-gw-stillowner-'));
      homes.push(dir);
      runInit({ home: dir, provider: 'openai-compat', baseUrl: fake.url, apiKey: 'sk-fake-local-server' });
      overdueJob(dir);

      const signals = new EventEmitter();
      const done = cmdGatewayRun(dir, { signals, tickMs: 5, sleep: () => new Promise((r) => setTimeout(r, 1)) });

      // The job's model call has genuinely reached the server and is held
      // open by the gate — this is "a run in flight", not a guess about timing.
      await vi.waitFor(() => expect(fake.requests).toBeGreaterThan(0), { timeout: 5000, interval: 5 });

      // Steal the claim from outside, exactly as a second gateway winning a
      // legitimate race would leave the row: a fresh pid and a fresh
      // holder_id, written directly rather than through `GatewayLock.claim`
      // so this does not depend on this test's own pid being distinguishable
      // from the real gateway's.
      const steal = new DatabaseCtor(paths(dir).db);
      steal
        .prepare(`UPDATE gateway_lock SET pid = ?, holder_id = ?, taken_at = ? WHERE id = 1`)
        .run(process.pid + 1, 'a-different-holder', new Date().toISOString());
      steal.close();

      // Now let the model call resolve. If `stillOwner` were not wired in,
      // `Scheduler.run` would proceed straight to `deliver` and the turn's
      // `delivery` column would read `sent`.
      fake.release();
      await new Promise((r) => setTimeout(r, 300));

      const check = new DatabaseCtor(paths(dir).db, { readonly: true });
      const turn = check.prepare(`SELECT delivery FROM turns LIMIT 1`).get() as { delivery: string | null } | undefined;
      check.close();
      expect(turn?.delivery ?? null).not.toBe('sent');

      signals.emit('SIGTERM');
      await done;
    } finally {
      await fake.close();
    }
  }, 10_000);

  it("TurnLane's own stillOwner refuses a due turn the instant the claim is stolen — R1", async () => {
    // R1 (judge, round 2): the heist test above proves the *scheduler's*
    // `stillOwner`, and the same technique cannot also prove the turn lane's.
    // `Gateway.tick` always calls `lock.beat()` — the same `lock` `stillOwner`
    // reads — *first*, and a `beat()` failure drains the whole process before
    // `turnLane.tick()` runs again (`core/gateway/service.ts`'s `tick`); since
    // `isCurrentClaim()` and `beat()`'s own fencing read the identical
    // holder_id/pid match, `turnLane.tick()` can only ever run on a beat that
    // has *just* succeeded, moments earlier, in the same synchronous call — so
    // it can never observe a theft the surrounding gateway has not already
    // reacted to. Verified: extending the heist test above with a waiting
    // turn and asserting it stays untouched still passed with `stillOwner`
    // deleted from the `TurnLane` construction in `cli/gateway.ts`.
    //
    // `onAssembled` (test-only; see its docstring on `cmdGatewayRun`) hands
    // back the *real* `turnLane`/`lock` this run builds, so this test can ask
    // the lane the question `stillOwner` exists to answer directly, at a
    // moment of its own choosing — independent of whether the gateway's own
    // heartbeat would ever get to ask it first.
    const fake = await fakeCompletionsServer();
    try {
      const dir = mkdtempSync(join(tmpdir(), 'muffin-gw-turnlane-stillowner-'));
      homes.push(dir);
      runInit({ home: dir, provider: 'openai-compat', baseUrl: fake.url, apiKey: 'sk-fake-local-server' });

      let assembled: { turnLane: TurnLane; lock: GatewayLock } | undefined;
      const signals = new EventEmitter();
      // An hour: long enough that no *automatic* tick lands during this test
      // beyond `serve()`'s own single one at start, so nothing but this
      // test's own direct call ever ticks `turnLane` from here on.
      const done = cmdGatewayRun(
        dir,
        { signals, tickMs: 3_600_000, sleep: () => new Promise((r) => setTimeout(r, 1)) },
        (parts) => (assembled = parts),
      );

      await vi.waitFor(
        () => {
          const db = new DatabaseCtor(paths(dir).db, { readonly: true });
          try {
            const row = db.prepare(`SELECT pid FROM gateway_lock WHERE id = 1`).get() as { pid: number | null } | undefined;
            expect(row?.pid).toBe(process.pid);
          } finally {
            db.close();
          }
        },
        { timeout: 5000, interval: 5 },
      );
      expect(assembled).toBeDefined();

      // Stolen *before* the turn below exists: whichever side of `serve()`'s
      // own single automatic tick this lands on, that tick cannot deliver the
      // row for real — either it runs first and finds nothing due yet, or it
      // runs after and its own `beat()` already fails, so it never reaches
      // `turnLane.tick()` at all.
      const steal = new DatabaseCtor(paths(dir).db);
      steal
        .prepare(`UPDATE gateway_lock SET pid = ?, holder_id = ?, taken_at = ? WHERE id = 1`)
        .run(process.pid + 1, 'a-different-holder', new Date().toISOString());
      steal.close();

      const turnId = waitingTurn(dir);

      // The real lane, asked directly — bypassing `Gateway.tick`'s own beat
      // entirely, which is the whole point of `onAssembled`.
      assembled!.turnLane.tick(new Date());
      // `tick` starts a resume in the background when it proceeds; give one a
      // moment to happen if `stillOwner` did not stop it — `fake` answers
      // immediately, so a resume that started would already be done.
      await new Promise((r) => setTimeout(r, 200));

      const check = new DatabaseCtor(paths(dir).db, { readonly: true });
      const row = check.prepare(`SELECT status, claimed_by AS claimedBy FROM turns WHERE id = ?`).get(turnId) as
        | { status: string; claimedBy: number | null }
        | undefined;
      check.close();
      // Untouched: exactly what `waitingTurn` suspended, claimed by nobody.
      expect(row).toEqual({ status: 'waiting', claimedBy: null });

      signals.emit('SIGTERM');
      await done;
    } finally {
      await fake.close();
    }
  }, 10_000);
});

/**
 * The two orderings a boot-time answer cannot survive, driven through the real
 * `Scheduler`, the real `JobStore` and the real `GatewayLock` — the same three
 * objects `runRepl` builds, wired by the same `gatewayStandDown` it passes.
 *
 * Spawned processes prove the wiring (above); these prove the *sequence*, which
 * a spawn cannot reach without waiting out a thirty-second tick.
 */
describe('the claim can change under a REPL that is already ticking', () => {
  const world = () => {
    const db = new DatabaseCtor(':memory:');
    const jobs = new JobStore(db);
    const job = jobs.add({ cron: '0 8 * * *', timezone: 'Europe/Rome', goal: 'brief', channel: 'cli' });
    db.prepare(`UPDATE jobs SET next_fire_at = ? WHERE id = ?`).run(new Date(Date.now() - 60_000).toISOString(), job.id);
    const said: string[] = [];
    const events: SchedulerEvent[] = [];
    const delivered: string[] = [];
    return { db, jobs, job, said, events, delivered };
  };
  const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

  it('REPL first, gateway second: the next tick hands over and says so', async () => {
    const w = world();
    const standDown = gatewayStandDown(w.db, (l) => w.said.push(l), false);
    const sched = new Scheduler(
      w.jobs,
      async () => ({ stopped: 'answered', text: 'brief', turnId: 'turn-test' }),
      async (_c, t) => (w.delivered.push(t), DELIVERED),
      undefined,
      (e) => w.events.push(e),
      undefined,
      standDown,
      undefined,
      new ModelLane(),
    );

    // Nobody owns it: this session is the scheduler, and behaves like one.
    sched.tick();
    await flush();
    expect(w.delivered).toEqual(['brief']);

    // The gateway starts — `muffin gateway install` finally run, or systemd
    // reaching the unit a moment after the shell did.
    new GatewayLock(w.db, () => true).claim(new Date(), 'in attesa', process.pid);
    sched.tick();
    await flush();

    expect(w.events.at(-1)).toEqual({ kind: 'deferred', reason: 'handover' });
    // Not silence. The boot line said "in questa sessione" and has just become
    // false, and a REPL that quietly stops scheduling is indistinguishable from
    // one that is broken.
    expect(w.said.join(' ')).toContain(`passato al gateway (pid ${process.pid})`);
  });

  it('the laptop lid, briefly: a live-but-quiet claim still reads present — P20', async () => {
    // Before the fix, `heldBy` asked the wall clock before it ever asked
    // whether the holder was alive, so ten missed heartbeats alone — a laptop
    // asleep for a few minutes, not dead — read as "no gateway" and this
    // session would start a second scheduler underneath a gateway that was
    // about to resume. `alive` says true throughout: the process object is
    // still there, exactly what a genuine sleep (not a kill) looks like.
    const w = world();
    const lock = new GatewayLock(w.db, () => true);
    const asleep = new Date(Date.now() - STALE_AFTER_MS - 1000);
    lock.claim(asleep, 'in attesa', process.pid);

    const standDown = gatewayStandDown(w.db, (l) => w.said.push(l), true);
    // Past the ordinary heartbeat horizon, still alive: still deferred to.
    // This exact instant is where the pre-fix code declared it gone.
    expect(standDown()).toBe(true);
  });

  it('a claim past the hard horizon reads free, and a fresh claim takes the store back', async () => {
    // Once genuinely past the hard horizon — the pid-reuse backstop, wide
    // enough that no realistically-long sleep or stall reaches it — the claim
    // is correctly read as gone and this session ticks. `alive` still says
    // true (a wedged process, or an ordinary reused pid): the horizon, not
    // liveness, is what is being exercised here.
    const w = world();
    const lock = new GatewayLock(w.db, () => true);
    const wedged = new Date(Date.now() - STALE_AFTER_MS * HARD_STALE_MULTIPLIER - 1000);
    lock.claim(wedged, 'in attesa', process.pid);

    const standDown = gatewayStandDown(w.db, (l) => w.said.push(l), false);
    expect(standDown()).toBe(false); // past the hard horizon: this session is right to tick

    // A gateway claims fresh — a supervisor restart, or the same process
    // finally re-claiming from scratch rather than resuming as if its old
    // claim were still good (which P21's `refresh` fix now refuses: the same
    // stale claim beating instead of re-claiming would not reach this point
    // at all, see `core/lock/durable.test.ts`'s refresh-horizon tests).
    new GatewayLock(w.db, () => true).claim(new Date(), 'in attesa', process.pid);

    expect(standDown()).toBe(true);
    expect(w.said.join(' ')).toContain('passato al gateway');
  });

  it('a job due while the gateway sleeps past the hard horizon runs exactly once — the REPL takes it, and the waking gateway cannot silently resume', async () => {
    // The end-to-end shape of P21's fix, in one test: a gateway claimed the
    // store, then went silent for longer than the hard horizon (a real sleep,
    // not a kill — `alive` says true throughout). The REPL correctly judges
    // it gone and runs the due job. When the gateway's own timer next fires —
    // it "wakes up" — its `beat()` must refuse rather than resume as if
    // nothing happened, which is exactly the asymmetry the audit found:
    // `readGateway` already judged this claim absent, but `DurableLock.refresh`
    // used to be guarded on `pid` alone and would have pushed `taken_at`
    // forward regardless, resurrecting a claim the REPL had already taken.
    const w = world();
    const gatewayLock = new GatewayLock(w.db, () => true);
    const wedged = new Date(Date.now() - STALE_AFTER_MS * HARD_STALE_MULTIPLIER - 1000);
    gatewayLock.claim(wedged, 'in attesa', process.pid);

    const standDown = gatewayStandDown(w.db, (l) => w.said.push(l), true);
    expect(standDown()).toBe(false); // the REPL now owns the ticker

    const runJob = vi.fn(async () => ({ stopped: 'answered' as const, text: 'brief', turnId: 'turn-repl' }));
    const replScheduler = new Scheduler(
      w.jobs, runJob, async (_c, t) => (w.delivered.push(t), DELIVERED),
      undefined, (e) => w.events.push(e), undefined, standDown, undefined, new ModelLane(),
    );
    replScheduler.tick();
    await flush();

    expect(runJob).toHaveBeenCalledOnce();
    expect(w.delivered).toEqual(['brief']);
    expect(w.jobs.get(w.job.id)!.lastRunAt).not.toBeNull();

    // Now the gateway "wakes up" and its interval timer fires a beat, exactly
    // as `Gateway.tick` does before it would ever call `scheduler.tick` again.
    const wokenBeat = gatewayLock.beat(new Date(), 'in attesa', process.pid);
    expect(wokenBeat).toBe(false); // P21: cannot resume the claim it already lost

    // So even a scheduler built on the *same* lock, ticking right now, would
    // find nothing to do either way — the fire already happened once, and
    // this "gateway" is not the owner any more regardless.
    expect(w.jobs.due(new Date())).toEqual([]);
  });

  it('a gateway that dies gives the jobs back, and that is announced too', () => {
    // The other direction, and it is the one the old shape could not do at all:
    // a terminal open since before the crash sat there scheduling nothing until
    // it was closed and reopened.
    const w = world();
    const lock = new GatewayLock(w.db, () => true);
    lock.claim(new Date(), 'in attesa', process.pid);
    const standDown = gatewayStandDown(w.db, (l) => w.said.push(l), true);
    expect(standDown()).toBe(true);
    expect(w.said).toEqual([]); // the boot line already said it — no double take

    lock.release(process.pid);

    expect(standDown()).toBe(false);
    expect(w.said.join(' ')).toMatch(/tornano a girare in questa finestra/);
  });

  it('a claim landing mid-turn costs the model call, never a second delivery', async () => {
    // The window the tick-start check cannot close: a turn is a model call with
    // tools, and the gateway can claim in the middle of one. The second check
    // sits between the run and the delivery, so what is lost is money — the
    // turn happened twice — and what is kept is the two irreversible things:
    // the owner is not told the same thing twice, and `markRan` does not move a
    // fire the new owner is about to serve.
    const w = world();
    const lock = new GatewayLock(w.db, () => true);
    let release!: () => void;
    const inFlight = new Promise<void>((r) => (release = r));
    const sched = new Scheduler(
      w.jobs,
      async () => {
        await inFlight;
        return { stopped: 'answered', text: 'brief', turnId: 'turn-test' };
      },
      async (_c, t) => (w.delivered.push(t), DELIVERED),
      undefined,
      (e) => w.events.push(e),
      undefined,
      gatewayStandDown(w.db, (l) => w.said.push(l), false),
      undefined,
      new ModelLane(),
    );

    sched.tick(); // nobody owns it yet — the turn starts
    await flush();
    lock.claim(new Date(), 'in attesa', process.pid); // …and now someone does
    release();
    await flush();
    await flush();

    expect(w.delivered).toEqual([]);
    expect(w.events.some((e) => e.kind === 'yielded')).toBe(true);
    expect(w.jobs.get(w.job.id)!.lastRunAt).toBeNull();
    expect(w.jobs.get(w.job.id)!.nextFireAt.getTime()).toBeLessThan(Date.now());
  });
});

describe('muffin gateway install', () => {
  it('prints a unit anchored to the data home, and puts it on stdout', () => {
    const dir = home();
    const r = muffin(dir, ['gateway', 'install']);
    // stdout is the result, so `muffin gateway install > file` is the one-liner.
    expect(r.out).toContain(dir);
    expect(r.out).not.toContain('poi, per attivarla');
    expect(r.err).toContain('poi, per attivarla');
    // Anchored to ~/.muffin and not to the checkout — Hermes' scar, ADR-0035.
    const anchor = process.platform === 'darwin' ? '<key>WorkingDirectory</key>' : `WorkingDirectory=${dir}`;
    expect(r.out).toContain(anchor);
  });

  it('writes nothing unless asked, then writes exactly what it printed', () => {
    const dir = home();
    const printed = muffin(dir, ['gateway', 'install']).out;

    const written = muffin(dir, ['gateway', 'install', '--write']);
    const path = /scritto (.+)/.exec(written.err)?.[1];
    expect(path).toBeTruthy();
    expect(readFileSync(path!, 'utf8')).toBe(printed);
  });

  it('refuses to clobber a unit the owner has edited', () => {
    // These are meant to be hand-tuned (a different WatchdogSec, an extra
    // Environment line). Regenerating over the top would eat the edit silently
    // and the owner would find out at the next restart.
    const dir = home();
    const path = /scritto (.+)/.exec(muffin(dir, ['gateway', 'install', '--write']).err)?.[1];
    expect(path).toBeTruthy();
    writeFileSync(path!, '# mio\n');

    const again = muffin(dir, ['gateway', 'install', '--write']);
    // 2, the "I did not do it" code — distinct from the 1 the command returns
    // when it wrote the unit but had a caveat about ExecStart.
    expect(again.code).toBe(2);
    expect(readFileSync(path!, 'utf8')).toBe('# mio\n');

    const forced = muffin(dir, ['gateway', 'install', '--write', '--force']);
    expect(forced.code).not.toBe(2);
    expect(readFileSync(path!, 'utf8')).not.toBe('# mio\n');
  });
});

describe('muffin gateway stop admits what it cannot do', () => {
  it('says nothing on Linux, where the exit code makes the verb true', () => {
    // `RestartPreventExitStatus=143` is the whole mechanism there, and an
    // apology on top of a verb that works is noise.
    expect(stopCaveat('linux', true)).toBeNull();
  });

  it('says nothing on macOS when no LaunchAgent is installed', () => {
    // A gateway started by hand in a terminal has nothing watching it. Warning
    // there would train the owner to ignore the warning that matters.
    expect(stopCaveat('darwin', false)).toBeNull();
  });

  /**
   * Non più una scusa: un promemoria.
   *
   * La frase che stava qui — «launchd lo riavvia entro Ns, per tenerlo giù usa
   * `launchctl bootout`» — era vera e non lo è più: il KeepAlive del plist è
   * condizionato al semaforo che `stop` scrive. Ma il fatto opposto ora va
   * detto, e va detto qui: chi ferma il gateway deve sapere che resta fermo
   * **anche dopo un riavvio del Mac**, altrimenti si chiede perché i job non
   * girano più e non ha nessun motivo di sospettare un file.
   */
  it('dice che lo stop resta, e nomina il verbo che lo disfa', () => {
    const caveat = stopCaveat('darwin', true) ?? '';
    expect(caveat).toContain('muffin gateway start');
    // E non promette più il contrario di quello che fa.
    expect(caveat).not.toContain('riavvia');
    expect(caveat).not.toContain('bootout');
  });
});

/**
 * `muffin gateway restart` (ADR-0070) — l'owner l'ha chiesto per non dover
 * fare `launchctl kickstart` più `muffin gateway status` a mano ogni volta.
 * `restartCommand`/`waitForGatewayPid`/`restartVerdict` sono gli stessi tre
 * pezzi di `cli/update.ts`'s `offerGatewayRestart` — questi test rispecchiano
 * apposta i tre casi di `describe('verifying the restart by state, not by
 * exit code')` in `cli/update.test.ts`, sullo stesso meccanismo importato.
 */
describe('muffin gateway restart', () => {
  /** Returns `seq[i]` on the i-th call, then repeats the last value forever — stessa forma di update.test.ts. */
  function pidSequence(seq: (number | null)[]): () => number | null {
    let i = 0;
    return () => seq[Math.min(i++, seq.length - 1)] ?? null;
  }
  const noSleep = async (): Promise<void> => {};
  const engaged = {
    unitFileExists: () => true,
    systemdEnabled: () => true,
    systemdFailed: () => false,
    lingerEnabled: () => true,
  };

  it('nessun supervisore installato: esce diverso da zero e nomina il rimedio, senza tentare niente', async () => {
    const err: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    });
    let code: number;
    try {
      code = await cmdGatewayRestart(home(), {
        platform: 'linux',
        supervisorProbes: { unitFileExists: () => false },
      });
    } finally {
      spy.mockRestore();
    }
    expect(code).not.toBe(0);
    expect(err.join('')).toMatch(/nessun gateway supervisionato/);
    expect(err.join('')).toContain('muffin gateway install');
  });

  it('riavviato e verificato: pid diverso dopo, esce 0 — anche se il comando avesse detto altro', async () => {
    const code = await cmdGatewayRestart(home(), {
      platform: 'linux',
      supervisorProbes: engaged,
      restart: () => ({ status: 0, stdout: '', stderr: '' }),
      readGatewayPid: pidSequence([88175, 88175, 65671]),
      sleep: noSleep,
    });
    expect(code).toBe(0);
  });

  it('comando fallito e nessun pid nuovo: esce diverso da zero — verificato sullo STATO, non sull exit code del comando', async () => {
    const out: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    let code: number;
    try {
      code = await cmdGatewayRestart(home(), {
        platform: 'linux',
        supervisorProbes: engaged,
        restart: () => ({ status: 1, stdout: '', stderr: 'Failed to restart muffin-gateway.service: Unit is masked.' }),
        readGatewayPid: pidSequence([88175]),
        sleep: noSleep,
        verifyAttempts: 2,
      });
    } finally {
      spy.mockRestore();
    }
    expect(code).not.toBe(0);
    expect(out.join('')).toMatch(/il riavvio non è avvenuto/);
    expect(out.join('')).toContain('Failed to restart muffin-gateway.service: Unit is masked.');
  });

  it('comando "fallito" ma un pid nuovo serve comunque (scontro transitorio): esce 0', async () => {
    const code = await cmdGatewayRestart(home(), {
      platform: 'linux',
      supervisorProbes: engaged,
      restart: () => ({ status: 1, stdout: '', stderr: '' }),
      readGatewayPid: pidSequence([88175, 88175, 65671]),
      sleep: noSleep,
    });
    expect(code).toBe(0);
  });

  it('su darwin usa launchctl kickstart -k — lo stesso comando di offerGatewayRestart, non una seconda stringa', async () => {
    let restarted: string[] | null = null;
    await cmdGatewayRestart(home(), {
      platform: 'darwin',
      supervisorProbes: { unitFileExists: () => true, launchdLoaded: () => true },
      restart: (argv) => {
        restarted = argv;
        return { status: 0, stdout: '', stderr: '' };
      },
      readGatewayPid: pidSequence([1111, 2222]),
      sleep: noSleep,
    });
    expect(restarted?.[0]).toBe('launchctl');
    expect(restarted?.[1]).toBe('kickstart');
    expect(restarted?.[2]).toBe('-k');
  });
});

describe('muffin doctor reports the gateway', () => {
  it('warns when nothing is running, and says what that costs', () => {
    const r = muffin(home(), ['doctor']);
    expect(r.out).toMatch(/gateway.*nessun processo attivo/s);
    expect(r.out).toContain('muffin gateway install');
  });

  it('reports it as ok, with the pid, when one is up', () => {
    const dir = home();
    holdGateway(dir);
    const r = muffin(dir, ['doctor']);
    expect(r.out).toMatch(new RegExp(`gateway\\s+attivo · pid ${process.pid}`));
  });
});

describe('muffin init offers the gateway', () => {
  it('off a terminal it installs nothing and prints the command instead', () => {
    // `promptLine` returns undefined on a pipe. An installer that wrote a
    // service unit during a scripted run would be doing precisely what ADR-0035
    // forbids — and every test in this file runs off a pipe.
    const dir = mkdtempSync(join(tmpdir(), 'muffin-gw-init-'));
    homes.push(dir);
    const r = muffin(dir, ['init'], 'sk-never-called');

    expect(r.err).toContain('muffin gateway install');
    const unit =
      process.platform === 'darwin'
        ? join(dir, 'Library/LaunchAgents/ai.muffin.gateway.plist')
        : join(dir, '.config/systemd/user/muffin-gateway.service');
    expect(existsSync(unit)).toBe(false);
  });
});

describe('MUFFIN_GATEWAY_TICK_MS — the acceptance suite\'s only way to speed up a spawned gateway', () => {
  it('is undefined on everything a real install would ever set', () => {
    expect(tickMsFromEnv(undefined)).toBeUndefined();
    expect(tickMsFromEnv('')).toBeUndefined();
  });

  it('ignores a value that could not possibly be a tick interval', () => {
    expect(tickMsFromEnv('not-a-number')).toBeUndefined();
    expect(tickMsFromEnv('0')).toBeUndefined();
    expect(tickMsFromEnv('-50')).toBeUndefined();
  });

  it('parses a real override', () => {
    expect(tickMsFromEnv('250')).toBe(250);
  });
});


/**
 * La cucitura, non il calcolo.
 *
 * `resolveInterpreterDir` era provata da sola e `gateway install` continuava a
 * passare `dirname(process.execPath)`: rimettendo quella riga com'era, tutta la
 * suite restava verde. La funzione giusta scollegata è lo stesso guasto della
 * funzione sbagliata, e sul binario vero è l'unico posto dove si vede.
 */
describe('muffin gateway install — quale interprete finisce nella unit', () => {
  it('sceglie la directory stabile del PATH, non quella versionata dell interprete', () => {
    // Una directory con dentro un link al Node che sta girando: è la forma di
    // `/opt/homebrew/bin` sulla macchina dell'owner, costruita a mano così il
    // test vale anche dove quella forma non esiste.
    const dir = home();
    const stable = mkdtempSync(join(tmpdir(), 'muffin-bin-stabile-'));
    symlinkSync(process.execPath, join(stable, 'node'));

    const r = muffin(dir, ['gateway', 'install'], '', { PATH: `${stable}${delimiter}${process.env['PATH'] ?? ''}` });

    expect(r.out).toContain(stable);
    // E non quella versionata: averle tutte e due significherebbe non aver
    // scelto, che è il caso in cui l'upgrade rompe comunque.
    expect(r.out).not.toContain(dirname(realpathSync(process.execPath)));
    rmSync(stable, { recursive: true, force: true });
  });
});


/**
 * La cucitura, non il calcolo.
 *
 * `describeSupervision` era provata da sola e la riga di avvio continuava a
 * derivare tutto da `NOTIFY_SOCKET`: rimettendo quel ternario, la suite restava
 * verde. La funzione giusta scollegata è lo stesso guasto della funzione
 * sbagliata — la stessa lezione di #151, nello stesso file.
 */
describe('muffin gateway run — la riga di supervisione', () => {
  it('stampa esattamente ciò che `describeSupervision` dice per questo ambiente', () => {
    // Confrontata con la funzione e non con una stringa: così vale su Linux e
    // su macOS senza che il test sappia dove sta girando, e la mutazione muore
    // comunque — il vecchio ternario produce parole diverse su entrambe.
    const dir = home();
    const env = { XPC_SERVICE_NAME: LAUNCHD_LABEL };
    // Il timeout non misura quanto ci mette il banner: è l'unico modo di
    // fermare un processo che di mestiere non finisce. Erano cinque secondi
    // «perché il banner esce prima di `serve()`», e quel ragionamento reggeva
    // solo su una macchina scarica: sotto il gate, con 213 file in parallelo,
    // `node --import tsx` non arrivava nemmeno a `main.ts` in cinque secondi e
    // il test cadeva su `r.err` **vuoto** — nessuna riga sbagliata, nessuna
    // riga. Un rosso da CPU, non da codice. Venti secondi non rendono il test
    // più permissivo: la stringa attesa resta identica, e se il banner non
    // arriva affatto il vitest a sessanta lo dice comunque.
    const r = muffin(dir, ['gateway', 'run'], '', env, 20_000);

    expect(r.err).toContain(`supervisione: ${describeSupervision({ ...process.env, ...env }, process.platform)}`);
  }, 60_000);
});

/**
 * `--start`: dal file al servizio, con sudo.
 *
 * Su Linux la unit è di sistema (D2): scriverla e attivarla chiede root, che
 * si vede come `sudo` in ogni passo stampato prima di eseguirlo. Quello che
 * `init` offre resta `--write` e basta: scrivere un file in casa propria è
 * una cosa, accendere un servizio un'altra, e quella decisione è scritta in
 * `cli/main.ts`. `--start` è l'owner che la prende, digitandola.
 */
describe('muffin gateway install --start', () => {
  const zitto = () => {
    const righe: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c) => { righe.push(String(c)); return true; });
    const spyOut = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    return { righe, ripristina: () => { spy.mockRestore(); spyOut.mockRestore(); } };
  };
  const sysdir = (dir: string) => join(dir, 'systemd-system');

  it('esegue la sequenza systemd nell ordine, con sudo e senza linger', async () => {
    const dir = home();
    const visti: string[][] = [];
    const s = zitto();
    try {
      const code = await cmdGatewayInstall(dir, ['--start'], {
        platform: 'linux',
        homeDir: dir,
        systemDir: sysdir(dir),
        identity: { user: 'owner', uid: 1000 },
        run: (argv) => { visti.push(argv); return { status: 0, stderr: '' }; },
        // Lo STATO che la verifica post-attivazione (regola della casa,
        // `cli/update.ts`) legge: un pid comparso. Un `run` finto che esce 0
        // non fa girare niente sul serio, quindi senza questa riga
        // `currentGatewayPid` leggerebbe sempre `null` e il test aspetterebbe
        // il tempo di attesa reale per un esito che non è quello che sta
        // provando.
        readGatewayPid: () => 4242,
      });
      // 0 oppure 1: sotto tsx il launcher non è il symlink installato e
      // `currentLauncher()` lo dice — è vero, ed è un avvertimento, non un
      // fallimento dell'attivazione. Quello che non deve essere è 3.
      expect(code).not.toBe(EXIT_NOT_ACTIVATED);
    } finally { s.ripristina(); }
    expect(visti).toEqual([
      ['sudo', 'systemctl', 'daemon-reload'],
      ['sudo', 'systemctl', 'enable', '--now', 'muffin-gateway.service'],
    ]);
    expect(s.righe.join('')).toContain('è un servizio adesso');
  });

  it('rifiuta User=root prima ancora di pianificare', async () => {
    // D1: il processo Muffin non gira mai come root. Installare DA root è
    // già un errore con rimedio, non una unit scritta con User=root.
    const dir = home();
    const s = zitto();
    try {
      const code = await cmdGatewayInstall(dir, ['--start'], {
        platform: 'linux',
        homeDir: dir,
        systemDir: sysdir(dir),
        identity: { user: 'root', uid: 0 },
        run: () => ({ status: 0, stderr: '' }),
      });
      expect(code).toBe(2);
    } finally { s.ripristina(); }
    expect(s.righe.join('')).toContain('non installare come root');
    expect(existsSync(join(sysdir(dir), 'muffin-gateway.service'))).toBe(false);
  });

  it('stampa il passo prima di eseguirlo, non dopo', async () => {
    // Senza sudo sul PATH il primo passo non parte nemmeno: se la riga si
    // stampasse dopo, l'owner guarderebbe un cursore fermo senza sapere su
    // quale comando. Un runner che lancia è il modo di chiedere «eri già
    // passato dalla stampa?» senza appendere il test.
    //
    // `cmdGatewayInstall` è `async` (la verifica post-attivazione aspetta un
    // pid): una funzione async non lancia mai in modo sincrono, un `throw`
    // dentro diventa sempre una promise rifiutata — `expect(() =>
    // ...).toThrow(...)` non vedrebbe più niente da catturare.
    const dir = home();
    const s = zitto();
    try {
      await expect(
        cmdGatewayInstall(dir, ['--start'], {
          platform: 'linux',
          homeDir: dir,
          systemDir: sysdir(dir),
          identity: { user: 'owner', uid: 1000 },
          run: () => { throw new Error('come se non tornasse mai'); },
        }),
      ).rejects.toThrow('come se non tornasse mai');
    } finally { s.ripristina(); }
    expect(s.righe.join('')).toContain('sudo systemctl daemon-reload');
  });

  it('si ferma al primo che fallisce, invece di abilitare una unit non riletta', async () => {
    const dir = home();
    const visti: string[][] = [];
    const s = zitto();
    let code: number;
    try {
      code = await cmdGatewayInstall(dir, ['--start'], {
        platform: 'linux',
        homeDir: dir,
        systemDir: sysdir(dir),
        identity: { user: 'owner', uid: 1000 },
        run: (argv) => { visti.push(argv); return { status: 1, stderr: 'Failed to connect to bus' }; },
      });
    } finally { s.ripristina(); }
    expect(visti).toHaveLength(1);
    expect(code).toBe(EXIT_NOT_ACTIVATED);
    const detto = s.righe.join('');
    // Il comando che si è fermato, il suo errore vero, e i passi rimasti: senza
    // i tre insieme «uscita 3» è un numero che non dice cosa fare adesso.
    expect(detto).toContain('sudo systemctl daemon-reload');
    expect(detto).toContain('Failed to connect to bus');
    expect(detto).toContain('la unit è scritta in');
  });

  it('senza privilegi di scrittura dice esattamente cosa far fare a root', async () => {
    // La unit di sistema vive sotto /etc: senza privilegi la scrittura muore
    // con EACCES, e quello è un rimedio stampato — mai una unit scritta
    // altrove che systemd non leggerebbe mai. (Saltato da root: root scrive
    // ovunque, e il test proverebbe il permesso sbagliato.)
    if (process.getuid?.() === 0) return;
    const dir = home();
    const sys = sysdir(dir);
    mkdirSync(sys, { recursive: true });
    chmodSync(sys, 0o555);
    const s = zitto();
    try {
      const code = await cmdGatewayInstall(dir, ['--write'], {
        platform: 'linux',
        homeDir: dir,
        systemDir: sys,
        identity: { user: 'owner', uid: 1000 },
        run: () => ({ status: 0, stderr: '' }),
      });
      expect(code).toBe(2);
      expect(s.righe.join('')).toContain('sudo install');
    } finally {
      chmodSync(sys, 0o755);
      s.ripristina();
    }
  });

  it('scrive la unit anche senza --write, perché non si accende un file che non c è', async () => {
    const dir = home();
    const s = zitto();
    try {
      await cmdGatewayInstall(dir, ['--start'], {
        platform: 'linux',
        homeDir: dir,
        systemDir: sysdir(dir),
        identity: { user: 'owner', uid: 1000 },
        run: () => ({ status: 0, stderr: '' }),
        // Questo test prova solo la scrittura del file, non l'esito
        // dell'accensione — un tentativo solo, senza attesa reale.
        readGatewayPid: () => null,
        verifyAttempts: 1,
        verifyIntervalMs: 0,
      });
    } finally { s.ripristina(); }
    const written = readFileSync(join(sysdir(dir), 'muffin-gateway.service'), 'utf8');
    expect(written).toMatch(/^User=\S+$/m);
    expect(written).not.toMatch(/^User=root$/m);
  });

  it('nomi provisionati diventano LoadCredentialEncrypted, gli altri no', async () => {
    // Il planner scrive righe solo per i nomi provisionati E richiesti: una
    // riga per un blob assente ucciderebbe il servizio all'attivazione (243)
    // per un file che non era mai il problema.
    const dir = home();
    process.env['MUFFIN_CREDSTORE_ENCRYPTED'] = join(dir, 'credstore');
    try {
      const ref = loadConfig(dir).provider.apiKeyRef;
      const name = ref.slice('secret://'.length);
      mkdirSync(join(dir, 'credstore'), { recursive: true });
      writeFileSync(join(dir, 'credstore', `${name}.cred`), 'BLOB');
      const s = zitto();
      try {
        await cmdGatewayInstall(dir, ['--write', '--force'], {
          platform: 'linux',
          homeDir: dir,
          systemDir: sysdir(dir),
          identity: { user: 'owner', uid: 1000 },
          run: () => ({ status: 0, stderr: '' }),
        });
      } finally { s.ripristina(); }
      // Backend file qui: nessuna riga, anche se il blob esiste — le righe
      // seguono il flag esplicito, mai la presenza del file.
      const fileBackend = readFileSync(join(sysdir(dir), 'muffin-gateway.service'), 'utf8');
      expect(fileBackend).not.toContain('LoadCredentialEncrypted');
      flipBackendSystemd(dir);
      const s2 = zitto();
      try {
        await cmdGatewayInstall(dir, ['--write', '--force'], {
          platform: 'linux',
          homeDir: dir,
          systemDir: sysdir(dir),
          identity: { user: 'owner', uid: 1000 },
          run: () => ({ status: 0, stderr: '' }),
        });
      } finally { s2.ripristina(); }
      const systemdBackend = readFileSync(join(sysdir(dir), 'muffin-gateway.service'), 'utf8');
      expect(systemdBackend).toContain(`LoadCredentialEncrypted=${name}:/etc/credstore.encrypted/${name}.cred`);
      // Un riferimento richiesto ma mai provisionato non diventa una riga: la
      // riga ucciderebbe il servizio all'attivazione, e a nominarlo ci pensa
      // il drift warning di doctor, non la unit.
      const withSearch = loadConfig(dir);
      saveConfig({ ...withSearch, search: { provider: 'tavily', apiKeyRef: 'secret://tavily_api_key' } }, dir);
      const s3 = zitto();
      try {
        await cmdGatewayInstall(dir, ['--write', '--force'], {
          platform: 'linux',
          homeDir: dir,
          systemDir: sysdir(dir),
          identity: { user: 'owner', uid: 1000 },
          run: () => ({ status: 0, stderr: '' }),
        });
      } finally { s3.ripristina(); }
      const filtered = readFileSync(join(sysdir(dir), 'muffin-gateway.service'), 'utf8');
      expect(filtered).not.toContain('tavily_api_key');
    } finally {
      delete process.env['MUFFIN_CREDSTORE_ENCRYPTED'];
    }
  });

  it('col binario vero, e senza il supervisore sul PATH, dice cosa manca ed esce 3', () => {
    // La cucitura per intero, non a pezzi: il flag parsato da `main.ts`, il
    // piano, la scrittura, il runner REALE e il codice d'uscita. Il PATH ha
    // solo `node` — quindi `systemctl`/`launchctl` non esistono davvero e
    // niente viene acceso su questa macchina, che è il punto: un test che
    // riuscisse qui registrerebbe un servizio vero a chi lo esegue.
    const dir = home();
    const soloNode = mkdtempSync(join(tmpdir(), 'muffin-solo-node-'));
    homes.push(soloNode);
    symlinkSync(process.execPath, join(soloNode, 'node'));
    // La unit di sistema non si scrive mai in /etc da un test: MUFFIN_SYSTEM_DIR
    // la sposta in scratch (hook di test, stessa famiglia di MUFFIN_BINDIR).
    const sysdir = mkdtempSync(join(tmpdir(), 'muffin-sysdir-'));
    homes.push(sysdir);

    const r = muffin(dir, ['gateway', 'install', '--start'], '', { PATH: soloNode, MUFFIN_SYSTEM_DIR: sysdir });

    expect(r.code).toBe(EXIT_NOT_ACTIVATED);
    expect(r.err).toContain('si è fermato qui');
    const unit = process.platform === 'darwin'
      ? join(dir, 'Library', 'LaunchAgents', 'ai.muffin.gateway.plist')
      : join(sysdir, 'muffin-gateway.service');
    expect(existsSync(unit)).toBe(true);
  });
});

/**
 * Uno stop chiesto tiene giù il gateway; un crash no.
 *
 * Misurato sulla macchina dell'owner il 28/08/2026 — «ho buttato giù il
 * gateway e lo ha riportato su da solo, questo non va bene». Su Linux il verbo
 * era vero da sempre (`RestartPreventExitStatus`); su macOS launchd non ha un
 * equivalente per codice di uscita, e il plist si limitava ad ammettere la
 * bugia in una riga di avvertimento.
 *
 * La traduzione è un **semaforo sul filesystem**, che launchd sa leggere
 * (`KeepAlive: {PathState: {…: false}}`). Il file lo scrive `stop` e lo toglie
 * `start`; un crash non passa da nessuno dei due, ed è così che «fermato» e
 * «morto» restano due cose diverse per il supervisore.
 *
 * Qui si prova la metà che vive dentro Muffin: il semaforo esiste, `run` lo
 * rispetta, `start` lo toglie. La metà dentro launchd è provata in
 * `core/gateway/unit.test.ts`, contro il plist generato.
 */
describe('uno stop chiesto tiene giù il gateway', () => {
  it('`gateway run` si rifiuta di partire quando il semaforo c è, e dice come riaccenderlo', () => {
    const dir = home();
    writeFileSync(paths(dir).gatewayStopped, '2026-08-28T00:00:00.000Z\n', 'utf8');

    const r = muffin(dir, ['gateway', 'run']);
    // Su stderr: stdout di un demone è il suo output, e un rifiuto non è
    // output. Stessa regola di ogni altro messaggio di questo file.
    expect(r.err).toContain('fermato di proposito');
    expect(r.err).toContain('muffin gateway start');
    // E non ha preso il lock: un processo che non parte non deve lasciare
    // dietro di sé una rivendicazione che faccia sembrare vivo il gateway.
    const db = new DatabaseCtor(paths(dir).db, { readonly: true });
    try {
      expect(readGateway(db)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('senza semaforo `run` parte come sempre — il difetto è il rifiuto, non il file', () => {
    const dir = home();
    // Non lo si lascia girare (è un demone): basta sapere che NON esce con la
    // riga del semaforo. Il lock già preso lo fa uscire subito per un'altra
    // ragione, che è esattamente ciò che serve per distinguere i due rifiuti.
    holdGateway(dir);
    const r = muffin(dir, ['gateway', 'run']);
    expect(r.err).not.toContain('fermato di proposito');
  });

  it('`gateway start` toglie il semaforo', () => {
    const dir = home();
    writeFileSync(paths(dir).gatewayStopped, 'x\n', 'utf8');

    muffin(dir, ['gateway', 'start']);
    expect(existsSync(paths(dir).gatewayStopped)).toBe(false);
  });

  /**
   * Fermo di proposito non è un guasto. Un `!` giallo su uno stato voluto è il
   * modo più rapido per insegnare all'owner a scorrere oltre `doctor`.
   */
  it('e `doctor` lo chiama fermo di proposito, non guasto', () => {
    const dir = home();
    writeFileSync(paths(dir).gatewayStopped, 'x\n', 'utf8');

    const r = muffin(dir, ['doctor']);
    expect(r.out).toMatch(/gateway.*fermo di proposito/s);
    expect(r.out).toContain('muffin gateway start');
    // E non la vecchia riga d'allarme, che qui sarebbe falsa.
    expect(r.out).not.toContain('nessun processo attivo');
  });

  it("e lo dice, invece di fingere di aver acceso qualcosa che non c'è", () => {
    const dir = home();
    writeFileSync(paths(dir).gatewayStopped, 'x\n', 'utf8');

    // Nessun LaunchAgent né unit installati in un home di prova: non c'è un
    // supervisore da svegliare, e stamparlo è meglio che eseguire un comando
    // che fallirà.
    const r = muffin(dir, ['gateway', 'start']);
    expect(r.err).toContain('supervisore');
    expect(r.err).toContain('muffin gateway install');
  });
});

/**
 * `muffin gateway status`, quando il gateway è giù.
 *
 * Misurato sulla macchina dell'owner il 28/08/2026, subito dopo un
 * `gateway stop` riuscito: «nessun gateway attivo → `muffin gateway install`».
 * Il rimedio è sbagliato due volte — è già installato, e installarlo di nuovo
 * non lo riaccende. `doctor` la distinzione la faceva già da #217; questo è il
 * comando che uno prova per primo, e non la faceva.
 *
 * Un rimedio sbagliato è peggio di nessun rimedio: si esegue.
 */
describe('status distingue «fermo» da «non c è»', () => {
  const home = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-gwstatus-'));
    runInit({ home: dir, apiKey: 'sk-mai-usata' });
    return dir;
  };

  it('senza semaforo dice che non c è, e come installarlo', () => {
    const dir = home();
    const out: string[] = [];
    const err: string[] = [];
    const o = vi.spyOn(process.stdout, 'write').mockImplementation((c) => (out.push(String(c)), true));
    const e = vi.spyOn(process.stderr, 'write').mockImplementation((c) => (err.push(String(c)), true));
    try {
      expect(cmdGatewayStatus(dir)).toBe(1);
    } finally {
      o.mockRestore();
      e.mockRestore();
    }
    expect(out.join('')).toContain('nessun gateway attivo');
    expect(err.join('')).toContain('gateway install');
    rmSync(dir, { recursive: true, force: true });
  });

  it('col semaforo dice che è fermo di proposito, e come riaccenderlo', () => {
    const dir = home();
    writeFileSync(paths(dir).gatewayStopped, `${new Date().toISOString()}\n`, 'utf8');
    const out: string[] = [];
    const err: string[] = [];
    const o = vi.spyOn(process.stdout, 'write').mockImplementation((c) => (out.push(String(c)), true));
    const e = vi.spyOn(process.stderr, 'write').mockImplementation((c) => (err.push(String(c)), true));
    try {
      // Sempre 1: la domanda scriptabile è «è su?», e la risposta è no
      // qualunque sia la ragione.
      expect(cmdGatewayStatus(dir)).toBe(1);
    } finally {
      o.mockRestore();
      e.mockRestore();
    }
    expect(out.join('')).toContain('fermo di proposito');
    expect(err.join('')).toContain('gateway start');
    // E soprattutto **non** il rimedio sbagliato.
    expect(err.join('')).not.toContain('gateway install');
    rmSync(dir, { recursive: true, force: true });
  });
});
