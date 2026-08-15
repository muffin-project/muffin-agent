import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SandboxExecutor } from './executor.js';
import { probeSandbox } from './probe.js';

/**
 * These are the tracer bullets of ADR-0026, as tests: each one executes a real
 * containment and asserts the *outcome*, because the library's own tracker has
 * open bugs where the declared policy silently does not hold (#432, #434,
 * #446). A green here means the guarantee held on this machine today — which
 * is the only claim worth making about a sandbox.
 *
 * The suite is **one** suite for both mechanisms, not two mirrored ones:
 * Seatbelt on macOS and bubblewrap on Linux are supposed to make the same
 * promises, so they are asserted by the same lines. A guarantee that only one
 * platform's copy of a test asserts is a guarantee that drifts.
 *
 * Until 2026-08-15 this file gated on `platform() === 'darwin'` alone, and the
 * consequence was measured in CI rather than reasoned about: `10 test, 9
 * saltati` on ubuntu-latest **with bubblewrap installed**. The nine
 * containments had never run on Linux — the platform of the production VPS —
 * on any machine, ever. The skip reason was right; what was missing is that
 * nothing ever turned the skip into a failure where the containment was
 * supposed to be provable. That is `MUFFIN_REQUIRE_SANDBOX` below.
 */
const host = platform();

/**
 * Can a real containment be executed here, and if not, why not — in words, at
 * collection time, before any assertion runs.
 *
 * macOS runs unconditionally: `sandbox-exec` is part of the OS, so a machine
 * that cannot contain is a broken machine and must go red, not quiet. Linux
 * gates on the probe because unavailability there is a *documented host
 * condition* (Ubuntu 24.04 restricts unprivileged user namespaces — ADR-0018,
 * field note 2026-08-04), not a bug in this repo.
 */
const gate: { run: boolean; why: string } = (() => {
  if (host === 'darwin') return { run: true, why: 'macOS: seatbelt is part of the OS' };
  if (host === 'linux') {
    const p = probeSandbox();
    if (p.available) return { run: true, why: `linux: ${p.mechanism} contained a real probe` };
    return { run: false, why: `linux: sandbox unavailable — ${p.reason}: ${p.detail}` };
  }
  return { run: false, why: `no OS-level sandbox on ${host}` };
})();

/**
 * The flag that makes a skip fail. Set it wherever the containment is supposed
 * to be provable — CI does, on the runner that stands in for the production
 * VPS. Unset on a laptop, where skipping on an unsupported platform is a fact
 * about the laptop and not a defect.
 */
const containmentRequired = process.env['MUFFIN_REQUIRE_SANDBOX'] === '1';

function scaffold() {
  const base = mkdtempSync(join(tmpdir(), 'muffin-exec-test-'));
  const workspace = join(base, 'workspace');
  const outside = join(base, 'outside');
  const guarded = join(base, 'guarded'); // stands in for ~/.muffin/rot
  const secrets = join(base, 'secrets');
  for (const d of [workspace, outside, guarded, secrets]) mkdirSync(d, { recursive: true });
  writeFileSync(join(guarded, 'manifest.json'), '{"probe": true}');
  writeFileSync(join(secrets, 'llm_api_key'), 'sk-live-do-not-read');
  writeFileSync(join(outside, 'diary.txt'), 'OUTSIDE_MARKER');
  return { base, workspace, outside, guarded, secrets };
}

describe('the containment suite declares whether it ran', () => {
  /**
   * The one test in this file that runs everywhere. It exists because the
   * previous system shipped a no-op sandbox for two months and every suite was
   * green the whole time: the skip was correct, silent, and indistinguishable
   * from a pass at a glance.
   */
  it('either the containment ran, or the skip is declared — and where it was required, a skip is a failure', () => {
    if (gate.run) {
      expect(gate.why).not.toBe('');
      return;
    }
    if (containmentRequired) {
      throw new Error(
        `MUFFIN_REQUIRE_SANDBOX=1 and no real containment was executed on this host — ${gate.why}. ` +
          'This failure is the flag working: a skipped containment must never read as a pass.',
      );
    }
    console.warn(`[sandbox] real containment SKIPPED — ${gate.why}`);
    expect(gate.why).not.toBe('');
  });
});

