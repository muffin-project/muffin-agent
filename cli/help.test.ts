import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AUTH_USAGE } from './auth.js';
import { COMMANDS, commandHelp, commandSpec, wantsHelp } from './command-surface.js';
import { FALLBACK_USAGE } from './fallback.js';
import { rotMigrateUsage } from './rot-migrate.js';

/**
 * `muffin <command> --help` answers for every command, exits 0, and never
 * runs the command. Measured on dev bbecf290: `init`, `run`, `doctor`,
 * `config`, `uninstall`, `orientamento` died on "Unknown option '--help'",
 * and `adopt --help` *adopted*.
 */

describe('wantsHelp', () => {
  it('sees --help and -h among the command arguments', () => {
    expect(wantsHelp(['--help'])).toBe(true);
    expect(wantsHelp(['set', '-h'])).toBe(true);
    expect(wantsHelp(['status'])).toBe(false);
  });
  it('stops at the POSIX `--` terminator: what follows is an operand', () => {
    expect(wantsHelp(['--', '--help'])).toBe(false);
    expect(wantsHelp(['spiega', '--', '-h'])).toBe(false);
  });
});

describe('commandHelp', () => {
  it('projects summary, aliases and usage from the one vocabulary', () => {
    const page = commandHelp('memoria', 'usage: muffin memory stats');
    expect(page).toContain('muffin memory — ');
    expect(page).toContain('alias: memoria');
    expect(page).toContain('usage: muffin memory stats');
  });
  it('builds a usage line from subcommands when a command has no text of its own', () => {
    expect(commandHelp('rot')).toContain('uso: muffin rot <verify|migrate>');
  });
  it('is null for an unknown command', () => {
    expect(commandHelp('nonesiste')).toBeNull();
  });

  it('auth help documents xAI login flags and lists logout', () => {
    const page = commandHelp('auth', AUTH_USAGE);
    expect(page).toContain('muffin auth login xai [--browser|--code|--device]');
    expect(page).toContain('--browser');
    expect(page).toContain('--code');
    expect(page).toContain('--device');
    expect(page).toContain('muffin auth logout');
    expect(commandSpec('auth')?.subcommands).toContain('logout');
  });

  it('fallback help is Italian and uses uso:', () => {
    const page = commandHelp('fallback', FALLBACK_USAGE);
    expect(page).toMatch(/^muffin fallback/m);
    expect(page).toContain('uso:');
    expect(page).not.toContain('usage:');
    expect(page).toContain('mostra le catene');
  });
});

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function run(
  args: string[],
  home: string,
  xdg: string,
  cwd: string,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', ['--import', 'tsx', join(process.cwd(), 'cli/main.ts'), ...args], {
      cwd,
      env: {
        ...process.env,
        NO_COLOR: '1',
        MUFFIN_HOME: home,
        XDG_CONFIG_HOME: xdg,
        HOME: join(home, '..'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (b: Buffer) => {
      out += b.toString();
    });
    child.stderr.on('data', (b: Buffer) => {
      err += b.toString();
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, err });
    });
  });
}

describe('muffin <command> --help', () => {
  it('every command answers --help on stdout, exit 0, and touches nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'muffin-help-'));
    dirs.push(root);
    const home = join(root, 'home');
    const xdg = join(root, 'xdg');
    // A cwd inside the checkout so `tsx` resolves, with no `.env` (see main.test.ts).
    const cwd = mkdtempSync(join(process.cwd(), 'muffin-test-cwd-'));
    dirs.push(cwd);

    const names = COMMANDS.map((c) => c.name).filter((n) => n !== 'help');
    const results: { name: string; flag: string; code: number; out: string; err: string }[] = [];
    const queue = names.flatMap((name) => [
      { name, flag: '--help' },
      ...(name === 'init' || name === 'adopt' ? [{ name, flag: '-h' }] : []),
    ]);
    const workers = Array.from({ length: 6 }, async () => {
      for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
        const r = await run([job.name, job.flag], home, xdg, cwd);
        results.push({ ...job, ...r });
      }
    });
    await Promise.all(workers);

    for (const r of results) {
      expect({ cmd: `${r.name} ${r.flag}`, code: r.code, err: r.err }).toEqual({
        cmd: `${r.name} ${r.flag}`,
        code: 0,
        err: '',
      });
      expect(r.out, `${r.name} ${r.flag}`).toContain(`muffin ${r.name}`);
    }
    // Nothing ran: no Home was created by any of them.
    expect(existsSync(home)).toBe(false);
    expect(existsSync(xdg) ? readdirSync(xdg) : []).toEqual([]);
  }, 240_000);

  it('`muffin help <command>` is the same page; an unknown one is a usage error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'muffin-help-topic-'));
    dirs.push(root);
    const cwd = mkdtempSync(join(process.cwd(), 'muffin-test-cwd-'));
    dirs.push(cwd);
    const home = join(root, 'home');
    const xdg = join(root, 'xdg');
    const [viaHelp, viaFlag, unknown] = await Promise.all([
      run(['help', 'status'], home, xdg, cwd),
      run(['status', '--help'], home, xdg, cwd),
      run(['help', 'nonesiste'], home, xdg, cwd),
    ]);
    expect(viaHelp.code).toBe(0);
    expect(viaHelp.out).toBe(viaFlag.out);
    expect(unknown.code).toBe(78);
  }, 120_000);

  it('muffin auth login xai --help documents --browser, --code and --device', async () => {
    const root = mkdtempSync(join(tmpdir(), 'muffin-help-xai-'));
    dirs.push(root);
    const cwd = mkdtempSync(join(process.cwd(), 'muffin-test-cwd-'));
    dirs.push(cwd);
    const r = await run(
      ['auth', 'login', 'xai', '--help'],
      join(root, 'home'),
      join(root, 'xdg'),
      cwd,
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain('--browser');
    expect(r.out).toContain('--code');
    expect(r.out).toContain('--device');
    expect(r.out).toContain('logout');
  }, 60_000);

  it('muffin rot --help names a customized MUFFIN_HOME, not ~/.muffin/user.md', async () => {
    const root = mkdtempSync(join(tmpdir(), 'muffin-help-rot-'));
    dirs.push(root);
    const cwd = mkdtempSync(join(process.cwd(), 'muffin-test-cwd-'));
    dirs.push(cwd);
    const home = join(root, 'custom-muffin-home');
    const r = await run(['rot', '--help'], home, join(root, 'xdg'), cwd);
    expect(r.code).toBe(0);
    expect(r.out).toContain(home);
    expect(r.out).toContain('user.md');
    expect(r.out).not.toContain('~/.muffin/user.md');
    expect(rotMigrateUsage(home)).toContain(join(home, 'user.md'));
    expect(rotMigrateUsage(home)).not.toContain('chiede comunque prima di scrivere');
  }, 60_000);
});
