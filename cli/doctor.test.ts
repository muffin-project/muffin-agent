import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { paths, writeSecret } from '../core/config/config.js';
import { TurnStore } from '../core/turns/store.js';
import { MemoryStore } from '../core/memory/store.js';
import {
  ConsolidationLog,
  type ConsolidationOutcome,
  type ConsolidationRun,
} from '../core/memory/consolidator.js';
import { seal } from '../core/rot/verify.js';
import type { SupervisorProbes } from '../core/gateway/supervisor.js';
import { runInit } from './init.js';
import { runDoctor, sandboxOkDetail, type Check } from './doctor.js';

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

describe('doctor reads undelivered turns — D3 (judge, PR #42)', () => {
  /**
   * `TurnStore.undelivered()` had zero callers and zero tests before this:
   * B8's own guarantee ("un job che dice inviato è arrivato") was checkable
   * in principle and unchecked in practice. This is the wiring test —
   * `runDoctor` is the real production entry point, not `undelivered()`
   * called directly, so it proves the mechanism is reached rather than only
   * that its logic is correct.
   */
  it('warns, naming the count and the oldest, when a done turn never settled its delivery', () => {
    const dir = home();
    const db = new DatabaseCtor(paths(dir).db);
    const store = new TurnStore(db);
    const counters = {
      iterations: 1,
      recoveriesUsed: 0,
      transportRetriesLeft: 3,
      toolCallsMade: 0,
      nudgedForCompletion: false,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      spentUsd: 0,
      resumes: 0,
      contextBuilt: false,
    };
    // A turn created with a `replyTo` starts `delivery: 'pending'`
    // (core/turns/store.ts `create`) — exactly what a process dying between
    // "the answer is ready" and "the surface confirmed it went out" leaves
    // behind, since nothing but a settled delivery ever moves it off `pending`.
    const undelivered = store.create({
      id: 'turn-undelivered-1',
      principal: { kind: 'owner', connector: 'telegram', externalId: '1' },
      tenant: 'host',
      surface: 'telegram',
      sessionId: 'sess-1',
      model: 't',
      messages: [],
      taint: 0,
      counters,
      replyTo: { chatId: 1, messageId: 1 },
    });
    store.finish('turn-undelivered-1', { outcome: 'answered', messages: [], taint: 0, counters }, undelivered.claimToken);
    db.close();

    const c = check(dir, 'consegne');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('1 turni');
    expect(c?.detail).toContain('turn-undeliv'); // TurnRecord.id.slice(0, 12)
    rmSync(dir, { recursive: true, force: true });
  });

  it('is ok, naming none missing, when every delivered turn actually settled', () => {
    const dir = home();
    const db = new DatabaseCtor(paths(dir).db);
    const store = new TurnStore(db);
    const counters = {
      iterations: 1,
      recoveriesUsed: 0,
      transportRetriesLeft: 3,
      toolCallsMade: 0,
      nudgedForCompletion: false,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      spentUsd: 0,
      resumes: 0,
      contextBuilt: false,
    };
    const settled = store.create({
      id: 'turn-settled-1',
      principal: { kind: 'owner', connector: 'telegram', externalId: '1' },
      tenant: 'host',
      surface: 'telegram',
      sessionId: 'sess-1',
      model: 't',
      messages: [],
      taint: 0,
      counters,
      replyTo: { chatId: 1, messageId: 1 },
    });
    store.finish('turn-settled-1', { outcome: 'answered', messages: [], taint: 0, counters }, settled.claimToken);
    store.delivered('turn-settled-1', 'sent'); // the settlement `Scheduler.settle` writes in production
    db.close();

    const c = check(dir, 'consegne');
    expect(c?.level).toBe('ok');
    rmSync(dir, { recursive: true, force: true });
  });

  it('says nothing at all on a fresh install — no turns table yet, not a fabricated "ok"', () => {
    // Same posture as the 'turni' check right above this one in doctor.ts: an
    // absent table means no turn has ever run here, which is the correct
    // state on day one, not a second thing to report alongside it.
    const dir = home();
    expect(check(dir, 'consegne')).toBeUndefined();
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

describe('doctor names turns whose answer has nowhere to go', () => {
  /**
   * D2, judge round 2: `LaneEvent.undeliverable` was emitted but reached only
   * the stderr of whichever process resumed the turn — invisible to `doctor`,
   * which opens its own handle on the same database and never saw the event.
   * `agent/turn-lane.ts` now writes `delivery = 'undeliverable'` on the row
   * itself, which is what this check reads back. The mutation that proves it
   * is load-bearing: deleting that write leaves this warn permanently absent.
   */
  const seedUndeliverable = (dir: string): void => {
    const db = new DatabaseCtor(paths(dir).db);
    const store = new TurnStore(db);
    store.create({
      id: 'turn-undeliverable',
      principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
      tenant: 'host',
      surface: 'telegram',
      sessionId: 's1',
      model: 'claude-opus-5',
      messages: [],
      taint: 0,
      counters: {
        iterations: 0,
        recoveriesUsed: 0,
        transportRetriesLeft: 2,
        toolCallsMade: 0,
        nudgedForCompletion: false,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        spentUsd: 0,
        resumes: 0,
        contextBuilt: false,
      },
    });
    store.delivered('turn-undeliverable', 'undeliverable');
    db.close();
  };

  it('says nothing on an install where every answer had somewhere to go', () => {
    const dir = home();
    expect(check(dir, 'turni senza indirizzo')).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('warns, and names the count, when one is stranded', () => {
    const dir = home();
    seedUndeliverable(dir);
    const c = check(dir, 'turni senza indirizzo');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('1 turni con risposta senza indirizzo');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('doctor tells the four consolidation outcomes apart', () => {
  /**
   * The four outcomes are four different facts about the lane, and for a long
   * time three of them printed the same green line. `budget` had its own branch;
   * `ran`, `busy` and `error` all fell through to one `ok` that named episodes,
   * facts and the run count — and never `errors`. So a batch that threw wrote a
   * blank row and read like a quiet week, and a batch where a third of the
   * episodes failed to extract read like one where none did.
   *
   * `errors` is the count of per-episode failures inside a batch that otherwise
   * finished (`consolidator.ts`, the `outcome: report.busy ? 'busy' : 'ran'`
   * write). It is comparable to `episodes` because `episodes` counts *attempts*
   * (`ingest.ts` §`marked`).
   */
  const seedRun = (
    dir: string,
    outcome: ConsolidationOutcome,
    errors = 0,
    over: Partial<ConsolidationRun> = {},
  ): void => {
    const db = new DatabaseCtor(paths(dir).db);
    new ConsolidationLog(db).record({
      ranAt: new Date('2026-08-15T09:00:00Z'),
      trigger: 'idle',
      outcome,
      episodes: 12,
      facts: 3,
      superseded: 0,
      indexed: 4,
      review: 0,
      errors,
      ms: 8_000,
      merged: 0,
      ...over,
    });
    db.close();
  };

  it('is ok, with the numbers, on a clean run', () => {
    const dir = home();
    seedRun(dir, 'ran');
    const report = runDoctor(dir);
    const c = report.checks.find((x) => x.name === 'consolidamento');
    expect(c?.level).toBe('ok');
    expect(c?.detail).toContain('12 episodi');
    expect(c?.detail).toContain('3 fatti');
    expect(c?.detail).not.toContain('falliti');
    rmSync(dir, { recursive: true, force: true });
  });

  it('names the failed episodes even when it stays green', () => {
    // The defect, at the size it actually shipped: a third of the batch failed
    // to extract and the line carried nothing but the successes. Still `ok` on
    // purpose — a failed extraction is left unmarked and retried next fire, so a
    // minority of them is the lane healing itself, and an exit 1 over that is
    // how a line stops being read. The count has to be *there*; it does not have
    // to be an alarm.
    const dir = home();
    seedRun(dir, 'ran', 4);
    const report = runDoctor(dir);
    const c = report.checks.find((x) => x.name === 'consolidamento');
    expect(c?.level).toBe('ok');
    expect(c?.detail).toContain('4 falliti');
    expect(c?.detail).toContain('12 episodi');

    // Against a clean seed rather than against a literal: a fresh install warns
    // about three unrelated things (sandbox mode, empty vector index, no
    // gateway), so pinning `exitCode` to a number here would be asserting facts
    // about checks this block does not test. The claim is the comparison — four
    // failed episodes move nothing.
    const clean = home();
    seedRun(clean, 'ran');
    expect(report.exitCode).toBe(runDoctor(clean).exitCode);

    rmSync(dir, { recursive: true, force: true });
    rmSync(clean, { recursive: true, force: true });
  });

  it('warns when the whole batch went nowhere, because those episodes come back', () => {
    // What does not heal on its own: every attempted episode failed and nothing
    // was added, so the same rows fail again next run, and again.
    const dir = home();
    seedRun(dir, 'ran', 12, { episodes: 12, facts: 0 });
    const report = runDoctor(dir);
    const c = report.checks.find((x) => x.name === 'consolidamento');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('12 errori su 12 episodi');
    expect(c?.remedy).toContain('muffin memory extract');
    rmSync(dir, { recursive: true, force: true });
  });

  it('stays green when the sweep threw but the batch worked', () => {
    // `errors >= episodes` alone is not the condition. The maintenance sweep
    // pushes its own failure into `report.errors`, so a one-episode run that
    // extracted a fact and then tripped the sweep arrives here as 1 error over 1
    // episode — and it is not a lane going nowhere.
    const dir = home();
    seedRun(dir, 'ran', 1, { episodes: 1, facts: 1 });
    const c = check(dir, 'consolidamento');
    expect(c?.level).toBe('ok');
    expect(c?.detail).toContain('1 falliti');
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails on a run that threw, instead of printing its blank row as green', () => {
    // The bigger half of the same defect: `execute` writes zero episodi and zero
    // fatti when `ingest` throws, which through `ok` is indistinguishable from a
    // quiet week — the exact confusion this check exists to remove.
    const dir = home();
    seedRun(dir, 'error', 1, { episodes: 0, facts: 0 });
    const report = runDoctor(dir);
    const c = report.checks.find((x) => x.name === 'consolidamento');
    expect(c?.level).toBe('fail');
    expect(c?.detail).toContain('fallito');
    // The row does not keep the message, so the remedy has to be the command
    // that reproduces it in the foreground.
    expect(c?.remedy).toContain('muffin memory extract');
    expect(report.exitCode).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('warns, naming the cap, when the budget stopped the lane', () => {
    const dir = home();
    seedRun(dir, 'budget', 0, { episodes: 0, facts: 0 });
    const c = check(dir, 'consolidamento');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('budget mensile esaurito');
    expect(c?.remedy).toContain('rot reseal');
    rmSync(dir, { recursive: true, force: true });
  });

  it('is ok on a lock refusal, and says so — it is the guarantee working', () => {
    // `busy` is the lane lock refusing a second extraction, which is the
    // opposite of a failure. Green, but the word has to appear: zero episodi and
    // zero fatti with no explanation is the shape this whole block distrusts.
    //
    // `errors: 1`, not 0: in production a lock refusal always carries one row
    // in `report.errors` — `ingest.ts`'s `acquireIngestLock` rejection pushes
    // its own message there so the caller can see why nothing ran
    // (`core/memory/ingest.ts` §busy) — and `consolidator.ts` writes that count
    // straight into `errors` regardless of outcome. Seeding 0 here hid the
    // defect: a lock refusal is not a per-episode extraction failure, so it
    // must never earn the "N falliti, riprovati al prossimo giro" suffix that
    // means exactly that on a `ran` row.
    const dir = home();
    seedRun(dir, 'busy', 1, { episodes: 0, facts: 0 });
    const c = check(dir, 'consolidamento');
    expect(c?.level).toBe('ok');
    expect(c?.detail).toContain('busy');
    expect(c?.detail).not.toContain('falliti');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('doctor asks whether a supervisor, not just a process, is behind the gateway', () => {
  // A1 (ADR-0035, owner's words): `readGateway` alone is true for a bare
  // `muffin gateway run` in a terminal, exactly the state that does not
  // survive a reboot or a logout. `unitFileExists` is always stubbed here —
  // never left to the real probe — because its default reads the *actual*
  // machine's `~/Library/LaunchAgents` or `~/.config/systemd/user`, and a
  // test whose result depends on whether the developer running it has ever
  // installed a real unit is not a test (this file's own header names the
  // same trap for XDG_CONFIG_HOME).

  it('warns with the install command when nothing is installed and no gateway runs', () => {
    const dir = home();
    const report = runDoctor(dir, { supervisorProbes: { unitFileExists: () => false } });
    const c = report.checks.find((x) => x.name === 'supervisore');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('non riparte da solo');
    expect(c?.remedy).toContain('gateway install --write');
    // Never the ceiling severity — a missing supervisor does not fail doctor.
    expect(report.exitCode).not.toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('names the live-but-unsupervised case when a gateway is actually running', () => {
    const dir = home();
    const db = new DatabaseCtor(paths(dir).db);
    // The same shape `readGateway` reads: a pid this process can truthfully
    // call `kill(pid, 0)` on — its own — is what makes the row a *live*
    // claim rather than a dead one.
    db.exec(
      `CREATE TABLE IF NOT EXISTS gateway_lock (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER, taken_at TEXT, since TEXT, status TEXT)`,
    );
    db.prepare(`INSERT INTO gateway_lock (id, pid, taken_at, since, status) VALUES (1, ?, ?, ?, 'in attesa')`).run(
      process.pid,
      new Date().toISOString(),
      new Date().toISOString(),
    );
    db.close();

    const report = runDoctor(dir, { supervisorProbes: { unitFileExists: () => false } });
    const gateway = report.checks.find((x) => x.name === 'gateway');
    const supervisor = report.checks.find((x) => x.name === 'supervisore');
    expect(gateway?.level).toBe('ok'); // sanity: the fixture really did register as a live gateway
    expect(supervisor?.level).toBe('warn');
    expect(supervisor?.detail).toContain('vive finché il terminale');
    rmSync(dir, { recursive: true, force: true });
  });

  it('is ok once the unit is installed and the platform confirms it is engaged', () => {
    const dir = home();
    const engaged: Partial<SupervisorProbes> =
      process.platform === 'darwin'
        ? { unitFileExists: () => true, launchdLoaded: () => true }
        : { unitFileExists: () => true, systemdEnabled: () => true, lingerEnabled: () => true };
    const report = runDoctor(dir, { supervisorProbes: engaged });
    const supervisor = report.checks.find((x) => x.name === 'supervisore');
    expect(supervisor?.level).toBe('ok');
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * ADR-0026 has claimed since it was written that "`doctor` controlla la
 * lunghezza di `TMPDIR` su Linux (#213)". Until this slice that sentence was
 * false — nothing in `doctor.ts` read TMPDIR at all — which is exactly the
 * shape of invisible fact this file exists to catch everywhere else. The
 * `platform` override (test-only, like `supervisorProbes` above) exercises
 * the Linux branch on whichever OS runs the suite, the same reasoning
 * `core/sandbox/probe.test.ts` uses to mock `node:os` for the same reason.
 */
describe('doctor names a TMPDIR that would break the Linux sandbox sockets (#213, ADR-0026)', () => {
  it('warns, naming the length, the limit and #213, when TMPDIR is past the socket-path limit on Linux', () => {
    const dir = home(); // must exist before TMPDIR is stubbed: home() mkdtemps under the real one
    vi.stubEnv('TMPDIR', '/x'.repeat(60)); // 120 chars, past the 108-byte sun_path limit
    const report = runDoctor(dir, { platform: 'linux' });
    const c = report.checks.find((x) => x.name === 'tmpdir');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('120');
    expect(c?.detail).toContain('108');
    expect(c?.detail).toContain('#213');
    expect(c?.remedy).toBeTruthy();
    rmSync(dir, { recursive: true, force: true });
  });

  it('warns anche nella fascia 74–108: il budget è del path del socket, non della directory', () => {
    // Il difetto che il judge ha trovato nel primo giro: 108 speso tutto su
    // TMPDIR nudo, mentre il runtime ci appende sotto 49 caratteri misurati
    // (scratch dell'executor + socket più profondo del bridge). Un TMPDIR di
    // 80 caratteri lasciava doctor verde e il sandbox rotto a runtime.
    const dir = home();
    vi.stubEnv('TMPDIR', '/x'.repeat(40)); // 80 chars: sotto 108 da solo, oltre col percorso reale
    const report = runDoctor(dir, { platform: 'linux' });
    const c = report.checks.find((x) => x.name === 'tmpdir');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('80');
    expect(c?.detail).toContain('49');
    rmSync(dir, { recursive: true, force: true });
  });

  it('is ok, naming the limit, when TMPDIR is short on Linux', () => {
    const dir = home();
    vi.stubEnv('TMPDIR', '/tmp');
    const report = runDoctor(dir, { platform: 'linux' });
    const c = report.checks.find((x) => x.name === 'tmpdir');
    expect(c?.level).toBe('ok');
    expect(c?.detail).toContain('/tmp');
    rmSync(dir, { recursive: true, force: true });
  });

  it('says nothing on a platform where the sandbox does not proxy through a Unix socket', () => {
    const dir = home();
    vi.stubEnv('TMPDIR', '/x'.repeat(60));
    const report = runDoctor(dir, { platform: 'darwin' });
    expect(report.checks.find((x) => x.name === 'tmpdir')).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('sandboxOkDetail — the sandbox "ok" line is honest about which platform actually contained it', () => {
  it('is a plain summary for seatbelt', () => {
    const line = sandboxOkDetail({ available: true, mechanism: 'seatbelt' });
    expect(line).toContain('seatbelt');
    expect(line).not.toContain('weaker');
  });

  it('names the Linux gap on bubblewrap — Unix-socket hardening is off there (executor.ts, #428/#429)', () => {
    const line = sandboxOkDetail({ available: true, mechanism: 'bubblewrap' });
    expect(line).toContain('bubblewrap');
    expect(line.toLowerCase()).toContain('weaker');
    expect(line).toMatch(/unix.socket/i);
  });
});
