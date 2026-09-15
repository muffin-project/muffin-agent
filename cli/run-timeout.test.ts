import { describe, expect, it } from 'vitest';
import { install } from '../evals/acceptance/harness.js';

describe('muffin run --timeout', () => {
  it(
    'aborts a turn that outlives the cap with exit 1, through the real binary',
    async () => {
      const inst = await install({ main: [{ text: 'troppo tardi', delayMs: 5_000 }] });
      try {
        const r = await inst.muffin(['run', '--timeout', '1', 'dimmi qualcosa']);
        expect(r.code).toBe(1);
        expect(r.err).toContain('interrotto dopo 1s');
      } finally {
        await inst.cleanup();
      }
    },
    60_000,
  );
});
