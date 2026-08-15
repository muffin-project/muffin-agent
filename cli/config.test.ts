import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInit } from './init.js';
import { cmdConfig, formatConfigKnobs } from './config.js';
import { listConfigKnobs } from '../core/config/inventory.js';

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-cmd-config-'));
  vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'xdg'));
  runInit({ home: dir, apiKey: 'sk-ant-fixture' });
  return dir;
}

afterEach(() => vi.unstubAllEnvs());

function capture(fn: () => number): { out: string; code: number } {
  let out = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  try {
    const code = fn();
    return { out, code };
  } finally {
    spy.mockRestore();
  }
}

describe('muffin config', () => {
  it('exits 0 and prints a table with the sealed column', () => {
    const dir = home();
    const { out, code } = capture(() => cmdConfig(dir, []));
    expect(code).toBe(0);
    expect(out).toContain('CHIAVE');
    expect(out).toContain('SIGILLATO');
    expect(out).toContain('provider.kind');
    expect(out).toContain('budgets.monthlyUsd');
    rmSync(dir, { recursive: true, force: true });
  });

  it('--json emits exactly what listConfigKnobs produces, valid JSON, parseable and complete', () => {
    const dir = home();
    const { out, code } = capture(() => cmdConfig(dir, ['--json']));
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed).toEqual(listConfigKnobs(dir));
    rmSync(dir, { recursive: true, force: true });
  });

  it('a home with no config.json fails clearly instead of throwing past the command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-cmd-config-empty-'));
    let err = '';
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      err += String(chunk);
      return true;
    });
    let code: number;
    try {
      code = cmdConfig(dir, []);
    } finally {
      spy.mockRestore();
    }
    expect(code).toBe(78);
    expect(err).toContain('muffin init');
    rmSync(dir, { recursive: true, force: true });
  });

  it('every row the table prints names which file it came from', () => {
    const dir = home();
    const table = formatConfigKnobs(listConfigKnobs(dir), dir);
    // Sealed rows read "rot/…" (relative to home, matching how doctor.ts
    // already names these same five files) and never the raw absolute path,
    // which is what made the very first real run of this command wider than
    // a terminal.
    expect(table).toContain('rot/budgets.json');
    expect(table).toContain('rot/policy.json');
    expect(table).toContain('rot/egress.json');
    expect(table).not.toContain(dir); // no leaked absolute path in the human table
    rmSync(dir, { recursive: true, force: true });
  });

  it('the sealed column reads sì/no in a fixed position — the fact a mutation could flip silently', () => {
    const dir = home();
    const table = formatConfigKnobs(listConfigKnobs(dir), dir);
    const providerLine = table.split('\n').find((l) => l.startsWith('provider.kind'));
    const budgetLine = table.split('\n').find((l) => l.startsWith('budgets.monthlyUsd'));
    // `\b` is ASCII-word-boundary in JS regex and does not treat "ì" as a word
    // character, so token-splitting on whitespace is the reliable check here.
    expect(providerLine?.split(/\s+/)).toContain('no');
    expect(budgetLine?.split(/\s+/)).toContain('sì');
    rmSync(dir, { recursive: true, force: true });
  });
});
