import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInit } from './init.js';
import { makeReplCliWrite, runRepl } from './repl.js';
import { cliSurface } from '../core/surface/cli.js';
import { SurfaceRegistry } from '../core/surface/registry.js';
import { DELIVERED, type Surface } from '../core/surface/types.js';
import { startFakeProvider } from '../evals/acceptance/provider.js';

/**
 * The REPL's delivery path, in isolation from the interactive stdin loop.
 *
 * The bug this file has always guarded: a scheduled job for a remote channel
 * advanced its schedule and spent its anchor on a message that never left the
 * machine. What changed is *where* the guard lives. It used to be
 * `makeReplDeliver`, whose remote branch had to remember to **throw** — the
 * only way a `Promise<void>` could say "not delivered", and the thing
 * `cli/gateway.ts`'s copy forgot to do. The `Deliver` contract now returns an
 * outcome, so the guard is a value the scheduler reads rather than an exception
 * three implementations each had to remember to raise.
 *
 * So the REPL no longer owns a `Deliver` at all. It owns a writer for the CLI
 * surface, and the question "is this channel real" belongs to the registry —
 * which is what these tests now drive.
 */
function capture(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return { out, err };
}

describe("the REPL's cli surface", () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes the message and gives the prompt back', async () => {
    const { out } = capture();
    const rl = { prompt: vi.fn() };
    const registry = new SurfaceRegistry([cliSurface(makeReplCliWrite(rl))]);

    await expect(registry.deliver('cli', 'promemoria: chiama Marco')).resolves.toEqual({ delivered: true });
    expect(out.join('')).toContain('promemoria: chiama Marco');
    expect(rl.prompt).toHaveBeenCalledTimes(1);
  });

  it('re-prompts even if writing throws, so the REPL never looks hung', async () => {
    const rl = { prompt: vi.fn() };
    vi.spyOn(process.stdout, 'write').mockImplementation(() => {
      throw new Error('EPIPE');
    });
    const write = makeReplCliWrite(rl);

    expect(() => write('x')).toThrow(/EPIPE/);
    expect(rl.prompt).toHaveBeenCalledTimes(1);
  });
});

describe('a channel nothing serves', () => {
  afterEach(() => vi.restoreAllMocks());

  it('comes back as a refusal carrying the reason, never as success', async () => {
    // The whole defect, in one assertion. Before the contract change this
    // returned `undefined` from an implementation that had written a line to
    // stderr — indistinguishable, to `Scheduler`, from a message that arrived.
    capture();
    const registry = new SurfaceRegistry([cliSurface(() => {})]);

    const outcome = await registry.deliver('telegram', 'promemoria: chiama Marco');

    expect(outcome.delivered).toBe(false);
    expect(outcome.delivered === false && outcome.why).toMatch(/nessuna superficie serve "telegram"/);
  });

  it('names what is connected, so the owner knows which repair to make', async () => {
    // "consegna fallita" with no list is a line the owner cannot act on: they
    // cannot tell `muffin surface enable telegram` from a dead network.
    capture();
    const registry = new SurfaceRegistry([cliSurface(() => {})]);
    const outcome = await registry.deliver('discord', 'x');
    expect(outcome.delivered === false && outcome.why).toContain('connesse: cli');
  });

  it('turns a surface that throws into a refusal instead of letting it escape', async () => {
    // An implementation that breaks the contract must still not be able to make
    // a failed delivery arrive at the scheduler as an exception in a floating
    // promise — that shape took the gateway down once already.
    const broken: Surface = {
      id: 'rotta',
      limits: { maxMessageChars: 10, maxUploadBytes: 0, maxDownloadBytes: 0 },
      streaming: { transport: 'off' },
      handles: (c) => c === 'rotta',
      deliver: async () => {
        throw new Error('socket chiuso');
      },
      deliverFile: async () => {
        throw new Error('socket chiuso');
      },
    };
    const registry = new SurfaceRegistry([broken]);

    const outcome = await registry.deliver('rotta', 'x');

    expect(outcome).toEqual({
      delivered: false,
      why: expect.stringContaining('socket chiuso') as unknown as string,
    });
  });

  it('routes to the first surface that claims the channel', async () => {
    const seen: string[] = [];
    const fake = (id: string): Surface => ({
      id,
      limits: { maxMessageChars: 100, maxUploadBytes: 0, maxDownloadBytes: 0 },
      streaming: { transport: 'off' },
      handles: (c) => c === id,
      deliver: async (_c, text) => {
        seen.push(`${id}:${text}`);
        return DELIVERED;
      },
      deliverFile: async () => DELIVERED,
    });
    const registry = new SurfaceRegistry([cliSurface(() => {}), fake('telegram'), fake('discord')]);

    await registry.deliver('discord', 'ciao');

    expect(seen).toEqual(['discord:ciao']);
  });
});

