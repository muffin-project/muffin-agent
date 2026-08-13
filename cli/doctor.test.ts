import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { paths } from '../core/config/config.js';
import { seal } from '../core/rot/verify.js';
import { runInit } from './init.js';
import { runDoctor, type Check } from './doctor.js';

/**
 * Doctor exists to say which of two indistinguishable states you are in.
 *
 * The cache dialect is the precedent: inferred from the endpoint, invisible to
 * the owner, and a wrong inference pays full input price on every turn in
 * silence. Where the permission matrix comes from is the same shape of fact —
 * the sealed file and the compiled fallback produce identical behaviour on a
 * default install, and the owner has no other way to learn which one answered.
 */

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-doctor-'));
  runInit({ home: dir, apiKey: 'sk-never-called' });
  return dir;
}

const check = (dir: string, name: string): Check | undefined =>
  runDoctor(dir).checks.find((c) => c.name === name);

describe('doctor names the source of the permission matrix', () => {
  it('says the sealed file when the sealed file spoke', () => {
    const dir = home();
    const c = check(dir, 'policy matrix');
    expect(c?.level).toBe('ok');
    expect(c?.detail).toContain('rot/policy.json');
    rmSync(dir, { recursive: true, force: true });
  });

  it('says fallback, with the reason, when the file could not be used', () => {
    const dir = home();
    writeFileSync(join(paths(dir).rot, 'policy.json'), 'not json at all');
    const c = check(dir, 'policy matrix');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('fallback');
    expect(c?.remedy).toBeTruthy();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('doctor names which profile the configured model resolves to', () => {
  it('is ok, naming the resolved profile, when nothing was dropped', () => {
    const dir = home(); // cli/init.ts writes models.main = claude-sonnet-5
    const c = check(dir, 'model profile');
    expect(c?.level).toBe('ok');
    expect(c?.detail).toBe('claude-sonnet-5 -> frontier');
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails and names the cost when the configured model falls back to conservative', () => {
    // D3 + D4 (judge, 2026-08-13): `profile.ts:109` and ADR-0037 both say a
    // stale profile is "nominato in `doctor`" — false until this test: the
    // problems used to reach only `bootLines` (stderr at boot), which
    // `doctor` never ran. A `profilesDir` stands in for `agent/profiles/`
    // here so the test never touches the real shipped files — another agent
    // in this worktree is concurrently editing unrelated ones.
    const dir = home();
    const profilesDir = mkdtempSync(join(tmpdir(), 'muffin-doctor-profiles-'));
    writeFileSync(
      join(profilesDir, 'frontier.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'frontier',
        match: ['*claude-sonnet-5*'],
        maxToolsExposed: 24,
        maxToolCallsPerTurn: 30,
        thinking: 'allowed', // stale, pre-ADR-0037 vocabulary — dropped at the boundary
        sampling: 'model-default',
        recovery: ['nudge', 'retryOnce'],
        notes: '',
      }),
    );
    const report = runDoctor(dir, { profilesDir });
    const c = report.checks.find((x) => x.name === 'model profile');

    expect(c?.level).toBe('fail');
    expect(c?.detail).toContain('frontier.json'); // which file
    expect(c?.detail).toContain('thinking'); // which field (D4 half 1: the zod path)
    expect(c?.detail).toContain('claude-sonnet-5'); // which configured model paid for it
    expect(c?.detail).toContain('conservativo');
    // The cost, not just the fact (D4 half 2): the fallback's own numbers,
    // named — not merely "something changed".
    expect(c?.detail).toContain('sampling deterministic');
    expect(c?.detail).toContain('10 tool esposti');
    expect(c?.detail).toContain('orizzonte 15');
    expect(report.exitCode).toBe(2);

    rmSync(dir, { recursive: true, force: true });
    rmSync(profilesDir, { recursive: true, force: true });
  });

  it('warns without failing when a problem fires but the configured model is unaffected', () => {
    // A dropped profile that the owner's actual model never would have
    // matched is still worth a line — just not a `fail`: nothing this owner
    // runs today is degraded by it.
    const dir = home();
    const profilesDir = mkdtempSync(join(tmpdir(), 'muffin-doctor-profiles-'));
    writeFileSync(
      join(profilesDir, 'frontier.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'frontier',
        match: ['*claude-sonnet-5*'],
        maxToolsExposed: 24,
        maxToolCallsPerTurn: 30,
        thinking: 'adaptive',
        sampling: 'model-default',
        recovery: ['nudge', 'retryOnce'],
        notes: '',
      }),
    );
    writeFileSync(
      join(profilesDir, 'consumer-local.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'consumer-local',
        match: ['*gemma*'],
        maxToolsExposed: 10,
        maxToolCallsPerTurn: 15,
        thinking: 'allowed', // stale — this file is dropped, frontier is not
        recovery: [],
        notes: '',
      }),
    );
    const report = runDoctor(dir, { profilesDir });
    const c = report.checks.find((x) => x.name === 'model profile');

    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('consumer-local.json');
    expect(c?.detail).toContain('claude-sonnet-5 risolve comunque su "frontier"');
    expect(report.exitCode).toBeLessThan(2);

    rmSync(dir, { recursive: true, force: true });
    rmSync(profilesDir, { recursive: true, force: true });
  });
});

describe('doctor runs the root-of-trust readers invariant', () => {
  it('passes on a fresh install', () => {
    const dir = home();
    expect(check(dir, 'rot readers')?.level).toBe('ok');
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails, and exits non-zero, on a sealed file nothing reads', () => {
    // The wiring half: an invariant that runs nowhere is the defect examining
    // itself. Asserted on the exit code too, because a check that only prints
    // is a check a script can ignore.
    const dir = home();
    writeFileSync(join(paths(dir).rot, 'decorative.json'), '{"binding":true}\n');
    seal(dir, '1', new Date());
    const report = runDoctor(dir);
    const c = report.checks.find((x) => x.name === 'rot readers');
    expect(c?.level).toBe('fail');
    expect(c?.detail).toContain('decorative.json');
    expect(report.exitCode).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
});
