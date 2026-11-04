import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionBudget } from './execution-budget.js';

async function waitForAbort(signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) return signal.reason;
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(signal.reason), { once: true }),
  );
}

describe('ExecutionBudget activity watchdogs', () => {
  afterEach(() => vi.useRealTimers());

  it('leaves a provider that never spoke to the hard model deadline', async () => {
    vi.useFakeTimers();
    const budget = new ExecutionBudget({
      modelCallDeadlineMs: 80,
      turnWallDeadlineMs: 200,
      stallTimeoutMs: 10,
    });
    const lease = budget.beginModelCall();
    const aborted = waitForAbort(lease.signal);
    // Well past the stall window: silence before the first activity is not
    // a stall — that reading belongs to the model deadline.
    await vi.advanceTimersByTimeAsync(10);
    expect(lease.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(70);
    expect(await aborted).toBe('model_deadline');
    lease.release();
    budget.close();
  });

  it('aborts after activity stops on the stall timeout', async () => {
    vi.useFakeTimers();
    const budget = new ExecutionBudget({
      modelCallDeadlineMs: 100,
      turnWallDeadlineMs: 200,
      stallTimeoutMs: 20,
    });
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
    const budget = new ExecutionBudget({
      modelCallDeadlineMs: 100,
      turnWallDeadlineMs: 200,
      stallTimeoutMs: 20,
    });
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
    const budget = new ExecutionBudget({
      modelCallDeadlineMs: 35,
      turnWallDeadlineMs: 200,
      stallTimeoutMs: 50,
    });
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
    const userBudget = new ExecutionBudget({
      modelCallDeadlineMs: 100,
      turnWallDeadlineMs: 200,
      stallTimeoutMs: 50,
    });
    const userLease = userBudget.beginModelCall(user.signal);
    const stopped = waitForAbort(userLease.signal);
    user.abort();
    await stopped;
    expect(userLease.reason()).toBe('user_stop');
    userLease.release();
    userBudget.close();

    const turnBudget = new ExecutionBudget({
      modelCallDeadlineMs: 100,
      turnWallDeadlineMs: 20,
      stallTimeoutMs: 50,
    });
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
    const budget = new ExecutionBudget({
      modelCallDeadlineMs: 10,
      turnWallDeadlineMs: 100,
      stallTimeoutMs: 5,
    });
    const lease = budget.beginModelCall();
    lease.release();
    await vi.advanceTimersByTimeAsync(50);
    expect(lease.signal.aborted).toBe(false);
    budget.close();
  });

  it('accumulates only active model time across leases', () => {
    vi.useFakeTimers();
    const budget = new ExecutionBudget({
      modelCallDeadlineMs: 100,
      turnWallDeadlineMs: 500,
      activeModelBudgetMs: 100,
      stallTimeoutMs: 20,
    });

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
    const budget = new ExecutionBudget({
      modelCallDeadlineMs: 100,
      turnWallDeadlineMs: 500,
      activeModelBudgetMs: 40,
    });
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
    const budget = new ExecutionBudget({
      modelCallDeadlineMs: 90,
      turnWallDeadlineMs: 500,
      activeModelBudgetMs: 10,
    });
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
    const budget = new ExecutionBudget({
      modelCallDeadlineMs: 100,
      turnWallDeadlineMs: 500,
      activeModelBudgetMs: 100,
      stallTimeoutMs: 20,
    });
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
    const activeWins = new ExecutionBudget({
      modelCallDeadlineMs: 90,
      turnWallDeadlineMs: 100,
      activeModelBudgetMs: 20,
    });
    const activeLease = activeWins.beginModelCall();
    const activeAbort = waitForAbort(activeLease.signal);
    await vi.advanceTimersByTimeAsync(20);
    expect(await activeAbort).toBe('active_model_budget_exhausted');
    activeLease.release();
    activeWins.close();

    const tie = new ExecutionBudget({
      modelCallDeadlineMs: 90,
      turnWallDeadlineMs: 20,
      activeModelBudgetMs: 20,
    });
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
    const budget = new ExecutionBudget({
      modelCallDeadlineMs: 1000,
      turnWallDeadlineMs: 5000,
      stallTimeoutMs: 100,
    });
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
    const budget = new ExecutionBudget({
      modelCallDeadlineMs: 1000,
      turnWallDeadlineMs: 5000,
      stallTimeoutMs: 100,
    });
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

describe('ExecutionBudget without aggregate time limits', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps healthy model requests and tool gaps alive beyond twenty minutes', () => {
    vi.useFakeTimers();
    const accounted: number[] = [];
    const budget = new ExecutionBudget(
      {
        modelCallDeadlineMs: 120_000,
        turnWallDeadlineMs: null,
        activeModelBudgetMs: null,
        stallTimeoutMs: 25_000,
      },
      Date.now,
      { initialActiveModelMs: 240_000, onActiveModelMs: (spent) => accounted.push(spent) },
    );
    expect(vi.getTimerCount()).toBe(0); // No aggregate timer, including a coerced null timer.
    for (let request = 0; request < 12; request += 1) {
      const lease = budget.beginModelCall();
      expect(lease.signal.aborted).toBe(false);
      expect(lease.telemetry()).toMatchObject({
        normalDeadlineMs: 120_000,
        effectiveDeadlineMs: 120_000,
        effectiveDeadlineSource: 'model_deadline',
      });
      expect(lease.telemetry().activeModelBudgetMs).toBeUndefined();
      expect(lease.telemetry().activeModelMsRemaining).toBeUndefined();
      for (let activity = 0; activity < 5; activity += 1) {
        vi.advanceTimersByTime(20_000);
        lease.activity('text');
      }
      expect(lease.signal.aborted).toBe(false);
      lease.release();
      lease.release(); // Releasing twice cannot double-charge active time.
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(10_000); // Tool work outside the model lease.
      expect(budget.expired()).toBe(false);
    }
    expect(Date.now() - budget.startedAt).toBe(1_320_000);
    expect(budget.activeModelMsUsed()).toBe(1_440_000);
    expect(accounted).toHaveLength(12);
    expect(accounted.at(-1)).toBe(1_440_000);
    expect(budget.activeModelMsRemaining()).toBeUndefined();
    budget.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disables each aggregate bound independently while preserving the other', () => {
    vi.useFakeTimers();
    const activeOnly = new ExecutionBudget({
      modelCallDeadlineMs: 100,
      turnWallDeadlineMs: null,
      activeModelBudgetMs: 20,
    });
    const activeLease = activeOnly.beginModelCall();
    vi.advanceTimersByTime(20);
    expect(activeLease.reason()).toBe('active_model_budget_exhausted');
    activeLease.release();
    activeOnly.close();

    const wallOnly = new ExecutionBudget({
      modelCallDeadlineMs: 100,
      turnWallDeadlineMs: 20,
      activeModelBudgetMs: null,
    });
    const wallLease = wallOnly.beginModelCall();
    vi.advanceTimersByTime(20);
    expect(wallLease.reason()).toBe('turn_deadline');
    wallLease.release();
    wallOnly.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains the per-call deadline when aggregate limits are disabled', () => {
    vi.useFakeTimers();
    const budget = new ExecutionBudget({
      modelCallDeadlineMs: 100,
      turnWallDeadlineMs: null,
      activeModelBudgetMs: null,
    });
    const lease = budget.beginModelCall();
    vi.advanceTimersByTime(99);
    expect(lease.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(lease.reason()).toBe('model_deadline');
    expect(budget.expired()).toBe(false);
    lease.release();
    budget.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains stalls after first activity and progress heartbeats without aggregate limits', () => {
    vi.useFakeTimers();
    const progress = vi.fn();
    const budget = new ExecutionBudget({
      modelCallDeadlineMs: 100,
      turnWallDeadlineMs: null,
      activeModelBudgetMs: null,
      stallTimeoutMs: 20,
      heartbeatIntervalMs: 5,
    });
    const lease = budget.beginModelCall(undefined, progress);
    vi.advanceTimersByTime(30);
    expect(lease.signal.aborted).toBe(false); // First activity still belongs to the model deadline.
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'waiting_for_model', elapsedMs: 30 }),
    );
    lease.activity('thinking');
    vi.advanceTimersByTime(20);
    expect(lease.reason()).toBe('model_stall');
    expect(budget.expired()).toBe(false);
    lease.release();
    budget.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains external user stop and cleans all call timers without aggregate limits', () => {
    vi.useFakeTimers();
    const owner = new AbortController();
    const budget = new ExecutionBudget({
      modelCallDeadlineMs: 100,
      turnWallDeadlineMs: null,
      activeModelBudgetMs: null,
    });
    const lease = budget.beginModelCall(owner.signal, vi.fn());
    lease.activity('text');
    vi.advanceTimersByTime(7);
    owner.abort('owner requested stop');
    expect(lease.signal.aborted).toBe(true);
    expect(lease.reason()).toBe('user_stop');
    lease.release();
    expect(budget.activeModelMsUsed()).toBe(7);
    budget.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
