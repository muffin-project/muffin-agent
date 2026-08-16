import DatabaseCtor from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runInit } from '../cli/init.js';
import { paths } from '../core/config/config.js';
import { runDoctor } from '../cli/doctor.js';
import { GatewayLock } from '../core/gateway/lock.js';
import { buildRuntime } from './runtime.js';
import { runTurn, type LoopDeps } from './loop.js';
import type { ChatResult, Provider } from './providers/types.js';

/**
 * The join between `buildRuntime` and the turn record, and the failure path
 * that reads it back — asserted through the production assembly.
 *
 * The loop's own tests prove a turn writes a record when it is handed a store.
 * They would all stay green if `buildRuntime` stopped handing it one: every
 * install would run with no record at all, silently, which is precisely the
 * shape of defect this repo has paid for four times. This file is the test that
 * fails without the wiring.
 *
 * The second half is the failure path, and it is run as a failure and not as a
 * simulation: a **real second process** takes a turn, dies holding it, and this
 * one reports what is unknown about it. No key is needed and no model is called
 * — the property is about the record, not about the answer.
 */

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  async chat(): Promise<ChatResult> {
    return {
      text: 'ecco la risposta',
      toolCalls: [],
      stopReason: 'end',
      usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: 'test',
    };
  }
}

function bootHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'muffin-turnwire-'));
  runInit({ home, apiKey: 'sk-never-called' });
  return home;
}

const workspace = () => mkdtempSync(join(tmpdir(), 'muffin-turnwire-ws-'));

/**
 * A process that takes a turn and dies with it — the crash this record exists
 * to make visible, performed rather than described.
 *
 * It goes through `buildRuntime` and the runtime's own store, so what it leaves
 * behind is a row written by production code, claimed by a pid that really
 * belonged to a process that really stopped existing.
 */
function crashHoldingATurn(home: string, ws: string): number {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-turnwire-crash-'));
  const script = join(dir, 'crash.mjs');
  const runtimeUrl = pathToFileURL(join(process.cwd(), 'agent', 'runtime.ts')).href;
  writeFileSync(
    script,
    `import { buildRuntime } from ${JSON.stringify(runtimeUrl)};
const rt = buildRuntime(process.argv[2], process.argv[3]);
rt.deps.turns.create({
  id: 'crash-turn',
  principal: { kind: 'owner', connector: 'telegram', externalId: '1' },
  tenant: 'host',
  surface: 'telegram',
  sessionId: 'telegram:1',
  model: 'claude-opus-5',
  messages: [],
  taint: 0,
  counters: { iterations: 1, recoveriesUsed: 0, transportRetriesLeft: 2, toolCallsMade: 1,
              nudgedForCompletion: false,
              usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
              spentUsd: 0 },
  replyTo: { chatId: 1, messageId: 2 },
});
rt.deps.turns.startToolCall('crash-turn', {
  callId: 'k1', tool: 'shell_run', capability: 'sys.shell', rerunnable: false, args: { command: 'invia' },
});
// Dies exactly where the defect lives: inside the turn, after the effect may
// have started and before anything recorded how it went.
process.exit(1);
`,
  );
  const child = spawnSync('node', ['--import', 'tsx', script, home, ws], { encoding: 'utf8', timeout: 60_000 });
  expect(child.status).toBe(1);
  return child.pid ?? 0;
}

