import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProfiles } from './profile.js';

const BASELINE_EXECUTION = {
  modelCallDeadlineMs: 90_000,
  turnWallDeadlineMs: 180_000,
  activeModelBudgetMs: 120_000,
  stallTimeoutMs: 25_000,
  heartbeatIntervalMs: 15_000,
};

describe('execution envelope backcompat', () => {
  it('a schema-v1 profile written before execution existed inherits the full bounded baseline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-profile-execution-'));
    writeFileSync(
      join(dir, 'old.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'old',
        match: ['*old*'],
        maxToolsExposed: 10,
        maxToolCallsPerTurn: 15,
        thinking: 'off',
        recovery: [],
        notes: '',
      }),
    );

    const problems: string[] = [];
    const [profile] = loadProfiles(dir, (line) => problems.push(line));

    expect(problems).toEqual([]);
    expect(profile?.execution).toEqual(BASELINE_EXECUTION);
  });

  it('a profile still carrying the removed first-activity watchdog loads, with the key ignored', () => {
    // The key was legal until 2026-09-28 (ADR-0092); a hand-written profile
    // that still has it must not fail the boundary, and must not revive a
    // timeout no path reads any more.
    const dir = mkdtempSync(join(tmpdir(), 'muffin-profile-execution-'));
    writeFileSync(
      join(dir, 'stale.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'stale',
        match: ['*stale*'],
        maxToolsExposed: 10,
        maxToolCallsPerTurn: 15,
        thinking: 'off',
        recovery: [],
        execution: { ...BASELINE_EXECUTION, firstActivityTimeoutMs: 30_000 },
        notes: '',
      }),
    );

    const problems: string[] = [];
    const [profile] = loadProfiles(dir, (line) => problems.push(line));

    expect(problems).toEqual([]);
    expect(profile?.execution).toEqual(BASELINE_EXECUTION);
  });
});
