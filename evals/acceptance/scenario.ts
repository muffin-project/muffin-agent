import { it } from 'vitest';
import { entry } from './manifest.js';

/**
 * Registers an M5-BIS row's acceptance scenario as a real vitest test, using
 * the manifest entry as the single source of truth for row, title and the
 * outcome it is expected to have.
 *
 * A `verde` scenario runs as a plain `it`: if it breaks, the suite goes red for
 * a real reason and stays that way until someone looks at it.
 *
 * An `atteso-rosso` scenario asserts the behaviour M5-BIS says is still
 * missing, and runs under `it.fails` — vitest's own primitive for exactly
 * this ("if the test fails, it is marked as passed"; verified against the
 * installed vitest 2.1.9 with a throwaway probe file before relying on it).
 * That is what makes it distinguishable from a real failure: a normal `it`
 * that breaks shows up red for a real reason, while an `it.fails` scenario
 * shows up red only the day someone fixes the underlying gap without touching
 * this file — which is the signal that it is time to promote it to `verde`
 * instead of leaving a stale "atteso-rosso" lying about what is covered.
 */
export function scenario(row: string, fn: () => Promise<void>, timeout?: number): void {
  const meta = entry(row);
  const runner = meta.expectation.kind === 'verde' ? it : it.fails;
  runner(meta.title, fn, timeout);
}
