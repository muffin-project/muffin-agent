import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { TurnInput, TurnResult } from '../agent/loop/types.js';
import { Gateway } from '../core/gateway/service.js';
import {
  CONTROL_PROTOCOL,
  type ControlServer,
  serveControlSocket,
} from '../core/gateway/control-socket.js';
import {
  ForwardHost,
  type ForwardDeps,
  submitViaGateway,
  UnknownOutcomeError,
} from '../core/gateway/forward.js';
import { GatewayLock } from '../core/gateway/lock.js';
import type { Notifier } from '../core/gateway/notify.js';
import { JobStore } from '../core/scheduler/jobs.js';
import { Scheduler } from '../core/scheduler/scheduler.js';
import { DELIVERED } from '../core/surface/types.js';
import { LANE_TURNS, ModelLane } from '../core/turns/model-lane.js';
import type { TurnRecord } from '../core/turns/store.js';
import {
  attachIdentify,
  cmdGatewayAttach,
  exitForAttachStopped,
  pollTurn,
  queryTurn,
} from './gateway-attach.js';
import { runInit } from './init.js';

/**
 * `gateway-attach` — il percorso attach sul gateway vivo.
 *
 * Prima il wiring esistente (socket + TurnStore), poi il minimo nuovo:
 * poll durevole per stesso id senza rieseguire, fail closed senza gateway,
 * wait-cap configurabile, exit code headless. Suite mirata, mai full-suite.
 */

const homes: string[] = [];
const servers: ControlServer[] = [];
afterAll(async () => {
  while (servers.length > 0) await servers.pop()!.close();
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-attach-'));
  homes.push(dir);
  runInit({ home: dir, apiKey: 'sk-never-called' });
  return dir;
}

function risultato(over: Partial<TurnResult> = {}): TurnResult {
  return {
    text: 'fatto',
    iterations: 1,
    traceId: 't',
    turnId: 't',
    stopped: 'answered',
    taint: 0,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ...over,
  };
}

type Setup = {
  host: ForwardHost;
  calls: TurnInput[];
  righe: Map<string, TurnRecord>;
  ancoraOwner: { valore: boolean };
  lane: ModelLane;
};

function setupHost(
  dir: string,
  behavior: (input: TurnInput) => Promise<TurnResult>,
): Setup {
  const lane = new ModelLane();
  const calls: TurnInput[] = [];
  const righe = new Map<string, TurnRecord>();
  const ancoraOwner = { valore: true };
  const deps: ForwardDeps = {
    modelLane: lane,
    stillOwner: () => ancoraOwner.valore,
    turns: { get: (id: string) => righe.get(id) ?? null },
    openSession: (id: string) => ({ id, file: join(dir, 'sessions', `${id}.jsonl`) }),
    execute: async (input: TurnInput) => {
      calls.push(input);
      return behavior(input);
    },
    model: () => 'modello-prova',
    log: () => {},
  };
  return { host: new ForwardHost(deps), calls, righe, ancoraOwner, lane };
}

async function servi(dir: string, s: Setup): Promise<void> {
  servers.push(
    await serveControlSocket(
      dir,
      (verb, body) => {
        if (verb === 'identify')
          return {
            protocol: CONTROL_PROTOCOL,
            pid: process.pid,
            home: dir,
            codeSha: null,
            startedAt: new Date().toISOString(),
          };
        if (verb === 'query') {
          const id = (body as { id?: unknown }).id;
          if (typeof id !== 'string') return null;
          return s.host.query(id);
        }
        return null;
      },
      { onStream: (sock: Socket, first: Record<string, unknown>) => s.host.handleRun(sock, first) },
    ),
  );
}

describe('exit code headless', () => {
  it('mappa stopped → 0/3/4/5/6/7/1 come `muffin run`', () => {
    expect(exitForAttachStopped('answered')).toBe(0);
    expect(exitForAttachStopped('ask')).toBe(3);
    expect(exitForAttachStopped('budget')).toBe(4);
    expect(exitForAttachStopped('cap')).toBe(5);
    expect(exitForAttachStopped('suspended')).toBe(6);
    expect(exitForAttachStopped('continuable')).toBe(7);
    expect(exitForAttachStopped('aborted')).toBe(1);
    expect(exitForAttachStopped('error')).toBe(1);
    expect(exitForAttachStopped(null, 'continuable')).toBe(7);
    expect(exitForAttachStopped(null, 'running')).toBe(1);
  });
});

describe('fail closed senza gateway', () => {
  it('attach senza socket: exit≠0, diagnostica con il rimedio, mai hang', async () => {
    const dir = home();
    const inizio = Date.now();
    const err: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      err.push(String(c));
      return true;
    });
    let code: number;
    try {
      code = await cmdGatewayAttach(dir, ['turno-mai', '--wait-sec', '30']);
    } finally {
      spy.mockRestore();
    }
    const durato = Date.now() - inizio;
    expect(code).not.toBe(0);
    expect(err.join('')).toContain('muffin gateway install');
    expect(err.join('')).toMatch(/status|start/);
    // Mai attesa silenziosa: senza gateway non si aspetta il cap.
    expect(durato).toBeLessThan(10_000);
  });

  it('poll con gateway caduto a metà: non lo aspetta che torni', async () => {
    let vivo = true;
    const out = await pollTurn({
      waitSec: 30,
      pollMs: 1,
      identify: async () => (vivo ? { pid: 1 } : null),
      query: async () => {
        vivo = false;
        return { found: true, status: 'running', stopped: null, text: null, turnId: 'x' };
      },
      sleep: async () => {},
    });
    expect(out.kind).toBe('gateway-down');
  });
});

