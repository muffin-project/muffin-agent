import DatabaseCtor from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, paths, saveConfig, writeSecret } from '../core/config/config.js';
import { WORKSPACE_ENV, muffinWorkspace } from '../core/config/workspace.js';
import { TurnStore } from '../core/turns/store.js';
import { MemoryStore } from '../core/memory/store.js';
import {
  ConsolidationLog,
  type ConsolidationOutcome,
  type ConsolidationRun,
} from '../core/memory/consolidator.js';
import { seal } from '../core/rot/verify.js';
import { sealOwnerBinding } from '../core/rot/owner.js';
import type { SupervisorProbes } from '../core/gateway/supervisor.js';
import { runInit } from './init.js';
import { buildRuntime } from '../agent/runtime.js';
import { SandboxExecutor } from '../core/sandbox/executor.js';
import {
  runDoctor,
  sandboxOkDetail,
  quantoDura,
  guastoDopoMsDaEnv,
  GUASTO_DOPO_MS,
  AVVIO_TROPPO_LUNGO_MS,
  type Check,
} from './doctor.js';
import { serveControlSocket, type ControlServer } from '../core/gateway/control-socket.js';
import { GatewayLock } from '../core/gateway/lock.js';
import type { StatoSuperficie } from '../core/surface/salute.js';
import { VectorIndex } from '../core/memory/vectors.js';
import { MEMORY_SCHEMA } from '../core/memory/schema.js';
import type { Embedder } from '../core/memory/embed.js';

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

const check = async (dir: string, name: string): Promise<Check | undefined> =>
  (await runDoctor(dir)).checks.find((c) => c.name === name);

const checkWith = async (dir: string, name: string, options: Parameters<typeof runDoctor>[1]): Promise<Check | undefined> =>
  (await runDoctor(dir, options)).checks.find((c) => c.name === name);

