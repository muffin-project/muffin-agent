import { describe, expect, it } from 'vitest';
import { jobOutcomeFromTurn } from './scheduler-run.js';
import type { TurnResult } from './loop.js';

const base: TurnResult = {
  text: '',
  iterations: 1,
  traceId: 't',
  turnId: 't',
  stopped: 'answered',
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
};

describe('jobOutcomeFromTurn', () => {
  it('an answered turn delivers its text as is', () => {
    expect(jobOutcomeFromTurn({ ...base, text: 'ecco il brief' })).toEqual({ stopped: 'answered', text: 'ecco il brief' });
  });

  it('a queued ASK is turned into a message the owner can act on', () => {
    const out = jobOutcomeFromTurn({
      ...base,
      stopped: 'ask',
      text: '',
      pending: { capability: 'outward.send', prompt: 'mando la mail a Marco?', resource: 'mail:marco' },
    });
    expect(out.stopped).toBe('ask');
    expect(out.text).toContain('In coda per te');
    expect(out.text).toContain('outward.send');
    expect(out.text).toContain('mail:marco');
    expect(out.text).toContain('mando la mail a Marco?');
  });

  it('an ASK without a resource still reads cleanly', () => {
    const out = jobOutcomeFromTurn({
      ...base,
      stopped: 'ask',
      text: '',
      pending: { capability: 'sys.shell', prompt: 'eseguo lo script?' },
    });
    expect(out.text).toContain('sys.shell');
    expect(out.text).not.toContain('undefined');
  });

  it('other terminal states pass through unchanged', () => {
    expect(jobOutcomeFromTurn({ ...base, stopped: 'error', text: 'qualcosa è rotto' })).toEqual({
      stopped: 'error',
      text: 'qualcosa è rotto',
    });
    expect(jobOutcomeFromTurn({ ...base, stopped: 'budget', text: 'cap raggiunto' }).stopped).toBe('budget');
  });
});