/**
 * The real wiring, B11 — through `buildRuntime` and a fake SSE HTTP server,
 * not a substituted `Provider` object. PRACTICES §5: this is the test that
 * fails without the wiring, and a hand-rolled `Provider.chatStream` fake
 * would not exercise `agent/providers/openai-compat.ts`'s own SSE parsing at
 * all — the seam this suite exists to prove is `runRepl` → `runTurn` → the
 * real adapter → a real (if local) socket, same shape
 * `evals/acceptance/provider.ts`'s own docstring insists on for the
 * acceptance suite, one layer down from a spawned binary.
 */
describe('the REPL streams the final answer while it forms (B11)', () => {
  afterEach(() => vi.restoreAllMocks());

  /** A fresh home pointed at `provider`, and nothing else configured. */
  function homeAgainst(baseUrl: string): string {
    const home = mkdtempSync(join(tmpdir(), 'muffin-repl-stream-'));
    runInit({ home, provider: 'openai-compat', baseUrl, apiKey: 'sk-repl-stream-fake' });
    return home;
  }

  /** Feeds one line, then closes — the readline loop's own "closed" catch is what ends `runRepl`. */
  function stdinWith(line: string): PassThrough {
    const stdin = new PassThrough();
    stdin.write(`${line}\n`);
    stdin.end();
    return stdin;
  }

  it('writes the answer as it forms, and the finished text is byte-identical to a non-streamed turn', async () => {
    const provider = await startFakeProvider({ main: [{ text: 'ciao dal muffin finto' }] });
    try {
      const home = homeAgainst(provider.baseUrl);
      const written: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        written.push(String(chunk));
        return true;
      });

      const code = await runRepl(home, { stream: true, stdin: stdinWith('ciao') });

      expect(code).toBe(0);
      // The wire really did carry more than one delta — this is `wordChunks`'
      // own split (`evals/acceptance/provider.ts`), and each one arrived as
      // its own `process.stdout.write` call, not pre-joined upstream.
      expect(written).toContain('ciao ');
      expect(written).toContain('dal ');
      expect(written).toContain('muffin ');
      // Exactly once: a turn that streamed must not *also* print the
      // finished text at the end — that would be the same answer twice.
      const occurrences = written.join('').split('ciao dal muffin finto').length - 1;
      expect(occurrences).toBe(1);
    } finally {
      await provider.close();
    }
  });

  it('does not stream with --no-stream (opts.stream: false), and still prints the whole answer once', async () => {
    const provider = await startFakeProvider({ main: [{ text: 'risposta intera, non a pezzi' }] });
    try {
      const home = homeAgainst(provider.baseUrl);
      const written: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        written.push(String(chunk));
        return true;
      });

      const code = await runRepl(home, { stream: false, stdin: stdinWith('ciao') });

      expect(code).toBe(0);
      // The mutation this guards against: delete `stream: Boolean(input.onDelta
      // && …)` in the loop, or drop the `opts.stream` check in the REPL, and
      // this turns red because the sink is attached regardless — the request
      // the fake server actually received is the ground truth, not a mock.
      expect(provider.main()[0]?.transcript).toBeDefined();
      expect(written.some((w) => w === 'risposta ')).toBe(false);
      expect(written.join('')).toContain('risposta intera, non a pezzi');
    } finally {
      await provider.close();
    }
  });
});
