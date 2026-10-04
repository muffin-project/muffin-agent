import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runInit } from '../cli/init.js';
import { runStatus } from '../core/autonomy/run-status.js';
import { paths } from '../core/config/config.js';
import { TurnLane } from '../core/turns/lane.js';
import { ModelLane } from '../core/turns/model-lane.js';
import type { TurnRecord } from '../core/turns/store.js';
import { buildRuntime } from './runtime.js';
import type { LoopDeps } from './loop.js';
import { makeLaneRunner } from './turn-lane.js';
import type { ChatResult, Provider } from './providers/types.js';

/**
 * #598 S2 · fault injection — a real process dies after its lease yields.
 *
 * A real Muffin child boots the production `buildRuntime`, fires a scheduled
 * job whose lease settles one effect and then ends `continuable`, and is
 * `SIGKILL`ed inside the `MUFFIN_JOB_FIRES_STALL_AFTER_CONTINUABLE_MS` window
 * — after the release is durable, before any resume could happen. No
 * `finally`, no cleanup: what the next process finds on disk is all it gets,
 * which is what a laptop closing or an OOM kill between a yield and its
 * continuation actually looks like.
 *
 * The restart then beats the lane once, with no owner message anywhere, and
 * must find: the same `turn_id`, exactly the one settled effect (a second
 * settled row is the duplication the intent WAL prevents), and a terminal
 * `done`. Reverting the `due()` inclusion in `core/turns/store.ts` leaves
 * the row `continuable` for ever — that is the red half of the falsifier,
 * demonstrated on the branch, not in this file.
 */

/** Unwrap-or-throw for rows the test itself just wrote: a missing row is a setup bug, not an assertion. */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('riga attesa assente nel database di prova');
  return value;
}

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

/**
 * The child: a real Muffin firing a real job, killed after its lease yields.
 *
 * Goes through `buildRuntime` + `makeJobRunner`, so the fire bind, the row,
 * the intent record and the continuable release are all written by the same
 * code an install runs. The tool settles one effect (one marker line), then
 * the provider stalls into `provider_empty` and the lease yields — and the
 * stall env var holds the process inside the release/resume window until the
 * parent's SIGKILL lands.
 */
const CHILD = (runtimeUrl: string, schedulerRunUrl: string) => `
import { appendFileSync } from 'node:fs';
import { buildRuntime } from ${JSON.stringify(runtimeUrl)};
import { makeJobRunner } from ${JSON.stringify(schedulerRunUrl)};

const [home, ws, marker] = process.argv.slice(2);
const rt = buildRuntime(home, ws);

rt.register(
  {
    capability: 'demo.append',
    spec: { name: 'append_mark', description: 'appunta', inputSchema: { type: 'object', properties: {} } },
    handler: async () => {
      appendFileSync(marker, 'settled\\n');
      return { content: 'appuntato', tier: 0 };
    },
    throwTier: 0,
  },
  {
    id: 'demo.append',
    effect: 'context',
    risk: 'low',
    reversible: 'yes',
    rerunnable: true,
    maxTaint: 3,
    resourceKind: 'none',
    policyArgs: [],
    hostOnly: false,
  },
);

const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const some = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const script = [
  { text: null, toolCalls: [{ id: 'c1', name: 'append_mark', args: {} }], stopReason: 'tool_use', usage: some, model: 'test' },
  { text: null, toolCalls: [], stopReason: 'error', usage: zero, model: 'test' },
  { text: null, toolCalls: [], stopReason: 'error', usage: zero, model: 'test' },
  { text: null, toolCalls: [], stopReason: 'error', usage: zero, model: 'test' },
  { text: null, toolCalls: [], stopReason: 'error', usage: zero, model: 'test' },
];
let i = 0;
const provider = {
  kind: 'openai-compat',
  chat: async () => {
    const next = script[i++];
    if (!next) throw new Error('lo script è finito');
    return next;
  },
};

const job = rt.jobs.add({ cron: '0 8 * * *', timezone: 'Europe/Rome', goal: 'appunta e fai il brief', channel: 'cli' });
await makeJobRunner({ ...rt.deps, provider }, rt.jobFires, null, null, rt.budget)(job, undefined);
`;

/** Spawns the child, waits until one effect is settled and the lease has yielded, and kills -9. */
async function killAfterYield(home: string, ws: string, marker: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-s2kill-'));
  const script = join(dir, 'child.mjs');
  writeFileSync(
    script,
    CHILD(
      pathToFileURL(join(process.cwd(), 'agent', 'runtime.ts')).href,
      pathToFileURL(join(process.cwd(), 'agent', 'scheduler-run.ts')).href,
    ),
  );

  const child = spawn('node', ['--import', 'tsx', script, home, ws, marker], {
    stdio: 'ignore',
    env: { ...process.env, MUFFIN_JOB_FIRES_STALL_AFTER_CONTINUABLE_MS: '30000' },
  });
  let gone = child.exitCode !== null;
  const exited = new Promise<void>((resolve) => {
    if (gone) resolve();
    child.on('exit', () => {
      gone = true;
      resolve();
    });
  });

  // The window this polls for is only open while the child sits in the
  // post-release stall: settled effect on disk, row continuable, fire still
  // bound and unsettled.
  const dbPath = paths(home).db;
  const deadline = Date.now() + 90_000;
  let ready = false;
  for (; !ready && Date.now() < deadline && !gone; ) {
    await new Promise((r) => setTimeout(r, 200));
    if (!existsSync(dbPath)) continue;
    const db = new DatabaseCtor(dbPath, { readonly: true });
    try {
      const turn = db.prepare(`SELECT id, status FROM turns LIMIT 1`).get() as
        | { id: string; status: string }
        | undefined;
      if (turn?.status !== 'continuable') continue;
      const settled = (
        db
          .prepare(`SELECT COUNT(*) AS n FROM turn_tool_calls WHERE ended_at IS NOT NULL AND undone_at IS NULL`)
          .get() as { n: number }
      ).n;
      ready = settled === 1;
    } catch {
      // The child is mid-write; poll again.
    } finally {
      db.close();
    }
  }
  if (!ready) {
    child.kill('SIGKILL');
    await exited;
    throw new Error(`il figlio non ha mai lasciato un continuable con un effetto (uscito ${child.exitCode})`);
  }
  // SIGKILL, not SIGTERM: no handler, no `finally`, no flush.
  child.kill('SIGKILL');
  await exited;
  // The kill has to be what ended it. A child that exited on its own would be
  // a tidy shutdown wearing the costume of a crash, and would prove nothing.
  expect(child.signalCode).toBe('SIGKILL');
}

