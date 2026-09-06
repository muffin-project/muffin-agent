import { describe, expect, it, vi } from 'vitest';
import { DiscordGateway, nextAction } from './gateway.js';
// Il socket finto vive in `fake-socket.ts` dalla fetta 16: ne servivano tre
// copie (qui, `salute-superficie.test.ts`, e il test di parità) e due erano
// già divergenti.
import { FakeSocket } from './fake-socket.js';

function harness(over: { intents?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const dispatches: { event: string; data: unknown; seq: number }[] = [];
  const logs: string[] = [];
  const stati: { viva: boolean; causa?: string }[] = [];
  const sleeps: number[] = [];
  const gw = new DiscordGateway({
    token: 'tok',
    intents: over.intents ?? 4096,
    gatewayUrl: async () => 'wss://gateway.discord.gg',
    onDispatch: (event, data, seq) => dispatches.push({ event, data, seq }),
    onLog: (l) => logs.push(l),
    onStato: (viva, causa) => stati.push(causa === undefined ? { viva } : { viva, causa }),
    wsFactory: (_url) => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { gw, sockets, dispatches, logs, stati, sleeps, latest: () => sockets[sockets.length - 1]! };
}

const HELLO = (interval: number) => ({ op: 10, d: { heartbeat_interval: interval } });
const READY = (sessionId: string, resumeUrl = 'wss://resume.discord.gg') => ({
  op: 0,
  s: 1,
  t: 'READY',
  d: { session_id: sessionId, resume_gateway_url: resumeUrl },
});

describe('nextAction — the close-code table', () => {
  it('never reconnects on a token or config problem', () => {
    for (const code of [4004, 4010, 4011, 4012, 4013, 4014]) {
      expect(nextAction(code).reconnect).toBe(false);
    }
  });

  it('reconnects but does not resume when the session itself is invalid', () => {
    expect(nextAction(4007)).toMatchObject({ reconnect: true, resume: false });
    expect(nextAction(4009)).toMatchObject({ reconnect: true, resume: false });
  });

  it('reconnects and resumes for an ordinary or unknown close', () => {
    expect(nextAction(1006)).toMatchObject({ reconnect: true, resume: true });
    expect(nextAction(4000)).toMatchObject({ reconnect: true, resume: true });
  });
});

describe('the handshake', () => {
  it('identifies with exactly token/intents/properties after Hello — never Resume on a first connect', async () => {
    const h = harness({ intents: 4096 });
    const run = h.gw.run();
    await vi.waitFor(() => expect(h.sockets.length).toBe(1));

    h.latest().serverSends(HELLO(45_000));

    expect(h.latest().sent).toEqual([{ op: 2, d: { token: 'tok', intents: 4096, properties: expect.any(Object) as unknown } }]);

    h.gw.stop();
    await run;
  });

  it('stores session_id and resume_gateway_url from READY, for the next connect to use', async () => {
    const h = harness();
    const run = h.gw.run();
    await vi.waitFor(() => expect(h.sockets.length).toBe(1));
    h.latest().serverSends(HELLO(45_000));
    h.latest().serverSends(READY('sess-1', 'wss://resume-here.discord.gg'));

    // Force a reconnect: an ordinary close is `resume: true` per nextAction.
    h.latest().close(1006, 'dropped');
    await vi.waitFor(() => expect(h.sockets.length).toBe(2));
    h.sockets[1]!.serverSends(HELLO(45_000));

    expect(h.sockets[1]!.sent).toEqual([{ op: 6, d: { token: 'tok', session_id: 'sess-1', seq: 1 } }]);

    h.gw.stop();
    await run;
  });

  it('falls back to a fresh Identify when Invalid Session says the session cannot resume', async () => {
    const h = harness();
    const run = h.gw.run();
    await vi.waitFor(() => expect(h.sockets.length).toBe(1));
    h.latest().serverSends(HELLO(45_000));
    h.latest().serverSends(READY('sess-1'));

    h.latest().serverSends({ op: 9, d: false }); // not resumable
    await vi.waitFor(() => expect(h.sockets.length).toBe(2));
    h.sockets[1]!.serverSends(HELLO(45_000));

    // op 2 (Identify), not op 6 (Resume) — the cached session was discarded.
    expect((h.sockets[1]!.sent[0] as { op: number }).op).toBe(2);

    h.gw.stop();
    await run;
  });
});

describe('backoff — D4', () => {
  it('resets attempt after a session sees READY or RESUMED, so failures do not compound forever', async () => {
    // Without the reset, `attempt` only ever grows across the life of run():
    // five ordinary reconnects (a laptop sleeping, a Discord-side blip — each
    // individually harmless once the session came back healthy) leave every
    // later reconnect waiting the capped 30s+jitter forever, indistinguishable
    // from a genuinely repeating failure.
    const h = harness();
    const run = h.gw.run();
    await vi.waitFor(() => expect(h.sockets.length).toBe(1));
    h.latest().serverSends(HELLO(45_000));
    h.latest().serverSends(READY('sess-1'));
    h.latest().close(1006, 'dropped'); // first reconnect: attempt 0 -> 1, backoff base 2000ms

    await vi.waitFor(() => expect(h.sleeps.length).toBe(1));
    await vi.waitFor(() => expect(h.sockets.length).toBe(2));
    h.sockets[1]!.serverSends(HELLO(45_000));
    h.sockets[1]!.serverSends({ op: 0, s: 2, t: 'RESUMED' }); // this session is healthy too

    h.sockets[1]!.close(1006, 'dropped again'); // second reconnect
    await vi.waitFor(() => expect(h.sleeps.length).toBe(2));

    // attempt=1 backoff is base 2000 + jitter [0,1000) = [2000,3000).
    // attempt=2 (unreset) is base 4000 + jitter = [4000,5000). The two ranges
    // never overlap, so this line alone tells the two behaviours apart.
    expect(h.sleeps[1]).toBeLessThan(4000);

    h.gw.stop();
    await run;
  });
});

describe('dispatch routing', () => {
  it('hands ordinary dispatch events to onDispatch with the sequence, and keeps READY/RESUMED internal', async () => {
    const h = harness();
    const run = h.gw.run();
    await vi.waitFor(() => expect(h.sockets.length).toBe(1));
    h.latest().serverSends(HELLO(45_000));
    h.latest().serverSends(READY('sess-1'));
    h.latest().serverSends({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: { content: 'ciao' } });

    expect(h.dispatches).toEqual([{ event: 'MESSAGE_CREATE', data: { content: 'ciao' }, seq: 2 }]);
    expect(h.dispatches.some((d) => d.event === 'READY')).toBe(false);

    h.gw.stop();
    await run;
  });
});

describe('heartbeat', () => {
  it('answers Heartbeat ACK and keeps the connection alive across a full interval', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const run = h.gw.run();
      await vi.waitFor(() => expect(h.sockets.length).toBe(1), { timeout: 1000 });
      h.latest().serverSends(HELLO(1000));

      await vi.advanceTimersByTimeAsync(1000); // past the jittered first beat
      const heartbeats = h.latest().sent.filter((m) => (m as { op: number }).op === 1);
      expect(heartbeats.length).toBeGreaterThanOrEqual(1);

      h.latest().serverSends({ op: 11 }); // ACK
      await vi.advanceTimersByTimeAsync(1000);
      // Still one socket: an ACK'd heartbeat does not trigger a reconnect.
      expect(h.sockets.length).toBe(1);

      h.gw.stop();
      await run;
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes and reconnects when an ACK never arrives before the next beat — the zombied-connection case', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const run = h.gw.run();
      await vi.waitFor(() => expect(h.sockets.length).toBe(1), { timeout: 1000 });
      h.latest().serverSends(HELLO(1000));

      await vi.advanceTimersByTimeAsync(1000); // first beat sent, no ACK
      await vi.advanceTimersByTimeAsync(1000); // second beat due — still no ACK

      await vi.waitFor(() => expect(h.sockets.length).toBe(2), { timeout: 1000 });
      expect(h.logs.some((l) => l.includes('zombie'))).toBe(true);

      h.gw.stop();
      await run;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('fatal close codes', () => {
  it('gives up without retrying on a bad token (4004), and says so', async () => {
    const h = harness();
    const run = h.gw.run();
    await vi.waitFor(() => expect(h.sockets.length).toBe(1));
    h.latest().serverSends(HELLO(45_000));
    h.latest().close(4004, 'Authentication failed');

    await run; // resolves on its own — no stop() needed, this is the give-up path
    expect(h.sockets.length).toBe(1); // never reconnected
    expect(h.logs.some((l) => l.includes('Authentication failed') || l.includes('non riprovo'))).toBe(true);
  });
});

describe('stop()', () => {
  it('closes the socket with 1000 and run() resolves', async () => {
    const h = harness();
    const run = h.gw.run();
    await vi.waitFor(() => expect(h.sockets.length).toBe(1));
    h.latest().serverSends(HELLO(45_000));

    h.gw.stop();
    await run;

    expect(h.latest().closedWith).toEqual({ code: 1000, reason: 'stop' });
  });
});


/**
 * Il difetto trovato dal secondo giudice sulla #260, e la ragione per cui un
 * `onLog` non basta.
 *
 * `run()` **si risolve** sia quando si e' chiesto `stop()` sia quando rinuncia
 * su un 4004 (token revocato) o 4013/4014 (intent tolti): e' una scelta
 * dichiarata nell'intestazione di `run()`, e va bene per il tipo. Ma vuol dire
 * che il `.catch` di `connectSurfaces` non scatta mai su quel ramo, e la
 * superficie restava registrata «connessa» dalla stretta di mano d'avvio: un
 * Discord muto quanto si vuole, e `muffin doctor` che stampa `✓ superfici
 * discord — connesse` per tutta la vita del processo. Verde perche' non arriva
 * niente, sulla seconda superficie.
 */
describe('il socket dice se sta portando eventi, non solo cosa e successo', () => {
  it('READY e la prova che arrivano i messaggi', async () => {
    const h = harness();
    const run = h.gw.run();
    await vi.waitFor(() => expect(h.sockets.length).toBe(1));
    h.latest().serverSends(HELLO(45_000));
    h.latest().serverSends(READY('s1'));
    await vi.waitFor(() => expect(h.stati).toContainEqual({ viva: true }));

    h.gw.stop();
    await run;
  });

  it('un token revocato (4004) registra la caduta, non il silenzio', async () => {
    const h = harness();
    const run = h.gw.run();
    await vi.waitFor(() => expect(h.sockets.length).toBe(1));
    h.latest().serverSends(HELLO(45_000));
    h.latest().close(4004, 'Authentication failed');
    await run;

    const cadute = h.stati.filter((s) => !s.viva);
    expect(cadute.length).toBeGreaterThan(0);
    // Deve distinguersi da uno stop voluto: e' l'unica riga che lo dice a chi
    // guarda da fuori, visto che la promise si chiude bene in tutti e due i casi.
    expect(cadute.some((s) => s.causa?.includes('non riprovo') === true)).toBe(true);
    expect(h.stati.some((s) => s.viva)).toBe(false);
  });

  it('anche una chiusura da cui si riprova e una caduta: a distinguerla e la durata', async () => {
    const h = harness();
    const run = h.gw.run();
    await vi.waitFor(() => expect(h.sockets.length).toBe(1));
    h.latest().serverSends(HELLO(45_000));
    h.latest().serverSends(READY('s1'));
    await vi.waitFor(() => expect(h.stati).toContainEqual({ viva: true }));
    h.latest().close(4000, 'unknown error');
    await vi.waitFor(() => expect(h.stati.filter((s) => !s.viva).length).toBeGreaterThan(0));

    h.gw.stop();
    await run;
  });
});
