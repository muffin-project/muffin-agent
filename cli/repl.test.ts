import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeReplDeliver } from './repl.js';

/**
 * `makeReplDeliver`, in isolation from the interactive stdin loop.
 *
 * The bug this guards: a scheduled job for a remote channel (telegram, …) is
 * not wired yet (M4 connect), and `deliver` used to write one stderr line and
 * return normally. `core/scheduler/scheduler.ts` calls `markRan` right after
 * `deliver` either way — deliberately, so a failure never re-runs a job — but
 * it only reports the failure (`delivery_failed`, with its own handler and
 * test) when `deliver` throws. Returning normally meant a remote job's
 * schedule advanced and its anchor spent, forever, on a message that never
 * left the machine — with nothing beyond a line in the journal to show it.
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

describe('makeReplDeliver', () => {
  afterEach(() => vi.restoreAllMocks());

  it('delivers on the cli channel without throwing, and re-prompts', async () => {
    const { out } = capture();
    const rl = { prompt: vi.fn() };
    const deliver = makeReplDeliver(rl);

    await expect(deliver('cli', 'promemoria: chiama Marco')).resolves.toBeUndefined();
    expect(out.join('')).toContain('promemoria: chiama Marco');
    expect(rl.prompt).toHaveBeenCalledTimes(1);
  });

  it('throws for an unwired remote channel instead of reporting success', async () => {
    // This is the wiring the scheduler depends on: `delivery_failed` only
    // fires when `deliver` rejects. A `deliver` that logs and resolves is the
    // exact shape that let a remote job's schedule advance on a delivery that
    // never happened — verified failing before this fix (it resolved).
    const { err } = capture();
    const rl = { prompt: vi.fn() };
    const deliver = makeReplDeliver(rl);

    await expect(deliver('telegram', 'promemoria: chiama Marco')).rejects.toThrow(
      /telegram.*non è cablata/,
    );
    // The message is not lost: it is printed before the throw.
    expect(err.join('')).toContain('promemoria: chiama Marco');
  });

  it('still re-prompts after a failed delivery, so the REPL does not look hung', async () => {
    capture();
    const rl = { prompt: vi.fn() };
    const deliver = makeReplDeliver(rl);

    await expect(deliver('telegram', 'x')).rejects.toThrow();
    expect(rl.prompt).toHaveBeenCalledTimes(1);
  });
});
