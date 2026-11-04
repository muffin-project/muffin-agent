import { describe, expect, it } from 'vitest';
import { formatCapabilityGap } from './capability-status.js';

describe('capability status text', () => {
  it('reports a disabled capability and its actionable remedy', () => {
    expect(formatCapabilityGap({
      capability: 'web_search',
      kind: 'disabled',
      reason: 'search is disabled',
      remedy: 'enable search in the owner configuration',
    })).toBe(
      'web_search spento: search is disabled — enable search in the owner configuration',
    );
  });

  it('does not invent a remedy where none is known', () => {
    expect(formatCapabilityGap({
      capability: 'sys.shell',
      kind: 'disabled',
      reason: 'sandbox is unavailable',
      remedy: null,
    })).toBe('sys.shell spento: sandbox is unavailable');
  });

  it('can still format a historical truncation diagnostic without creating one', () => {
    expect(formatCapabilityGap({
      capability: 'legacy_tool',
      kind: 'truncated',
      reason: 'historical record',
      remedy: null,
    })).toBe('legacy_tool tagliato: historical record');
  });
});
