import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../cli/init.js';
import { buildRuntime } from './runtime.js';
import type { SandboxProbe } from '../core/sandbox/probe.js';

/**
 * One line in `buildRuntime` decides whether the model is offered a way to run
 * commands at all:
 *
 *     if (executor.status().available) tools.push(makeShellTool(...));
 *
 * ADR-0018 rule 5 — "sandbox non disponibile ≠ silenziosamente unsandboxed" —
 * is that line and nothing else. The containment tests prove the sandbox
 * contains; this proves the *absence* of a sandbox removes the tool, which is
 * the half no containment test can reach. Both halves were built and only one
 * was ever asserted, which is this repository's signature defect (AGENTS.md:
 * four defences with correct logic and no caller).
 *
 * The probe is mocked rather than the platform: what the gate reads is the
 * probe's verdict, so that is what a test must be able to set.
 */

const verdict = vi.hoisted(() => ({ current: null as SandboxProbe | null }));

vi.mock('../core/sandbox/probe.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../core/sandbox/probe.js')>();
  return { ...mod, probeSandbox: () => verdict.current ?? mod.probeSandbox() };
});

const contains: SandboxProbe = { available: true, mechanism: 'seatbelt' };
const doesNot: SandboxProbe = {
  available: false,
  mechanism: 'bubblewrap',
  reason: 'userns_denied',
  detail: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted',
  remedy: 'add an AppArmor profile for bwrap',
};

function toolNames(): string[] {
  const home = mkdtempSync(join(tmpdir(), 'muffin-gate-'));
  runInit({ home, apiKey: 'sk-never-called' });
  const runtime = buildRuntime(home, mkdtempSync(join(tmpdir(), 'muffin-gate-ws-')));
  return runtime.deps.tools.map((t) => t.spec.name);
}

describe('the shell tool exists only where a containment was proved', () => {
  beforeEach(() => {
    verdict.current = null;
  });

  it('a probe that proved containment registers shell_run', () => {
    verdict.current = contains;
    expect(toolNames()).toContain('shell_run');
  });

  /**
   * The one that matters. On the production VPS the probe answered exactly this
   * for the whole life of the previous system's flag — and there the tool was
   * registered anyway and ran uncontained. Here the absence of the sandbox must
   * be the absence of the tool: no unsandboxed fallback, no degraded variant,
   * nothing for the model to reach for.
   */
  it('a probe that could not prove containment removes it — no unsandboxed fallback', () => {
    verdict.current = doesNot;
    const names = toolNames();
    expect(names).not.toContain('shell_run');
    // Not a general outage: the rest of the toolset is untouched, so a red here
    // means the gate, not a broken runtime.
    expect(names).toContain('fs_read');
  });
});
