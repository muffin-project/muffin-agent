import { describe, expect, it } from 'vitest';
import type { TurnResult } from '../agent/loop.js';
import { describeAbort } from './abort.js';

/**
 * #533 — un cancel dopo un possibile effetto esterno non diventa mai
 * «annullato, non è successo niente».
 */

function aborted(over: Partial<TurnResult> = {}): TurnResult {
  return {
    text: '',
    iterations: 0,
    traceId: 't',
    turnId: 'abcdef1234567890',
    stopped: 'aborted',
    taint: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ...over,
  };
}

describe('describeAbort', () => {
  it('prima di qualunque passaggio: niente è partito, e lo si può dire', () => {
    expect(describeAbort(aborted())).toContain('prima di iniziare');
  });

  it('dopo dei passaggi: potrebbe aver eseguito qualcosa, con l id per controllare', () => {
    const riga = describeAbort(aborted({ iterations: 3 }));
    expect(riga).toContain('potrebbe aver già eseguito qualcosa');
    expect(riga).toContain('abcdef123456');
  });

  it('spesa senza passaggi conta come lavoro fatto', () => {
    const riga = describeAbort(
      aborted({
        usage: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
    );
    expect(riga).toContain('potrebbe aver già eseguito qualcosa');
  });
});
