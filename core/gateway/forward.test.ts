import { mkdtempSync } from 'node:fs';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TurnInput, TurnResult } from '../../agent/loop/types.js';
import { LANE_JOBS, ModelLane } from '../turns/model-lane.js';
import type { TurnRecord } from '../turns/store.js';
import { type ControlServer, serveControlSocket } from './control-socket.js';
import {
  type ForwardDeps,
  ForwardHost,
  forwardChannel,
  runViaGateway,
  UnknownOutcomeError,
} from './forward.js';

/**
 * #533 — l'execution ha un solo owner per tutta la sua vita.
 *
 * Su socket reale, con `ModelLane` vera: dedup per id, attach del secondo
 * osservatore, cancel esplicito, disconnect senza duplicati, lane condivisa
 * con gli altri holder, fail closed quando la claim è persa.
 */

const aperti: ControlServer[] = [];
afterEach(async () => {
  while (aperti.length > 0) await aperti.pop()!.close();
});

const home = (): string => mkdtempSync(join(tmpdir(), 'muffin-fwd-'));

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
  execute: (input: TurnInput) => Promise<TurnResult>;
  righe: Map<string, TurnRecord>;
  lane: ModelLane;
  ancoraOwner: { valore: boolean };
};

function setup(behavior: (input: TurnInput) => Promise<TurnResult>): Setup & { home: string } {
  const h = home();
  const lane = new ModelLane();
  const calls: TurnInput[] = [];
  const righe = new Map<string, TurnRecord>();
  const ancoraOwner = { valore: true };
  const execute = async (input: TurnInput): Promise<TurnResult> => {
    calls.push(input);
    return behavior(input);
  };
  const deps: ForwardDeps = {
    modelLane: lane,
    stillOwner: () => ancoraOwner.valore,
    turns: { get: (id: string) => righe.get(id) ?? null },
    openSession: (id: string) => ({ id, file: join(h, 'sessions', `${id}.jsonl`) }),
    execute,
    model: () => 'modello-prova',
    log: () => {},
  };
  const host = new ForwardHost(deps);
  return { host, calls, execute, righe, lane, ancoraOwner, home: h };
}

async function servi(s: Setup & { home: string }): Promise<void> {
  aperti.push(
    await serveControlSocket(s.home, () => null, {
      onStream: (sock: Socket, first: Record<string, unknown>) => s.host.handleRun(sock, first),
    }),
  );
}

