import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mandatoryGuards } from '../rot/guards.js';
import { SandboxExecutor } from './executor.js';
import { probeSandbox } from './probe.js';

/**
 * The Muffin home is not a workspace, proven the only way it is worth proving:
 * a real command, through the production `SandboxExecutor`, with the real
 * `mandatoryGuards` — never a mock of either.
 *
 * ## What was measured before the fix
 *
 * The supervised gateway ran with `cwd = ~/.muffin` (its unit pins
 * `WorkingDirectory` there on purpose, ADR-0035), `cli/gateway.ts` built the
 * runtime with no cwd, and that cwd became `FsScope.root` **and** the
 * sandbox's `writeScope`. Against that configuration, on this file's own
 * scaffold (2026-09-03, seatbelt):
 *
 * ```text
 * denied   rot/egress.json    exit=1  Operation not permitted
 * WRITTEN  .rot-anchor        exit=0  20B → 6B
 * WRITTEN  muffin.db          exit=0  20480B → 6B
 * WRITTEN  voice.md           exit=0  17B → 6B
 * WRITTEN  sessions/*.jsonl   exit=0  14B → 6B
 * ```
 *
 * `.rot-anchor` is the sharp one: it lives *beside* `rot/`, so the deny that
 * covered the sealed directory did not cover the seal, and a write there makes
 * the next `verify()` answer `anchor_mismatch` — safe mode in single-user, a
 * refused boot when hardened. `muffin.db` holds episodes, chunks, facts, turns,
 * jobs and spend; `sessions/` holds the conversation history. Every one of
 * those is reachable from a turn whose content arrived in a forwarded message,
 * a web page or a PDF.
 *
 * ## What this file falsifies, and what it does not
 *
 * The fix has two halves:
 *
 * - **the braces** — `resolveWorkspace` (`core/config/workspace.ts`) never
 *   hands a turn the installation, so the write scope is a sibling directory;
 * - **the belt** — `mandatoryGuards` denies the home outright, so even a write
 *   scope that *named* the home would not reach it.
 *
 * **Only the belt is falsifiable here, and an earlier version of this comment
 * claimed otherwise.** It said the first block "reverts red when the braces
 * go". It does not: that block builds a home and a workspace by hand and never
 * calls `resolveWorkspace` at all, so removing the braces leaves all of its
 * assertions green — measured by a judge, 2026-09-03, not reasoned about. The
 * sentence was false, and a test file that misstates where its own guarantee
 * lives is worse than one that says nothing, because the next reader trusts
 * it.
 *
 * So, precisely:
 *
 * - **the belt** is falsified *here*: with `p.home` removed from
 *   `core/rot/guards.ts`, the second block fails on `.rot-anchor`,
 *   `muffin.db`, `voice.md`, the grandchild and the interpreter, while the
 *   first stays green;
 * - **the braces** are falsified *elsewhere*, and both places are needed:
 *   `core/config/workspace.test.ts` for the decision itself, and
 *   `evals/system/acceptance.test.ts` — *"a turn's own writes land in
 *   runtime.workspace"* — for the wiring at the production seam. That second
 *   one exists because reverting `FsScope.root`/`makeShellTool` to the raw
 *   `cwd`, with `resolveWorkspace` left intact, once left the entire suite
 *   green: a deny cannot hold the wiring, since a deny looks the same
 *   whichever mechanism produced it. Only a positive claim can.
 *
 * What this file proves, then, is the belt — and it proves it against a real
 * containment rather than a mock.
 *
 * ## The two properties a deny list gets wrong more often than the deny
 *
 * - it is **inherited**: a shell that spawns a shell, a freshly spawned
 *   interpreter and a command under a pty are contained by the same
 *   kernel-level boundary — a deny that only held for the first process would
 *   be a deny an `sh -c` walks around;
 * - it is **not a wall**: each block has a control leg that must succeed.
 *   Without one, a sandbox that had stopped working entirely would read as a
 *   perfect green — the ambiguity `probe.ts` and `executor.ts` both have their
 *   own two-legged shape for.
 *
 * Every target below is written by exactly one test. An earlier test's
 * successful attack must never be able to leave a later one comparing `pwned`
 * to `pwned` and calling it a pass — which is what the first draft of this file
 * did, caught by the mutation run rather than by reading it.
 */
const host = platform();

/** Same gate, and same reasoning, as `core/sandbox/executor.test.ts`. */
const gate: { run: boolean; why: string } = (() => {
  if (host === 'darwin') return { run: true, why: 'macOS: seatbelt is part of the OS' };
  if (host === 'linux') {
    const p = probeSandbox();
    if (p.available) return { run: true, why: `linux: ${p.mechanism} contained a real probe` };
    return { run: false, why: `linux: sandbox unavailable — ${p.reason}: ${p.detail}` };
  }
  return { run: false, why: `no OS-level sandbox on ${host}` };
})();