describe('wait-cap configurabile', () => {
  it('un turno che non finisce: timeout entro il cap, stesso id, niente riesecuzione', async () => {
    const inizio = Date.now();
    const err: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      err.push(String(c));
      return true;
    });
    let code: number;
    try {
      code = await cmdGatewayAttach(home(), ['turno-lento'], {
        waitSecDefault: 0.3,
        pollMs: 20,
        identify: async () => ({ pid: 1 }),
        queryOverride: () => async () => ({
          found: true,
          status: 'running',
          stopped: null,
          text: null,
          turnId: 'turno-lento',
        }),
      });
    } finally {
      spy.mockRestore();
    }
    expect(code).not.toBe(0);
    expect(err.join('')).toContain('turno-lento');
    expect(err.join('')).toContain('muffin gateway attach turno-lento');
    expect(Date.now() - inizio).toBeLessThan(10_000);
  });
});

describe('stesso turn_id, mai una riesecuzione (socket + TurnStore veri)', () => {
  it('stesso id due volte: una sola esecuzione, il secondo riattacca', async () => {
    const dir = home();
    const s = setupHost(dir, async (input) => risultato({ turnId: input.id ?? '?' }));
    await servi(dir, s);

    const primo = await submitViaGateway(dir, { id: 'dup-attach-1', text: 'uno', sessionId: 's' });
    expect(primo).toBe('dup-attach-1');
    const secondo = await submitViaGateway(dir, { id: 'dup-attach-1', text: 'uno', sessionId: 's' });
    expect(secondo).toBe('dup-attach-1');

    const esito = await pollTurn({
      waitSec: 10,
      pollMs: 10,
      identify: () => attachIdentify(dir),
      query: () => queryTurn(dir, 'dup-attach-1'),
    });
    expect(esito.kind).toBe('ready');
    if (esito.kind === 'ready') expect(esito.query.turnId).toBe('dup-attach-1');
    // Una execution, due submit: il non-duplicato, non l'esattamente-una-volta.
    await vi.waitFor(() => expect(s.calls).toHaveLength(1), { timeout: 5000, interval: 10 });
    expect(s.calls).toHaveLength(1);
  });

  it('riga esistente senza execution viva: niente esecuzione, esito unknown (mutation: senza il check riesegue)', async () => {
    const dir = home();
    const s = setupHost(dir, async (input) => risultato({ turnId: input.id ?? '?' }));
    s.righe.set('vecchia-attach-1', { id: 'vecchia-attach-1', status: 'running' } as TurnRecord);
    await servi(dir, s);
    await expect(
      submitViaGateway(dir, { id: 'vecchia-attach-1', text: 'uno', sessionId: 's' }),
    ).rejects.toBeInstanceOf(UnknownOutcomeError);
    expect(s.calls).toHaveLength(0);
    const q = await queryTurn(dir, 'vecchia-attach-1');
    expect(q).toMatchObject({ found: true, status: 'running' });
  });

  it('disconnect mentre la lane è occupata: l esecuzione resta viva e il poll la ritrova', async () => {
    const dir = home();
    const s = setupHost(dir, async (input) => risultato({ turnId: input.id ?? '?' }));
    await servi(dir, s);

    // La lane è tenuta da un altro holder: il submit entra in coda e il
    // socket si chiude subito dopo `started` — la race che il vecchio gate
    // (`observers.size === 0` → delete) perdeva in silenzio.
    expect(s.lane.take(LANE_TURNS)).toBeNull();
    try {
      const id = await submitViaGateway(dir, { id: 'coda-attach-1', text: 'uno', sessionId: 's' });
      await new Promise((r) => setTimeout(r, 150));
      // In coda, senza osservatori: con il vecchio gate qui era già cancellata.
      expect(s.calls).toHaveLength(0);
      s.lane.release(LANE_TURNS);
      const esito = await pollTurn({
        waitSec: 10,
        pollMs: 10,
        identify: () => attachIdentify(dir),
        query: () => queryTurn(dir, id),
      });
      expect(esito.kind).toBe('ready');
      expect(s.calls).toHaveLength(1);
    } finally {
      s.lane.release(LANE_TURNS);
    }
  });
});

