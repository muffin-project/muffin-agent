import DatabaseCtor from 'better-sqlite3';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeProvider, type FakeProvider, type FakeProviderOptions } from './provider.js';

/**
 * The installation an owner would have, driven the way an owner drives it.
 *
 * Everything here runs `cli/main.ts` as a **process**, against a throwaway
 * `MUFFIN_HOME`, and asserts what leaves it: stdout, stderr, the exit code, the
 * rows in the database. Nothing imports `runTurn` and hands it fakes — that
 * proves a function is correct and says nothing about whether Muffin works,
 * which is the distinction ORCHESTRATION.md §11 draws between "unit test" and
 * "cablaggio in produzione". The defect family this repo keeps paying for lives
 * exactly in the gap: a mechanism with green tests that no real path reaches.
 *
 * Isolation, and why each piece of it is there:
 *
 *  - `MUFFIN_HOME` — the owner's real home is never touched.
 *  - `XDG_CONFIG_HOME` — the persistent secret store (`--persist`, ADR-0039)
 *    deliberately lives *outside* the home, so without this a scenario would
 *    read the developer's own key.
 *  - `cwd` is a scratch workspace, not the repo. It is what `buildRuntime`
 *    scopes the filesystem tools to, and it is what `loadDotenvIfPresent` looks
 *    in: a `.env` in the checkout must not leak into a scenario.
 */

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const CLI = join(REPO, 'cli', 'main.ts');
/**
 * Resolved, not spelled `tsx`.
 *
 * `node --import tsx` resolves the specifier against the child's **working
 * directory**, and every child here runs in a scratch workspace with no
 * `node_modules` — so the bare name fails with ERR_MODULE_NOT_FOUND before the
 * CLI is ever reached. Resolving it here pins it to this checkout's copy, which
 * is also the copy the rest of the suite is running under.
 */
const TSX = import.meta.resolve('tsx');

export type Run = { code: number; out: string; err: string };

export type Install = {
  home: string;
  /** The scratch directory the child runs in — the agent's filesystem scope. */
  workspace: string;
  provider: FakeProvider;
  /** One CLI invocation, one process. */
  muffin(args: string[], stdin?: string): Run;
  /** The home database, read-only, for asserting state instead of prose. */
  db<T>(read: (db: DatabaseCtor.Database) => T): T;
  /** Starts `muffin gateway run` and waits for a line on stderr. */
  gateway(): Promise<Gateway>;
  cleanup(): Promise<void>;
};

export type Gateway = {
  /** Resolves when stderr has matched, or rejects after the timeout. */
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<string>;
  stderr(): string;
  stdout(): string;
  /** SIGTERM and wait for the drain. */
  stop(): Promise<number>;
};

export type InstallOptions = FakeProviderOptions & {
  /** Extra environment for every child — used by scenarios that need a clock or a flag. */
  env?: Record<string, string>;
};

/**
 * A fresh install, from the same command an owner types.
 *
 * `init` is run rather than simulated: this is A1's first half, and every other
 * scenario stands on it, so an install that stopped working would take the
 * whole suite red instead of one line of it.
 */
export async function install(options: InstallOptions): Promise<Install> {
  const root = mkdtempSync(join(tmpdir(), 'muffin-accept-'));
  const home = join(root, 'home');
  const xdg = join(root, 'xdg');
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const provider = await startFakeProvider(options);

  const env: Record<string, string> = {
    MUFFIN_HOME: home,
    XDG_CONFIG_HOME: xdg,
    NO_COLOR: '1',
    ...(options.env ?? {}),
  };

  const run = (args: string[], stdin = ''): Run => {
    const result = spawnSync('node', ['--import', TSX, CLI, ...args], {
      env: { ...process.env, ...env },
      cwd: workspace,
      input: stdin,
      encoding: 'utf8',
      timeout: 120_000,
    });
    // A spawn that never ran (ENOENT, a timeout, a signal) has `status === null`
    // and an empty stderr — which reads exactly like "the command printed
    // nothing", the least debuggable failure a scenario can produce. Say what
    // actually happened instead.
    const err =
      (result.stderr ?? '') +
      (result.error ? `\n[spawn] ${result.error.message}` : '') +
      (result.signal ? `\n[spawn] ucciso da ${result.signal}` : '');
    return { code: result.status ?? -1, out: result.stdout ?? '', err };
  };

  const init = run([
    'init',
    '--provider',
    'openai-compat',
    '--base-url',
    provider.baseUrl,
    '--api-key',
    'sk-acceptance-fake-key',
  ]);
  if (init.code !== 0) {
    await provider.close();
    throw new Error(`muffin init è uscito con ${init.code}:\n${init.err}`);
  }

  const children: Array<{ kill: () => void }> = [];

  return {
    home,
    workspace,
    provider,
    muffin: run,
    db: (read) => {
      const db = new DatabaseCtor(join(home, 'muffin.db'), { readonly: true });
      try {
        return read(db);
      } finally {
        db.close();
      }
    },
    gateway: async () => {
      const child = spawn('node', ['--import', TSX, CLI, 'gateway', 'run'], {
        env: { ...process.env, ...env },
        cwd: workspace,
      });
      children.push({ kill: () => child.kill('SIGKILL') });
      let err = '';
      let out = '';
      child.stderr.setEncoding('utf8');
      child.stdout.setEncoding('utf8');
      child.stderr.on('data', (c: string) => {
        err += c;
      });
      child.stdout.on('data', (c: string) => {
        out += c;
      });
      const waitFor = (pattern: RegExp, timeoutMs = 30_000): Promise<string> =>
        new Promise((resolvePromise, reject) => {
          const started = Date.now();
          const poll = setInterval(() => {
            const match = pattern.exec(`${err}\n${out}`);
            if (match) {
              clearInterval(poll);
              resolvePromise(match[0]);
            } else if (Date.now() - started > timeoutMs) {
              clearInterval(poll);
              reject(new Error(`il gateway non ha mai scritto ${pattern}\n--- stderr ---\n${err}\n--- stdout ---\n${out}`));
            }
          }, 100);
        });
      return {
        waitFor,
        stderr: () => err,
        stdout: () => out,
        stop: () =>
          new Promise<number>((resolvePromise) => {
            child.on('exit', (code) => resolvePromise(code ?? -1));
            child.kill('SIGTERM');
            // The drain budget is a minute; a scenario that waits that long has
            // already failed at something else.
            setTimeout(() => child.kill('SIGKILL'), 20_000).unref();
          }),
      };
    },
    cleanup: async () => {
      for (const c of children) c.kill();
      await provider.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Wait for a condition the CLI reports, polling a command instead of sleeping.
 *
 * A fixed sleep is either flaky or slow, and both cost the same in a suite that
 * runs on every PR.
 */
export async function until(check: () => boolean, timeoutMs = 15_000, everyMs = 200): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - started > timeoutMs) throw new Error('condizione mai raggiunta');
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
