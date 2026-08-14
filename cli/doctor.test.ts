import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { paths, writeSecret } from '../core/config/config.js';
import { MemoryStore } from '../core/memory/store.js';
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
  // The persistent secret store defaults to the *real* `~/.config`, so without
  // this every assertion about which backend answered would depend on whether
  // the person running the suite has migrated their own key. A test whose result
  // is a property of the developer's machine is not a test.
  vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'xdg'));
  runInit({ home: dir, apiKey: 'sk-never-called' });
  return dir;
}

afterEach(() => vi.unstubAllEnvs());

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

describe('doctor names the spend cap and where it came from', () => {
  it('says the sealed file, with the numbers', () => {
    // Same class of invisible fact as the matrix above, and worse in
    // consequence: `rot/budgets.json` and `config.json` carried identical caps
    // for months, so nothing anywhere distinguished "the seal holds the cap"
    // from "the seal holds a copy of the cap".
    const dir = home();
    const c = check(dir, 'tetto di spesa');
    expect(c?.level).toBe('ok');
    expect(c?.detail).toContain('rot/budgets.json');
    expect(c?.detail).toContain('80');
    rmSync(dir, { recursive: true, force: true });
  });

  it('warns, with the reason, when the compiled floor is what answered', () => {
    const dir = home();
    writeFileSync(join(paths(dir).rot, 'budgets.json'), 'not json at all');
    const c = check(dir, 'tetto di spesa');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('compilati');
    expect(c?.remedy).toContain('rot reseal');
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a config still carrying the old cap, instead of migrating in silence', () => {
    const dir = home();
    const file = paths(dir).config;
    const config = JSON.parse(readFileSync(file, 'utf8'));
    config.schemaVersion = 1;
    config.budget = { monthlyUsd: 500, perTenantDailyUsd: 9 };
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    const c = check(dir, 'config migrata');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('monthlyUsd 500');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('doctor names which secret store answered', () => {
  it('names the backend and the path, so a chain is never silent', () => {
    const dir = home();
    const c = check(dir, 'api key');
    expect(c?.level).toBe('ok');
    expect(c?.detail).toContain('home');
    expect(c?.detail).toContain(join(paths(dir).secrets, 'provider_api_key'));
    // Never the value. The check counts characters precisely so it does not
    // have to print any of them.
    expect(c?.detail).not.toContain('sk-never-called');
    rmSync(dir, { recursive: true, force: true });
  });

  it('warns when a second copy exists, because the losing one looks identical', () => {
    // The failure this exists for: an owner migrates the key to the persistent
    // store, the old copy in the home keeps answering, and every symptom of a
    // successful migration is present.
    const dir = home();
    writeSecret('provider_api_key', 'sk-never-called', dir, 'persistent');
    const c = check(dir, 'api key');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('non viene mai usata');
    expect(c?.remedy).toBeTruthy();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('doctor names the memory questions waiting on the owner', () => {
  /**
   * The one memory state that cannot resolve itself. A judge `review` verdict
   * leaves **both** beliefs current on purpose — the system refuses to guess —
   * so recall keeps returning both and nothing in the lane will ever choose.
   * Before this, the register had no reader anywhere in production: the rows
   * accumulated and the only number that surfaced was a total over every row
   * ever written, which on an append-only table only grows.
   *
   * Silent when there is nothing open, because a line that fires on the empty
   * case is the firehose ADR-0028 exists to prevent, smaller.
   */
  const seedContradiction = (dir: string): void => {
    const db = new DatabaseCtor(paths(dir).db);
    const store = new MemoryStore(db);
    const episodeId = store.addEpisode({
      tenantId: 'host', connector: 'cli', threadKey: 't', role: 'user', kind: 'message',
      content: 'il commercialista ora è Lucia', trustTier: 0, createdAt: '2026-08-13T10:00:00Z',
    });
    const subjectId = store.upsertEntity('host', 'owner', 'person', '2026-08-13T10:00:00Z');
    const believe = (object: string, at: string) =>
      store.addFact({
        tenantId: 'host', subjectId, predicate: 'accountant', objectValue: object,
        episodeId, trustTier: 0, confidence: 0.9, extractionV: 1, recordedAt: at,
      });
    store.recordReview({
      tenantId: 'host',
      kind: 'contradiction',
      existingFactId: believe('Marco', '2026-06-01T10:00:00Z'),
      incomingFactId: believe('Lucia', '2026-08-13T10:00:00Z'),
      detail: 'nessuna delle due frasi dice quando',
      createdAt: '2026-08-13T10:00:01Z',
    });
    db.close();
  };

  it('says nothing on an install with no open question', () => {
    const dir = home();
    expect(check(dir, 'memoria da decidere')).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('warns, with the command that answers it, when one is open', () => {
    const dir = home();
    seedContradiction(dir);
    const c = check(dir, 'memoria da decidere');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('1 contraddizioni');
    expect(c?.remedy).toContain('muffin memory review');
    rmSync(dir, { recursive: true, force: true });
  });
});