describe('un job due scatta solo con il tick vivo', () => {
  function mondo() {
    const db = new DatabaseCtor(':memory:');
    const jobs = new JobStore(db);
    const job = jobs.add({ cron: '0 8 * * *', timezone: 'Europe/Rome', goal: 'brief', channel: 'cli' });
    db.prepare(`UPDATE jobs SET next_fire_at = ? WHERE id = ?`).run(
      new Date(Date.now() - 60_000).toISOString(),
      job.id,
    );
    return { db, jobs, job };
  }
  const fakeNotify: Notifier = {
    notifySocket: false,
    watchdogIntervalMs: null,
    ready: () => {},
    watchdog: () => {},
    stopping: () => {},
    problem: () => null,
  };

  it('senza tick il job resta dovuto; con il tick del gateway parte una volta', async () => {
    const w = mondo();
    // Senza tick nessuno esegue: ancora dovuto, mai corso.
    expect(w.jobs.due(new Date()).map((j) => j.id)).toContain(w.job.id);
    expect(w.jobs.get(w.job.id)!.lastRunAt).toBeNull();

    let eseguiti = 0;
    const scheduler = new Scheduler(
      w.jobs,
      async () => {
        eseguiti += 1;
        return { stopped: 'answered' as const, text: 'brief', turnId: 'turn-test' };
      },
      async () => DELIVERED,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new ModelLane(),
    );
    const lock = new GatewayLock(w.db, () => true);
    lock.claim(new Date(), 'avvio', process.pid);
    const gateway = new Gateway({
      lock,
      notify: fakeNotify,
      scheduler,
      turnLane: { tick: () => {}, isRunning: () => false },
      jobs: w.jobs,
      close: () => {},
      log: () => {},
      signals: { on: () => {}, off: () => {} },
      sleep: async () => {},
      tickMs: 3_600_000,
    });
    gateway.tick(new Date());
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(eseguiti).toBe(1);
    expect(w.jobs.due(new Date())).toEqual([]);
  });
});
