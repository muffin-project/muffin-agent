import { describe, expect, it } from 'vitest';
import { CONSERVATIVE, DEFAULT_EXECUTION, loadProfiles } from './profile.js';

const expected = {
  'consumer-local': {
    modelCallDeadlineMs: 90_000,
    turnWallDeadlineMs: 900_000,
    activeModelBudgetMs: 900_000,
    firstActivityTimeoutMs: 30_000,
    stallTimeoutMs: 25_000,
    heartbeatIntervalMs: 15_000,
  },
  frontier: {
    modelCallDeadlineMs: 120_000,
    turnWallDeadlineMs: 300_000,
    activeModelBudgetMs: 240_000,
    firstActivityTimeoutMs: 30_000,
    stallTimeoutMs: 25_000,
    heartbeatIntervalMs: 15_000,
  },
} as const;

describe('shipped execution envelopes', () => {
  it('pins every shipped profile to the reviewed time budget', () => {
    const profiles = loadProfiles();
    const actual = Object.fromEntries(profiles.map((profile) => [profile.name, profile.execution]));
    expect(actual).toEqual(expected);
  });

  it('the unknown-model conservative floor is bounded too', () => {
    expect(CONSERVATIVE.execution).toEqual(DEFAULT_EXECUTION);
  });

  it('every shipped envelope can heartbeat and stall before its hard model deadline', () => {
    for (const profile of loadProfiles()) {
      const execution = profile.execution;
      expect(execution, profile.name).toBeDefined();
      if (execution === undefined) continue;
      expect(execution.heartbeatIntervalMs, profile.name).toBeLessThan(execution.stallTimeoutMs);
      expect(execution.stallTimeoutMs, profile.name).toBeLessThan(execution.modelCallDeadlineMs);
      expect(execution.firstActivityTimeoutMs, profile.name).toBeLessThan(execution.modelCallDeadlineMs);
      expect(execution.activeModelBudgetMs, profile.name).toBeLessThanOrEqual(execution.turnWallDeadlineMs);
    }
  });
});
