import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDecide } from '../../core/policy/decide.js';
import { SandboxExecutor } from '../../core/sandbox/executor.js';
import { classifySource, resolveWorkspace } from '../../core/dev/workspace.js';
import { devCapability, makeDevTools } from './dev.js';

const owner = { tenant: 'host', principal: { kind: 'owner', connector: 'cli' } } as const;

describe('workspace resolution', () => {
  it('confines every workspace under the dev root', () => {
    const home = '/tmp/muffin-home';
    const good = resolveWorkspace(home, 'muffin-next');
    expect(good).toMatchObject({ ok: true });
    for (const bad of ['../escape', 'a/b', '..', 'Bad Name']) {
      expect(resolveWorkspace(home, bad).ok).toBe(false);
    }
  });

  it('reads the forge host from a remote source, resolves a local one', () => {
    expect(classifySource('https://github.com/o/r.git')).toMatchObject({ kind: 'remote', host: 'github.com' });
    expect(classifySource('git@github.com:o/r.git')).toMatchObject({ kind: 'remote', host: 'github.com' });
    expect(classifySource('/some/local/path')).toMatchObject({ kind: 'local' });
  });
});

describe('dev capability through the kernel', () => {
  const decide = createDecide({
    capabilities: new Map([[devCapability.id, devCapability]]),
    budgetExhausted: () => false,
    hardened: false, // even single-user: dev is medium, taint 0 → allow for owner
  });
  const base = { capability: 'dev', resource: { kind: 'none' }, args: { workspace: 'x' } } as const;

  it('owner at taint 0 is allowed — dev is the owner working on their own repo', () => {
    expect(decide({ ...base, principal: owner.principal, tenant: 'host', taint: 0 }).effect).toBe('allow');
  });

  it('any taint above zero denies — a tainted turn cannot reach the repo', () => {
    const d = decide({ ...base, principal: owner.principal, tenant: 'host', taint: 1 });
    expect(d).toMatchObject({ effect: 'deny', code: 'taint_exceeded' });
  });

  it('a group member has no path to dev at all', () => {
    const d = decide({
      ...base,
      principal: { kind: 'member', connector: 'telegram', tenantId: 'group:t:1', externalId: 'u' },
      tenant: 'group:t:1',
      taint: 0,
    });
    expect(d).toMatchObject({ effect: 'deny', code: 'principal_forbidden' });
  });
});

// Real git, real containment: macOS only (the sandbox executor runs Seatbelt).
const onMac = platform() === 'darwin';

describe.runIf(onMac)('dev tools against a real repo, contained', () => {
  const home = mkdtempSync(join(tmpdir(), 'muffin-dev-home-'));
  const originDir = mkdtempSync(join(tmpdir(), 'muffin-dev-origin-'));

  // A real upstream repo to clone from — local, so no network is involved.
  const git = (args: string[], cwd: string) =>
    execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  git(['init', '-q', '-b', 'main'], originDir);
  git(['config', 'user.email', 't@t'], originDir);
  git(['config', 'user.name', 'T'], originDir);
  writeFileSync(join(originDir, 'README.md'), '# upstream\n');
  writeFileSync(join(originDir, 'value.txt'), 'forty-two\n');
  git(['add', '.'], originDir);
  git(['commit', '-q', '-m', 'seed'], originDir);

  const executor = new SandboxExecutor({ denyWrite: [], denyRead: [] });
  const [clone, run] = makeDevTools(executor, home);

  afterAll(async () => {
    await executor.close();
  });

  it('clones into a dedicated workspace, not the owner tree', async () => {
    const out = await clone!.handler({ workspace: 'proj', source: originDir }, owner);
    expect(out.isError).toBeUndefined();
    expect(existsSync(join(home, 'dev', 'proj', '.git'))).toBe(true);
    // the origin is untouched — a clone, never the working tree
    expect(existsSync(join(originDir, '.git'))).toBe(true);
  }, 30_000);

  it('a second clone of the same name is idempotent, not an error', async () => {
    const out = await clone!.handler({ workspace: 'proj', source: originDir }, owner);
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain('già presente');
  }, 20_000);

  it('runs a command in the workspace and reads its files', async () => {
    const out = await run!.handler({ workspace: 'proj', command: 'cat value.txt' }, owner);
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain('forty-two');
  }, 20_000);

  it('can branch and commit locally inside the workspace', async () => {
    const out = await run!.handler(
      {
        workspace: 'proj',
        command:
          'git config user.email a@b && git config user.name A && ' +
          'git checkout -q -b fix && echo patched > value.txt && ' +
          'git commit -aqm "fix: patch" && git log --oneline -1',
      },
      owner,
    );
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain('fix: patch');
  }, 20_000);

  it('cannot write outside the workspace — containment holds for dev too', async () => {
    const escape = join(home, 'ESCAPED.txt');
    const out = await run!.handler(
      { workspace: 'proj', command: `echo out > '${escape}'` },
      owner,
    );
    expect(out.isError).toBe(true);
    expect(existsSync(escape)).toBe(false);
  }, 20_000);

  it('refuses a command in a workspace that was never cloned', async () => {
    const out = await run!.handler({ workspace: 'ghost', command: 'ls' }, owner);
    expect(out.isError).toBe(true);
    expect(out.content).toContain('dev_clone');
  });
});