describe.runIf(gate.run)(`sandboxed execution holds (real containment — ${gate.why})`, () => {
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

  /**
   * The limit, asserted rather than assumed. `filesystem.allowWrite` is a
   * *write* scope: ADR-0018 says "fs write-scope ristretto al workspace del
   * turno", and reads stay open except for the mandatory deny-read paths.
   * Measured on macOS 2026-08-15 with this executor: a contained command reads
   * `/etc/hosts`, `$HOME`, and any file outside the scope.
   *
   * It is pinned here because it is the kind of limit that gets misremembered
   * as a guarantee — "the sandbox confines the command to the workspace" is
   * true of writes and false of reads, and `~/.muffin/muffin.db` is readable by
   * a contained command today. If this line ever goes red, someone tightened
   * reads: that is a good change, and it should be a deliberate one.
   */
  it('the write scope is a write scope — reads outside it are NOT contained (declared limit)', async () => {
    const r = await executor.run({
      command: `cat '${join(s.outside, 'diary.txt')}'`,
      cwd: s.workspace,
      writeScope: [s.workspace],
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('OUTSIDE_MARKER');
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

  /**
   * HTTPS on purpose, on both platforms. macOS denies the socket outright; on
   * Linux the namespace is unshared and the only way out is the egress proxy,
   * which answers a CONNECT for a domain outside the allowlist with `403
   * Forbidden` — curl treats a refused CONNECT as an error, so the exit code
   * still carries the denial. Plain HTTP would not: there the proxy returns a
   * 403 *body*, and `curl` without `--fail` exits 0 holding an error page. The
   * content assertion is the one that would catch that.
   */
  it('network egress is denied by default', async () => {
    const r = await executor.run({
      command: 'curl -sS --max-time 4 https://example.com',
      cwd: s.workspace,
      writeScope: [s.workspace],
      timeoutMs: 15_000,
    });
    expect(r.code).not.toBe(0);
    expect(r.stdout).not.toContain('<html');
    expect(r.stdout).not.toContain('Example Domain');
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
  const unavailable = () =>
    ({
      available: false,
      mechanism: 'bubblewrap',
      reason: 'userns_denied',
      detail: 'probe says no',
      remedy: 'fix the host',
    }) as const;

  it('run() refuses instead of running unsandboxed', async () => {
    const executor = new SandboxExecutor({ denyWrite: [], denyRead: [] }, unavailable);
    await expect(
      executor.run({ command: 'true', cwd: tmpdir(), writeScope: [] }),
    ).rejects.toThrow(/sandbox unavailable/);
  });

  /**
   * "Refuses" has two possible meanings and only one of them is safe: the
   * command never ran, versus the command ran and its result was thrown away.
   * The rejection alone cannot tell them apart, so the filesystem is asked.
   */
  it('refusing means the command never ran, not that its output was discarded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-exec-refuse-'));
    const witness = join(dir, 'it-ran.txt');
    const executor = new SandboxExecutor({ denyWrite: [], denyRead: [] }, unavailable);
    await expect(
      executor.run({ command: `echo ran > '${witness}'`, cwd: dir, writeScope: [dir] }),
    ).rejects.toThrow(/sandbox unavailable/);
    expect(existsSync(witness)).toBe(false);
  });

  /**
   * The refusal is read by a human (`muffin doctor`) and by the model, and both
   * need the *remedy*, not just the fact. A message that says only "unavailable"
   * is how a fixable host condition becomes a permanent missing capability.
   */
  it('the refusal carries the reason and the remedy', async () => {
    const executor = new SandboxExecutor({ denyWrite: [], denyRead: [] }, unavailable);
    await expect(
      executor.run({ command: 'true', cwd: tmpdir(), writeScope: [] }),
    ).rejects.toThrow(/userns_denied.*fix the host/s);
  });
});
