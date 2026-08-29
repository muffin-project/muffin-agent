import { describe, expect, it } from 'vitest';
import { ToolLoopGuardrail } from './tool-loop.js';

const observe = (
  guard: ToolLoopGuardrail,
  patch: Partial<Parameters<ToolLoopGuardrail['observe']>[0]> = {},
) =>
  guard.observe({
    turnId: 'turn-1',
    tool: 'fs_read',
    args: { path: 'a.md' },
    result: 'same bytes',
    isError: false,
    idempotentRead: true,
    ...patch,
  });

describe('ToolLoopGuardrail', () => {
  it('warns on the second identical failing call, not the first', () => {
    const guard = new ToolLoopGuardrail();
    expect(observe(guard, { isError: true, result: 'ENOENT' })).toBeNull();
    const warning = observe(guard, { isError: true, result: 'ENOENT' });
    expect(warning?.kind).toBe('exact_failure');
    expect(warning?.count).toBe(2);
    expect(warning?.message).toContain('Non ripetere');
  });

  it('detects the same tool failing with changing arguments', () => {
    const guard = new ToolLoopGuardrail();
    expect(observe(guard, { isError: true, args: { path: 'a' }, result: 'no' })).toBeNull();
    expect(observe(guard, { isError: true, args: { path: 'b' }, result: 'no' })).toBeNull();
    const warning = observe(guard, { isError: true, args: { path: 'c' }, result: 'no' });
    expect(warning?.kind).toBe('same_tool_failure');
    expect(warning?.count).toBe(3);
  });

  it('detects an idempotent read returning the same result despite changing args', () => {
    const guard = new ToolLoopGuardrail();
    expect(observe(guard, { args: { query: 'first' } })).toBeNull();
    const warning = observe(guard, { args: { query: 'second' } });
    expect(warning?.kind).toBe('idempotent_no_progress');
    expect(warning?.count).toBe(2);
  });

  it('does not classify successful effects as no-progress merely because their receipt is identical', () => {
    const guard = new ToolLoopGuardrail();
    expect(
      observe(guard, {
        tool: 'outward_send',
        args: { to: 'a' },
        result: 'sent',
        idempotentRead: false,
      }),
    ).toBeNull();
    expect(
      observe(guard, {
        tool: 'outward_send',
        args: { to: 'b' },
        result: 'sent',
        idempotentRead: false,
      }),
    ).toBeNull();
  });

  it('resets a failure run after a productive success', () => {
    const guard = new ToolLoopGuardrail();
    expect(observe(guard, { isError: true, result: 'failed' })).toBeNull();
    expect(observe(guard, { isError: false, result: 'worked' })).toBeNull();
    expect(observe(guard, { isError: true, result: 'failed' })).toBeNull();
  });

  it('keeps state isolated by durable turn id', () => {
    const guard = new ToolLoopGuardrail();
    expect(observe(guard, { turnId: 'a', isError: true, result: 'x' })).toBeNull();
    expect(observe(guard, { turnId: 'b', isError: true, result: 'x' })).toBeNull();
    expect(observe(guard, { turnId: 'a', isError: true, result: 'x' })?.kind).toBe('exact_failure');
  });

  it('bounds state even before universal turn-end cleanup is wired', () => {
    const guard = new ToolLoopGuardrail({ maxTrackedTurns: 2 });
    observe(guard, { turnId: 'a' });
    observe(guard, { turnId: 'b' });
    observe(guard, { turnId: 'c' });
    expect(guard.trackedTurns).toBe(2);

    // a was the least-recently-used state and therefore starts fresh again.
    expect(observe(guard, { turnId: 'a', isError: true, result: 'x' })).toBeNull();
  });

  it('can forget terminal turn state explicitly when a lifecycle seam owns cleanup', () => {
    const guard = new ToolLoopGuardrail();
    observe(guard, { turnId: 'a' });
    expect(guard.trackedTurns).toBe(1);
    guard.forget('a');
    expect(guard.trackedTurns).toBe(0);
  });
});
