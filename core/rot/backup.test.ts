import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupOwnerConfigFile } from './backup.js';

describe('backupOwnerConfigFile', () => {
  it('copies the source aside and leaves the original intact', () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-rot-bak-'));
    mkdirSync(join(home, 'rot'), { recursive: true });
    const src = join(home, 'rot', 'budgets.json');
    writeFileSync(src, '{"monthlyUsd":80}\n');
    const expected = join(home, 'backups', 'budgets.json-2026-11-25T14-20-00-000Z');
    const dest = backupOwnerConfigFile(home, src, new Date('2026-11-25T14:20:00Z'));
    expect(dest).toBe(expected);
    expect(readFileSync(expected, 'utf8')).toBe('{"monthlyUsd":80}\n');
    expect(readFileSync(src, 'utf8')).toBe('{"monthlyUsd":80}\n');
  });

  it('returns null when the source does not exist yet', () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-rot-bak-'));
    expect(backupOwnerConfigFile(home, join(home, 'rot', 'missing.json'))).toBeNull();
  });
});
