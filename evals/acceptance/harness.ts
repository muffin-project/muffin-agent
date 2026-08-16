import DatabaseCtor from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
 *
 * Not `import.meta.resolve('tsx')`, which is what this line used to be: it
 * works standalone but throws `__vite_ssr_import_meta__.resolve is not a
 * function` the moment this module is loaded through vitest's own Vite-based
 * SSR runner, which does not implement it — found by running the acceptance
 * suite under vitest, not by reading Vite's docs. `tsx`'s own package.json
 * points `"."` unconditionally at `dist/loader.mjs` (checked directly, no
 * `import`/`require` split on that entry), so building the URL from `REPO` is
 * exactly what resolution would have produced, without an API only one of the
 * two runners this file needs to survive actually has.
 */
const TSX_LOADER = join(REPO, 'node_modules', 'tsx', 'dist', 'loader.mjs');
if (!existsSync(TSX_LOADER)) {
  throw new Error(
    `tsx loader non trovato in ${TSX_LOADER} — la versione installata potrebbe aver spostato dist/loader.mjs`,
  );
}
const TSX = pathToFileURL(TSX_LOADER).href;

export type Run = { code: number; out: string; err: string };

/**
 * Run the CLI as a child process — asynchronously, never `spawnSync`.
 *
 * This is not a style preference; `spawnSync` here reproduces a real deadlock,
 * found by running it and reading the exact symptom rather than guessing from
 * one. `startFakeProvider` runs its HTTP server on this same process's event
 * loop. `spawnSync` blocks that event loop until the child exits. So a scenario
 * that calls `muffin run` — which must reach back over loopback to the fake
 * provider running right here — deadlocks: the child's request arrives, and
 * the only thread that could answer it is frozen waiting synchronously for the
 * child to finish. It manifests as `curl`/`fetch` timing out against a server
 * that demonstrably works when awaited instead of blocked on
 * (`node -e` probe, 2026-08-16: an in-process `await fetch()` against a
 * same-process server returns 200; a `spawnSync('curl', …)` against the exact
 * same server times out with 0 bytes received, because the accept-and-respond
 * never gets a turn on the loop). `init` and `doctor` never triggered it only
 * because they make no network call at all — the trap is scoped to exactly
 * the scenarios that need the provider, which is the whole suite's point.
 */
function spawnAsync(
  args: string[],
  env: Record<string, string>,
  cwd: string,
  stdin: string,
): Promise<Run> {
  return new Promise((resolvePromise) => {
    const child = spawn('node', ['--import', TSX, CLI, ...args], {
      env: { ...process.env, ...env },
      cwd,
      timeout: 120_000,
    });
    let out = '';
    let err = '';
    let settled = false;
    // A spawn that never ran (ENOENT, a timeout, a signal) has `code === null`
    // and an empty stderr — which reads exactly like "the command printed
    // nothing", the least debuggable failure a scenario can produce. Say what
    // actually happened instead. Guarded against a double resolve: Node does
    // not guarantee 'error' and 'close' are mutually exclusive.
    const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error): void => {
      if (settled) return;
      settled = true;
      const suffix =
        (spawnError ? `\n[spawn] ${spawnError.message}` : '') +
        (signal ? `\n[spawn] ucciso da ${signal}` : '');
      resolvePromise({ code: code ?? -1, out, err: err + suffix });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      out += c;
    });
    child.stderr.on('data', (c: string) => {
      err += c;
    });
    child.on('error', (e) => finish(null, null, e));
    child.on('close', (code, signal) => finish(code, signal));
    // Closed immediately even when empty: `cmdSecret` reads stdin with a
    // blocking `readFileSync(0)`, which waits for EOF. Never sending it is how
    // a scenario that never touches `secret set` would still hang.
    child.stdin.end(stdin);
  });
}

export type Install = {
  home: string;
  /** The scratch directory the child runs in — the agent's filesystem scope. */
  workspace: string;
  provider: FakeProvider;
  /**
   * One CLI invocation, one process.
   *
   * Async, and it must stay that way. See `spawnAsync` below: the fake
   * provider's HTTP server lives in this same process, and a synchronous
   * child-process wait blocks the event loop that server needs to answer.
   */
  muffin(args: string[], stdin?: string): Promise<Run>;
  /**
   * The same command, as a child this scenario can **kill**.
   *
   * `muffin()` awaits the exit, which is right for every scenario about what a
   * command produces and useless for the one about what happens when a command
   * never gets to produce anything. B5's claim is precisely that: a process
   * killed mid-turn leaves a row that is enough on its own. There is no way to
   * assert that against a process this harness insists on waiting for.
   */
  spawnRaw(args: string[]): { kill: () => void; exited: Promise<number | null> };
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

  const run = (args: string[], stdin = ''): Promise<Run> => spawnAsync(args, env, workspace, stdin);

  const init = await run([
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
    spawnRaw: (args) => {
      const child = spawn('node', ['--import', TSX, CLI, ...args], {
        env: { ...process.env, ...env },
        cwd: workspace,
        // Inherited output would interleave with vitest's own; a scenario that
        // kills this child never reads what it said anyway.
        stdio: 'ignore',
      });
      children.push({ kill: () => child.kill('SIGKILL') });
      return {
        kill: () => child.kill('SIGKILL'),
        // Attached now, not on demand: a child that dies before the caller
        // awaits would otherwise resolve nothing and hang the scenario.
        exited: new Promise<number | null>((resolveExit) => child.on('exit', (code) => resolveExit(code))),
      };
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