const containmentRequired = process.env['MUFFIN_REQUIRE_SANDBOX'] === '1';

/** The line every attack tries to leave behind. */
const PWNED = 'pwned\n';

/**
 * A home shaped like a real one, and a workspace that is its **sibling** —
 * which is the shape `resolveWorkspace` produces and, measured, the only shape
 * that works: with the workspace nested inside a denied home, a write to the
 * workspace itself came back `Operation not permitted` (seatbelt, 2026-09-03).
 * See `core/config/workspace.ts`.
 *
 * Every file the tests aim at is created here with content of its own, and each
 * is the target of one test only.
 */
function scaffold(): { home: string; workspace: string; file: (rel: string) => string } {
  const base = mkdtempSync(join(tmpdir(), 'muffin-home-ws-'));
  const home = join(base, '.muffin');
  const workspace = join(base, 'muffin-workspace');
  for (const dir of [join(home, 'rot'), join(home, 'sessions'), join(home, 'secrets'), workspace]) {
    mkdirSync(dir, { recursive: true });
  }
  const contents: Record<string, string> = {
    'rot/egress.json': '{"allow":[]}\n',
    '.rot-anchor': 'e3b0c44298fc1c149afbf4c8996fb924\n',
    'muffin.db': `SQLite format 3 ${'.'.repeat(20464)}`,
    'voice.md': '# la voce\nparlo cosi.\n',
    'sessions/owner.jsonl': '{"role":"user"}\n',
    'config.json': '{"schemaVersion":2}\n',
    // One target per inheritance leg, so no leg can inherit another's damage.
    'nipote.md': 'nipote\n',
    'interprete.md': 'interprete\n',
    'pty.md': 'pty\n',
  };
  for (const [rel, body] of Object.entries(contents)) writeFileSync(join(home, rel), body);
  writeFileSync(join(workspace, 'appunti.md'), 'appunti\n');
  return { home, workspace, file: (rel: string) => join(home, rel) };
}

describe('the containment suite declares whether it ran', () => {
  it('either the home-vs-workspace containment ran, or the skip is declared — and where it was required, a skip is a failure', () => {
    if (gate.run) {
      expect(gate.why).not.toBe('');
      return;
    }
    if (containmentRequired) {
      throw new Error(
        `MUFFIN_REQUIRE_SANDBOX=1 and no real containment was executed on this host — ${gate.why}.`,
      );
    }
    expect(gate.why).not.toBe('');
  });
});

/** The four rows a judge measured going through, and the seal beside them. */
const ROWS: [string, string][] = [
  ['rot/egress.json', 'rot/egress.json'],
  ['.rot-anchor', '.rot-anchor'],
  ['muffin.db', 'muffin.db'],
  ['voice.md', 'voice.md'],
];

/**
 * The **shape** the braces produce, not the braces themselves: a scope built by
 * hand the way `buildRuntime` builds it. It says what a turn in a real
 * workspace can reach; it cannot say that production puts a turn there — see
 * the header for where that is proven.
 */
describe.runIf(gate.run)('the shape the braces produce: a workspace scope reaches nothing in the installation', () => {
  const s = scaffold();
  const exec = new SandboxExecutor(mandatoryGuards(s.home, s.workspace));

  for (const [label, rel] of ROWS) {
    it(`denies a shell write to ${label}`, async () => {
      const target = s.file(rel);
      const before = readFileSync(target, 'utf8');
      const result = await exec.run({
        command: `printf '${PWNED.trim()}\\n' > ${target}`,
        cwd: s.workspace,
        writeScope: [s.workspace],
      });
      expect(readFileSync(target, 'utf8'), `${label} was overwritten by a contained command`).toBe(before);
      expect(result.code, `${label}: the command should have failed`).not.toBe(0);
    });
  }

  it('denies the conversation history too — the directory, not only the files in it today', async () => {
    const nuovo = s.file('sessions/inventato.jsonl');
    const result = await exec.run({
      command: `printf '${PWNED.trim()}\\n' > ${nuovo}`,
      cwd: s.workspace,
      writeScope: [s.workspace],
    });
    expect(result.code).not.toBe(0);
    expect(() => statSync(nuovo)).toThrow();
  });

  it('still lets the workspace be written, so the scope is a scope and not a wall', async () => {
    const target = join(s.workspace, 'appunti.md');
    const result = await exec.run({
      command: `printf 'scritto\\n' > ${target}`,
      cwd: s.workspace,
      writeScope: [s.workspace],
    });
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe('scritto\n');
  });
});

/**
 * The belt, on the **pre-fix production configuration exactly**:
 * `writeScope: [home]`, which is what `agent/runtime.ts` handed
 * `makeShellTool` when the gateway's cwd was the home. This is the judge's own
 * measurement, re-run against today's guards.
 */
