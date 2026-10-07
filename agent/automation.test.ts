import { describe, expect, it } from 'vitest';
import {
  dispatchRuntimeEvent,
  executeAction,
  type AutomationRule,
  type RuntimeEvent,
} from './automation.js';

const event: RuntimeEvent = {
  occurrenceId: 'occ-1',
  kind: 'message.received',
  source: 'test',
  observedAt: '2026-10-07T00:00:00.000Z',
  evidence: { text: 'buongiorno' },
};

describe('runtime automation waist', () => {
  it('uses the first deterministic matching rule instead of the fallback', async () => {
    let fallbackCalls = 0;
    const rules: AutomationRule<string>[] = [
      {
        id: 'morning',
        matches: (candidate) => candidate.evidence.text === 'buongiorno',
        action: () => ({ mode: 'deterministic', run: () => 'checked' }),
      },
    ];

    const result = await dispatchRuntimeEvent(event, rules, {
      mode: 'agent',
      run: () => {
        fallbackCalls++;
        return 'agent';
      },
    });

    expect(result).toBe('checked');
    expect(fallbackCalls).toBe(0);
  });

  it('falls back to the canonical action when no rule matches', async () => {
    const result = await dispatchRuntimeEvent(event, [], {
      mode: 'agent',
      run: () => 'agent',
    });
    expect(result).toBe('agent');
  });

  it('does not invoke the agent when deterministic-first emits no signal', async () => {
    let agentCalls = 0;
    const result = await executeAction({
      mode: 'deterministic_then_agent_on_signal',
      check: () => ({ signal: false }),
      noSignal: () => 'silent',
      runAgent: () => {
        agentCalls++;
        return 'agent';
      },
    });

    expect(result).toBe('silent');
    expect(agentCalls).toBe(0);
  });

  it('passes only the emitted evidence to the agent escalation', async () => {
    const result = await executeAction({
      mode: 'deterministic_then_agent_on_signal',
      check: () => ({ signal: true, evidence: { changed: true } }),
      noSignal: () => 'silent',
      runAgent: (evidence) => JSON.stringify(evidence),
    });

    expect(result).toBe('{"changed":true}');
  });
});
