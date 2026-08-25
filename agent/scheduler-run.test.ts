import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecide } from '../core/policy/decide.js';
import { POLICY_FLOOR } from '../core/policy/matrix.js';
import { JobFireStore } from '../core/scheduler/job-fires.js';
import { JobStore, type Job } from '../core/scheduler/jobs.js';
import { SessionStore } from '../core/session/store.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { TodoStore } from '../core/turns/todo.js';
import { TurnStore } from '../core/turns/store.js';
import { jobOutcomeFromTurn, makeJobRunner } from './scheduler-run.js';
import type { LoopDeps, TurnResult } from './loop.js';
import { CONSERVATIVE } from './profiles/profile.js';
import type { ChatCall, ChatResult, Provider } from './providers/types.js';

const base: TurnResult = {
  text: '',
  iterations: 1,
  traceId: 't',
  turnId: 't',
  stopped: 'answered',
  // Nothing here reads it — `jobOutcomeFromTurn` maps a stop reason to a
  // message. Present because the type requires it, and the type requires it so
  // that a caller writing something derived from a turn cannot forget to ask.
  taint: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
};

describe('jobOutcomeFromTurn', () => {
  it('an answered turn delivers its text as is, carrying the row it wrote', () => {
    // `turnId` is what lets the scheduler settle the *delivery* onto the same
    // record as the turn — the two outcomes ADR-0042 keeps in two columns.
    expect(jobOutcomeFromTurn({ ...base, text: 'ecco il brief' })).toEqual({
      stopped: 'answered',
      text: 'ecco il brief',
      turnId: 't',
    });
  });

  it('a queued ASK is turned into a message the owner can act on', () => {
    const out = jobOutcomeFromTurn({
      ...base,
      stopped: 'ask',
      text: '',
      pending: { capability: 'outward.send', prompt: 'mando la mail a Marco?', resource: 'mail:marco', taint: 0 },
    });
    expect(out.stopped).toBe('ask');
    expect(out.text).toContain('In coda per te');
    expect(out.text).toContain('outward.send');
    expect(out.text).toContain('mail:marco');
    expect(out.text).toContain('mando la mail a Marco?');
  });

  it('an ASK without a resource still reads cleanly', () => {
    const out = jobOutcomeFromTurn({
      ...base,
      stopped: 'ask',
      text: '',
      pending: { capability: 'sys.shell', prompt: 'eseguo lo script?', taint: 0 },
    });
    expect(out.text).toContain('sys.shell');
    expect(out.text).not.toContain('undefined');
  });

  it('a tainted ASK says why it deserves suspicion; taint 0 stays silent', () => {
    const tainted = jobOutcomeFromTurn({
      ...base,
      stopped: 'ask',
      text: '',
      pending: { capability: 'outward.send', prompt: 'inoltro?', resource: 'mail:x', taint: 2 },
    });
    expect(tainted.text).toContain('turno a taint 2');
    const clean = jobOutcomeFromTurn({
      ...base,
      stopped: 'ask',
      text: '',
      pending: { capability: 'outward.send', prompt: 'inoltro?', resource: 'mail:x', taint: 0 },
    });
    expect(clean.text).not.toContain('taint');
  });

  it('other terminal states pass through unchanged', () => {
    expect(jobOutcomeFromTurn({ ...base, stopped: 'error', text: 'qualcosa è rotto' })).toEqual({
      stopped: 'error',
      text: 'qualcosa è rotto',
      turnId: 't',
    });
    expect(jobOutcomeFromTurn({ ...base, stopped: 'budget', text: 'cap raggiunto' }).stopped).toBe('budget');
  });
});

