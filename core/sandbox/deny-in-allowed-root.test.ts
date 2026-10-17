import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
 * Hardlink residual: `ln .env copy && cat copy` in the write lane names the
 * same inode through a non-denied spelling. Whether the sandbox denies by
 * path or by inode is backend-specific; the variant below records the live
 * outcome on this host rather than asserting a mechanism no backend promises.
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

  it('run (write lane): anche via hardlink ln .env copy && cat copy resta negato', async () => {
    // Live 2026-10-17, macOS seatbelt: `ln` stesso fallisce con
    // `Operation not permitted`, quindi `cat copy` non gira affatto
    // (exit != 0, nessun canarino). Se un backend futuro lo lasciasse passare,
    // questo test diventerebbe rosso — e quella è la forma giusta per un
    // residual: un rosso, non un paragrafo.
    const r = await executor.run({
      command: 'rm -f copy && ln .env copy && cat copy',
      cwd: workspace,
      writeScope: [workspace],
    });
    expect(r.code).not.toBe(0);
    expect(r.stdout).not.toContain(CANARY);
  });
});
