import { describe, expect, it } from 'vitest';
import type { ChatCall, ChatResult, Provider } from '../../agent/providers/types.js';
import { judgeContradiction } from './judge.js';
import type { Fact } from './store.js';

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

class OneReply implements Provider {
  readonly kind = 'openai-compat' as const;
  constructor(private readonly text: string) {}
  async chat(_call: ChatCall): Promise<ChatResult> {
    return { text: this.text, toolCalls: [], stopReason: 'end', usage, model: 'test' };
  }
}

const existing: Fact = {
  id: 1,
  subjectId: 1,
  subjectName: 'owner',
  predicate: 'accountant',
  objectValue: 'Marco',
  objectId: null,
  objectName: null,
  validFrom: null,
  validTo: null,
  recordedAt: '2026-07-01T10:00:00.000Z',
  expiredAt: null,
  episodeId: 1,
  trustTier: 0,
  confidence: 0.9,
  origin: 'said',
  importance: 0,
  supersededBy: null,
  pinned: 0,
};

const input = {
  subject: 'owner',
  predicate: 'accountant',
  existing,
  incoming: { object: 'Lucia', validFrom: null },
  evidence: {
    existing: 'Marco è il mio commercialista.',
    incoming: 'Ho cambiato commercialista: ora è Lucia.',
  },
};

describe('contradiction judge — reasoning is explanation, not decision validity', () => {
  it('keeps a structurally valid verdict when reasoning exceeds the durable display budget', async () => {
    // Reproduces the real 2026-08-29 failure shape: the light model answered the
    // actual question, but a >600-char explanation made zod reject the whole
    // object and the caller safely-but-wrongly treated the judge as unavailable.
    const longReasoning = `cambio dichiarato. ${'dettaglio '.repeat(90)}`;
    expect(longReasoning.length).toBeGreaterThan(600);

    const outcome = await judgeContradiction(
      new OneReply(JSON.stringify({ reasoning: longReasoning, verdict: 'supersede', confidence: 0.95 })),
      'test-light',
      input,
    );

    expect(outcome.failure).toBeUndefined();
    expect(outcome.verdict).toBe('supersede');
    expect(outcome.confidence).toBe(0.95);
    expect(outcome.downgraded).toBe(false);
    expect(outcome.reasoning.length).toBeLessThanOrEqual(600);
    expect(outcome.reasoning.endsWith('…')).toBe(true);
  });

  it('does not make an invented verdict valid merely because it truncates the reasoning', async () => {
    const longReasoning = `spiegazione. ${'dettaglio '.repeat(90)}`;
    const outcome = await judgeContradiction(
      new OneReply(JSON.stringify({ reasoning: longReasoning, verdict: 'inventato', confidence: 0.95 })),
      'test-light',
      input,
    );

    expect(outcome.verdict).toBe('coexist');
    expect(outcome.confidence).toBe(0);
    expect(outcome.failure?.reason.kind).toBe('schema');
    if (outcome.failure?.reason.kind === 'schema') {
      expect(outcome.failure.reason.field).toBe('verdict');
    }
  });
});