/**
 * `makeJobRunner` — B7's identity resolution.
 *
 * Real `TurnStore`, `JobStore`, `JobFireStore`, `SessionStore`, on one real
 * (`:memory:`) `better-sqlite3` connection — the same store classes production
 * wires, never a scheduler mock. Only the model is faked (`Scripted`, a
 * `Provider`), which is the one thing a unit test cannot avoid faking and the
 * one thing every assertion below is checking the call count of.
 */

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  calls = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(_call?: ChatCall): Promise<ChatResult> {
    const next = this.script[this.calls++];
    if (!next) throw new Error('lo script è finito — il modello non doveva essere richiamato di nuovo');
    return next;
  }
}

const answer = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  stopReason: 'end',
  usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'test',
});

/** `TurnCounters`, freshly — `agent/loop.ts`'s own `freshCounters` is not exported. */
function counters(): NonNullable<Parameters<TurnStore['create']>[0]>['counters'] {
  return {
    iterations: 0,
    recoveriesUsed: 0,
    transportRetriesLeft: 2,
    toolCallsMade: 0,
    nudgedForCompletion: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    spentUsd: 0,
    resumes: 0,
    contextBuilt: false,
  };
}

const SPEC = { cron: '0 8 * * *', timezone: 'Europe/Rome', goal: 'controlla il backup', channel: 'cli' };

function fixture(script: ChatResult[]) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-scheduler-run-'));
  const db = new DatabaseCtor(':memory:');
  const turns = new TurnStore(db);
  const todos = new TodoStore(db);
  const jobs = new JobStore(db);
  const fires = new JobFireStore(db);
  const provider = new Scripted(script);
  const deps: LoopDeps = {
    provider,
    profile: CONSERVATIVE,
    model: 'test-model',
    tools: [],
    decide: createDecide({ matrix: POLICY_FLOOR, capabilities: new Map(), budgetExhausted: () => false, hardened: true }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions: new SessionStore(home),
    turns,
    todos,
    budgetExhausted: () => false,
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite in un gruppo.' },
  };
  return { deps, db, jobs, fires, provider };
}

