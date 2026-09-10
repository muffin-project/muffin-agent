import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionBudget } from './execution-budget.js';

async function waitForAbort(signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) return signal.reason;
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(signal.reason), { once: true }));
}

describe('ExecutionBudget activity watchdogs', () => {
  afterEach(() => vi.useRealTimers());

  it('aborts a completely silent provider on first activity timeout', async () => {
    vi.useFakeTimers();
    const budget = new ExecutionBudget({ modelCallDeadlineMs: 100, turnWallDeadlineMs: 200, firstActivityTimeoutMs: 10, stallTimeoutMs: 20 });
    const lease = budget.beginModelCall();
    const aborted = waitForAbort(lease.signal);
    await vi.advanceTimersByTimeAsync(10);
    expect(await aborted).toBe('model_first_activity_timeout');
    lease.release();
    budget.close();
  });

  it('aborts after activity stops on the stall timeout', async () => {
    vi.useFakeTimers();
    const budget = new ExecutionBudget({ modelCallDeadlineMs: 100, turnWallDeadlineMs: 200, firstActivityTimeoutMs: 10, stallTimeoutMs: 20 });
    const lease = budget.beginModelCall();
    lease.activity('thinking');
    const aborted = waitForAbort(lease.signal);
    await vi.advanceTimersByTimeAsync(20);
    expect(await aborted).toBe('model_stall');
    lease.release();
    budget.close();
  });

  it('does not stall while semantic activity keeps arriving', async () => {
    vi.useFakeTimers();
    const budget = new ExecutionBudget({ modelCallDeadlineMs: 100, turnWallDeadlineMs: 200, firstActivityTimeoutMs: 10, stallTimeoutMs: 20 });
    const lease = budget.beginModelCall();
    lease.activity('text');
    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(15);
      lease.activity(i % 2 === 0 ? 'thinking' : 'tool_call');
    }
    expect(lease.signal.aborted).toBe(false);
    lease.release();
    budget.close();
  });

  it('keeps the hard model deadline above the stall watchdog', async () => {
    vi.useFakeTimers();
    const budget = new ExecutionBudget({ modelCallDeadlineMs: 35, turnWallDeadlineMs: 200, firstActivityTimeoutMs: 10, stallTimeoutMs: 50 });
    const lease = budget.beginModelCall();
    lease.activity('text');
    const aborted = waitForAbort(lease.signal);
    await vi.advanceTimersByTimeAsync(35);
    expect(await aborted).toBe('model_deadline');
    lease.release();
    budget.close();
  });

  it('preserves user stop and turn deadline causes', async () => {
    vi.useFakeTimers();
    const user = new AbortController();
    const userBudget = new ExecutionBudget({ modelCallDeadlineMs: 100, turnWallDeadlineMs: 200, firstActivityTimeoutMs: 50, stallTimeoutMs: 50 });
    const userLease = userBudget.beginModelCall(user.signal);
    const stopped = waitForAbort(userLease.signal);
    user.abort();
    await stopped;
    expect(userLease.reason()).toBe('user_stop');
    userLease.release();
    userBudget.close();

    const turnBudget = new ExecutionBudget({ modelCallDeadlineMs: 100, turnWallDeadlineMs: 20, firstActivityTimeoutMs: 50, stallTimeoutMs: 50 });
    const turnLease = turnBudget.beginModelCall();
    const deadline = waitForAbort(turnLease.signal);
    await vi.advanceTimersByTimeAsync(20);
    await deadline;
    expect(turnLease.reason()).toBe('turn_deadline');
    turnLease.release();
    turnBudget.close();
  });

  it('cleans watchdogs so a successful attempt cannot abort a later operation', async () => {
    vi.useFakeTimers();
    const budget = new ExecutionBudget({ modelCallDeadlineMs: 10, turnWallDeadlineMs: 100, firstActivityTimeoutMs: 5, stallTimeoutMs: 5 });
    const lease = budget.beginModelCall();
    lease.release();
    await vi.advanceTimersByTimeAsync(50);
    expect(lease.signal.aborted).toBe(false);
    budget.close();
  });
});
