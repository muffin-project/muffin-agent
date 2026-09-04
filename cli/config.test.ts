import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInit } from './init.js';
import { cmdConfig, cmdConfigSet, formatConfigKnobs } from './config.js';
import { listConfigKnobs } from '../core/config/inventory.js';
import { loadConfig } from '../core/config/config.js';
import { formatSetOutcome, setConfigKnob } from '../core/config/settings.js';

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

/** Same shape as `capture`, but for the commands that answer on stderr (a rejection). */
function captureErr(fn: () => number): { err: string; code: number } {
  let err = '';
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    err += String(chunk);
    return true;
  });
  try {
    const code = fn();
    return { err, code };
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

/**
 * `muffin config set` (ADR-0070) — `cmdConfigSet` non decide niente: prova che
 * chiama `setConfigKnob` e stampa esattamente `formatSetOutcome`, mai un testo
 * suo. `core/config/settings.test.ts` prova il cancello stesso (chiavi
 * escluse, validazione); qui si prova solo che questa porta lo raggiunge.
 */
describe('muffin config set', () => {
  it('scrive, esce 0, e stampa esattamente formatSetOutcome', () => {
    const dir = home();
    const outcome = setConfigKnob(dir, 'traces.retentionDays', '30');
    // Rifatto due volte a bella posta: `setConfigKnob` non è idempotente sulla
    // FS reale al secondo giro (il valore è già 30), quindi si confronta il
    // testo con una chiamata equivalente fresca sullo stesso valore di arrivo.
    rmSync(dir, { recursive: true, force: true });

    const dir2 = home();
    const { out, code } = capture(() => cmdConfigSet(dir2, ['traces.retentionDays', '30']));
    expect(code).toBe(0);
    expect(out).toBe(`${formatSetOutcome(outcome)}\n`);
    expect(loadConfig(dir2).traces.retentionDays).toBe(30);
    rmSync(dir2, { recursive: true, force: true });
  });

  it('una chiave esclusa esce 78 e non tocca il file', () => {
    const dir = home();
    const before = loadConfig(dir);
    const { err, code } = captureErr(() => cmdConfigSet(dir, ['rot.mode', 'hardened']));
    expect(code).toBe(78);
    expect(err).toContain('non è un\'impostazione modificabile');
    expect(loadConfig(dir)).toEqual(before);
    rmSync(dir, { recursive: true, force: true });
  });

  it('senza chiave o senza valore stampa l\'usage ed esce 78', () => {
    const dir = home();
    expect(captureErr(() => cmdConfigSet(dir, [])).code).toBe(78);
    expect(captureErr(() => cmdConfigSet(dir, ['traces.retentionDays'])).code).toBe(78);
    rmSync(dir, { recursive: true, force: true });
  });

  it('`muffin config set ...` (via cmdConfig) raggiunge la stessa funzione di `muffin config set` diretto', () => {
    const dir = home();
    const { out, code } = capture(() => cmdConfig(dir, ['set', 'traces.retentionDays', '15']));
    expect(code).toBe(0);
    expect(loadConfig(dir).traces.retentionDays).toBe(15);
    expect(out).toContain('traces.retentionDays');
    rmSync(dir, { recursive: true, force: true });
  });
});