describe('makeJobRunner — B7 identity resolution', () => {
  it('a fresh occurrence creates exactly one turn and binds the fire to it', async () => {
    const { deps, db, jobs, fires, provider } = fixture([answer('ecco il brief')]);
    const job = jobs.add(SPEC);

    const outcome = await makeJobRunner(deps, fires)(job, undefined);

    if (!('stopped' in outcome)) throw new Error(`atteso un JobOutcome, ricevuto ${JSON.stringify(outcome)}`);
    expect(outcome.stopped).toBe('answered');
    expect(outcome.text).toBe('ecco il brief');
    expect(provider.calls).toBe(1);

    const fire = fires.get(job.id, job.nextFireAt.toISOString());
    expect(fire?.turnId).toBe(outcome.turnId);
    expect(deps.turns.get(outcome.turnId!)?.status).toBe('done');
    const rows = db.prepare(`SELECT count(*) AS n FROM turns`).get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('the SAME occurrence resolved twice — before anything settles it — never re-runs the model (fault point 6)', async () => {
    // job.nextFireAt does not move between the two calls (nothing calls
    // `markRan`), so `scheduledFor` is identical both times — exactly a
    // second tick, or a second process, reaching the same due job before
    // `Scheduler` ever gets to deliver/settle the first pass.
    const { deps, db, jobs, fires, provider } = fixture([answer('primo e unico giro')]);
    const job = jobs.add(SPEC);

    const first = await makeJobRunner(deps, fires)(job, undefined);
    if (!('stopped' in first)) throw new Error(`atteso un JobOutcome, ricevuto ${JSON.stringify(first)}`);
    expect(first.text).toBe('primo e unico giro');

    const second = await makeJobRunner(deps, fires)(job, undefined);
    expect(provider.calls).toBe(1); // the model ran exactly once, not twice
    if (!('stopped' in second)) throw new Error(`atteso un JobOutcome, ricevuto ${JSON.stringify(second)}`);
    expect(second.turnId).toBe(first.turnId);
    // Recovered from the session file the first pass wrote — not re-asked.
    expect(second.text).toBe('primo e unico giro');

    const rows = db.prepare(`SELECT count(*) AS n FROM turns`).get() as { n: number };
    expect(rows.n).toBe(1); // never a second turn for the same occurrence
  });

  it('a turn already done and already delivered settles without touching the model — fault point 5/6', async () => {
    const { deps, jobs, fires, provider } = fixture([answer('non deve mai essere chiamato')]);
    const job = jobs.add(SPEC);
    const scheduledFor = job.nextFireAt.toISOString();
    fires.claim(job.id, scheduledFor);
    const turnId = fires.bind(job.id, scheduledFor, 'turn-done-delivered');
    const rec = deps.turns.create(
      {
        id: turnId,
        principal: { kind: 'system', source: 'scheduler' },
        tenant: 'host',
        surface: 'cli',
        sessionId: 'sess-done-delivered',
        model: 'test-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: job.goal }] }],
        taint: 0,
        counters: counters(),
        replyTo: { channel: 'cli' },
      },
      99999,
    );
    deps.turns.finish(rec.id, { outcome: 'answered', messages: rec.messages, taint: 0, counters: rec.counters }, rec.claimToken);
    deps.turns.delivered(rec.id, 'sent'); // some other pass already delivered it

    const outcome = await makeJobRunner(deps, fires)(job, undefined);

    expect(provider.calls).toBe(0);
    if (!('settleOnly' in outcome)) throw new Error(`atteso settleOnly, ricevuto ${JSON.stringify(outcome)}`);
    expect(outcome.turnId).toBe(turnId);
    expect(outcome.outcome).toBe('answered');
    expect(outcome.delivered).toBe(true);
  });

  it('a turn already done but recorded undeliverable also settles without touching the model, and says delivered:false', async () => {
    const { deps, jobs, fires, provider } = fixture([answer('non deve mai essere chiamato')]);
    const job = jobs.add(SPEC);
    const scheduledFor = job.nextFireAt.toISOString();
    fires.claim(job.id, scheduledFor);
    const turnId = fires.bind(job.id, scheduledFor, 'turn-undeliverable');
    const rec = deps.turns.create(
      {
        id: turnId,
        principal: { kind: 'system', source: 'scheduler' },
        tenant: 'host',
        surface: 'cli',
        sessionId: 'sess-undeliverable',
        model: 'test-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: job.goal }] }],
        taint: 0,
        counters: counters(),
        replyTo: { channel: 'cli' },
      },
      99999,
    );
    deps.turns.finish(rec.id, { outcome: 'answered', messages: rec.messages, taint: 0, counters: rec.counters }, rec.claimToken);
    deps.turns.delivered(rec.id, 'undeliverable');

    const outcome = await makeJobRunner(deps, fires)(job, undefined);

    expect(provider.calls).toBe(0);
    if (!('settleOnly' in outcome)) throw new Error(`atteso settleOnly, ricevuto ${JSON.stringify(outcome)}`);
    expect(outcome.delivered).toBe(false);
  });

  it('a turn already done but not yet delivered recovers the text from the session file — fault point 5', async () => {
    const { deps, jobs, fires, provider } = fixture([answer('non deve mai essere chiamato')]);
    const job = jobs.add(SPEC);
    const scheduledFor = job.nextFireAt.toISOString();
    fires.claim(job.id, scheduledFor);
    const turnId = fires.bind(job.id, scheduledFor, 'turn-crash-before-settle');

    const session = deps.sessions.open('job-recover-session');
    deps.sessions.append(session, {
      role: 'assistant',
      content: 'la risposta che il crash non ha mai consegnato',
      surface: 'cli',
      createdAt: new Date().toISOString(),
      traceId: turnId,
    });
    const rec = deps.turns.create(
      {
        id: turnId,
        principal: { kind: 'system', source: 'scheduler' },
        tenant: 'host',
        surface: 'cli',
        sessionId: session.id,
        model: 'test-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: job.goal }] }],
        taint: 0,
        counters: counters(),
        replyTo: { channel: 'cli' },
      },
      99999,
    );
    deps.turns.finish(rec.id, { outcome: 'answered', messages: rec.messages, taint: 0, counters: rec.counters }, rec.claimToken);
    // delivery is still 'pending' — nothing has told the channel yet.

    const outcome = await makeJobRunner(deps, fires)(job, undefined);

    expect(provider.calls).toBe(0); // never called the model again
    if (!('stopped' in outcome)) throw new Error(`atteso un JobOutcome, ricevuto ${JSON.stringify(outcome)}`);
    expect(outcome.stopped).toBe('answered');
    expect(outcome.text).toBe('la risposta che il crash non ha mai consegnato');
    expect(outcome.turnId).toBe(turnId);
  });

  it.each(['running', 'interrupted', 'waiting'] as const)(
    "a fire bound to a turn that is still '%s' defers — belongs to the turn lane, not this call (fault point 4)",
    async (status) => {
      const { deps, db, jobs, fires, provider } = fixture([answer('non deve mai essere chiamato')]);
      const job = jobs.add(SPEC);
      const scheduledFor = job.nextFireAt.toISOString();
      fires.claim(job.id, scheduledFor);
      const turnId = fires.bind(job.id, scheduledFor, `turn-${status}`);
      deps.turns.create(
        {
          id: turnId,
          principal: { kind: 'system', source: 'scheduler' },
          tenant: 'host',
          surface: 'cli',
          sessionId: `sess-${status}`,
          model: 'test-model',
          messages: [{ role: 'user', content: [{ type: 'text', text: job.goal }] }],
          taint: 0,
          counters: counters(),
          replyTo: { channel: 'cli' },
        },
        99999,
      );
      // `create` always leaves a fresh row 'running'; the other two statuses
      // this fault point covers are reached the way a real crash/suspend
      // leaves them, not by re-deriving the mechanism here.
      if (status !== 'running') db.prepare(`UPDATE turns SET status = ? WHERE id = ?`).run(status, turnId);

      const outcome = await makeJobRunner(deps, fires)(job, undefined);

      expect(provider.calls).toBe(0);
      expect(outcome).toEqual({ deferred: true });
      // The fire stays exactly as it was — not settled, still pointing at the
      // one turn that already exists.
      const fire = fires.get(job.id, scheduledFor);
      expect(fire?.settledAt).toBeNull();
      expect(fire?.turnId).toBe(turnId);
    },
  );

  it('an occurrence that arrives already bound (to any id) is always resolved through that id, never a competing one', async () => {
    // Stands in for the runner losing the bind race a moment before this call:
    // by the time `makeJobRunner` reads the fire, `turn_id` is already set to
    // an id it did not mint. `job_fires.test.ts` proves the store's own
    // first-writer-wins guarantee directly; this proves the runner obeys it.
    const { deps, db, jobs, fires, provider } = fixture([answer('completa il binding interrotto')]);
    const job = jobs.add(SPEC);
    const scheduledFor = job.nextFireAt.toISOString();
    fires.claim(job.id, scheduledFor);
    fires.bind(job.id, scheduledFor, 'turn-winner'); // bound, but never created — fault point 2

    const outcome = await makeJobRunner(deps, fires)(job, undefined);

    if (!('stopped' in outcome)) throw new Error(`atteso un JobOutcome, ricevuto ${JSON.stringify(outcome)}`);
    expect(outcome.turnId).toBe('turn-winner'); // never a freshly minted id
    expect(provider.calls).toBe(1); // completing the interrupted bind runs once
    const rows = db.prepare(`SELECT count(*) AS n FROM turns`).get() as { n: number };
    expect(rows.n).toBe(1); // never a second, competing turn
  });
});
