import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../cli/init.js';
import type { SandboxProbe } from '../core/sandbox/probe.js';
import { buildRuntime, type Runtime } from './runtime.js';

/**
 * One line in `buildRuntime` decides whether the model is offered a way to run
 * commands at all:
 *
 *     if (assessShellBoundary(executor.status()).usable) tools.push(makeShellTool(...));
 *
 * ADR-0018 rule 5 — "sandbox non disponibile ≠ silenziosamente unsandboxed" —
 * is that line and nothing else, and #642 widened it: a behavioral pass alone
 * is not enough when the mechanism is bubblewrap, because the setup-time class
 * (CVE-2026-87766) is invisible to the probe. The containment tests prove the
 * sandbox contains; this proves the *absence* of a usable boundary removes the
 * tool — probe negative, or probe green with an unverified patch posture —
 * which is the half no containment test can reach. Both halves were built and
 * only one was ever asserted, which is this repository's signature defect
 * (AGENTS.md: four defences with correct logic and no caller).
 *
 * The probe is mocked rather than the platform: what the gate reads is the
 * probe's verdict, so that is what a test must be able to set. The bwrap
 * version is mocked the same way — a fixture, never a claim about the host
 * that runs the suite.
 */

const verdict = vi.hoisted(() => ({
  current: null as SandboxProbe | null,
  version: null as string | null,
}));

vi.mock('../core/sandbox/probe.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../core/sandbox/probe.js')>();
  return { ...mod, probeSandbox: () => verdict.current ?? mod.probeSandbox() };
});

vi.mock('../core/sandbox/bubblewrap-version.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../core/sandbox/bubblewrap-version.js')>();
  return { ...mod, readBubblewrapVersion: () => verdict.version };
});

const contains: SandboxProbe = { available: true, mechanism: 'seatbelt' };
const containsBwrap: SandboxProbe = { available: true, mechanism: 'bubblewrap' };
const doesNot: SandboxProbe = {
  available: false,
  mechanism: 'bubblewrap',
  reason: 'userns_denied',
  detail: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted',
  remedy: 'add an AppArmor profile for bwrap',
};

function build(): Runtime {
  const home = mkdtempSync(join(tmpdir(), 'muffin-gate-'));
  runInit({ home, apiKey: 'sk-never-called' });
  return buildRuntime(home, mkdtempSync(join(tmpdir(), 'muffin-gate-ws-')));
}

function toolNames(): string[] {
  return build().deps.tools.map((t) => t.spec.name);
}

describe('the shell tool exists only where a containment was proved', () => {
  beforeEach(() => {
    verdict.current = null;
    verdict.version = null;
  });

  it('a probe that proved containment registers both lanes', () => {
    verdict.current = contains;
    const runtime = build();
    const names = runtime.deps.tools.map((t) => t.spec.name);
    expect(names).toContain('shell_run');
    expect(names).toContain('shell_run_write');
    expect(runtime.executor).not.toBeNull();
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
    // Dal 06/09 (ADR-0074 punto 4) le corsie sono due, e la sola lettura non è un
    // ripiego per un host senza sandbox: è la *più stretta* delle due e la sua
    // promessa — niente scritture fuori dallo scratch, niente rete — è la
    // promessa del sandbox. Registrarla dove il contenimento non si prova
    // sarebbe la degradazione silenziosa che l'ADR vieta, dalla parte opposta.
    expect(names).not.toContain('shell_run_write');
    // Not a general outage: the rest of the toolset is untouched, so a red here
    // means the gate, not a broken runtime.
    expect(names).toContain('fs_read');
  });

  /**
   * #642: the defect this lane exists for. Behavioral probe green, bubblewrap
   * present, version below the upstream CVE-2026-87766 fix — the exact shape
   * of centria-zero (bwrap 0.11.1). Before the shared boundary, this host
   * registered both lanes while doctor could only warn. Fixture declared: the
   * version string is pinned here, not read from the machine running the suite.
   */
  it('bubblewrap probe green + fixture < 0.12.0 → no shell lanes, gap says why (#642)', () => {
    verdict.current = containsBwrap;
    verdict.version = 'bubblewrap 0.11.1';
    const runtime = build();
    const names = runtime.deps.tools.map((t) => t.spec.name);
    expect(names).not.toContain('shell_run');
    expect(names).not.toContain('shell_run_write');
    expect(names).toContain('fs_read');
    const gap = runtime.capabilityGaps.find((g) => g.capability === 'shell_run, shell_run_write');
    expect(gap?.kind).toBe('disabled');
    expect(gap?.reason).toMatch(/CVE-2026-87766|unverified/);
    expect(gap?.remedy).toBeTruthy();
    // The job runner reads the same `contained` flag: no executor to run
    // scripts outside a model turn either.
    expect(runtime.executor).toBeNull();
  });

  /**
   * The positive half, also a declared fixture: same green probe, patch
   * posture trusted, lanes return. Without this, "no tools when unverified"
   * could be satisfied by a gate that never lets the shell in at all.
   */
  it('bubblewrap probe green + patched fixture still exposes no execution while AF_UNIX is unrestricted', () => {
    verdict.current = containsBwrap;
    verdict.version = 'bubblewrap 0.12.0';
    const runtime = build();
    const names = runtime.deps.tools.map((t) => t.spec.name);
    expect(names).not.toContain('shell_run');
    expect(names).not.toContain('shell_run_write');
    expect(runtime.executor).toBeNull();
    const gap = runtime.capabilityGaps.find((g) => g.capability === 'shell_run, shell_run_write');
    expect(gap?.kind).toBe('disabled');
    expect(gap?.reason).toMatch(/AF_UNIX.*unfiltered|allowAllUnixSockets/i);
    expect(gap?.remedy).toMatch(/verified Linux socket filtering/);
  });
});
