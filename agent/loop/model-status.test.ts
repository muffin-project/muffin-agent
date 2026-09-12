import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionBudget, type ModelProgress } from './execution-budget.js';

describe('model status progress', () => {
  afterEach(() => vi.useRealTimers());

  it('reports semantic state transitions immediately, while heartbeat only repeats the current state', async () => {
    vi.useFakeTimers();
    const seen: ModelProgress[] = [];
    const budget = new ExecutionBudget({
      modelCallDeadlineMs: 1_000,
      turnWallDeadlineMs: 2_000,
      firstActivityTimeoutMs: 200,
      stallTimeoutMs: 200,
      heartbeatIntervalMs: 50,
    });
    const lease = budget.beginModelCall(undefined, (progress) => seen.push(progress));

    expect(seen.map((p) => p.status)).toEqual(['waiting_for_model']);

    lease.activity('thinking');
    expect(seen.map((p) => p.status)).toEqual(['waiting_for_model', 'thinking']);

    // Repeated chunks in the same semantic state are not a progress-event flood.
    lease.activity('thinking');
    expect(seen.map((p) => p.status)).toEqual(['waiting_for_model', 'thinking']);

    lease.activity('text');
    expect(seen.map((p) => p.status)).toEqual(['waiting_for_model', 'thinking', 'receiving']);

    await vi.advanceTimersByTimeAsync(50);
    expect(seen.map((p) => p.status)).toEqual(['waiting_for_model', 'thinking', 'receiving', 'receiving']);

    lease.release();
    budget.close();
  });
});
