import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeReplCliWrite } from './repl.js';
import { cliSurface } from '../core/surface/cli.js';
import { SurfaceRegistry } from '../core/surface/registry.js';
import { DELIVERED, type Surface } from '../core/surface/types.js';

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
      handles: (c) => c === 'rotta',
      deliver: async () => {
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
      handles: (c) => c === id,
      deliver: async (_c, text) => {
        seen.push(`${id}:${text}`);
        return DELIVERED;
      },
    });
    const registry = new SurfaceRegistry([cliSurface(() => {}), fake('telegram'), fake('discord')]);

    await registry.deliver('discord', 'ciao');

    expect(seen).toEqual(['discord:ciao']);
  });
});
