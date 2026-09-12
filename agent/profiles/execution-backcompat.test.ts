import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProfiles } from './profile.js';

const BASELINE_EXECUTION = {
  modelCallDeadlineMs: 90_000,
  turnWallDeadlineMs: 180_000,
  activeModelBudgetMs: 120_000,
  firstActivityTimeoutMs: 30_000,
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
});