describe('forward — un turno del terminale sul runtime del gateway', () => {
  it('esegue una volta sola e ritorna stream + risultato allo stesso client', async () => {
    const s = setup(async (input) => {
      input.onDelta?.({ type: 'text', text: 'ciao ' });
      input.onDelta?.({ type: 'text', text: 'mondo' });
      input.onProgress?.({ type: 'round', n: 1 });
      return risultato({ turnId: input.id ?? '?', traceId: input.id ?? '?' });
    });
    await servi(s);
    const deltas: string[] = [];
    let rounds = 0;
    const result = await runViaGateway(
      s.home,
      { id: 'exec-1', text: 'dimmi ciao', sessionId: 'sess-1' },
      {
        onDelta: (d) => {
          if (d.type === 'text') deltas.push(d.text);
        },
        onProgress: (e) => {
          if (e.type === 'round') rounds += 1;
        },
        approve: async () => 'deny',
      },
    );
    expect(result.text).toBe('fatto');
    expect(result.turnId).toBe('exec-1');
    expect(deltas.join('')).toBe('ciao mondo');
    expect(rounds).toBe(1);
    expect(s.calls).toHaveLength(1);
    // Stesso owner, stessa superficie, stesso canale di risposta del terminale:
    // l'esecuzione non ha inventato un'identità diversa da quella locale.
    expect(s.calls[0]).toMatchObject({
      surface: 'cli',
      tenant: 'host',
      principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
      replyChannel: forwardChannel('exec-1'),
      text: 'dimmi ciao',
    });
    expect(s.calls[0]?.session.id).toBe('sess-1');
  });

  it('stesso id due volte: nessuna seconda esecuzione, il secondo si attacca', async () => {
    let rilascia!: () => void;
    const attesa = new Promise<void>((res) => {
      rilascia = res;
    });
    const s = setup(async (input) => {
      await attesa;
      return risultato({ turnId: input.id ?? '?' });
    });
    await servi(s);
    const primo = runViaGateway(
      s.home,
      { id: 'dup-1', text: 'uno', sessionId: 's' },
      { approve: async () => 'deny' },
    );
    await new Promise((r) => setTimeout(r, 100));
    const secondo = runViaGateway(
      s.home,
      { id: 'dup-1', text: 'uno', sessionId: 's' },
      { approve: async () => 'deny' },
    );
    rilascia();
    const [r1, r2] = await Promise.all([primo, secondo]);
    expect(r1.turnId).toBe('dup-1');
    expect(r2.turnId).toBe('dup-1');
    // Una execution, due osservatori: esattamente-once non è promesso, il
    // non-duplicato sì.
    expect(s.calls).toHaveLength(1);
  });

  it('a esecuzione finita lo stesso id torna l esito senza rieseguire', async () => {
    const s = setup(async (input) => risultato({ turnId: input.id ?? '?' }));
    await servi(s);
    await runViaGateway(
      s.home,
      { id: 'fatta-1', text: 'uno', sessionId: 's' },
      { approve: async () => 'deny' },
    );
    const diNuovo = await runViaGateway(
      s.home,
      { id: 'fatta-1', text: 'uno', sessionId: 's' },
      { approve: async () => 'deny' },
    );
    expect(diNuovo.turnId).toBe('fatta-1');
    expect(s.calls).toHaveLength(1);
  });

  it('riga esistente senza execution viva: niente esecuzione, esito unknown interrogabile', async () => {
    const s = setup(async (input) => risultato({ turnId: input.id ?? '?' }));
    s.righe.set('vecchia-1', { id: 'vecchia-1', status: 'running' } as TurnRecord);
    await servi(s);
    await expect(
      runViaGateway(
        s.home,
        { id: 'vecchia-1', text: 'uno', sessionId: 's' },
        { approve: async () => 'deny' },
      ),
    ).rejects.toBeInstanceOf(UnknownOutcomeError);
    expect(s.calls).toHaveLength(0);
    expect(s.host.query('vecchia-1')).toMatchObject({ found: true, status: 'running' });
  });

  it('cancel esplicito abortisce la stessa execution e torna `aborted`', async () => {
    const s = setup(async (input) => {
      await new Promise<void>((res) => {
        if (input.signal?.aborted) return res();
        input.signal?.addEventListener('abort', () => res(), { once: true });
      });
      return risultato({ turnId: input.id ?? '?', stopped: 'aborted', text: '' });
    });
    await servi(s);
    const controller = new AbortController();
    const run = runViaGateway(
      s.home,
      { id: 'canc-1', text: 'lavoro lungo', sessionId: 's' },
      { approve: async () => 'deny', signal: controller.signal },
    );
    await new Promise((r) => setTimeout(r, 150));
    controller.abort();
    const result = await run;
    expect(result.stopped).toBe('aborted');
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.signal?.aborted).toBe(true);
  });

  it('disconnect senza cancel: l esecuzione continua e il re-run si riattacca senza duplicare', async () => {
    let rilascia!: () => void;
    const attesa = new Promise<void>((res) => {
      rilascia = res;
    });
    const s = setup(async (input) => {
      await attesa;
      return risultato({ turnId: input.id ?? '?' });
    });
    await servi(s);
    // Primo client: si stacca a metà senza cancel (socket distrutto).
    const { connect } = await import('node:net');
    const { resolveSocketPath } = await import('./control-socket.js');
    const crudo = connect(resolveSocketPath(s.home));
    await new Promise<void>((res) => crudo.on('connect', () => res()));
    crudo.setEncoding('utf8');
    crudo.write(
      `${JSON.stringify({ verb: 'run', protocol: 2, id: 'disc-1', text: 'uno', sessionId: 's' })}\n`,
    );
    await new Promise((r) => setTimeout(r, 150));
    crudo.destroy();
    await new Promise((r) => setTimeout(r, 100));
    // Il re-run con lo stesso id non duplica: si attacca all'unica execution.
    const re = runViaGateway(
      s.home,
      { id: 'disc-1', text: 'uno', sessionId: 's' },
      { approve: async () => 'deny' },
    );
    rilascia();
    expect((await re).turnId).toBe('disc-1');
    expect(s.calls).toHaveLength(1);
  });

  it('mentre la lane è presa da un altro holder, l esecuzione aspetta invece di sovrapporsi', async () => {
    const s = setup(async (input) => risultato({ turnId: input.id ?? '?' }));
    await servi(s);
    expect(s.lane.take(LANE_JOBS)).toBeNull();
    try {
      const run = runViaGateway(
        s.home,
        { id: 'coda-1', text: 'uno', sessionId: 's' },
        { approve: async () => 'deny' },
      );
      await new Promise((r) => setTimeout(r, 150));
      // La corsia è una sola: finché i job la tengono, il turno non parte.
      expect(s.calls).toHaveLength(0);
      s.lane.release(LANE_JOBS);
      expect((await run).turnId).toBe('coda-1');
      expect(s.calls).toHaveLength(1);
    } finally {
      s.lane.release(LANE_JOBS);
    }
  });

  it('claim persa prima dell inizio: niente esecuzione, errore deterministico', async () => {
    const s = setup(async (input) => risultato({ turnId: input.id ?? '?' }));
    s.ancoraOwner.valore = false;
    await servi(s);
    await expect(
      runViaGateway(
        s.home,
        { id: 'persa-1', text: 'uno', sessionId: 's' },
        { approve: async () => 'deny' },
      ),
    ).rejects.not.toBeInstanceOf(UnknownOutcomeError);
    expect(s.calls).toHaveLength(0);
  });

  it('approvazione senza execution viva: unavailable, come oggi sul gateway', async () => {
    const s = setup(async (input) => risultato({ turnId: input.id ?? '?' }));
    expect(
      await s.host.approve({ capability: 'x', prompt: 'y', taint: 0 }, { turnId: 'mai' }),
    ).toBe('unavailable');
  });

  it('approvazione con execution viva: round-trip sullo stesso socket, stessa execution', async () => {
    // L'execution non finisce mai: resta viva e attaccata, come un turno che
    // il kernel mette in pausa per chiedere.
    const s = setup(() => new Promise<TurnResult>(() => {}));
    await servi(s);
    const { connect } = await import('node:net');
    const { resolveSocketPath } = await import('./control-socket.js');
    const crudo = connect(resolveSocketPath(s.home));
    try {
      await new Promise<void>((res) => crudo.on('connect', () => res()));
      crudo.setEncoding('utf8');
      crudo.write(
        `${JSON.stringify({ verb: 'run', protocol: 2, id: 'appr-1', text: 'uno', sessionId: 's' })}\n`,
      );
      await new Promise<void>((res) => {
        let buf = '';
        const onStarted = (c: string): void => {
          buf += c;
          if (buf.includes('"started"')) {
            crudo.off('data', onStarted);
            res();
          }
        };
        crudo.on('data', onStarted);
      });
      expect(s.calls).toHaveLength(1);
      const risposta = s.host.approve(
        { capability: 'sys.shell', prompt: 'posso?', taint: 0 },
        { turnId: 'appr-1' },
      );
      // La domanda arriva al client sullo stesso socket…
      const riga = await new Promise<string>((res) => {
        let buf = '';
        const onData = (c: string): void => {
          buf += c;
          const righe = buf.split('\n').filter((l) => l.trim() !== '');
          const trovata = righe.find((l) => l.includes('"approval"'));
          if (trovata) {
            crudo.off('data', onData);
            res(trovata);
          }
        };
        crudo.on('data', onData);
      });
      expect(riga).toContain('sys.shell');
      // …e il sì rientra nella stessa execution, senza farne nascere un'altra.
      crudo.write(`${JSON.stringify({ kind: 'approval-answer', answer: 'allow' })}\n`);
      expect(await risposta).toBe('allow');
      expect(s.calls).toHaveLength(1);
    } finally {
      crudo.destroy();
    }
  });

  it('query: id sconosciuto, riga in corso, esecuzione finita', async () => {
    const s = setup(async (input) => risultato({ turnId: input.id ?? '?', text: 'risposta vera' }));
    await servi(s);
    expect(s.host.query('mai')).toEqual({ found: false });
    s.righe.set('attesa-1', {
      id: 'attesa-1',
      status: 'waiting',
      outcome: null,
      messages: [],
    } as unknown as TurnRecord);
    expect(s.host.query('attesa-1')).toMatchObject({
      found: true,
      status: 'waiting',
      stopped: null,
    });
    await runViaGateway(
      s.home,
      { id: 'finita-1', text: 'uno', sessionId: 's' },
      { approve: async () => 'deny' },
    );
    expect(s.host.query('finita-1')).toMatchObject({
      found: true,
      status: 'done',
      stopped: 'answered',
      text: 'risposta vera',
    });
  });
});
