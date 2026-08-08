import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SandboxExecutor } from './executor.js';

/**
 * These are the tracer bullets of ADR-0026, as tests: each one executes a real
 * containment and asserts the *outcome*, because the library's own tracker has
 * open bugs where the declared policy silently does not hold (#432, #434,
 * #446). A green here means the guarantee held on this machine today — which
 * is the only claim worth making about a sandbox.
 *
 * Real `sandbox-exec` runs: macOS only. On other platforms the suite skips
 * rather than pretending (a skipped containment reported as passed is how the
 * previous system shipped a no-op sandbox for two months).
 */
const onMac = platform() === 'darwin';

function scaffold() {
  const base = mkdtempSync(join(tmpdir(), 'muffin-exec-test-'));
  const workspace = join(base, 'workspace');
  const outside = join(base, 'outside');
  const guarded = join(base, 'guarded'); // stands in for ~/.muffin/rot
  const secrets = join(base, 'secrets');
  for (const d of [workspace, outside, guarded, secrets]) mkdirSync(d, { recursive: true });
  writeFileSync(join(guarded, 'manifest.json'), '{"probe": true}');
  writeFileSync(join(secrets, 'llm_api_key'), 'sk-live-do-not-read');
  return { base, workspace, outside, guarded, secrets };
}

describe.runIf(onMac)('sandboxed execution holds (real containment)', () => {
  const s = scaffold();
  const executor = new SandboxExecutor({
    denyWrite: [s.guarded, s.secrets],
    denyRead: [s.secrets],
  });

  afterAll(async () => {
    await executor.close();
  });

  it('a write inside the scope succeeds — a sandbox that contains everything is broken too', async () => {
    const r = await executor.run({
      command: 'echo ok > inside.txt && cat inside.txt',
      cwd: s.workspace,
      writeScope: [s.workspace],
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('ok');
    expect(readFileSync(join(s.workspace, 'inside.txt'), 'utf8')).toContain('ok');
  });

  it('a write outside the scope is denied', async () => {
    const target = join(s.outside, 'escaped.txt');
    const r = await executor.run({
      command: `echo escaped > '${target}'`,
      cwd: s.workspace,
      writeScope: [s.workspace],
    });
    expect(r.code).not.toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it('a guard path is denied even with cwd elsewhere — upstream #432 anchored deny globs to cwd', async () => {
    const target = join(s.guarded, 'manifest.json');
    const r = await executor.run({
      command: `echo tampered > '${target}'`,
      cwd: s.workspace,
      writeScope: [s.workspace],
    });
    expect(r.code).not.toBe(0);
    expect(readFileSync(target, 'utf8')).toBe('{"probe": true}');
  });

  it('the guard also holds when the guarded dir itself is in the write scope', async () => {
    // denyWrite must beat allowWrite: this is the "mandatory" in mandatory deny.
    const target = join(s.guarded, 'manifest.json');
    const r = await executor.run({
      command: `echo tampered > '${target}'`,
      cwd: s.workspace,
      writeScope: [s.workspace, s.guarded],
    });
    expect(r.code).not.toBe(0);
    expect(readFileSync(target, 'utf8')).toBe('{"probe": true}');
  });

  it('a deny-read file cannot be read', async () => {
    const r = await executor.run({
      command: `cat '${join(s.secrets, 'llm_api_key')}'`,
      cwd: s.workspace,
      writeScope: [s.workspace],
    });
    expect(r.code).not.toBe(0);
    expect(r.stdout).not.toContain('sk-live');
  });

  it('a host-env secret does not ride into the child environment', async () => {
    process.env['MUFFIN_TEST_FAKE_KEY'] = 'sk-fake-in-host-env';
    try {
      const r = await executor.run({
        command: 'printenv MUFFIN_TEST_FAKE_KEY',
        cwd: s.workspace,
        writeScope: [s.workspace],
      });
      // printenv exits 1 when the variable is absent — which is the point.
      expect(r.code).not.toBe(0);
      expect(r.stdout).not.toContain('sk-fake-in-host-env');
    } finally {
      delete process.env['MUFFIN_TEST_FAKE_KEY'];
    }
  });

  it('network egress is denied by default', async () => {
    const r = await executor.run({
      command: '/usr/bin/curl -sS --max-time 4 https://example.com',
      cwd: s.workspace,
      writeScope: [s.workspace],
      timeoutMs: 15_000,
    });
    expect(r.code).not.toBe(0);
    expect(r.stdout).not.toContain('<html');
  }, 20_000);

  it('a command that overruns its timeout is killed and says so', async () => {
    const r = await executor.run({
      command: 'sleep 10',
      cwd: s.workspace,
      writeScope: [s.workspace],
      timeoutMs: 1_500,
    });
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(9_000);
  }, 15_000);

  it('oversized output is cut head-and-tail with an announced marker', async () => {
    const r = await executor.run({
      command: `node -e 'process.stdout.write("x".repeat(80000) + "TAIL_END")'`,
      cwd: s.workspace,
      writeScope: [s.workspace],
    });
    expect(r.truncated).toBe(true);
    expect(r.stdout).toContain('output troncato');
    // tail-weighted: the end of the output survives the cut
    expect(r.stdout).toContain('TAIL_END');
  }, 20_000);
});

describe('when the sandbox is unavailable', () => {
  it('run() refuses instead of running unsandboxed', async () => {
    const executor = new SandboxExecutor({ denyWrite: [], denyRead: [] }, () => ({
      available: false,
      mechanism: 'bubblewrap',
      reason: 'userns_denied',
      detail: 'probe says no',
      remedy: 'fix the host',
    }));
    await expect(
      executor.run({ command: 'true', cwd: tmpdir(), writeScope: [] }),
    ).rejects.toThrow(/sandbox unavailable/);
  });
});