describe('buildRuntime puts the turn record on the real path', () => {
  it('a turn through the production runtime leaves a row in the home database', async () => {
    const home = bootHome();
    const runtime = buildRuntime(home, workspace());
    const deps: LoopDeps = { ...runtime.deps, provider: new Scripted() };
    const result = await runTurn(deps, {
      principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
      tenant: 'host',
      surface: 'cli',
      session: runtime.deps.sessions.open('wiring'),
      text: 'ciao',
    });
    runtime.close();

    // Read from a fresh handle on the file the owner's data actually lives in:
    // the row has to have survived the process that wrote it, or none of this
    // is a record of anything.
    const db = new DatabaseCtor(paths(home).db, { readonly: true });
    const row = db.prepare(`SELECT * FROM turns WHERE id = ?`).get(result.turnId) as
      | { status: string; model: string; surface: string; turn_outcome: string; delivery: string | null }
      | undefined;
    db.close();
    expect(row).toMatchObject({ status: 'done', surface: 'cli', turn_outcome: 'answered' });
    // The model of the assembled runtime, not a literal from this test: the pin
    // has to be the one the turn really ran on.
    expect(row?.model).toBe(runtime.config.models.main);
    // No reply address on the CLI, so no delivery that can fail.
    expect(row?.delivery).toBeNull();
  });

  it('the record shares the database of everything else — one process, one handle', () => {
    const home = bootHome();
    const runtime = buildRuntime(home, workspace());
    // `jobs` and the budget already live on `runtime.db` (ADR-0022). If the
    // turn store opened its own connection, the row below would not be visible
    // through this one — and the day a connector needs the update and the turn
    // record to commit together, it would be impossible.
    runtime.deps.turns.create({
      id: 'same-db',
      principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
      tenant: 'host',
      surface: 'cli',
      sessionId: 's',
      model: 'm',
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
    const seen = runtime.db.prepare(`SELECT count(*) AS n FROM turns`).get() as { n: number };
    runtime.close();
    expect(seen.n).toBe(1);
  });
});

describe('a turn a dead process was holding', () => {
  it('is named at the next boot, with what cannot be known about it', () => {
    const home = bootHome();
    const ws = workspace();
    crashHoldingATurn(home, ws);

    // The next surface to start — any of them: `muffin run`, the REPL, the
    // gateway all print `bootLines` before their first turn.
    const runtime = buildRuntime(home, ws);
    const notes = runtime.bootLines.join('\n');
    runtime.close();

    expect(notes).toContain('crash-turn');
    expect(notes).toContain('telegram');
    // The honest part: the call is not declared re-runnable, so nothing here
    // may claim to know whether it landed.
    expect(notes).toContain('shell_run');
    expect(notes).toContain('non è possibile sapere se ha avuto effetto');
  });

  it('is not resumed, and does not pretend to be resumable', () => {
    const home = bootHome();
    const ws = workspace();
    crashHoldingATurn(home, ws);
    buildRuntime(home, ws).close();

    const db = new DatabaseCtor(paths(home).db, { readonly: true });
    const row = db.prepare(`SELECT status, claimed_by FROM turns WHERE id = 'crash-turn'`).get() as {
      status: string;
      claimed_by: number | null;
    };
    db.close();
    // `interrupted`, never `runnable`: no resume exists, and a status promising
    // one would be a mechanism declared and connected to nothing — the family
    // of defect this whole record was built to stop adding to.
    expect(row).toEqual({ status: 'interrupted', claimed_by: null });
  });

  it('is announced once, not once per surface that starts', () => {
    const home = bootHome();
    const ws = workspace();
    crashHoldingATurn(home, ws);
    const first = buildRuntime(home, ws);
    const second = buildRuntime(home, ws);
    const firstNotes = first.bootLines.filter((l) => l.includes('crash-turn'));
    const secondNotes = second.bootLines.filter((l) => l.includes('crash-turn'));
    first.close();
    second.close();
    expect(firstNotes).toHaveLength(1);
    expect(secondNotes).toEqual([]);
  });

  it('a live turn in another process is left alone — this is not a lock breaker', () => {
    const home = bootHome();
    const ws = workspace();
    const runtime = buildRuntime(home, ws);
    // Claimed by a process that exists: this one.
    runtime.deps.turns.create({
      id: 'mine',
      principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
      tenant: 'host',
      surface: 'cli',
      sessionId: 's',
      model: 'm',
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
    const other = buildRuntime(home, ws);
    const claimed = other.bootLines.filter((l) => l.includes('mine'));
    runtime.close();
    other.close();
    expect(claimed).toEqual([]);
  });
});

describe('un turno sospeso senza gateway non è un turno perso in silenzio', () => {
  /**
   * The state only a laneless surface can produce, and the one `doctor` was
   * blind to.
   *
   * `health()` counted `interrupted` and nothing else, so a turn suspended from
   * the REPL or from `muffin run` sat at `waiting` for ever with no path by
   * which the owner ever learned that its wake-up was owed to a process that is
   * not running. The two facts are useless apart: N suspended turns is healthy
   * with a gateway up and is *work nobody will ever wake* without one.
   */
  function homeWithASuspendedTurn(): string {
    const home = bootHome();
    const ws = workspace();
    const runtime = buildRuntime(home, ws);
    runtime.deps.turns.create({
      id: 'sospeso',
      principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
      tenant: 'host',
      surface: 'cli',
      sessionId: 's',
      model: 'm',
      messages: [],
      taint: 0,
      counters: {
        iterations: 1,
        recoveriesUsed: 0,
        transportRetriesLeft: 2,
        toolCallsMade: 0,
        nudgedForCompletion: false,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        spentUsd: 0,
        resumes: 0,
        contextBuilt: true,
      },
    });
    runtime.deps.turns.suspend('sospeso', {
      messages: [],
      taint: 0,
      counters: {
        iterations: 1,
        recoveriesUsed: 0,
        transportRetriesLeft: 2,
        toolCallsMade: 0,
        nudgedForCompletion: false,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        spentUsd: 0,
        resumes: 0,
        contextBuilt: true,
      },
      wakeAt: '2026-08-16T11:00:00.000Z',
      waitFor: null,
    });
    runtime.close();
    return home;
  }

  it('`muffin doctor` avverte quando nessun gateway può svegliarlo', () => {
    const check = runDoctor(homeWithASuspendedTurn()).checks.find((c) => c.name === 'turni sospesi');
    expect(check?.level).toBe('warn');
    expect(check?.detail).toContain('nessun gateway attivo');
    // The number and the deadline, because "some turns are waiting" is not
    // something an owner can act on.
    expect(check?.detail).toContain('1 in attesa');
    expect(check?.detail).toContain('2026-08-16 11:00');
    expect(check?.remedy).toContain('gateway');
  });

  it('lo dice anche al boot, dove l’owner guarda per primo', () => {
    const runtime = buildRuntime(homeWithASuspendedTurn(), workspace());
    const notes = runtime.bootLines.join('\n');
    runtime.close();
    expect(notes).toContain('1 turni sospesi');
  });

  it('e non è un allarme quando il gateway c’è', () => {
    const home = homeWithASuspendedTurn();
    // A live claim, taken by this very process, so `readGateway` sees a holder.
    const db = new DatabaseCtor(paths(home).db);
    new GatewayLock(db).claim(new Date(), 'in attesa', process.pid);
    db.close();

    const check = runDoctor(home).checks.find((c) => c.name === 'turni sospesi');
    expect(check?.level).toBe('ok');
    expect(check?.detail).toContain('li riprende il gateway');
  });

  it('e tace del tutto quando non ce ne sono', () => {
    const home = bootHome();
    buildRuntime(home, workspace()).close();
    // No row, no line: a check that always speaks is a check nobody reads.
    expect(runDoctor(home).checks.find((c) => c.name === 'turni sospesi')).toBeUndefined();
  });
});

describe('acceptance: the owner asks what happened', () => {
  it('`muffin doctor` names the interrupted turn and says what the resume will and will not redo', () => {
    const home = bootHome();
    const ws = workspace();
    crashHoldingATurn(home, ws);

    // Before anything else boots — the state an owner is actually in when they
    // notice no answer came and open a terminal.
    const report = runDoctor(home);
    const turns = report.checks.find((c) => c.name === 'turni');
    expect(turns?.level).toBe('warn');
    expect(turns?.detail).toContain('crash-turn');
    expect(turns?.detail).toContain('shell_run');
    // The remedy used to read "non esiste ancora un resume … controllali a
    // mano", and this assertion is what kept it honest — it now pins the
    // opposite fact, because the resume exists. A remedy that tells the owner to
    // go and redo by hand what the runtime deliberately did not redo would send
    // them to repeat the very effect the record exists to avoid repeating.
    expect(turns?.remedy).toContain('il gateway li riprende');
    expect(turns?.remedy).toContain('non ri-eseguibile non viene rifatta');

    // And once it has been reported at boot, `doctor` still says it: the state
    // is on the row, not in whoever happened to print a line first.
    buildRuntime(home, ws).close();
    const after = runDoctor(home).checks.find((c) => c.name === 'turni');
    expect(after?.level).toBe('warn');
    expect(after?.detail).toContain('crash-turn');
  });

  it('says so plainly when nothing is wrong', () => {
    const home = bootHome();
    buildRuntime(home, workspace()).close();
    const turns = runDoctor(home).checks.find((c) => c.name === 'turni');
    expect(turns?.level).toBe('ok');
    expect(turns?.detail).toContain('nessuno interrotto');
  });
});
