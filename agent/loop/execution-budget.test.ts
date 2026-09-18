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

  it('accumulates only active model time across leases', () => {
    vi.useFakeTimers();
    const budget = new ExecutionBudget({ modelCallDeadlineMs: 100, turnWallDeadlineMs: 500, activeModelBudgetMs: 100, firstActivityTimeoutMs: 10, stallTimeoutMs: 20 });

    const first = budget.beginModelCall();
    vi.advanceTimersByTime(40);
    first.release();
    expect(budget.activeModelMsUsed()).toBe(40);

    vi.advanceTimersByTime(100); // local/tool/backoff time is outside the lease
    const second = budget.beginModelCall();
    vi.advanceTimersByTime(35);
    second.release();
    const third = budget.beginModelCall();
    vi.advanceTimersByTime(20);
    third.release();

    expect(budget.activeModelMsUsed()).toBe(95);
    expect(third.telemetry().activeModelMsRemaining).toBe(5);
    budget.close();
  });

  it('refuses a provider invocation once the active budget is exhausted', () => {
    vi.useFakeTimers();
    const budget = new ExecutionBudget({ modelCallDeadlineMs: 100, turnWallDeadlineMs: 500, activeModelBudgetMs: 40 });
    const first = budget.beginModelCall();
    vi.advanceTimersByTime(40);
    first.release();

    const exhausted = budget.beginModelCall();
    expect(exhausted.signal.aborted).toBe(true);
    expect(exhausted.reason()).toBe('active_model_budget_exhausted');
    expect(exhausted.telemetry().effectiveDeadlineSource).toBe('active_model_budget_exhausted');
    exhausted.release();
    budget.close();
  });

  it('uses the active budget when it is smaller than the normal deadline', async () => {
    vi.useFakeTimers();
    const budget = new ExecutionBudget({ modelCallDeadlineMs: 90, turnWallDeadlineMs: 500, activeModelBudgetMs: 10 });
    const lease = budget.beginModelCall();
    const aborted = waitForAbort(lease.signal);
    await vi.advanceTimersByTimeAsync(10);
    expect(await aborted).toBe('active_model_budget_exhausted');
    expect(lease.telemetry().effectiveDeadlineMs).toBe(10);
    lease.release();
    budget.close();
  });

  it('counts stalled and user-stopped calls, while preserving their causes', () => {
    vi.useFakeTimers();
    const budget = new ExecutionBudget({ modelCallDeadlineMs: 100, turnWallDeadlineMs: 500, activeModelBudgetMs: 100, firstActivityTimeoutMs: 10, stallTimeoutMs: 20 });
    const stalled = budget.beginModelCall(undefined, undefined);
    vi.advanceTimersByTime(7);
    stalled.activity('thinking');
    vi.advanceTimersByTime(20);
    expect(stalled.reason()).toBe('model_stall');
    stalled.release();

    const user = new AbortController();
    const stopped = budget.beginModelCall(user.signal);
    vi.advanceTimersByTime(8);
    user.abort();
    expect(stopped.reason()).toBe('user_stop');
    stopped.release();

    expect(budget.activeModelMsUsed()).toBe(35);
    budget.close();
  });

  it('has deterministic precedence when active and wall deadlines race', async () => {
    vi.useFakeTimers();
    const activeWins = new ExecutionBudget({ modelCallDeadlineMs: 90, turnWallDeadlineMs: 100, activeModelBudgetMs: 20 });
    const activeLease = activeWins.beginModelCall();
    const activeAbort = waitForAbort(activeLease.signal);
    await vi.advanceTimersByTimeAsync(20);
    expect(await activeAbort).toBe('active_model_budget_exhausted');
    activeLease.release();
    activeWins.close();

    const tie = new ExecutionBudget({ modelCallDeadlineMs: 90, turnWallDeadlineMs: 20, activeModelBudgetMs: 20 });
    const tieLease = tie.beginModelCall();
    const tieAbort = waitForAbort(tieLease.signal);
    await vi.advanceTimersByTimeAsync(20);
    expect(await tieAbort).toBe('turn_deadline');
    tieLease.release();
    tie.close();
  });
});

describe('ExecutionBudget call-activity telemetry (#497)', () => {
  afterEach(() => vi.useRealTimers());

  it('reports first activity, ttft and last activity from the owned clocks', async () => {
    vi.useFakeTimers();
    const budget = new ExecutionBudget({ modelCallDeadlineMs: 1000, turnWallDeadlineMs: 5000, firstActivityTimeoutMs: 100, stallTimeoutMs: 100 });
    const lease = budget.beginModelCall();
    await vi.advanceTimersByTimeAsync(12);
    lease.activity('text');
    await vi.advanceTimersByTimeAsync(8);
    lease.activity('tool_call');
    const telemetry = lease.telemetry();
    expect(telemetry.firstActivityAt).toBe(telemetry.startedAt + 12);
    expect(telemetry.ttftMs).toBe(12);
    expect(telemetry.lastActivityAt).toBe(telemetry.startedAt + 20);
    lease.release();
    budget.close();
  });

  it('leaves first-activity fields absent when the provider never spoke', async () => {
    vi.useFakeTimers();
    const budget = new ExecutionBudget({ modelCallDeadlineMs: 1000, turnWallDeadlineMs: 5000, firstActivityTimeoutMs: 100, stallTimeoutMs: 100 });
    const lease = budget.beginModelCall();
    await vi.advanceTimersByTimeAsync(10);
    const telemetry = lease.telemetry();
    // Silence is silence: no first, no ttft — and no fake "last" defaulted
    // to the start. The watchdog's internal baseline is not evidence.
    expect(telemetry.firstActivityAt).toBeUndefined();
    expect(telemetry.ttftMs).toBeUndefined();
    expect(telemetry.lastActivityAt).toBeUndefined();
    lease.release();
    budget.close();
  });
});