describe('doctor names the source of the permission matrix', () => {
  it('says the sealed file when the sealed file spoke', async () => {
    const dir = home();
    const c = await check(dir, 'policy matrix');
    expect(c?.level).toBe('ok');
    expect(c?.detail).toContain('rot/policy.json');
    rmSync(dir, { recursive: true, force: true });
  });

  it('says fallback, with the reason, when the file could not be used', async () => {
    const dir = home();
    writeFileSync(join(paths(dir).rot, 'policy.json'), 'not json at all');
    const c = await check(dir, 'policy matrix');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('fallback');
    expect(c?.remedy).toBeTruthy();
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * ADR-0059 separated "dove gira il processo" da "dove un turno può scrivere":
 * il workspace è un fratello della casa, creato al primo `buildRuntime`. Fino
 * a questa slice nessuna delle due porte che l'owner guarda (un turno,
 * `muffin doctor`) diceva dove fosse — solo una riga di boot su stderr, che
 * finisce in `gateway.err` e in nessun posto che qualcuno legge.
 *
 * `describeWorkspace` (`core/config/workspace.ts`) non crea mai la cartella:
 * per questo "esiste già" e "non esiste ancora" restano due risposte diverse,
 * cosa che chiamare `resolveWorkspace` da una diagnosi non permetterebbe (crea
 * la cartella incondizionatamente).
 */
describe('doctor nomina il workspace di ADR-0059, mai la casa', () => {
  it('dice che non esiste ancora su un\'installazione fresca, ma resta un ok — niente da fare qui', async () => {
    // Coordinatore, 03/09: un `warn` senza un'azione insegna a scorrere oltre
    // gli avvisi, ed è la regola che una slice mergiata oggi ha già fissato —
    // lead con la conseguenza e l'azione, mai un warn dove non c'è azione.
    // «si crea da sola» non è qualcosa che l'owner deve fare: resta un `ok`
    // con la nota dentro, non un `warn`.
    const dir = home();
    expect(existsSync(muffinWorkspace(dir))).toBe(false);
    const c = await check(dir, 'workspace');
    expect(c?.level).toBe('ok');
    expect(c?.detail).toContain(muffinWorkspace(dir));
    expect(c?.detail).toContain('atterrano le scritture');
    expect(c?.detail).toContain('si crea da sola al primo turno che ci scrive');
    expect(c?.remedy).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('è ok, con lo stesso testo, una volta che il workspace esiste già', async () => {
    const dir = home();
    mkdirSync(muffinWorkspace(dir), { recursive: true });
    const c = await check(dir, 'workspace');
    expect(c?.level).toBe('ok');
    expect(c?.detail).toContain(muffinWorkspace(dir));
    expect(c?.detail).toContain('atterrano le scritture');
    // Distinto dal caso "non esiste ancora": una volta creato non porta più
    // la nota su come si crea.
    expect(c?.detail).not.toContain('si crea da sola');
    expect(c?.remedy).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('dice che MUFFIN_WORKSPACE è stato ignorato, e perché, quando punta dentro la casa — questo resta un warn: è genuinamente suo da correggere', async () => {
    const dir = home();
    vi.stubEnv(WORKSPACE_ENV, dir);
    const c = await check(dir, 'workspace');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain(dir);
    expect(c?.detail).toContain(muffinWorkspace(dir));
    expect(c?.detail).toContain('ignorato');
    expect(c?.remedy).toContain(WORKSPACE_ENV);
    rmSync(dir, { recursive: true, force: true });
  });

  it('nomina esattamente il path che il runtime vero risolve, ok — stessa funzione di `resolveWorkspace`, non un secondo calcolo', async () => {
    // cwd = home forza il caso rilocalizzato: lo scenario misurato dall'ADR
    // (la unit del gateway fissa WorkingDirectory sulla casa). buildRuntime
    // crea davvero la cartella (resolveWorkspace fa mkdirSync), quindi qui
    // il check è 'ok' — non il ramo "non esiste ancora".
    const dir = home();
    const runtime = buildRuntime(dir, dir);
    const risolto = runtime.workspace;
    runtime.close();
    expect(risolto).toBe(muffinWorkspace(dir));

    const c = await check(dir, 'workspace');
    expect(c?.level).toBe('ok');
    expect(c?.detail).toContain(risolto);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('doctor names the everyday consequence of single-user, and the remedy for it', () => {
  it('names sys.shell asking every time, and points at `muffin rot harden`', async () => {
    // `runInit` without `--hardened` seals `single-user` (cli/init.ts) — the
    // mode every fresh install actually has. Before this slice the line named
    // the mechanism (detection, not prevention) but not what the owner feels
    // from it: every high-risk capability asking, always, with no command
    // that gets them out of it.
    const dir = home();
    const c = await check(dir, 'root of trust mode');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('single-user');
    expect(c?.detail).toContain('sys.shell');
    expect(c?.remedy).toContain('muffin rot harden');
    rmSync(dir, { recursive: true, force: true });
  });

  it('leads with what happens to him, and only names the mode afterwards — 03/09/2026 UX pass', async () => {
    // The owner's own complaint, read against real `muffin doctor` output:
    // the line named "root of trust", "single-user", "seal" before it ever
    // said what he should expect or do. This locks the order so a future
    // edit cannot quietly put the vocabulary back in front.
    const dir = home();
    const c = await check(dir, 'root of trust mode');
    const consequenceAt = c!.detail.indexOf('sys.shell');
    const modeNameAt = c!.detail.indexOf('single-user');
    expect(consequenceAt).toBeGreaterThan(-1);
    expect(modeNameAt).toBeGreaterThan(-1);
    expect(consequenceAt).toBeLessThan(modeNameAt);
    // Every warning names something the owner can actually type.
    expect(c?.remedy).toMatch(/`muffin [^`]+`/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('doctor names which profile the configured model resolves to', () => {
  it('is ok, naming the resolved profile, when nothing was dropped', async () => {
    const dir = home(); // cli/init.ts writes models.main = claude-sonnet-5
    const c = await check(dir, 'model profile');
    expect(c?.level).toBe('ok');
    expect(c?.detail).toBe('claude-sonnet-5 -> frontier');
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails and names the cost when the configured model falls back to conservative', async () => {
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
    const report = await runDoctor(dir, { profilesDir });
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
    // Etichettato come su `sys_inspect`, non "orizzonte N" — i due numeri si
    // somigliano (qui: 10 e 15) e vanno distinti per quello che sono, quanti
    // tool si vedono contro quante call si fanno, non con un termine indefinito.
    expect(c?.detail).toContain('15 call/turno');
    expect(report.exitCode).toBe(2);

    rmSync(dir, { recursive: true, force: true });
    rmSync(profilesDir, { recursive: true, force: true });
  });

  it('warns without failing when a problem fires but the configured model is unaffected', async () => {
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
    const report = await runDoctor(dir, { profilesDir });
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
  it('passes on a fresh install', async () => {
    const dir = home();
    expect((await check(dir, 'rot readers'))?.level).toBe('ok');
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails, and exits non-zero, on a sealed file nothing reads', async () => {
    // The wiring half: an invariant that runs nowhere is the defect examining
    // itself. Asserted on the exit code too, because a check that only prints
    // is a check a script can ignore.
    const dir = home();
    writeFileSync(join(paths(dir).rot, 'decorative.json'), '{"binding":true}\n');
    seal(dir, '1', new Date());
    const report = await runDoctor(dir);
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
  it('warns, naming the count and the oldest, when a done turn never settled its delivery', async () => {
    const dir = home();
    const db = new DatabaseCtor(paths(dir).db);
    const store = new TurnStore(db);
    const counters = {
      iterations: 1,
      recoveriesUsed: 0,
      transportRetriesLeft: 3,
      truncationsUsed: 0,
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

    const c = await check(dir, 'consegne');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('1 turni');
    expect(c?.detail).toContain('turn-undeliv'); // TurnRecord.id.slice(0, 12)
    rmSync(dir, { recursive: true, force: true });
  });

  it('is ok, naming none missing, when every delivered turn actually settled', async () => {
    const dir = home();
    const db = new DatabaseCtor(paths(dir).db);
    const store = new TurnStore(db);
    const counters = {
      iterations: 1,
      recoveriesUsed: 0,
      transportRetriesLeft: 3,
      truncationsUsed: 0,
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

    const c = await check(dir, 'consegne');
    expect(c?.level).toBe('ok');
    rmSync(dir, { recursive: true, force: true });
  });

  it('says nothing at all on a fresh install — no turns table yet, not a fabricated "ok"', async () => {
    // Same posture as the 'turni' check right above this one in doctor.ts: an
    // absent table means no turn has ever run here, which is the correct
    // state on day one, not a second thing to report alongside it.
    const dir = home();
    expect(await check(dir, 'consegne')).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('doctor names the spend cap and where it came from', () => {
  it('says the sealed file, with the numbers', async () => {
    // Same class of invisible fact as the matrix above, and worse in
    // consequence: `rot/budgets.json` and `config.json` carried identical caps
    // for months, so nothing anywhere distinguished "the seal holds the cap"
    // from "the seal holds a copy of the cap".
    const dir = home();
    const c = await check(dir, 'tetto di spesa');
    expect(c?.level).toBe('ok');
    expect(c?.detail).toContain('rot/budgets.json');
    expect(c?.detail).toContain('80');
    rmSync(dir, { recursive: true, force: true });
  });

  it('warns, with the reason, when the compiled floor is what answered', async () => {
    const dir = home();
    writeFileSync(join(paths(dir).rot, 'budgets.json'), 'not json at all');
    const c = await check(dir, 'tetto di spesa');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('compilati');
    expect(c?.remedy).toContain('rot reseal');
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a config still carrying the old cap, instead of migrating in silence', async () => {
    const dir = home();
    const file = paths(dir).config;
    const config = JSON.parse(readFileSync(file, 'utf8'));
    config.schemaVersion = 1;
    config.budget = { monthlyUsd: 500, perTenantDailyUsd: 9 };
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    const c = await check(dir, 'config migrata');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('monthlyUsd 500');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('doctor names which secret store answered', () => {
  it('names the backend and the path, so a chain is never silent', async () => {
    const dir = home();
    const c = await check(dir, 'api key');
    expect(c?.level).toBe('ok');
    expect(c?.detail).toContain('home');
    expect(c?.detail).toContain(join(paths(dir).secrets, 'provider_api_key'));
    // Never the value. The check counts characters precisely so it does not
    // have to print any of them.
    expect(c?.detail).not.toContain('sk-never-called');
    rmSync(dir, { recursive: true, force: true });
  });

  it('warns when a second copy exists, because the losing one looks identical', async () => {
    // The failure this exists for: an owner migrates the key to the persistent
    // store, the old copy in the home keeps answering, and every symptom of a
    // successful migration is present.
    const dir = home();
    writeSecret('provider_api_key', 'sk-never-called', dir, 'persistent');
    const c = await check(dir, 'api key');
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

  it('says nothing on an install with no open question', async () => {
    const dir = home();
    expect(await check(dir, 'memoria da decidere')).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('warns, with the command that answers it, when one is open', async () => {
    const dir = home();
    seedContradiction(dir);
    const c = await check(dir, 'memoria da decidere');
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
        truncationsUsed: 0,
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

  it('says nothing on an install where every answer had somewhere to go', async () => {
    const dir = home();
    expect(await check(dir, 'turni senza indirizzo')).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('warns, and names the count, when one is stranded', async () => {
    const dir = home();
    seedUndeliverable(dir);
    const c = await check(dir, 'turni senza indirizzo');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('1 turni con risposta senza indirizzo');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('doctor names continuable leases awaiting the owner', () => {
  const seedContinuable = (dir: string): void => {
    const db = new DatabaseCtor(paths(dir).db);
    const store = new TurnStore(db);
    const created = store.create({
      id: 'turn-continuabile',
      principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
      tenant: 'host',
      surface: 'telegram',
      sessionId: 's1',
      model: 'claude-opus-5',
      messages: [],
      taint: 0,
      counters: {
        iterations: 3,
        recoveriesUsed: 5,
        transportRetriesLeft: 7,
        truncationsUsed: 0,
        toolCallsMade: 2,
        nudgedForCompletion: false,
        usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        spentUsd: 0,
        resumes: 0,
        contextBuilt: true,
        activeModelMs: 0,
      },
    });
    expect(
      store.releaseContinuable(
        'turn-continuabile',
        {
          messages: [],
          taint: 0,
          counters: {
            iterations: 3,
            recoveriesUsed: 5,
            transportRetriesLeft: 7,
            truncationsUsed: 0,
            toolCallsMade: 2,
            nudgedForCompletion: false,
            usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            spentUsd: 0,
            resumes: 0,
            contextBuilt: true,
            activeModelMs: 0,
          },
          reason: { class: 'provider_empty', lease: 0, at: '2026-09-18T17:14:09.000Z' },
        },
        created.claimToken,
      ),
    ).toBe(true);
    db.close();
  };

  it('says nothing when no lease is awaiting continuation', async () => {
    const dir = home();
    expect(await check(dir, 'turni continuabili')).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('names the count and the way back when one is', async () => {
    const dir = home();
    seedContinuable(dir);
    const c = await check(dir, 'turni continuabili');
    expect(c?.level).toBe('ok');
    expect(c?.detail).toContain('1 lease esaurite');
    expect(c?.detail).toContain('muffin resume');
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

  it('is ok, with the numbers, on a clean run', async () => {
    const dir = home();
    seedRun(dir, 'ran');
    const report = await runDoctor(dir);
    const c = report.checks.find((x) => x.name === 'consolidamento');
    expect(c?.level).toBe('ok');
    expect(c?.detail).toContain('12 episodi');
    expect(c?.detail).toContain('3 fatti');
    expect(c?.detail).not.toContain('falliti');
    rmSync(dir, { recursive: true, force: true });
  });

  it('names the failed episodes even when it stays green', async () => {
    // The defect, at the size it actually shipped: a third of the batch failed
    // to extract and the line carried nothing but the successes. Still `ok` on
    // purpose — a failed extraction is left unmarked and retried next fire, so a
    // minority of them is the lane healing itself, and an exit 1 over that is
    // how a line stops being read. The count has to be *there*; it does not have
    // to be an alarm.
    const dir = home();
    seedRun(dir, 'ran', 4);
    const report = await runDoctor(dir);
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
    expect(report.exitCode).toBe((await runDoctor(clean)).exitCode);

    rmSync(dir, { recursive: true, force: true });
    rmSync(clean, { recursive: true, force: true });
  });

  it('warns when the whole batch went nowhere, because those episodes come back', async () => {
    // What does not heal on its own: every attempted episode failed and nothing
    // was added, so the same rows fail again next run, and again.
    const dir = home();
    seedRun(dir, 'ran', 12, { episodes: 12, facts: 0 });
    const report = await runDoctor(dir);
    const c = report.checks.find((x) => x.name === 'consolidamento');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('12 errori su 12 episodi');
    expect(c?.remedy).toContain('muffin memory extract');
    rmSync(dir, { recursive: true, force: true });
  });

  it('un episodio che non lancia non salva un giro andato a vuoto — 13 errori su 14, zero fatti', async () => {
    // Lo stato vero dell'installazione dell'owner il 27/08, letto da
    // `consolidation_runs`: dopo il cambio di modello del 25/08 i tre giri sono
    // stati 3/3, 10/11 e 13/14 errori, sempre con zero fatti. Il primo avvisava,
    // gli altri due erano **verdi** — bastava un episodio che non avesse
    // lanciato perché `errors >= episodes` fallisse per uno, e la corsia morta
    // si leggeva come una settimana tranquilla. Che è esattamente l'unica
    // confusione che questo check esiste per togliere.
    const dir = home();
    seedRun(dir, 'ran', 13, { episodes: 14, facts: 0 });
    const c = await check(dir, 'consolidamento');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('13 errori su 14 episodi');
    rmSync(dir, { recursive: true, force: true });
  });

  it('stays green when the sweep threw but the batch worked', async () => {
    // `errors >= episodes` alone is not the condition. The maintenance sweep
    // pushes its own failure into `report.errors`, so a one-episode run that
    // extracted a fact and then tripped the sweep arrives here as 1 error over 1
    // episode — and it is not a lane going nowhere.
    const dir = home();
    seedRun(dir, 'ran', 1, { episodes: 1, facts: 1 });
    const c = await check(dir, 'consolidamento');
    expect(c?.level).toBe('ok');
    expect(c?.detail).toContain('1 falliti');
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails on a run that threw, instead of printing its blank row as green', async () => {
    // The bigger half of the same defect: `execute` writes zero episodi and zero
    // fatti when `ingest` throws, which through `ok` is indistinguishable from a
    // quiet week — the exact confusion this check exists to remove.
    const dir = home();
    seedRun(dir, 'error', 1, { episodes: 0, facts: 0 });
    const report = await runDoctor(dir);
    const c = report.checks.find((x) => x.name === 'consolidamento');
    expect(c?.level).toBe('fail');
    expect(c?.detail).toContain('fallito');
    // The row does not keep the message, so the remedy has to be the command
    // that reproduces it in the foreground.
    expect(c?.remedy).toContain('muffin memory extract');
    expect(report.exitCode).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('warns, naming the cap, when the budget stopped the lane', async () => {
    const dir = home();
    seedRun(dir, 'budget', 0, { episodes: 0, facts: 0 });
    const c = await check(dir, 'consolidamento');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('budget mensile esaurito');
    expect(c?.remedy).toContain('rot reseal');
    rmSync(dir, { recursive: true, force: true });
  });

  it('is ok on a lock refusal, and says so — it is the guarantee working', async () => {
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
    const c = await check(dir, 'consolidamento');
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

  it('warns with the install command when nothing is installed and no gateway runs', async () => {
    const dir = home();
    const report = await runDoctor(dir, { supervisorProbes: { unitFileExists: () => false } });
    const c = report.checks.find((x) => x.name === 'supervisore');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('non riparte da solo');
    expect(c?.remedy).toContain('gateway install --write');
    // Never the ceiling severity — a missing supervisor does not fail doctor.
    expect(report.exitCode).not.toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('names the live-but-unsupervised case when a gateway is actually running', async () => {
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

    const report = await runDoctor(dir, { supervisorProbes: { unitFileExists: () => false } });
    const gateway = report.checks.find((x) => x.name === 'gateway');
    const supervisor = report.checks.find((x) => x.name === 'supervisore');
    expect(gateway?.level).toBe('ok'); // sanity: the fixture really did register as a live gateway
    expect(supervisor?.level).toBe('warn');
    expect(supervisor?.detail).toContain('vive finché il terminale');
    rmSync(dir, { recursive: true, force: true });
  });

  it('is ok once the unit is installed and the platform confirms it is engaged', async () => {
    const dir = home();
    const engaged: Partial<SupervisorProbes> =
      process.platform === 'darwin'
        ? { unitFileExists: () => true, launchdLoaded: () => true }
        : { unitFileExists: () => true, systemdEnabled: () => true, lingerEnabled: () => true };
    const report = await runDoctor(dir, { supervisorProbes: engaged });
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
  it('warns, naming the length, the limit and #213, when TMPDIR is past the socket-path limit on Linux', async () => {
    const dir = home(); // must exist before TMPDIR is stubbed: home() mkdtemps under the real one
    vi.stubEnv('TMPDIR', '/x'.repeat(60)); // 120 chars, past the 108-byte sun_path limit
    const report = await runDoctor(dir, { platform: 'linux' });
    const c = report.checks.find((x) => x.name === 'tmpdir');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('120');
    expect(c?.detail).toContain('108');
    expect(c?.detail).toContain('#213');
    expect(c?.remedy).toBeTruthy();
    rmSync(dir, { recursive: true, force: true });
  });

  it('warns anche nella fascia 74–108: il budget è del path del socket, non della directory', async () => {
    // Il difetto del giro 1 del judge: 108 speso tutto su TMPDIR nudo, mentre
    // il bridge del sandbox appende il suo socket più lungo (35 caratteri
    // misurati, claude-socks-<16hex>.sock) direttamente sotto quella
    // directory. Un TMPDIR di 80 caratteri lasciava doctor verde e il sandbox
    // rotto a runtime.
    const dir = home();
    vi.stubEnv('TMPDIR', '/x'.repeat(40)); // 80 chars: sotto 108 da solo, oltre col percorso reale
    const report = await runDoctor(dir, { platform: 'linux' });
    const c = report.checks.find((x) => x.name === 'tmpdir');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('80');
    expect(c?.detail).toContain('35');
    rmSync(dir, { recursive: true, force: true });
  });

  it('is ok, naming the limit, when TMPDIR is short on Linux', async () => {
    const dir = home();
    vi.stubEnv('TMPDIR', '/tmp');
    const report = await runDoctor(dir, { platform: 'linux' });
    const c = report.checks.find((x) => x.name === 'tmpdir');
    expect(c?.level).toBe('ok');
    expect(c?.detail).toContain('/tmp');
    rmSync(dir, { recursive: true, force: true });
  });

  it('says nothing on a platform where the sandbox does not proxy through a Unix socket', async () => {
    const dir = home();
    vi.stubEnv('TMPDIR', '/x'.repeat(60));
    const report = await runDoctor(dir, { platform: 'darwin' });
    expect(report.checks.find((x) => x.name === 'tmpdir')).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('sandboxOkDetail — the sandbox "ok" line is honest about which platform actually contained it', () => {
  it('is a plain summary for seatbelt', async () => {
    const line = sandboxOkDetail({ available: true, mechanism: 'seatbelt' });
    expect(line).toContain('seatbelt');
    expect(line).not.toContain('weaker');
  });

  it('names the Linux gap on bubblewrap — Unix-socket hardening is off there (executor.ts, #428/#429)', async () => {
    const line = sandboxOkDetail({ available: true, mechanism: 'bubblewrap' });
    expect(line).toContain('bubblewrap');
    expect(line.toLowerCase()).toContain('weaker');
    expect(line).toMatch(/unix.socket/i);
  });
});

describe('la riga sandbox di doctor viene dalla porta vera, non dal probe economico', () => {
  /**
   * La rete che mancava (judge #129, secondo follow-up): il meccanismo era
   * coperto, ma niente inchiodava *doctor* a `verify()`. Un ritorno accidentale
   * a `probeSandbox()` — una riga — non lo avrebbe visto nessun test, e
   * riaprirebbe esattamente il reperto: doctor verde su una macchina dove il
   * primo comando contenuto muore con l'errore grezzo di bwrap dentro un job.
   */
  it('un contenimento che fallisce alla prova reale finisce nella riga, con la sua ragione', async () => {
    const dir = home();
    const spia = vi.spyOn(SandboxExecutor.prototype, 'verify').mockResolvedValue({
      available: false,
      mechanism: 'bubblewrap',
      reason: 'contain_failed',
      detail: "bwrap: Can't mount proc on /newroot/proc: Operation not permitted",
      remedy: 'questa macchina non può contenere: nessun comando verrà eseguito',
    });
    try {
      const line = await check(dir, 'sandbox');
      expect(spia).toHaveBeenCalled(); // rossa se doctor tornasse al probe nudo
      expect(line?.level).toBe('warn');
      expect(line?.detail).toContain('contain_failed');
      expect(line?.detail).toContain('mount proc');
      expect(line?.remedy).toContain('non può contenere');
    } finally {
      spia.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('doctor sees defaults drift (persona.md, voice.md, rot/*) — deriva-defaults-2026-08-26', () => {
  /**
   * The property the task brief names as the one that matters most: a file
   * the owner edited must never come back proposing to overwrite it. Real
   * repository, real checkout resolution (`findCheckoutRoot`, `cli/update.ts`)
   * — the deep case-by-case logic already has its own thorough coverage in
   * `core/config/defaults-drift.test.ts`; what these tests hold onto is the
   * *wiring*: that `runDoctor` calls it, at all, and turns the verdict into
   * the right level.
   */

  it('a fresh install reports every tracked default as up-to-date, ok — never a warn A10 does not expect', async () => {
    const dir = home();
    // **Il checkout va detto, non lasciato all'ambiente.** Senza questo il test
    // usa `findCheckoutRoot`, che per `muffin update` prende di proposito la
    // *prima* riga di `git worktree list` — cioè sempre il checkout
    // principale. Ma `runInit` qui sopra ha copiato i default da **questo**
    // albero: dentro un worktree che tocca `defaults/`, il confronto è fra due
    // checkout diversi e la riga esce `adoptable`. Il 28/08/2026 è successo
    // esattamente questo, e il rosso sembrava un difetto della modifica invece
    // che di dove girava il test. La proprietà che questo test vuole provare è
    // «i file appena copiati risultano allineati alla sorgente da cui sono
    // stati copiati», e quella sorgente è nota: non serve indovinarla.
    const questoCheckout = join(dirname(fileURLToPath(import.meta.url)), '..');
    const r = await runDoctor(dir, { checkoutRoot: questoCheckout });
    const defaultsChecks = r.checks.filter((c) => c.name.startsWith('default '));
    // At minimum the files the research doc measured — a fresh `muffin init`
    // just copied them from this very checkout, so every one must read as
    // up-to-date, not merely "present".
    for (const relPath of ['persona.md', 'voice.md', 'rot/identity.md', 'rot/policy.json', 'rot/egress.json', 'rot/budgets.json']) {
      const c = defaultsChecks.find((x) => x.name === `default ${relPath}`);
      expect(c, `missing check for ${relPath}`).toBeTruthy();
      expect(c?.level, `${relPath}: ${c?.detail}`).toBe('ok');
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('an owner edit reads as ok — "è suo", never a proposal to overwrite it', async () => {
    const dir = home();
    writeFileSync(paths(dir).persona, "testo scritto a mano dall'owner, non spedito da nessun commit\n");
    const c = await check(dir, 'default persona.md');
    expect(c?.level).toBe('ok');
    expect(c?.remedy).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('with no checkout resolvable and no registry, degrades to one declared line instead of staying silently green', async () => {
    const dir = home();
    // Wipe the registry `muffin init` just wrote, so this exercises the
    // "neither source available" branch rather than the registry-only one.
    rmSync(paths(dir).defaultsManifest, { force: true });
    const r = await runDoctor(dir, { checkoutRoot: null });
    const c = r.checks.find((x) => x.name === 'defaults');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('checkout Git leggibile');
    rmSync(dir, { recursive: true, force: true });
  });

  it('adopting a sealed rot/ file states the safe-mode consequence before the command, and names `rot reseal`', async () => {
    // A synthetic checkout, independent of this repository's own history, so
    // the "installed content matches an old shipped commit" fact is
    // constructed rather than borrowed from real history.
    const checkout = realpathSync(mkdtempSync(join(tmpdir(), 'muffin-doctor-drift-checkout-')));
    const sh = (cmd: string, args: string[]): void => {
      const r = spawnSync(cmd, args, { cwd: checkout, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`);
    };
    mkdirSync(join(checkout, 'defaults', 'rot'), { recursive: true });
    writeFileSync(join(checkout, 'defaults', 'rot', 'identity.md'), 'v1 identity\n');
    sh('git', ['init', '-q']);
    sh('git', ['config', 'user.email', 't@t']);
    sh('git', ['config', 'user.name', 't']);
    sh('git', ['add', '.']);
    sh('git', ['commit', '-qm', 'v1']);
    writeFileSync(join(checkout, 'defaults', 'rot', 'identity.md'), 'v2 identity — HEAD ora dice questo\n');
    sh('git', ['add', '.']);
    sh('git', ['commit', '-qm', 'v2']);

    const dir = home();
    writeFileSync(join(paths(dir).rot, 'identity.md'), 'v1 identity\n'); // stuck at the v1 commit, never touched since
    // `home()` already ran a real `muffin init` against THIS repository, so
    // the registry it wrote (rule 1) names the real, shipped identity.md —
    // not the synthetic v1/v2 fabricated above. Dropping it forces this test
    // through rule 2 (Git history) against the synthetic checkout instead,
    // which is the fallback this test actually means to exercise.
    rmSync(paths(dir).defaultsManifest, { force: true });

    try {
      const c = await checkWith(dir, 'default rot/identity.md', { checkoutRoot: checkout });
      expect(c?.level).toBe('warn');
      expect(c?.remedy).toBeTruthy();
      const safeModeAt = c!.remedy!.indexOf('safe mode');
      const cpAt = c!.remedy!.indexOf('cp ');
      const resealAt = c!.remedy!.indexOf('rot reseal');
      expect(safeModeAt).toBeGreaterThan(-1);
      expect(cpAt).toBeGreaterThan(-1);
      expect(resealAt).toBeGreaterThan(-1);
      // The consequence is said BEFORE the command — the owner decides first.
      expect(safeModeAt).toBeLessThan(cpAt);
      expect(cpAt).toBeLessThan(resealAt);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  it('several sealed rot/ files diverging together get one grouped remedy, not one paragraph per file — 03/09/2026 UX pass', async () => {
    // Same synthetic-checkout technique as the single-file test above, but
    // with two sealed files both stuck at v1 while HEAD moved to v2. Before
    // this slice each file produced its own full "questo file è dentro il
    // sigillo…" paragraph, `muffin rot reseal` named once per file — the
    // owner read the same explanation twice for one `muffin update`.
    const checkout = realpathSync(mkdtempSync(join(tmpdir(), 'muffin-doctor-drift-group-checkout-')));
    const sh = (cmd: string, args: string[]): void => {
      const r = spawnSync(cmd, args, { cwd: checkout, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`);
    };
    mkdirSync(join(checkout, 'defaults', 'rot'), { recursive: true });
    writeFileSync(join(checkout, 'defaults', 'rot', 'identity.md'), 'v1 identity\n');
    writeFileSync(join(checkout, 'defaults', 'rot', 'policy.json'), '{"v":1}\n');
    sh('git', ['init', '-q']);
    sh('git', ['config', 'user.email', 't@t']);
    sh('git', ['config', 'user.name', 't']);
    sh('git', ['add', '.']);
    sh('git', ['commit', '-qm', 'v1']);
    writeFileSync(join(checkout, 'defaults', 'rot', 'identity.md'), 'v2 identity — HEAD ora dice questo\n');
    writeFileSync(join(checkout, 'defaults', 'rot', 'policy.json'), '{"v":2}\n');
    sh('git', ['add', '.']);
    sh('git', ['commit', '-qm', 'v2']);

    const dir = home();
    writeFileSync(join(paths(dir).rot, 'identity.md'), 'v1 identity\n');
    writeFileSync(join(paths(dir).rot, 'policy.json'), '{"v":1}\n');
    rmSync(paths(dir).defaultsManifest, { force: true });

    try {
      const report = await runDoctor(dir, { checkoutRoot: checkout });

      // No per-file check for the two that diverged together — they are
      // folded into the group instead of repeating.
      expect(report.checks.find((c) => c.name === 'default rot/identity.md')).toBeUndefined();
      expect(report.checks.find((c) => c.name === 'default rot/policy.json')).toBeUndefined();

      const group = report.checks.find((c) => c.name === 'default rot/*');
      expect(group).toBeTruthy();
      expect(group?.level).toBe('warn');
      expect(group?.detail).toContain('rot/identity.md');
      expect(group?.detail).toContain('rot/policy.json');
      expect(group?.remedy).toBeTruthy();
      // One explanation, one command sequence: `rot reseal` named exactly
      // once for the whole batch, not once per file.
      const resealCount = (group!.remedy!.match(/rot reseal/g) ?? []).length;
      expect(resealCount).toBe(1);
      // A command an owner can actually run — for each file — is still there.
      expect(group?.remedy).toContain('cp ');
      expect(group?.remedy).toContain(join(checkout, 'defaults', 'rot', 'identity.md'));
      expect(group?.remedy).toContain(join(checkout, 'defaults', 'rot', 'policy.json'));
      expect(group?.remedy).toContain('safe mode');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    }
  });
});


/**
 * Contare non è chiedere.
 *
 * I due numeri della riga `vector index` dicono che ciò che è **già**
 * indicizzato è coerente. Non dicono niente su ciò che verrà. Sull'installazione
 * dell'owner, il 27/08: ollama giù dal 25, tre righe in `memory_review` che lo
 * dicevano, il gateway che stampava «il recall resta testuale» a ogni giro — e
 * questa riga verde, «55 chunks, 55 vectors, in sync». Tutto vero, tutto
 * fuorviante. `agent/runtime.ts` lo scrive accanto al punto in cui costruisce
 * l'embedder: la differenza «deve essere visibile in `doctor`». Non lo era.
 */
describe("l'indice coerente non dice che l'embedder risponda", () => {
  class Finto implements Embedder {
    readonly id = 'finto:test';
    readonly dimensions = 4;
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((_, i) => Float32Array.from([1, 0, 0, i]));
    }
  }

  /** Una home con l'indice pieno e coerente — l'unico stato in cui la riga era verde. */
  async function conIndice(): Promise<string> {
    const dir = home();
    const db = new DatabaseCtor(paths(dir).db);
    const index = new VectorIndex(db, new Finto());
    await index.index('host', [{ kind: 'episode', sourceId: 1, text: 'un frammento qualsiasi' }], '2026-08-27T00:00:00Z');
    db.close();
    return dir;
  }

  it('resta verde quando la sonda risponde', async () => {
    const dir = await conIndice();
    const c = await checkWith(dir, 'vector index', { embedderProbe: async () => {} });
    expect(c?.level).toBe('ok');
    expect(c?.detail).toContain('in sync');
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Il posto dove l'owner legge davvero la causa. Il difetto era a monte —
   * `embed.ts` passava `error.message` a `EmbedderUnavailable`, e quando
   * ollama e' giu' quel messaggio e' la parola `fetch failed` e nient'altro:
   * questa riga stampava «l'embedder non risponde (embedder "…" non
   * disponibile: fetch failed)», che dice solo che qualcosa e' fallito.
   *
   * Niente `embedderProbe` e niente errore finto: la sonda vera, su una porta
   * **davvero chiusa** — aperta e richiusa qui sopra, cosi' e' chiusa per
   * costruzione e non per convenzione. E' la sola forma di questo test che
   * misuri `ECONNREFUSED` invece di scriverlo. (La porta 1 dell'altro test
   * non serve: `undici` la rifiuta come «bad port» prima di connettersi, e
   * quel fallimento non ha `cause.code`.)
   */
  it('la riga vector index nomina la causa quando ollama e giu', async () => {
    const dir = await conIndice();
    const chiusa = createNetServer();
    await new Promise<void>((r) => chiusa.listen(0, '127.0.0.1', () => r()));
    const porta = (chiusa.address() as { port: number }).port;
    await new Promise<void>((r) => chiusa.close(() => r()));

    const configPath = paths(dir).config;
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.embedder = { kind: 'ollama', model: 'qwen3-embedding:0.6b', dimensions: 7, baseUrl: `http://127.0.0.1:${porta}` };
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const c = await checkWith(dir, 'vector index', {});
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('ECONNREFUSED');
    // La riga resta quella che era: la causa si aggiunge, non sostituisce.
    expect(c?.detail).toContain("l'embedder non risponde");
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);

  it('avvisa quando i numeri tornano ma l embedder non risponde, e dice perché', async () => {
    const dir = await conIndice();
    const c = await checkWith(dir, 'vector index', {
      embedderProbe: async () => {
        throw new Error('fetch failed');
      },
    });
    expect(c?.level).toBe('warn');
    // I due numeri restano: non sono sbagliati, sono insufficienti.
    expect(c?.detail).toContain('coerenti');
    expect(c?.detail).toContain('fetch failed');
    expect(c?.detail).toContain('solo testuale');
    expect(c?.remedy).toContain('ollama');
    rmSync(dir, { recursive: true, force: true });
  });

  it('interroga l embedder della config, non Ollama per definizione', async () => {
    // La cucitura, misurata: sostituire `makeEmbedder(config.embedder, …)` con
    // `undefined` in `cli/doctor.ts` lasciava **48 test verdi**. Cioè `doctor`
    // poteva interrogare Ollama su una macchina configurata per un altro
    // embedder — dire «giù» su una macchina sana e «su» su una rotta, che è
    // esattamente il `doctor` verde con la memoria spenta da cui nasce questo
    // blocco.
    //
    // Niente `embedderProbe` qui: l override è il pezzo che questo test deve
    // NON usare. La porta 1 rifiuta sempre e senza rete, e il messaggio porta
    // l id dell embedder — che è il nome del modello configurato, e non quello
    // di default.
    const dir = await conIndice();
    const configPath = paths(dir).config;
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.embedder = { kind: 'ollama', model: 'un-modello-inventato', dimensions: 7, baseUrl: 'http://127.0.0.1:1' };
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const c = await checkWith(dir, 'vector index', {});
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('un-modello-inventato');
    expect(c?.detail).not.toContain('qwen3-embedding');
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);

  it('nomina la config rotta invece di ricadere su Ollama', async () => {
    // Il `catch {}` che stava qui buttava via l'errore di `makeEmbedder` e
    // lasciava `configurato = undefined` — e `undefined` faceva cadere la sonda
    // sul default Ollama. Su una macchina con Ollama **vivo** la sonda
    // rispondeva e la riga tornava verde.
    //
    // Misurato prima di ripararlo, con questo stesso server finto su
    // `OLLAMA_URL` e questa stessa config: «LIVELLO: ok | DETTAGLIO: 1 chunks,
    // 1 vectors, in sync | RIMEDIO: undefined», mentre `agent/runtime.ts:352`
    // inghiottiva lo stesso errore e girava con `vectors === undefined`. Cioè
    // esattamente lo stato da cui nasce questo blocco, ricreato dalla manopola
    // nuova per un campo dimenticato in config.json.
    //
    // Niente `embedderProbe`: l'override è il pezzo che questo test deve NON
    // usare, perché la prova sta proprio nel non interrogare Ollama.
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ embedding: Array.from({ length: 1024 }, () => 0.1) }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    vi.stubEnv('OLLAMA_URL', `http://127.0.0.1:${port}`);

    const dir = await conIndice();
    const configPath = paths(dir).config;
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    // `dimensions` dimenticata: `makeEmbedder` lancia, e il suo messaggio la
    // nomina. Questo è l'unico posto che lo legge.
    config.embedder = { kind: 'openai-compat', model: 'text-embedding-3-small', apiKeyRef: 'secret://emb' };
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const c = await checkWith(dir, 'vector index', {});
    expect(c?.level).toBe('fail');
    expect(c?.detail).toContain('dimensions');
    expect(c?.detail).not.toContain('in sync');
    expect(c?.remedy).toContain('config.embedder');

    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('nomina la config rotta anche a indice VUOTO — l installazione fresca', async () => {
    // Il calcolo della config stava dentro il ramo `chunks > 0`, quindi su
    // un'installazione appena fatta il ramo `chunks === 0` scattava per primo e
    // la config non veniva mai costruita.
    //
    // Misurato prima di ripararlo, su questa stessa home: `warn | empty: recall
    // is full-text only | run muffin memory extract`. La stessa home con **un**
    // chunk indicizzato, config identica: `fail | mancano dimensions`.
    //
    // Ed è l'installazione che la slice dice di servire: VPS senza Ollama,
    // `makeEmbedder` lancia, `agent/runtime.ts:352` inghiotte, `vectors =
    // undefined`, quindi `chunks` resta 0 per sempre — e il rimedio prescritto,
    // `muffin memory extract`, ripassa da `makeEmbedder` e non indicizza
    // niente. Ciclo permanente, causa sbagliata, rimedio inerte.
    const dir = home();
    const db = new DatabaseCtor(paths(dir).db);
    // La tabella c'è ed è vuota: lo stato di un'installazione fresca, non
    // quello di un DB senza memoria.
    new VectorIndex(db, new Finto());
    expect((db.prepare(`SELECT count(*) AS n FROM chunks`).get() as { n: number }).n).toBe(0);
    db.close();

    const configPath = paths(dir).config;
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.embedder = { kind: 'openai-compat', model: 'text-embedding-3-small', apiKeyRef: 'secret://emb' };
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const c = await checkWith(dir, 'vector index', { embedderProbe: async () => {} });
    expect(c?.level).toBe('fail');
    expect(c?.detail).toContain('dimensions');
    expect(c?.remedy).toContain('config.embedder');
    // Il rimedio che non poteva funzionare non deve più comparire.
    expect(c?.remedy).not.toContain('memory extract');
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('non dice «in sync» mentre delle sorgenti aspettano ancora un vettore', async () => {
    // Contare `chunks` contro `chunks_vec` dice solo che ciò che è già
    // indicizzato è coerente. Dopo un cambio di embedder il backlog si drena a
    // scaglioni (`indexBacklog` ha `limit = 200`), quindi i due numeri tornano
    // mentre una parte del corpus è fuori dal recall semantico.
    //
    // Misurato prima di ripararlo, in piccolo per non pagare 250 giri: 3
    // episodi, uno solo indicizzato — `ok: "1 chunks, 1 vectors, in sync"`, con
    // 2 episodi che il recall non vede. È alla lettera il «55 chunks, 55
    // vectors, in sync: vero e fuorviante» da cui nasce questa slice.
    const dir = home();
    const db = new DatabaseCtor(paths(dir).db);
    db.exec(MEMORY_SCHEMA);
    const ins = db.prepare(
      `INSERT INTO episodes (tenant_id, connector, thread_key, role, kind, content, trust_tier, created_at, extraction_v)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    for (const t of ['uno', 'due', 'tre']) ins.run('host', 'cli', 't1', 'user', 'message', t, 0, '2026-08-27', 0);
    // La **stessa** identità che la config nomina qui sotto, o i tre episodi
    // risulterebbero pendenti per il motivo sbagliato — un id diverso — invece
    // che per il drenaggio a metà, che è il caso in prova.
    const index = new VectorIndex(db, { id: 'ollama:test', dimensions: 4, embed: new Finto().embed });
    // Uno solo dei tre: i conteggi tornano, il corpus no.
    await index.index('host', [{ kind: 'episode', sourceId: 1, text: 'uno' }], '2026-08-27T00:00:00Z');
    db.close();

    const configPath = paths(dir).config;
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.embedder = { kind: 'ollama', model: 'test', dimensions: 4 };
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const c = await checkWith(dir, 'vector index', { embedderProbe: async () => {} });
    expect(c?.level).toBe('warn');
    expect(c?.detail).not.toContain('in sync');
    expect(c?.detail).toContain('2 sorgenti');
    expect(c?.remedy).toContain('memory extract');
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('con `openai-compat` non manda l owner ad avviare ollama', async () => {
    // Il rimedio seguiva l'abitudine e non la config: «avvia ollama … oppure
    // OLLAMA_URL» a chi ha configurato un endpoint remoto manda a riparare la
    // cosa sbagliata — e la seconda metà era pure inerte, perché `makeEmbedder`
    // lascia vincere `config.embedder.baseUrl` su `OLLAMA_URL`.
    const dir = await conIndice();
    const configPath = paths(dir).config;
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.embedder = {
      kind: 'openai-compat',
      model: 'text-embedding-3-small',
      dimensions: 4,
      apiKeyRef: 'secret://emb',
      baseUrl: 'http://127.0.0.1:1/v1',
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    writeSecret('emb', 'sk-never-called', dir);

    const c = await checkWith(dir, 'vector index', {
      embedderProbe: async () => {
        throw new Error('fetch failed');
      },
    });
    expect(c?.level).toBe('warn');
    expect(c?.remedy).not.toContain('ollama');
    expect(c?.remedy).toContain('config.embedder');
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('non resta appesa a un embedder che accetta la connessione e non risponde', async () => {
    // Il caso opposto alla porta chiusa, e il motivo per cui il tetto esiste:
    // `doctor` è ciò che si lancia quando la macchina è già strana.
    const dir = await conIndice();
    const c = await checkWith(dir, 'vector index', { embedderProbe: () => new Promise<void>(() => {}) });
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('nessuna risposta entro');
    rmSync(dir, { recursive: true, force: true });
  }, 10_000);
});

/**
 * La prima domanda di qualunque diagnosi: quale build sto guardando.
 */
describe('doctor dice quale commit sta girando', () => {
  it('pulito: il commit e la data, e basta', async () => {
    const dir = home();
    const c = await checkWith(dir, 'build', { build: { sha: 'abc123def4567890', date: '2026-08-27', dirty: false } });
    expect(c?.level).toBe('ok');
    expect(c?.detail).toContain('abc123def456');
    expect(c?.detail).toContain('2026-08-27');
    rmSync(dir, { recursive: true, force: true });
  });

  it('modificato: avvisa, perché quel SHA non descrive ciò che gira', async () => {
    // Non un `fail`: su una macchina di sviluppo è lo stato normale. Ma neanche
    // un `ok` silenzioso, che direbbe una cosa precisa e falsa.
    const dir = home();
    const c = await checkWith(dir, 'build', { build: { sha: 'abc123def4567890', date: '2026-08-27', dirty: true } });
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('non committate');
    rmSync(dir, { recursive: true, force: true });
  });

  it('fuori da un checkout: lo dichiara invece di inventare', async () => {
    const dir = home();
    const c = await checkWith(dir, 'build', { build: null });
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('non so quale commit');
    rmSync(dir, { recursive: true, force: true });
  });
});


describe('MUFFIN_GUASTO_DOPO_MS — la sola manopola sulla soglia', () => {
  it('e assente su tutto quello che un installazione vera imposterebbe', () => {
    expect(guastoDopoMsDaEnv(undefined)).toBe(GUASTO_DOPO_MS);
    expect(guastoDopoMsDaEnv('')).toBe(GUASTO_DOPO_MS);
  });

  it('un refuso nell ambiente non fa uscire doctor: resta il default', () => {
    expect(guastoDopoMsDaEnv('non-un-numero')).toBe(GUASTO_DOPO_MS);
    expect(guastoDopoMsDaEnv('0')).toBe(GUASTO_DOPO_MS);
    expect(guastoDopoMsDaEnv('-1')).toBe(GUASTO_DOPO_MS);
  });

  it('e un valore vero passa', () => {
    expect(guastoDopoMsDaEnv('1500')).toBe(1500);
  });
});

describe('quantoDura — un lampo e un guasto che dura non si somigliano', () => {
  const t0 = new Date('2026-08-30T12:00:00Z');
  const meno = (ms: number): string => new Date(t0.getTime() - ms).toISOString();

  it('sotto il minuto non finge una precisione', () => {
    expect(quantoDura(meno(20_000), t0)).toBe('meno di un minuto');
  });

  it('minuti, ore e giorni, al singolare quando e uno', () => {
    expect(quantoDura(meno(60_000), t0)).toBe('1 minuto');
    expect(quantoDura(meno(25 * 60_000), t0)).toBe('25 minuti');
    expect(quantoDura(meno(3_600_000), t0)).toBe('1 ora');
    expect(quantoDura(meno(19 * 3_600_000), t0)).toBe('19 ore');
    expect(quantoDura(meno(5 * 24 * 3_600_000), t0)).toBe('5 giorni');
  });

  it('una data illeggibile lo dice invece di stampare NaN', () => {
    expect(quantoDura('non-una-data', t0)).toBe('un tempo non registrato');
  });
});

/**
 * Il difetto misurato il 30/08/2026 sulla macchina dell'owner.
 *
 * Telegram era abilitata e aveva portato 44 turni veri. Nell'arco di vita di un
 * gateway il polling era fallito 3187 volte, e `doctor` stampava `gateway
 * attivo · socket concorde` e `nessuna delivery mancante`. Vere tutte e due, e
 * **cieche per costruzione**: una superficie che non riceve non produce turni,
 * quindi non produce consegne, quindi non ne mancano. Quei numeri restano
 * identici che il guasto duri cinque secondi o un giorno, ed e' proprio la
 * differenza fra i due casi che serviva sapere.
 */
describe('doctor guarda se una superficie abilitata sta rispondendo', () => {
  const aperti: ControlServer[] = [];
  afterEach(async () => {
    while (aperti.length > 0) await aperti.pop()?.close();
  });

  /** Una home con Telegram abilitata e un gateway vivo tenuto da questo processo. */
  const conTelegram = (): string => {
    const dir = home();
    const db = new DatabaseCtor(paths(dir).db);
    const esito = new GatewayLock(db).claim(new Date(), 'in attesa', process.pid);
    if (!('release' in esito)) throw new Error('la fixture non ha preso il lock');
    db.close();
    const file = join(paths(dir).home, 'config.json');
    const config = JSON.parse(readFileSync(file, 'utf8')) as { surfaces: Record<string, unknown> };
    config.surfaces = {
      ...config.surfaces,
      enabled: ['cli', 'telegram'],
      telegram: { ownerUserId: 1, ownerChatId: 1 },
    };
    writeFileSync(file, JSON.stringify(config, null, 2));
    return dir;
  };

  const gatewayCheDice = async (dir: string, risposta: unknown): Promise<void> => {
    aperti.push(
      await serveControlSocket(dir, (verb) => {
        if (verb === 'identify') {
          return { protocol: 1, pid: process.pid, home: dir, codeSha: null, startedAt: new Date().toISOString() };
        }
        if (verb === 'superfici') return risposta;
        return null;
      }),
    );
  };

  const caduta = (ore: number): StatoSuperficie => ({
    id: 'telegram',
    connessa: false,
    da: new Date(Date.now() - ore * 3_600_000).toISOString(),
    causa: 'Telegram 0: TypeError (ECONNRESET)',
    fallimentiDiFila: 3187,
  });

  it('una superficie caduta si vede: da quanto, con che causa, quante volte', async () => {
    const dir = conTelegram();
    await gatewayCheDice(dir, { superfici: [caduta(19)] });

    const c = await check(dir, 'superficie telegram');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('19 ore');
    expect(c?.detail).toContain('ECONNRESET');
    expect(c?.detail).toContain('3187');
    expect(c?.remedy).toContain('gateway');
  });

  /**
   * La riga che rende la prima una notizia e non rumore: dice **perche** gli
   * altri indicatori restano verdi. Senza, l'owner legge il `!` e poi vede
   * `consegne ✓` e conclude che il `!` esagera.
   */
  it('e dice perche le consegne e i turni non lo denunciano', async () => {
    const dir = conTelegram();
    await gatewayCheDice(dir, { superfici: [caduta(19)] });

    const c = await check(dir, 'superficie telegram');
    expect(c?.detail).toContain('non arriva niente');
  });

  it('quando risponde, lo dice una volta e non allarma', async () => {
    const dir = conTelegram();
    const viva: StatoSuperficie = {
      id: 'telegram',
      connessa: true,
      da: new Date(Date.now() - 3_600_000).toISOString(),
      fallimentiDiFila: 0,
    };
    await gatewayCheDice(dir, { superfici: [viva] });

    const report = await runDoctor(dir);
    expect(report.checks.find((c) => c.name === 'superficie telegram')).toBeUndefined();
    const riga = report.checks.find((c) => c.name === 'superfici');
    expect(riga?.level).toBe('ok');
    expect(riga?.detail).toContain('telegram');
    // Non «in ascolto»: la parola deve reggere per la superficie piu' debole,
    // e per Discord `connessa` significa «ultimo READY/RESUMED senza chiusure
    // da allora» — vero adesso a meno di circa due `heartbeat_interval`, che e'
    // quanto il rilevamento zombie ci mette a chiudere un socket muto.
    // «Connesse» e' quello che si sa; «in ascolto» prometterebbe l'istante.
    expect(riga?.detail).not.toContain('in ascolto');
  });

  /**
   * I due falsi positivi trovati dal giudice sulla #260, e il secondo li'
   * riprodotto sul binario vero.
   *
   * Il primo: fra l'avvio del connettore e il primo `getMe` passano fino a due
   * minuti, e in quella finestra `doctor` diceva «non e stata nemmeno
   * tentata», usciva 1 e consigliava di riavviare — cioe' di rifare partire
   * l'handshake. Il secondo: un `ECONNRESET` fra due long poll lascia la
   * superficie caduta per i cinque secondi prima del tentativo dopo, e un
   * `doctor` in quella finestra stampava un guasto.
   *
   * Un `!` su uno stato sano e' il modo piu' rapido per insegnare a scorrere
   * oltre `doctor`: e' il difetto che questa slice esiste per chiudere, al
   * contrario.
   */
  it('mentre aspetta il primo battito, tace', async () => {
    const dir = conTelegram();
    const inAvvio: StatoSuperficie = {
      id: 'telegram',
      connessa: false,
      inAvvio: true,
      da: new Date(Date.now() - 90_000).toISOString(),
      fallimentiDiFila: 0,
    };
    await gatewayCheDice(dir, { superfici: [inAvvio] });

    const report = await runDoctor(dir);
    expect(report.checks.find((c) => c.name.startsWith('superfic'))).toBeUndefined();
  });

  /**
   * Il terzo modo di stare zitti, e l'unico che non aveva un limite superiore.
   * Una superficie che entra in avvio e non emette mai ne' `connessa` ne'
   * `caduta` — un upgrade WebSocket che stalla, che Node non limita — resterebbe
   * invisibile per sempre. «In avvio da tre ore» non e' un «non lo so» onesto.
   */
  it('ma un avvio che non finisce mai smette di essere un avvio', async () => {
    const dir = conTelegram();
    await gatewayCheDice(dir, {
      superfici: [
        {
          id: 'telegram',
          connessa: false,
          inAvvio: true,
          da: new Date(Date.now() - AVVIO_TROPPO_LUNGO_MS - 1000).toISOString(),
          fallimentiDiFila: 0,
        } satisfies StatoSuperficie,
      ],
    });

    const c = await check(dir, 'superficie telegram');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('in avvio da');
    // Non «riavvia»: riavviare rifa partire proprio l'handshake che non finisce.
    expect(c?.remedy).toContain('primo piano');
    expect(c?.remedy).not.toMatch(/^riavvia/);
  });

  it('un lampo fra due long poll non e un guasto', async () => {
    const dir = conTelegram();
    const lampo: StatoSuperficie = {
      id: 'telegram',
      connessa: false,
      da: new Date(Date.now() - 3_000).toISOString(),
      causa: 'Telegram 0: TypeError (ECONNRESET)',
      fallimentiDiFila: 1,
    };
    await gatewayCheDice(dir, { superfici: [lampo] });

    expect(await check(dir, 'superficie telegram')).toBeUndefined();
  });

  it('ma appena supera la soglia lo dice', async () => {
    const dir = conTelegram();
    await gatewayCheDice(dir, { superfici: [caduta(GUASTO_DOPO_MS / 3_600_000 + 0.001)] });

    expect((await check(dir, 'superficie telegram'))?.level).toBe('warn');
  });

  /**
   * Una superficie senza owner non si ripara riavviando il gateway: si ripara
   * con `surface enable`, che la riga d'avvio accanto dice gia'. Il rimedio
   * sbagliato e' peggio di nessun rimedio.
   */
  it('e quando chi registra sa il rimedio, e quello che stampa', async () => {
    const dir = conTelegram();
    await gatewayCheDice(dir, {
      superfici: [
        {
          id: 'telegram',
          connessa: false,
          da: new Date(Date.now() - 3_600_000).toISOString(),
          causa: 'abilitata ma senza owner',
          rimedio: '`muffin surface enable telegram`',
          fallimentiDiFila: 1,
        } satisfies StatoSuperficie,
      ],
    });

    const c = await check(dir, 'superficie telegram');
    expect(c?.remedy).toBe('`muffin surface enable telegram`');
    expect(c?.remedy).not.toContain('riavvia');
  });

  it('abilitata ma mai tentata non passa per sana', async () => {
    const dir = conTelegram();
    await gatewayCheDice(dir, { superfici: [] });

    const c = await check(dir, 'superficie telegram');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('non ne ha notizia');
  });

  /**
   * Un gateway avviato prima di questa versione non conosce il verbo, e le
   * superfici salgono **dopo** il socket. In tutti e due i casi la risposta
   * onesta e il silenzio: inventare un guasto da un «non lo so» sarebbe la
   * stessa bugia al contrario.
   */
  it('un «non lo so» non diventa un guasto', async () => {
    const dir = conTelegram();
    await gatewayCheDice(dir, null);

    const report = await runDoctor(dir);
    expect(report.checks.find((c) => c.name.startsWith('superfic'))).toBeUndefined();
  });

  it('senza superfici oltre alla cli non chiede niente al gateway', async () => {
    const dir = home();
    const db = new DatabaseCtor(paths(dir).db);
    new GatewayLock(db).claim(new Date(), 'in attesa', process.pid);
    db.close();
    let chiesto = false;
    aperti.push(
      await serveControlSocket(dir, (verb) => {
        if (verb === 'superfici') chiesto = true;
        return verb === 'identify' ? { protocol: 1, pid: process.pid, home: dir, codeSha: null, startedAt: '' } : null;
      }),
    );
    await runDoctor(dir);
    expect(chiesto).toBe(false);
  });
});

describe('doctor says whether a voice note would be understood, before the first one arrives', () => {
  // Voice notes arrive from Telegram/Discord: the row only has something to
  // say once such a surface is enabled. `runInit` enables the CLI alone.
  const conTelegram = (dir: string): string => {
    const file = join(paths(dir).home, 'config.json');
    const config = JSON.parse(readFileSync(file, 'utf8')) as { surfaces: Record<string, unknown> };
    config.surfaces = { ...config.surfaces, enabled: ['cli', 'telegram'] };
    writeFileSync(file, JSON.stringify(config, null, 2));
    return dir;
  };

  it('says there is nothing to prepare when no voice-carrying surface is enabled', async () => {
    const dir = home();
    const c = await checkWith(dir, 'note vocali', { voce: { accettaAudio: async () => false, path: join(dir, 'vuota') } });
    expect(c?.level).toBe('ok');
    expect(c?.detail).toMatch(/nessuna superficie vocale/);
  });

  it('is ok, naming the model, when the configured model accepts audio', async () => {
    const dir = conTelegram(home());
    const c = await checkWith(dir, 'note vocali', { voce: { accettaAudio: async () => true } });
    expect(c?.level).toBe('ok');
    expect(c?.detail).toMatch(/accetta audio/);
  });

  it('warns, naming each missing prerequisite with its command, when the model does not listen and nothing is installed', async () => {
    const dir = conTelegram(home());
    const c = await checkWith(dir, 'note vocali', { voce: { accettaAudio: async () => false, path: join(dir, 'vuota') } });
    expect(c?.level).toBe('warn');
    expect(c?.detail).toMatch(/ffmpeg non è installato/);
    expect(c?.detail).toMatch(/whisper\.cpp non è installato/);
    expect(c?.detail).toMatch(/modello whisper/);
    expect(c?.detail).toMatch(/la prima nota vocale fallirebbe/);
    expect(c?.remedy).toContain('brew install ffmpeg');
    expect(c?.remedy).toContain('brew install whisper-cpp');
    expect(c?.remedy).toContain('ggml-base.bin');
  });

  it('is ok, naming the local transcription, when the binaries and the model are there', async () => {
    const dir = conTelegram(home());
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'ffmpeg'), '');
    writeFileSync(join(bin, 'whisper-cli'), '');
    mkdirSync(join(dir, 'models'));
    writeFileSync(join(dir, 'models', 'ggml-base.bin'), '');
    const c = await checkWith(dir, 'note vocali', { voce: { accettaAudio: async () => false, path: bin } });
    expect(c?.level).toBe('ok');
    expect(c?.detail).toMatch(/si trascrive in casa/);
    expect(c?.detail).toContain(join(dir, 'models', 'ggml-base.bin'));
  });

  it('takes the transcription branch when the probe fails, like the runtime does', async () => {
    const dir = conTelegram(home());
    const c = await checkWith(dir, 'note vocali', {
      voce: {
        accettaAudio: async () => {
          throw new Error('rete giù');
        },
        path: join(dir, 'vuota'),
      },
    });
    expect(c?.level).toBe('warn');
  });
});

/**
 * "Perché non ho `web_search`" costava tre turni di retry, il 03/09/2026:
 * `config.json` dichiarava Tavily, `rot/egress.json` non allowlistava
 * `api.tavily.com`, e la ragione stava già una volta sola in `gateway.err`
 * dal boot — nessuna delle due porte che l'owner guarda (un turno, `muffin
 * doctor`) la diceva. Questo blocco prova che ora entrambe la dicono, dalla
 * stessa funzione (`diagnoseSearch`, `agent/tools/search.ts`), non da due
 * letture che potrebbero divergere.
 */
describe('doctor nomina le capacità spente o tagliate, come sys.inspect', () => {
  it('web_search: stessa ragione e stesso rimedio di `sys.inspect`, dalla stessa fonte', async () => {
    const dir = home();
    const configPath = paths(dir).config;
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.search = { provider: 'tavily', apiKeyRef: 'secret://tavily' };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    writeSecret('tavily', 'tvly-test-key', dir);
    // rot/egress.json resta quello di `muffin init`: nessun host allowlistato
    // — la lacuna esatta dell'owner.

    const workspace = mkdtempSync(join(tmpdir(), 'muffin-doctor-capgap-ws-'));
    const runtime = buildRuntime(dir, workspace);
    const gap = runtime.capabilityGaps.find((g) => g.capability === 'web_search');
    runtime.close();
    expect(gap).toBeDefined();

    const c = await check(dir, 'capacità: web_search');
    expect(c?.level).toBe('warn');
    // Non "menziona la stessa cosa" — è letteralmente la stessa stringa,
    // perché entrambe le porte chiamano `diagnoseSearch` e nessuna delle due
    // la riscrive con parole proprie.
    expect(c?.detail).toBe(gap?.reason);
    expect(c?.remedy).toBe(gap?.remedy);
    expect(c?.detail).toContain('api.tavily.com');
    expect(c?.remedy).toContain('rot reseal');
    rmSync(dir, { recursive: true, force: true });
  });

  it('web_search: ok una volta che l’host è allowlistato e il sigillo è rifatto', async () => {
    const dir = home();
    const configPath = paths(dir).config;
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.search = { provider: 'tavily', apiKeyRef: 'secret://tavily' };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    writeSecret('tavily', 'tvly-test-key', dir);
    const egressPath = join(paths(dir).rot, 'egress.json');
    const egress = JSON.parse(readFileSync(egressPath, 'utf8'));
    egress.allow = ['api.tavily.com'];
    writeFileSync(egressPath, JSON.stringify(egress, null, 2));
    seal(dir, '1', new Date());

    const c = await check(dir, 'capacità: web_search');
    expect(c?.level).toBe('ok');
    expect(c?.detail).toContain('attivo');
    rmSync(dir, { recursive: true, force: true });
  });

  it('web_search: nessuna riga quando la ricerca non è configurata affatto', async () => {
    // La postura deliberata di `agent/runtime.ts`: assente non è un guasto.
    const dir = home();
    const c = await check(dir, 'capacità: web_search');
    expect(c).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('shell_run: spento con la stessa ragione del check `sandbox`, non una parola generica', async () => {
    const dir = home();
    const spia = vi.spyOn(SandboxExecutor.prototype, 'verify').mockResolvedValue({
      available: false,
      mechanism: 'bubblewrap',
      reason: 'contain_failed',
      detail: "bwrap: Can't mount proc on /newroot/proc: Operation not permitted",
      remedy: 'questa macchina non può contenere: nessun comando verrà eseguito',
    });
    try {
      const c = await check(dir, 'capacità: shell_run');
      expect(c?.level).toBe('warn');
      expect(c?.detail).toContain('contain_failed');
      expect(c?.remedy).toContain('non può contenere');
      // Distinto da "tagliato dal tetto": nessuna capacità spenta usa quella
      // parola, e nessuna capacità tagliata dice "non disponibile".
      expect(c?.detail).not.toContain('tetto');
    } finally {
      spia.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shell_run: ok quando il contenimento regge', async () => {
    const dir = home();
    const c = await check(dir, 'capacità: shell_run');
    expect(c?.level).toBe('ok');
    rmSync(dir, { recursive: true, force: true });
  });

  it('tetto tool: nomina i tool tagliati quando il modello risolve sul profilo conservativo, e non è la stessa frase di uno spento', async () => {
    // Nessun profilo spedito taglia oggi (consumer-local: 15, frontier: 24,
    // contro una dozzina di tool base — agent/runtime-exposure.test.ts lo
    // misura). Un id modello che non combacia con nessun `match` risolve su
    // CONSERVATIVE (maxToolsExposed: 10), che invece taglia davvero.
    const dir = home();
    const configPath = paths(dir).config;
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.models.main = 'modello-mai-schedato-xyz';
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const c = await check(dir, 'capacità: tetto tool');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('tetto');
    expect(c?.detail).toContain('conservative');
    expect(c?.remedy).toContain('maxToolsExposed');
    // Distinto da una capacità spenta: il tetto non "non è disponibile" e non
    // è "spento", è tagliato — e viceversa, il check `sandbox`/`web_search`
    // non nomina mai un tetto.
    expect(c?.detail).not.toContain('non disponibile');
    rmSync(dir, { recursive: true, force: true });
  });

  it('tetto tool: ok quando il profilo risolto copre tutti i tool registrati', async () => {
    const dir = home(); // cli/init.ts risolve su un profilo frontier, tetto 24
    const c = await check(dir, 'capacità: tetto tool');
    expect(c?.level).toBe('ok');
    expect(c?.remedy).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * Da dove viene il legame owner — DAY-1 B15.
 *
 * Stessa famiglia di fatto invisibile del tetto di spesa qui sopra, con la
 * posta più alta: `surfaces.telegram.ownerUserId` decide **chi ha autorità**,
 * e in un `config.json` ordinario lo riscrive qualunque processo che gira come
 * l'owner. I quattro stati vanno detti separati, o «c'è un owner» finisce per
 * leggersi come «l'owner è protetto».
 */
describe('doctor names where the owner binding lives', () => {
  const conConfigTelegram = (dir: string, ownerUserId: number): void => {
    const config = loadConfig(dir);
    saveConfig(
      {
        ...config,
        surfaces: { ...config.surfaces, enabled: [...config.surfaces.enabled, 'telegram'], telegram: { ownerUserId, ownerChatId: ownerUserId } },
      },
      dir,
    );
  };

  it('says nothing at all when nothing is bound anywhere', async () => {
    const dir = home();
    expect(await check(dir, 'owner binding')).toBeUndefined();
    expect(await check(dir, 'owner binding legacy')).toBeUndefined();
  });

  it('names the sealed file when the binding is inside the seal', async () => {
    const dir = home();
    expect(sealOwnerBinding(dir, { telegram: { userId: 999, chatId: 999 } }, { out: () => {} }).ok).toBe(true);
    const c = await check(dir, 'owner binding');
    expect(c?.level).toBe('ok');
    expect(c?.detail).toContain('rot/owner.json — telegram 999');
  });

  it('calls a config-only binding legacy, and names the command that seals it', async () => {
    const dir = home();
    conConfigTelegram(dir, 111);
    const c = await check(dir, 'owner binding legacy');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('telegram 111');
    // La conseguenza, non solo lo stato: è la riga che dice perché importa.
    expect(c?.detail).toMatch(/qualunque processo che gira come te/);
    expect(c?.remedy).toContain('muffin surface enable telegram');
  });

  it('on hardened does not promise an automatic reseal — it names the privilege owning rot/', async () => {
    const dir = home();
    conConfigTelegram(dir, 111);
    const c = await checkWith(dir, 'owner binding legacy', { hardened: true });
    expect(c?.level).toBe('warn');
    expect(c?.remedy).toContain('muffin surface enable telegram');
    // La bugia misurata in #569: su hardened l'enable girato da questo
    // processo non scrive rot/owner.json né risigilla, quindi il rimedio non
    // può promettere il giro automatico — deve nominare il privilegio.
    expect(c?.remedy).not.toContain('scrive rot/owner.json e risigilla nello stesso giro');
    expect(c?.remedy).toMatch(/hardened/);
    expect(c?.remedy).toMatch(/privilegio che possiede rot\//);
  });

  it('with the single-user override keeps promising the automatic reseal', async () => {
    const dir = home();
    conConfigTelegram(dir, 111);
    const c = await checkWith(dir, 'owner binding legacy', { hardened: false });
    expect(c?.level).toBe('warn');
    expect(c?.remedy).toContain('scrive rot/owner.json e risigilla nello stesso giro');
  });

  it('says which of two disagreeing bindings wins', async () => {
    const dir = home();
    conConfigTelegram(dir, 111);
    sealOwnerBinding(dir, { telegram: { userId: 999, chatId: 999 } }, { out: () => {} });
    const c = await check(dir, 'owner binding');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('sigillo 999');
    expect(c?.detail).toContain('config.json 111');
    expect(c?.detail).toMatch(/vince il sigillo/);
  });

  it('fails loudly when the sealed binding no longer verifies — nobody is owner', async () => {
    const dir = home();
    conConfigTelegram(dir, 111);
    sealOwnerBinding(dir, { telegram: { userId: 999, chatId: 999 } }, { out: () => {} });
    // La manomissione: il file sigillato riscritto, nessun reseal.
    writeFileSync(join(dir, 'rot', 'owner.json'), JSON.stringify({ schemaVersion: 1, telegram: { userId: 111, chatId: 111 } }));
    const c = await check(dir, 'owner binding');
    expect(c?.level).toBe('fail');
    expect(c?.detail).toMatch(/nessuna superficie riconosce più un owner/);
  });
});

describe('model routing (issue #501)', () => {
  it('warns, with remedy, when pins derive from another model era', async () => {
    const dir = home();
    const c = loadConfig(dir);
    saveConfig(
      {
        ...c,
        models: { main: 'google/gemma-4-31b-it', light: 'google/gemma-4-26b-a4b-it' },
        provider: { ...c.provider, routing: { only: ['alibaba'] }, routingForFamily: 'qwen' },
      },
      dir,
    );
    const found = await check(dir, 'model routing');
    expect(found?.level).toBe('warn');
    expect(found?.detail).toContain('alibaba');
    expect(found?.remedy).toContain('muffin model google/gemma-4-31b-it');
    rmSync(dir, { recursive: true, force: true });
  });

  it('is silent with no pins or marker, ok when the marker confirms', async () => {
    const plain = home();
    expect(await check(plain, 'model routing')).toBeUndefined();
    rmSync(plain, { recursive: true, force: true });

    const dir = home();
    const c = loadConfig(dir);
    saveConfig(
      {
        ...c,
        provider: { ...c.provider, routing: { dataCollection: 'deny' }, routingForFamily: 'qwen' },
        models: { main: 'qwen/qwen3.8-27b', light: 'qwen/qwen3.8-flash' },
      },
      dir,
    );
    // Solo policy, niente pin: niente da confrontare, nemmeno col marcatore.
    expect(await check(dir, 'model routing')).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('ok quando il marcatore conferma i pin', async () => {
    const dir = home();
    const c = loadConfig(dir);
    saveConfig(
      {
        ...c,
        provider: { ...c.provider, routing: { only: ['alibaba'] }, routingForFamily: 'qwen' },
        models: { main: 'qwen/qwen3.8-27b', light: 'qwen/qwen3.8-flash' },
      },
      dir,
    );
    const found = await check(dir, 'model routing');
    expect(found?.level).toBe('ok');
    expect(found?.detail).toContain('qwen');
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * DT-09 §3: il drift del vault in una riga — l'etichetta stale finché il
 * watcher non è cablato in un processo longevo.
 *
 * La forma è quella che `audit()` già garantisce (`core/vault/vault.ts`):
 * directory contro indice, stesso censimento del reindex. Qui si prova solo
 * che `doctor` la riporta col rimedio giusto, sul tenant `host` come
 * `muffin vault check`.
 */
describe('doctor reports vault drift with the reindex remedy', () => {
  it('is ok on a fresh home — empty vault, nothing to drift', async () => {
    const dir = home();
    const c = await check(dir, 'vault');
    expect(c?.level).toBe('ok');
    expect(c?.remedy).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is ok, naming the alignment, once the index matches the directory', async () => {
    const dir = home();
    writeFileSync(join(paths(dir).vault, 'nota.md'), '# Nota\n\ntesto\n');
    const runtime = buildRuntime(dir, dir);
    await runtime.vault.reindex('host');
    runtime.close();

    const c = await check(dir, 'vault');
    expect(c?.level).toBe('ok');
    expect(c?.detail).toContain('allineato');
    expect(c?.remedy).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('warns with the reindex remedy when a hand edit made the index stale', async () => {
    const dir = home();
    writeFileSync(join(paths(dir).vault, 'nota.md'), '# Nota\n\nprima\n');
    const runtime = buildRuntime(dir, dir);
    await runtime.vault.reindex('host');
    runtime.close();
    writeFileSync(join(paths(dir).vault, 'nota.md'), '# Nota\n\nseconda, a mano\n');

    const c = await check(dir, 'vault');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain("cambiati dopo l'indice");
    expect(c?.remedy).toContain('muffin vault reindex');
    rmSync(dir, { recursive: true, force: true });
  });

  it('warns when a file was never indexed at all', async () => {
    const dir = home();
    writeFileSync(join(paths(dir).vault, 'nota.md'), '# Nota\n\ntesto\n');
    const runtime = buildRuntime(dir, dir);
    await runtime.vault.reindex('host');
    runtime.close();
    writeFileSync(join(paths(dir).vault, 'altra.md'), '# Altra\n\nmai vista\n');

    const c = await check(dir, 'vault');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('non indicizzati');
    expect(c?.remedy).toContain('muffin vault reindex');
    rmSync(dir, { recursive: true, force: true });
  });

  it('warns when an indexed file disappeared from disk', async () => {
    const dir = home();
    writeFileSync(join(paths(dir).vault, 'nota.md'), '# Nota\n\ntesto\n');
    const runtime = buildRuntime(dir, dir);
    await runtime.vault.reindex('host');
    runtime.close();
    rmSync(join(paths(dir).vault, 'nota.md'));

    const c = await check(dir, 'vault');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('file spariti');
    expect(c?.remedy).toContain('muffin vault reindex');
    rmSync(dir, { recursive: true, force: true });
  });
});
