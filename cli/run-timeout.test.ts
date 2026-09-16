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
        // #533: il cancel dice se qualcosa potrebbe essere partito (qui un
        // passaggio c'è stato) invece di «interrotto dopo Xs» e basta — vedi
        // `describeAbort`. L'id serve a controllare, non a riprovare.
        expect(r.err).toContain('annullato dopo 1 passaggi — potrebbe aver già eseguito qualcosa');
      } finally {
        await inst.cleanup();
      }
    },
    60_000,
  );
});
