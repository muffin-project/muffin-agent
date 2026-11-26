import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { paths } from '../core/config/config.js';
import { cmdFallback } from './fallback.js';
import { runInit } from './init.js';
import { cmdModel } from './model.js';
import { channelOf, cmdStatus, type StatusReport } from './status.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function freshHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'muffin-status-'));
  roots.push(root);
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'xdg'));
  const home = join(root, 'home');
  runInit({ home, apiKey: 'sk-ant-fixture-never-called' });
  return home;
}

function status(home: string, argv: string[] = []): { code: number; lines: string[] } {
  const lines: string[] = [];
  const code = cmdStatus(home, argv, {
    out: (l) => lines.push(l),
    version: '0.0.0 (fixture)',
    channel: () => 'dev',
  });
  return { code, lines };
}

const row = (lines: string[], label: string) => lines.find((l) => l.startsWith(label));

describe('muffin status', () => {
  it('una casa nuova: poche righe leggibili, una per argomento, e il rimando a doctor', () => {
    const home = freshHome();
    const { code, lines } = status(home);
    expect(code).toBe(0);
    expect(row(lines, 'versione')).toContain('0.0.0 (fixture) · canale dev');
    expect(row(lines, 'gateway')).toContain('spento');
    expect(row(lines, 'modelli')).toMatch(/^modelli\s+1\. /);
    expect(row(lines, 'identità')).toContain('fondazione dal prodotto · nessun user.md');
    expect(row(lines, 'ricerca')).toContain('spenta');
    expect(row(lines, 'embedding')).toContain('ollama');
    expect(row(lines, 'memoria')).toBeDefined();
    expect(lines.at(-1)).toContain('muffin doctor');
    expect(lines.length).toBeLessThanOrEqual(15);
  });

  it('embedding spenti con `muffin model embed off` si leggono come spenti', async () => {
    const home = freshHome();
    expect(await cmdModel(home, ['embed', 'off'], { out: () => {} })).toBe(0);
    expect(row(status(home).lines, 'embedding')).toContain('spenti · ricerca testuale attiva');
  });

  it('la catena mostra tutti gli anelli in ordine, e quello senza credenziale lo dice', () => {
    const home = freshHome();
    expect(cmdFallback(home, ['add', 'xai', 'grok-4.7'], { out: () => {} })).toBe(0);
    expect(cmdFallback(home, ['add', 'openrouter', 'openrouter/free'], { out: () => {} })).toBe(0);
    const { lines } = status(home);
    const i = lines.findIndex((l) => l.startsWith('modelli'));
    expect(lines[i]).toContain('1. ');
    expect(lines[i + 1]?.trim()).toMatch(
      /^2\. .*grok-4\.7.*credenziale mancante → muffin auth login xai \(oppure muffin secret set xai_api_key\)/,
    );
    expect(lines[i + 2]?.trim()).toMatch(/^3\. .*openrouter\/free/);
  });

  it('identità: una copia modificata a mano rimanda a rot migrate; user.md mostra i token', () => {
    const home = freshHome();
    writeFileSync(
      join(paths(home).rot, 'identity.md'),
      '# Identità\n\nPatto scritto a mano (fixture).\n',
    );
    expect(row(status(home).lines, 'identità')).toContain('muffin rot migrate');
    writeFileSync(paths(home).user, 'Rispondi breve (fixture).\n');
    expect(row(status(home).lines, 'identità')).toMatch(/user\.md \(\d+\/1000 token\)/);
  });

  it('gateway fermato di proposito lo dice, con il comando per riaccenderlo', () => {
    const home = freshHome();
    writeFileSync(paths(home).gatewayStopped, '');
    expect(row(status(home).lines, 'gateway')).toContain('muffin gateway start');
  });

  it('--json dà lo stesso rapporto per uno script', () => {
    const home = freshHome();
    const { code, lines } = status(home, ['--json']);
    expect(code).toBe(0);
    const report = JSON.parse(lines.join('\n')) as StatusReport;
    expect(report.home).toBe(home);
    expect(Array.isArray(report.modelli)).toBe(true);
  });

  it('senza configurazione rimanda a init, exit 78, senza creare niente', () => {
    const root = mkdtempSync(join(tmpdir(), 'muffin-status-empty-'));
    roots.push(root);
    const writes = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(status(join(root, 'nessuna-home')).code).toBe(78);
      expect(String(writes.mock.calls[0]?.[0])).toContain('muffin init');
    } finally {
      writes.mockRestore();
    }
  });

  it('--json senza configurazione emette JSON strutturato e non testo libero su stderr', () => {
    const root = mkdtempSync(join(tmpdir(), 'muffin-status-empty-json-'));
    roots.push(root);
    const writes = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { code, lines } = status(join(root, 'nessuna-home'), ['--json']);
      expect(code).toBe(78);
      const report = JSON.parse(lines.join('\n')) as {
        ok: boolean;
        error: string;
        hint: string;
      };
      expect(report.ok).toBe(false);
      expect(report.error).toBe('uninitialized');
      expect(report.hint).toBe('muffin init');
      expect(writes.mock.calls.map((c) => String(c[0])).join('')).not.toContain(
        'Muffin non è ancora configurato',
      );
    } finally {
      writes.mockRestore();
    }
  });

  it('un flag sconosciuto è un errore d’uso', () => {
    const writes = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(status(freshHome(), ['--bogus']).code).toBe(78);
    } finally {
      writes.mockRestore();
    }
  });
});

describe('channelOf', () => {
  const git = (ancestorOf: string | null) => (args: string[]) => {
    if (args[0] === 'worktree') return { status: 0, stdout: 'worktree /repo\n', stderr: '' };
    if (args[0] === 'log')
      return { status: 0, stdout: `${'a'.repeat(40)} 2026-11-26\n`, stderr: '' };
    if (args[0] === 'status') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'merge-base') {
      return {
        status: ancestorOf !== null && args[3]?.endsWith(`/${ancestorOf}`) ? 0 : 1,
        stdout: '',
        stderr: '',
      };
    }
    return { status: 1, stdout: '', stderr: '' };
  };

  it('main quando la build è già su origin/main', () => {
    expect(channelOf('/repo/cli', git('main'))).toBe('main');
  });
  it('dev quando è solo su origin/dev', () => {
    expect(channelOf('/repo/cli', git('dev'))).toContain('dev (non ancora promosso su main)');
  });
  it('build locale quando non è su nessuno dei due', () => {
    expect(channelOf('/repo/cli', git(null))).toContain('build locale');
  });
});
