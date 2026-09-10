import { describe, expect, it } from 'vitest';
import { resolveReasoningPolicy, type ReasoningCapabilities, type ReasoningRequest } from './reasoning.js';

const capable: ReasoningCapabilities = {
  support: 'supported',
  canDisable: true,
  supportedEfforts: ['xhigh', 'medium', 'low'],
  supportsMaxTokens: true,
  mandatory: false,
};

const resolve = (request: ReasoningRequest | undefined, capabilities = capable) =>
  resolveReasoningPolicy(request, capabilities, 'static-snapshot');

describe('resolveReasoningPolicy', () => {
  it('omits adaptive/default intent without inventing a wire parameter', () => {
    expect(resolve({ mode: 'adaptive' })).toMatchObject({ status: 'applied', effective: { mode: 'adaptive' } });
    expect(resolve(undefined)).toEqual({ status: 'omitted', capabilitySource: 'static-snapshot' });
  });

  it('applies off only when the model can disable reasoning', () => {
    expect(resolve({ mode: 'off' })).toMatchObject({ status: 'applied', effective: { mode: 'off' } });
    expect(resolve({ mode: 'off' }, { ...capable, canDisable: false })).toMatchObject({ status: 'unsupported' });
    expect(resolve({ mode: 'off' }, { ...capable, mandatory: true })).toMatchObject({ status: 'unsupported' });
  });

  it('does not silently convert unsupported effort or exact token budget', () => {
    expect(resolve({ mode: 'on', effort: 'high' })).toMatchObject({ status: 'unsupported' });
    expect(resolve({ mode: 'on', maxTokens: 2048 }, { ...capable, supportsMaxTokens: false })).toMatchObject({ status: 'unsupported' });
  });

  it('preserves supported effort and exact token budget', () => {
    expect(resolve({ mode: 'on', effort: 'low' })).toMatchObject({ status: 'applied', effective: { mode: 'on', effort: 'low' } });
    expect(resolve({ mode: 'on', maxTokens: 2048 })).toMatchObject({ status: 'applied', effective: { mode: 'on', maxTokens: 2048 } });
  });

  it('treats an endpoint without reasoning as an explicit omission for off/default', () => {
  const noReasoning = { support: 'unsupported' as const, canDisable: true, supportsMaxTokens: false, mandatory: false };
    expect(resolve({ mode: 'off' }, noReasoning)).toMatchObject({ status: 'omitted', reason: expect.stringContaining('no reasoning') });
    expect(resolve({ mode: 'on' }, noReasoning)).toMatchObject({ status: 'omitted' });
  });
});

it('keeps unknown capability distinct from unsupported', () => {
  const unknown = { ...capable, support: 'unknown' as const, supportsMaxTokens: false };

  expect(resolveReasoningPolicy({ mode: 'on' }, unknown, 'unknown')).toMatchObject({ status: 'omitted', reason: expect.stringContaining('unknown') });
  expect(resolveReasoningPolicy({ mode: 'off' }, unknown, 'unknown')).toMatchObject({ status: 'unsupported', reason: expect.stringContaining('unknown') });
  expect(resolveReasoningPolicy({ mode: 'on', maxTokens: 1024 }, unknown, 'unknown')).toMatchObject({ status: 'unsupported', reason: expect.stringContaining('unknown') });
});
