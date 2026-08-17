import { describe, expect, it } from 'vitest';
import { promoteMarker } from './manifest.js';
import { guardAttesoRosso } from './scenario.js';

/**
 * `guardAttesoRosso` is the mechanism that replaced plain `it.fails` (mandato
 * DAY-1 §4.9 / P39): an `atteso-rosso` scenario is only "correctly red" if it
 * throws for the reason the manifest declares, not for any reason at all.
 * These tests drive it directly with a fake `fn`, so they run in milliseconds
 * and do not need a live vitest suite underneath them — the same reason
 * `report.test.ts` drives `summarize`/`verdictFor` directly instead of
 * spawning the real acceptance suite.
 */
describe('guardAttesoRosso — the atteso-rosso failure signature', () => {
  it('resolves when fn throws an error matching the declared expectFailure regex', async () => {
    await expect(
      guardAttesoRosso(
        'X1',
        async () => {
          throw new Error('il registro non esiste ancora');
        },
        { kind: 'atteso-rosso', reason: 'nessun registro', closedBy: 'slice/fake', expectFailure: /registro non esiste/ },
      ),
    ).resolves.toBeUndefined();
  });

  it('resolves when fn throws and the declared expectFailure is a predicate that matches', async () => {
    await expect(
      guardAttesoRosso(
        'X1',
        async () => {
          throw new Error('boom');
        },
        {
          kind: 'atteso-rosso',
          reason: 'r',
          closedBy: 'c',
          expectFailure: (error) => error instanceof Error && error.message === 'boom',
        },
      ),
    ).resolves.toBeUndefined();
  });

  // The gap this closes: `it.fails` alone marked this "passed" too, which is
  // exactly how D10's stale reason (PR #28) went unnoticed — the scenario kept
  // throwing, just not for the reason M5-BIS.md still named.
  it('rejects, naming the declared reason, when fn throws for a DIFFERENT reason than declared', async () => {
    await expect(
      guardAttesoRosso(
        'X2',
        async () => {
          throw new Error('un crash del tutto scollegato');
        },
        { kind: 'atteso-rosso', reason: 'la ragione dichiarata nel manifest', closedBy: 'slice/fake', expectFailure: /registro non esiste/ },
      ),
    ).rejects.toThrow(/la ragione dichiarata nel manifest.*un crash del tutto scollegato/s);
  });

  it('rejects with the promote marker when fn does not throw at all', async () => {
    await expect(
      guardAttesoRosso(
        'X3',
        async () => {
          // no-op: the gap the manifest describes is gone
        },
        { kind: 'atteso-rosso', reason: 'r', closedBy: 'c', expectFailure: /never matches this branch/ },
      ),
    ).rejects.toThrow(new RegExp(promoteMarker('X3').replace(/[()]/g, '\\$&')));
  });
});
