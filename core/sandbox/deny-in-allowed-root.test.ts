import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mandatoryGuards } from '../rot/guards.js';
import { SandboxExecutor } from './executor.js';
import { probeSandbox } from './probe.js';

/**
 * B2 — a guard-denied secret nested inside an allowed root stays denied on
 * both lanes.
 *
 * The working-directory `.env` ADR-0030 tells the owner to create lives
 * *inside* the workspace, which the read scope allows (`cwd`/`writeScope` are
 * allow roots). It stays unreadable only because `mandatoryGuards`
 * (`core/rot/guards.ts`) puts `join(cwd, '.env')` in `denyRead`, and the
 * executor layers `guards.denyRead` over `buildReadScope` on every call
 * (`core/sandbox/executor.ts` `execute()`): nested-deny re-emit on macOS,
 * exact file-mask and tmpfs ordering on Linux.
 *
 * This file is the live falsifier: a real `.env` with a canary in a real
 * workspace, read directly on **both** lanes (`runReadOnly` and `run` with
 * the workspace in `writeScope`). Both must fail without leaking the canary.
 * The control leg (a visible file in the same workspace) must succeed on
 * both lanes, so a green pair below cannot be read as a dead sandbox.
 *
 * **The mutation that must turn it red:** the `.env` entry removed from
 * `denyRead` (or `execute()` no longer layering `guards.denyRead`) — the
 * direct read then succeeds and the canary lands in `stdout`.
 *
 * Hardlink residual: `guards.denyRead` names `.env` as a *path*, not an inode,
 * so a hardlink that already exists host-side (`ln .env copy`) names the same
 * inode under a non-denied spelling and is read through. The model cannot
 * create that link from inside the sandbox (the creation leg below measures
 * macOS `ln` at `Operation not permitted`), so the trigger is a link the host
 * already had — and a process able to create one already reads `.env`
 * directly. The leg below creates the alias host-side and *records* the live
 * outcome (record-only, like the mid-command hooks-dir replacement in
 * `executor.selftest.test.ts`): no inode-aware denial exists today, so this is
 * a warning pinning the behaviour, not a refusal. The day inode-aware denial
 * lands, that leg flips to denied and must be re-gated.
 */
const host = platform();

/** Same gate as `core/sandbox/executor.test.ts`, same reasoning. */
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

describe('il confine dichiara se è stato provato', () => {
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
    console.warn(`[sandbox] denied-in-allowed-root NON provato — ${gate.why}`);
    expect(gate.why).not.toBe('');
  });
});

describe.runIf(gate.run)(`B2: un segreto negato dentro una root permessa resta negato (${gate.why})`, () => {
  const base = mkdtempSync(join(tmpdir(), 'muffin-deny-in-allowed-'));
  const workspace = join(base, 'workspace');
  const home = join(base, 'muffin-home');
  const userHome = join(base, 'user-home');
  for (const d of [workspace, home, userHome]) mkdirSync(d, { recursive: true });
  const CANARY = 'CANARY-DENIED-IN-ALLOWED-ENV';
  writeFileSync(join(workspace, '.env'), `LLM_API_KEY=${CANARY}\n`);
  writeFileSync(join(workspace, 'visibile.txt'), 'pubblico\n');

  // Production guards: the `.env` deny comes from `mandatoryGuards`, not from
  // a hand-written list in this file.
  const guards = mandatoryGuards(home, workspace, userHome);
  expect(guards.denyRead).toContain(join(workspace, '.env'));

  const executor = new SandboxExecutor({ denyWrite: guards.denyWrite, denyRead: guards.denyRead });

  afterAll(async () => {
    await executor.close();
  });

  it('controllo: un file visibile dello stesso workspace si legge su entrambe le corsie', async () => {
    const ro = await executor.runReadOnly({ command: 'cat visibile.txt', cwd: workspace });
    expect(ro.code).toBe(0);
    expect(ro.stdout).toContain('pubblico');
    const wr = await executor.run({
      command: 'cat visibile.txt',
      cwd: workspace,
      writeScope: [workspace],
    });
    expect(wr.code).toBe(0);
    expect(wr.stdout).toContain('pubblico');
  });

  it('runReadOnly: la lettura diretta di .env negato-in-permesso fallisce', async () => {
    const r = await executor.runReadOnly({ command: 'cat .env', cwd: workspace });
    expect(r.code).not.toBe(0);
    expect(r.stdout).not.toContain(CANARY);
  });

  it('run: la lettura diretta di .env negato-in-permesso fallisce', async () => {
    const r = await executor.run({
      command: 'cat .env',
      cwd: workspace,
      writeScope: [workspace],
    });
    expect(r.code).not.toBe(0);
    expect(r.stdout).not.toContain(CANARY);
  });

  it('run (write lane): creare un hardlink dentro il sandbox è negato (gate di creazione)', async () => {
    // On macOS seatbelt `ln` itself fails with `Operation not permitted`, so
    // `cat copy` never runs. This pins the *creation* gate — it says nothing
    // about a hardlink that already exists, which is the record-only leg below.
    const r = await executor.run({
      command: 'rm -f copy && ln .env copy && cat copy',
      cwd: workspace,
      writeScope: [workspace],
    });
    expect(r.code).not.toBe(0);
    expect(r.stdout).not.toContain(CANARY);
  });

  it('un hardlink pre-esistente al .env resta un residual registrato (deny path-based)', async () => {
    // `guards.denyRead` denies `.env` BY PATH; a host-side hardlink `copy`
    // names the same inode under a non-denied path, so the contained read
    // reaches the secret. The model cannot create the link from inside the
    // sandbox (leg above), so the trigger is a pre-existing host-side alias.
    // Recorded, not gated: `console.warn` pins the live outcome for both
    // lanes while the direct path stays denied, and the control leg proves the
    // sandbox is alive rather than dead.
    const alias = join(workspace, 'copy');
    rmSync(alias, { force: true });
    linkSync(join(workspace, '.env'), alias);

    const direct = await executor.runReadOnly({ command: 'cat .env', cwd: workspace });
    expect(direct.code).not.toBe(0);
    expect(direct.stdout).not.toContain(CANARY);

    const legs: Array<[string, { code: number | null; stdout: string }]> = [
      ['runReadOnly', await executor.runReadOnly({ command: 'cat copy', cwd: workspace })],
      ['run', await executor.run({ command: 'cat copy', cwd: workspace, writeScope: [workspace] })],
    ];
    for (const [name, r] of legs) {
      const leaked = r.stdout.includes(CANARY);
      console.warn(
        `[sandbox] hardlink pre-esistente al .env via ${name}: ${
          leaked ? 'LEGGE (residual aperto, deny path-based)' : 'negato'
        } — exit ${r.code}`,
      );
    }

    const control = await executor.runReadOnly({ command: 'cat visibile.txt', cwd: workspace });
    expect(control.stdout).toContain('pubblico');
  });
});
