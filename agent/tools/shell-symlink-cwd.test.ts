import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SandboxExecutor } from '../../core/sandbox/executor.js';
import { probeSandbox } from '../../core/sandbox/probe.js';
import { toolContext } from '../fixtures/tool-context.js';
import { makeShellTool, makeShellWriteTool } from './shell.js';

/**
 * B1 — the symlinked-`cwd` flip, through the production lanes, not a mock.
 *
 * `makeLane` (`agent/tools/shell.ts`) used to check `cwd` lexically
 * (`resolve(scope.root, …)`), while `execute()` (`core/sandbox/executor.ts`)
 * feeds `cwd` to `buildReadScope` → `resolveReadRoot` → `realpathSync`. A
 * `cwd` that is a symlink inside the project pointing to a sensitive tree
 * outside passed the check and landed resolved in `allowRead` on both lanes.
 *
 * This file is the live proof: a symlink in the workspace points at an
 * outside directory holding a canary, and reading through the symlinked
 * `cwd` on **both** lanes must fail — the tool refuses, tier stays 0, the
 * canary never reaches the content. The unit twin in `shell.test.ts`
 * (fake executor, no sandbox) pins that the refusal happens before the
 * executor is reached; here a real command runs and the sandbox is real.
 *
 * **The mutation that must turn it red:** the `realpathSync`
 * canonicalisation in `makeLane` removed (back to the lexical
 * `resolve`/`relative` check) — the symlinked `cwd` passes the tool and the
 * resolved outside tree becomes readable, so the canary lands in `content`.
 *
 * The control leg first: a plain in-workspace read succeeds on both lanes,
 * so a green pair below cannot be read as a dead sandbox.
 */
const host = platform();

/** Same gate as `core/sandbox/confine-sola-lettura.test.ts`, same reasoning. */
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

describe('B1 prova dichiarata: o gira, o lo skip è dichiarato', () => {
  it('o la prova è girata, o lo skip è dichiarato — e dove era richiesta, uno skip è un guasto', () => {
    if (gate.run) {
      expect(gate.why).not.toBe('');
      return;
    }
    if (containmentRequired) {
      throw new Error(
        `MUFFIN_REQUIRE_SANDBOX=1 e nessun contenimento reale è girato su questo host — ${gate.why}.`,
      );
    }
    console.warn(`[sandbox] symlinked-cwd NON provato — ${gate.why}`);
    expect(gate.why).not.toBe('');
  });
});

describe.runIf(gate.run)(`B1: un cwd symlink verso fuori non legge (${gate.why})`, () => {
  const base = mkdtempSync(join(tmpdir(), 'muffin-symlink-cwd-'));
  const workspace = join(base, 'workspace');
  const outside = join(base, 'outside');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const CANARY = 'CANARY-SYMLINK-CWD-FUORI-PERIMETRO';
  writeFileSync(join(outside, 'canary.txt'), `${CANARY}\n`);
  writeFileSync(join(workspace, 'visibile.txt'), 'pubblico\n');
  symlinkSync(outside, join(workspace, 'link'));

  const executor = new SandboxExecutor({ denyWrite: [], denyRead: [] });
  const ctx = toolContext();

  afterAll(async () => {
    await executor.close();
  });

  it('controllo: una lettura nel workspace riesce su entrambe le corsie', async () => {
    for (const make of [makeShellTool, makeShellWriteTool]) {
      const out = await make(executor, { root: workspace }).handler(
        { command: 'cat visibile.txt', description: 'leggo un file del workspace' },
        ctx,
      );
      // Success carries no `isError` field (`formatExecOutcome` omits it on
      // exit 0), so assert falsy rather than literal `false`.
      expect(out.isError).toBeFalsy();
      expect(out.content).toContain('pubblico');
    }
  });

  it('shell_run rifiuta la lettura via cwd symlink verso fuori', async () => {
    const out = await makeShellTool(executor, { root: workspace }).handler(
      { command: 'cat canary.txt', cwd: 'link', description: 'leggo via symlink' },
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(out.content).toContain('escapes');
    expect(out.content).not.toContain(CANARY);
    expect(out.tier).toBe(0);
  });

  it('shell_run_write rifiuta la lettura via cwd symlink verso fuori', async () => {
    const out = await makeShellWriteTool(executor, { root: workspace }).handler(
      { command: 'cat canary.txt', cwd: 'link', description: 'leggo via symlink' },
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(out.content).toContain('escapes');
    expect(out.content).not.toContain(CANARY);
    expect(out.tier).toBe(0);
  });
});