async function settle(lane: TurnLane): Promise<void> {
  for (let i = 0; i < 800 && lane.isRunning(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(lane.isRunning()).toBe(false);
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('#598 S2 · fault injection — killed after the yield, resumes unattended', () => {
  it('same turn, exactly one settled effect, terminal done, no owner message', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-s2kill-home-'));
    runInit({ home, apiKey: 'sk-never-called' });
    const ws = mkdtempSync(join(tmpdir(), 'muffin-s2kill-ws-'));
    const marker = join(ws, 'effects.log');

    await killAfterYield(home, ws, marker);
    // The effect settled before the kill, exactly once.
    expect(readFileSync(marker, 'utf8').split('\n').filter((l) => l === 'settled')).toHaveLength(1);

    // ---- the restart: a fresh process over the same home, lane beats once --
    const runtime = buildRuntime(home, ws);
    const killed = runtime.db.prepare(`SELECT id, status FROM turns`).all() as { id: string; status: string }[];
    expect(killed).toHaveLength(1);
    expect(killed[0]?.status).toBe('continuable');
    const turnId = must(killed[0]).id;

    // The same tool list a restart has; if the resume re-ran the settled
    // call, the marker would gain its second line.
    runtime.register(
      {
        capability: 'demo.append',
        spec: { name: 'append_mark', description: 'appunta', inputSchema: { type: 'object', properties: {} } },
        handler: async () => {
          appendFileSync(marker, 'settled\n');
          return { content: 'appuntato', tier: 0 as const };
        },
        throwTier: 0,
      },
      {
        id: 'demo.append',
        effect: 'context',
        risk: 'low',
        reversible: 'yes',
        rerunnable: true,
        maxTaint: 3,
        resourceKind: 'none',
        policyArgs: [],
        hostOnly: false,
      },
    );

    const provider = new Scripted([answer('brief dopo il kill')]);
    const deps: LoopDeps = { ...runtime.deps, provider };
    const delivered: { turn: TurnRecord; text: string }[] = [];
    const lane = new TurnLane({
      turns: runtime.deps.turns,
      run: makeLaneRunner(
        deps,
        async (turn, text) => {
          delivered.push({ turn, text });
        },
        undefined,
        undefined,
        // Wired exactly as `cli/gateway.ts` wires it: the real ledger behind
        // the autonomous grant.
        {
          jobCap: (jobId) => runtime.jobs.get(jobId)?.perJobUsd ?? null,
          jobMonthUsd: (jobId) => runtime.budget.jobMonthUsd(jobId),
        },
      ),
      modelLane: new ModelLane(),
    });
    lane.tick();
    await settle(lane);

    const done = must(runtime.deps.turns.get(turnId));
    const settled = (
      runtime.db
        .prepare(`SELECT COUNT(*) AS n FROM turn_tool_calls WHERE turn_id = ? AND ended_at IS NOT NULL AND undone_at IS NULL`)
        .get(turnId) as { n: number }
    ).n;
    const fire = runtime.db.prepare(`SELECT job_id, scheduled_for, turn_id, settled_at FROM job_fires`).get() as {
      job_id: string;
      scheduled_for: string;
      turn_id: string;
      settled_at: string | null;
    };
    runtime.close();

    // Same identity, terminal, delivered once — with no owner message in any
    // session between the kill and the answer.
    expect(fire.turn_id).toBe(turnId);
    expect(done.status).toBe('done');
    expect(done.outcome).toBe('answered');
    expect(done.delivery).toBe('sent');
    expect(delivered.map((d) => d.text)).toEqual(['brief dopo il kill']);
    // S1's read-only projection over the same durable rows, no new states.
    const db = new DatabaseCtor(paths(home).db, { readonly: true });
    try {
      expect(
        runStatus(db, {
          jobId: fire.job_id,
          scheduledFor: fire.scheduled_for,
          turnId: fire.turn_id,
          settledAt: fire.settled_at,
        }).state,
      ).toBe('done');
    } finally {
      db.close();
    }
    // Exactly the one settled effect: the resume replayed, never re-ran.
    expect(settled).toBe(1);
    expect(readFileSync(marker, 'utf8').split('\n').filter((l) => l === 'settled')).toHaveLength(1);
  }, 180_000);
});