describe.runIf(gate.run)('the belt: the deny holds even when a write scope names the home', () => {
  const s = scaffold();
  const exec = new SandboxExecutor(mandatoryGuards(s.home, s.home));
  const inHome = { cwd: s.home, writeScope: [s.home] as const };

  for (const [label, rel] of ROWS) {
    it(`denies ${label} with the home itself as the write scope`, async () => {
      const target = s.file(rel);
      const before = readFileSync(target, 'utf8');
      const result = await exec.run({ command: `printf '${PWNED.trim()}\\n' > ${target}`, ...inHome });
      expect(readFileSync(target, 'utf8'), `${label} was overwritten inside an allow-write over the home`).toBe(before);
      expect(result.code).not.toBe(0);
    });
  }

  it('denies a grandchild shell — the deny is the kernel’s, not the first shell’s cooperation', async () => {
    const target = s.file('nipote.md');
    const result = await exec.run({
      command: `sh -c "sh -c \\"printf '${PWNED.trim()}\\\\n' > ${target}\\""`,
      ...inHome,
    });
    expect(readFileSync(target, 'utf8'), 'a grandchild shell overwrote a file in the home').toBe('nipote\n');
    expect(result.code).not.toBe(0);
  });

  it('denies a freshly spawned interpreter, which never saw the shell at all', async () => {
    const target = s.file('interprete.md');
    // The quoting matters and was got wrong first: a `node -e "…"` whose inner
    // path lost its quotes dies of `SyntaxError` before touching the disk, and
    // an assertion on "the file is intact" would then pass against a sandbox
    // with no deny list at all. Measured with `denyWrite: []`: this exact
    // spelling writes the file, exit 0.
    const result = await exec.run({
      command: `node -e 'require("fs").writeFileSync("${target}", "pwned")'`,
      ...inHome,
    });
    expect(readFileSync(target, 'utf8'), 'a spawned interpreter overwrote a file in the home').toBe('interprete\n');
    expect(result.code).not.toBe(0);
  });

  /**
   * A pty, because a terminal is a different code path in every shell and
   * "it held for a pipe" is not the claim.
   *
   * The two mechanisms answer differently, and both answers were measured on
   * 2026-09-03 with the deny list emptied, so that each says what it says
   * about the pty and not about the deny:
   *
   * - **seatbelt (macOS 15)**: `script(1)` exists inside the sandbox and dies
   *   at `script: openpty: Operation not permitted`. The sandbox refuses the
   *   pty itself, so on this mechanism there is no pty-shaped escape at all.
   * - **bubblewrap (Linux, node:22-bookworm, non-root)**: the pty allocates
   *   and, with no deny, the write lands — `exit=0`, file `"pwned"`. So on the
   *   platform Muffin actually lives on, this leg is a real test of the deny,
   *   and it is green.
   *
   * This test therefore accepts exactly two outcomes and no third: the pty was
   * refused, or it was allocated and the write was still denied. It never
   * accepts "the file is intact" on its own, which is what a `script` failing
   * for an unrelated reason would also produce.
   */
  it('a pty is either refused outright or does not get the write through', async () => {
    const target = s.file('pty.md');
    const pty = ptyCommand(`printf '${PWNED.trim()}\\n' > ${target}`);
    if (pty === null) {
      if (containmentRequired) {
        throw new Error(
          `MUFFIN_REQUIRE_SANDBOX=1 and no pty could be allocated on this host — script(1) not found on ${host}`,
        );
      }
      // Declared, never silent: a skipped pty leg that looked like a pass is
      // the shape of green this repository has shipped before.
      expect(pty).toBeNull();
      return;
    }
    const result = await exec.run({ command: pty, ...inHome });
    const refusedPty = /openpty|posix_openpt|ptmx|out of pty/i.test(result.stderr);
    expect(readFileSync(target, 'utf8'), 'the write went through under a pty').toBe('pty\n');
    expect(
      refusedPty || result.code !== 0,
      `the pty leg proved nothing: exit ${result.code}, stderr ${JSON.stringify(result.stderr.slice(0, 200))}`,
    ).toBe(true);
  });

  it('still writes outside the home, so this block is not measuring a dead sandbox', async () => {
    const target = join(s.workspace, 'fuori.md');
    const result = await exec.run({
      command: `printf 'fuori\\n' > ${target}`,
      cwd: s.workspace,
      writeScope: [s.workspace],
    });
    expect(result.code).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe('fuori\n');
  });
});

/**
 * `script(1)` allocating a real pty, or `null` when this host has none.
 * macOS: `script -q <file> <cmd> [args…]`. util-linux: `script -qec <cmd> <file>`.
 */
function ptyCommand(inner: string): string | null {
  try {
    execFileSync('sh', ['-c', 'command -v script'], { stdio: 'ignore' });
  } catch {
    return null;
  }
  if (host === 'darwin') return `script -q /dev/null sh -c ${JSON.stringify(inner)}`;
  if (host === 'linux') return `script -qec ${JSON.stringify(inner)} /dev/null`;
  return null;
}
