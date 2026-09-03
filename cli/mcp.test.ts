import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadMcpRegistry } from '../core/mcp/registry.js';
import { cmdMcpAdd, cmdMcpList, cmdMcpRemove } from './mcp.js';
import { runInit } from './init.js';
import { paths } from '../core/config/config.js';
import { verify } from '../core/rot/verify.js';

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

/**
 * `--host` — la stessa porta di `muffin search` (ADR-0058), attraversata da
 * `widenEgressForCapability`. Il server MCP di prova non parla mai davvero
 * con quegli host: quello che conta qui è solo se `rot/egress.json` cambia.
 */
describe('muffin mcp add --host', () => {
  function home(): string {
    const h = mkdtempSync(join(tmpdir(), 'muffin-mcphost-'));
    runInit({ home: h, provider: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-fake' });
    return h;
  }

  function egressAllow(h: string): string[] {
    return JSON.parse(readFileSync(join(paths(h).rot, 'egress.json'), 'utf8')).allow;
  }

  it('senza --host non tocca affatto l egress', async () => {
    const h = home();
    expect(await cmdMcpAdd(h, 'echo', process.execPath, [FIXTURE], {})).toBe(0);
    expect(egressAllow(h)).toEqual([]);
  });

  it('con --host e conferma, aggiunge esattamente gli host nominati e risigilla', async () => {
    const h = home();
    const domande: string[] = [];
    const code = await cmdMcpAdd(h, 'echo', process.execPath, [FIXTURE], {}, ['a.example', 'b.example'], {
      out: () => {},
      chiediConferma: (d) => {
        domande.push(d);
        return Promise.resolve('s');
      },
    });
    expect(code).toBe(0);
    expect(domande).toHaveLength(1);
    expect(domande[0]).toContain('«echo»');
    expect(egressAllow(h)).toEqual(['a.example', 'b.example']);
    expect(verify(h, 'single-user').ok).toBe(true);
  });

  it('senza chiediConferma (nessun terminale): approva il server comunque, ma non allarga l egress', async () => {
    const h = home();
    const { sink, out } = (() => {
      const buf: string[] = [];
      return { out: buf, sink: (l: string) => void buf.push(l) };
    })();
    const code = await cmdMcpAdd(h, 'echo', process.execPath, [FIXTURE], {}, ['a.example'], { out: sink });
    expect(code).toBe(0);
    expect(loadMcpRegistry(h).servers.echo).toBeDefined();
    expect(egressAllow(h)).toEqual([]);
    expect(out.join('\n')).toContain('nessun terminale interattivo');
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

/**
 * Il binario vero, invocato senza terminale — esattamente la condizione di
 * `spawnSync` (stdin è una pipe, mai un TTY) e la stessa condizione che il
 * figlio sandboxato di `sys.shell` produce sempre (`stdio: ['ignore', 'pipe',
 * 'pipe']`, `core/sandbox/executor.ts`). Non c'è un `--yes`/`--force` da
 * passare: il flag non esiste, e non ne aggiungiamo uno — la conferma dipende
 * solo da `isatty(0)` misurato dentro `main()` al momento in cui gira, non da
 * un argomento che un chiamante automatico potrebbe scrivere.
 */
describe('muffin mcp add --host, dal binario vero e senza terminale', () => {
  it('approva il server ma non allarga rot/egress.json — nessuna domanda può arrivare a un flag', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-mcphost-real-'));
    try {
      runInit({ home: dir, provider: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-fake' });
      const egressPath = join(paths(dir).rot, 'egress.json');
      const prima = readFileSync(egressPath, 'utf8');

      const r = muffin(dir, [
        'mcp',
        'add',
        'echo',
        '--host',
        'api.example.com',
        '--',
        process.execPath,
        FIXTURE,
      ]);
      expect(r.code).toBe(0);
      expect(readFileSync(egressPath, 'utf8')).toBe(prima);
      expect(r.err + r.out).toContain('nessun terminale interattivo');
      expect(verify(dir, 'single-user').ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

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
