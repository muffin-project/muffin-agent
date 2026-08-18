import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadMcpRegistry } from '../core/mcp/registry.js';
import { cmdMcpAdd, cmdMcpList, cmdMcpRemove } from './mcp.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'core',
  'mcp',
  'fixtures',
  'echo-server.mjs',
);

/**
 * The whole owner flow against the real fixture server: approve, audit,
 * detect drift, remove. Return codes are the contract — a clean audit exits
 * 0 so `muffin mcp list --verify` can gate a script.
 */
describe('muffin mcp verbs', () => {
  it('add pins, list --verify audits clean, drift flips the exit code, remove forgets', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-mcpcli-'));

    // approve
    expect(await cmdMcpAdd(home, 'echo', process.execPath, [FIXTURE], {})).toBe(0);
    const registry = loadMcpRegistry(home);
    expect(Object.keys(registry.servers.echo!.tools)).toEqual(['echo']);

    // clean audit
    expect(await cmdMcpList(home, true)).toBe(0);

    // the server drifts: same command, description now different (env-driven)
    registry.servers.echo!.env = { DESC_OVERRIDE: 'Something else entirely.' };
    const { saveMcpRegistry } = await import('../core/mcp/registry.js');
    saveMcpRegistry(registry, home);
    expect(await cmdMcpList(home, true)).toBe(1);

    // re-approval with no command reuses the stored entry and repins
    expect(await cmdMcpAdd(home, 'echo', undefined, [], {})).toBe(0);
    expect(await cmdMcpList(home, true)).toBe(0);

    // remove forgets
    expect(cmdMcpRemove(home, 'echo')).toBe(0);
    expect(loadMcpRegistry(home).servers).toEqual({});
    expect(cmdMcpRemove(home, 'echo')).toBe(1);
  }, 40_000);

  it('a malformed name never reaches a connection', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-mcpcli-'));
    expect(await cmdMcpAdd(home, 'Bad Name!', '/bin/true', [], {})).toBe(78);
    expect(loadMcpRegistry(home).servers).toEqual({});
  });
});


import { spawnSync } from 'node:child_process';

/** Il binario vero, con la sua home: il parsing di `--env` vive in `cli/main.ts`, non in `cli/mcp.ts`. */
function muffin(dir: string, args: string[]): { code: number; out: string; err: string } {
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'main.ts');
  const r = spawnSync('npx', ['tsx', cli, ...args], {
    env: { ...process.env, MUFFIN_HOME: dir },
    encoding: 'utf8',
  });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

describe('una chiave di un server MCP non passa per argv (correzione owner 18/08)', () => {
  it('rifiuta --env K=valore e insegna il riferimento', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-mcpenv-'));
    try {
      const r = muffin(dir, ['mcp', 'add', 'gh', '--env', 'GITHUB_TOKEN=ghp_mai_in_argv', '--', 'npx', 'server']);
      expect(r.code).toBe(78);
      expect(r.err).toMatch(/ps di chiunque|shell history/);
      expect(r.err).toMatch(/secret:\/\/mcp_github_token/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('un riferimento secret:// passa la guardia — fallisce semmai alla connessione, non al flag', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-mcpref-'));
    try {
      const r = muffin(dir, ['mcp', 'add', 'gh', '--env', 'GITHUB_TOKEN=secret://mcp_gh', '--', 'npx', 'server']);
      // Non 78: la guardia sull'argv non scatta. Qui il comando prova davvero a
      // connettersi (è così che `mcp add` pinna i tool) e il segreto non è
      // registrato in questa home, quindi fallisce **rumorosamente** — che è la
      // direzione giusta: un server MCP avviato senza la sua chiave fallirebbe
      // più tardi, dove nessuno collega la causa.
      expect(r.code).not.toBe(78);
      expect(r.err).toMatch(/missing secret "mcp_gh"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolveEnv risolve solo i riferimenti e lascia stare il resto', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-resolveenv-'));
    try {
      writeFileSync(join(dir, 'config.json'), '{}');
      mkdirSync(join(dir, 'secrets'), { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, 'secrets', 'mcp_gh'), 'ghp_valore_che_non_deve_girare', { mode: 0o600 });
      const { resolveEnvForTest } = await import('../core/mcp/connect.js');
      const out = resolveEnvForTest({ GITHUB_TOKEN: 'secret://mcp_gh', LANG: 'C' }, dir);
      expect(out['GITHUB_TOKEN']).toBe('ghp_valore_che_non_deve_girare');
      expect(out['LANG']).toBe('C');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
