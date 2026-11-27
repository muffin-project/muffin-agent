import { describe, expect, it } from 'vitest';
import type { CapabilityDecl, CapabilityId, Decision } from '../../core/policy/types.js';
import { searchCapability } from '../tools/search.js';
import { WORK_MESSAGE_TOOL_NAME } from '../tools/work-message.js';
import { isParallelReadAllow, PARALLEL_READ_CONCURRENCY } from './parallel-reads.js';

const allow: Decision = { effect: 'allow' };
const ask: Decision = { effect: 'ask', ask: { audience: 'owner', prompt: 'ok?' } };

function decl(over: Partial<CapabilityDecl> = {}): CapabilityDecl {
  return { ...searchCapability, ...over };
}

describe('isParallelReadAllow', () => {
  it('accepts already-allowed rerunnable egress reads such as web_search', () => {
    expect(
      isParallelReadAllow({ name: 'web_search', decl: searchCapability, decision: allow }),
    ).toBe(true);
    expect(
      isParallelReadAllow({
        name: 'http_get',
        decl: decl({ id: 'sys.http.get' as CapabilityId, resourceKind: 'url' }),
        decision: allow,
      }),
    ).toBe(true);
    expect(
      isParallelReadAllow({
        name: 'memory_search',
        decl: decl({ id: 'sys.memory.search' as CapabilityId, effect: 'context', risk: 'low' }),
        decision: allow,
      }),
    ).toBe(true);
  });

  it('rejects ask, draft, deny, missing decls, and non-rerunnable writes', () => {
    expect(isParallelReadAllow({ name: 'web_search', decl: searchCapability, decision: ask })).toBe(
      false,
    );
    expect(
      isParallelReadAllow({
        name: 'web_search',
        decl: searchCapability,
        decision: { effect: 'deny', code: 'taint_exceeded' },
      }),
    ).toBe(false);
    expect(isParallelReadAllow({ name: 'web_search', decl: undefined, decision: allow })).toBe(
      false,
    );
    expect(
      isParallelReadAllow({
        name: 'shell_run',
        decl: decl({ effect: 'host', rerunnable: false, risk: 'high' }),
        decision: allow,
      }),
    ).toBe(false);
    expect(
      isParallelReadAllow({
        name: 'fs_write',
        decl: decl({ effect: 'host', rerunnable: true, risk: 'medium' }),
        decision: allow,
      }),
    ).toBe(false);
  });

  it('keeps work_message and mutating context tools sequential even when allowed', () => {
    const context = decl({ effect: 'context', rerunnable: true, risk: 'low' });
    expect(
      isParallelReadAllow({ name: WORK_MESSAGE_TOOL_NAME, decl: context, decision: allow }),
    ).toBe(false);
    for (const name of ['todo', 'wait', 'capability_search', 'schedule', 'schedule_recurring']) {
      expect(isParallelReadAllow({ name, decl: context, decision: allow })).toBe(false);
    }
    expect(PARALLEL_READ_CONCURRENCY).toBe(4);
  });
});
