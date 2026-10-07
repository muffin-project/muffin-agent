import { describe, expect, it } from 'vitest';
import type { StoredAutomationRule } from '../core/automation/rules.js';
import {
  compileStoredAutomationRule,
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

  it('compiles a durable rule without moving execution ownership into the store', async () => {
    const stored: StoredAutomationRule = {
      id: 'persisted-morning',
      tenant: 'host',
      eventKind: 'message.received',
      matcher: { type: 'evidence_equals', key: 'text', value: 'buongiorno' },
      action: { mode: 'deterministic', ref: 'test.checked' },
      origin: {
        principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
        surface: 'cli',
        turnId: 'turn-create',
        tier: 0,
      },
      enabled: true,
      version: 1,
      createdAt: '2026-10-07T00:00:00.000Z',
      updatedAt: '2026-10-07T00:00:00.000Z',
    };
    let resolvedRef: string | null = null;
    const rule = compileStoredAutomationRule(stored, (action) => ({
      mode: 'deterministic',
      run: () => {
        resolvedRef = action.ref;
        return 'persisted';
      },
    }));

    const result = await dispatchRuntimeEvent(event, [rule], {
      mode: 'agent',
      run: () => 'fallback',
    });

    expect(result).toBe('persisted');
    expect(resolvedRef).toBe('test.checked');
  });

  it('does not match a disabled persisted rule', async () => {
    const stored: StoredAutomationRule = {
      id: 'disabled',
      tenant: 'host',
      eventKind: 'message.received',
      matcher: { type: 'evidence_equals', key: 'text', value: 'buongiorno' },
      action: { mode: 'deterministic', ref: 'test.checked' },
      origin: {
        principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
        surface: 'cli',
        turnId: null,
        tier: 0,
      },
      enabled: false,
      version: 2,
      createdAt: '2026-10-07T00:00:00.000Z',
      updatedAt: '2026-10-07T00:01:00.000Z',
    };
    const rule = compileStoredAutomationRule(stored, () => ({
      mode: 'deterministic',
      run: () => 'should-not-run',
    }));

    const result = await dispatchRuntimeEvent(event, [rule], {
      mode: 'agent',
      run: () => 'fallback',
    });
    expect(result).toBe('fallback');
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
