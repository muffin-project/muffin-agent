import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BudgetEngine } from '../core/budget/budget.js';
import { createDecide } from '../core/policy/decide.js';
import { POLICY_FLOOR } from '../core/policy/matrix.js';
import { JobFireStore } from '../core/scheduler/job-fires.js';
import { JobStore, type Job, jobPayload } from '../core/scheduler/jobs.js';
import { SessionStore } from '../core/session/store.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { TodoStore } from '../core/turns/todo.js';
import { CAPPED_MODEL, SCRIPT_MODEL, TurnStore } from '../core/turns/store.js';
import { jobOutcomeFromTurn, makeJobRunner } from './scheduler-run.js';
import { makeScheduleTool, scheduleCapability } from './tools/schedule.js';
import { resumeTurn } from './loop.js';
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
    truncationsUsed: 0,
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
    capabilities: new Map(),
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
        messages: [{ role: 'user', content: [{ type: 'text', text: jobPayload(job) }] }],
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
        messages: [{ role: 'user', content: [{ type: 'text', text: jobPayload(job) }] }],
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
        messages: [{ role: 'user', content: [{ type: 'text', text: jobPayload(job) }] }],
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
          messages: [{ role: 'user', content: [{ type: 'text', text: jobPayload(job) }] }],
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

/**
 * Il probe del judge di questa slice, reso permanente.
 *
 * La prima stesura scriveva la riga del turno **dopo** `exec.run()`. Un crash
 * a metà script non lasciava quindi nessuna riga, `resolveBound` legge
 * l'assenza di riga come «non è ancora partito niente, quindi non è un
 * duplicato», e al riavvio lo script ripartiva: `exec.run()` chiamato due
 * volte, osservato dal judge con un probe. Uno script che manda una mail o
 * addebita qualcosa lo farebbe due volte, e la riga finale mostrerebbe
 * un'esecuzione sola — la duplicazione non lascia traccia.
 */
describe('makeJobRunner — uno script non gira due volte', () => {
  const SCRIPT_SPEC = {
    cron: '0 8 * * *',
    timezone: 'Europe/Rome',
    channel: 'cli',
    kind: 'script' as const,
    script: 'echo ciao',
  };

  it('un crash a metà script non fa ripartire lo script al riavvio', async () => {
    const { deps, jobs, fires, provider } = fixture([]);
    const job = jobs.add(SCRIPT_SPEC);

    // Uno script che non ritorna mai: è il processo che muore mentre gira.
    let partenze = 0;
    const appeso = {
      run: async (): Promise<never> => {
        partenze += 1;
        return new Promise<never>(() => {});
      },
    };

    // Prima esecuzione: parte e resta appesa (il processo muore qui).
    void makeJobRunner(deps, fires, appeso, { cwd: '/tmp' })(job, undefined);
    await new Promise((r) => setTimeout(r, 50));
    expect(partenze).toBe(1);

    // Riavvio: la stessa occorrenza viene risolta di nuovo. In gara con un
    // timeout, perché il difetto che questo test esiste per catturare fa
    // ripartire lo script — e lo script appeso non torna mai: senza la gara
    // il fallimento sarebbe un timeout del test invece dell'asserzione, cioè
    // un rosso che non dice cosa è andato storto.
    const seconda = await Promise.race([
      makeJobRunner(deps, fires, appeso, { cwd: '/tmp' })(job, undefined),
      new Promise((r) => setTimeout(() => r('BLOCCATO'), 1500)),
    ]);

    // Lo script NON è ripartito, e il secondo giro dice che il lavoro è di
    // qualcun altro invece di rifarlo.
    expect(partenze).toBe(1);
    expect(seconda).toEqual({ deferred: true });
    expect(provider.calls).toBe(0);
  });

  it('senza sandbox non esegue, e lo dice', async () => {
    const { deps, jobs, fires, provider } = fixture([]);
    const job = jobs.add(SCRIPT_SPEC);

    const outcome = await makeJobRunner(deps, fires, null, { cwd: '/tmp' })(job, undefined);

    if (!('stopped' in outcome)) throw new Error(`atteso un JobOutcome, ricevuto ${JSON.stringify(outcome)}`);
    expect(outcome.stopped).toBe('error');
    expect(outcome.text).toContain('sandbox');
    expect(provider.calls).toBe(0);
  });

  it('un turno script interrotto non si riprende col modello, e lo script non viene rifatto', async () => {
    // L'altra metà del crash a metà script, sul percorso che NON passa dallo
    // scheduler: la riga `running` di un processo morto viene reclamata come
    // `interrupted` al boot, e la turn-lane la riprende con `resumeTurn`.
    // Prima della guardia su SCRIPT_MODEL la lane chiamava il modello con
    // «script: echo …» come fosse una richiesta dell'owner — un costo, una
    // risposta inventata, e consegnata. Il judge del giro 2 ha provato la
    // guardia sana con un probe usa-e-getta; questo è quel probe reso
    // permanente, perché era a un refactor di distanza dal rompersi in
    // silenzio.
    const { deps, provider } = fixture([answer('mai chiamato')]);

    // La riga esattamente come la scrive `runScript`: stesso principal,
    // stesso modello sentinella, stesso primo messaggio.
    const morto = 999_999_983; // un pid che non esiste: la reclaim lo vede morto
    const riga = deps.turns.create(
      {
        id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
        principal: { kind: 'system', source: 'scheduler' },
        tenant: 'host',
        surface: 'cli',
        sessionId: deps.sessions.open('job-test').id,
        model: SCRIPT_MODEL,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'script: echo ciao' }] }],
        taint: 0,
        counters: { ...counters(), contextBuilt: true },
        replyTo: { channel: 'cli' },
      },
      morto,
    );
    expect(riga.status).toBe('running');

    // Il boot successivo: il pid è morto, la riga diventa `interrupted`.
    const reclaimed = deps.turns.reclaim(new Date());
    expect(reclaimed.map((r) => r.id)).toContain(riga.id);

    const esito = await resumeTurn(deps, riga.id);
    if (!('stopped' in esito)) throw new Error(`atteso un esito terminale, ricevuto ${JSON.stringify(esito)}`);

    // Il modello non è mai stato toccato, lo script non è stato rieseguito, e
    // il testo dice la sola cosa vera: forse fatto, non rifatto.
    expect(provider.calls).toBe(0);
    expect(esito.stopped).toBe('error');
    expect(esito.text).toContain("Non l'ho rifatto");
    expect(esito.text).toContain('echo ciao');
    expect(deps.turns.get(riga.id)?.status).toBe('done');
  });
});

/**
 * Il tetto per-job, sul percorso che chiama davvero il modello (DAY-1 E1).
 *
 * `makeJobRunner` è l'unico posto in cui un job diventa una chiamata al
 * modello, quindi è l'unico posto in cui un tetto per-job può essere qualcosa
 * di diverso da una colonna. La prova non è «la funzione ha restituito
 * budget»: è **`provider.calls === 0`** — l'assenza di una richiesta che
 * sarebbe stata registrata se ci fosse stata — più la riga durevole che dice
 * perché.
 */
describe('makeJobRunner — il tetto per-job (E1)', () => {
  /** `BudgetEngine` visto da `makeJobRunner`: solo il conto, in dollari. */
  const contatore = (map: Record<string, number>) => ({ jobMonthUsd: (id: string) => map[id] ?? 0 });

  it('un job che ha già speso il suo tetto NON chiama il modello, e la riga dice perché', async () => {
    // Lo script è vuoto di proposito: se il modello venisse chiamato,
    // `Scripted.chat` lancerebbe «lo script è finito» — il rosso arriverebbe
    // comunque, e da due direzioni invece che da una.
    const { deps, db, jobs, fires, provider } = fixture([]);
    const job = jobs.add({ ...SPEC, perJobUsd: 1 });

    const outcome = await makeJobRunner(deps, fires, null, null, contatore({ [job.id]: 1.5 }))(job, undefined);

    if (!('stopped' in outcome)) throw new Error(`atteso un JobOutcome, ricevuto ${JSON.stringify(outcome)}`);
    // (1) Il modello non è stato chiamato. È la proprietà, il resto è contorno.
    expect(provider.calls).toBe(0);
    // (2) L'esito è durevole e nomina il tetto: un job spento in silenzio
    //     sembra un job che gira e non trova niente da dire.
    expect(outcome.stopped).toBe('budget');
    expect(outcome.text).toContain('tetto per-job');
    expect(outcome.text).toContain('$1');
    expect(outcome.text).toContain('1.50');
    const riga = deps.turns.get(outcome.turnId!);
    expect(riga?.status).toBe('done');
    expect(riga?.outcome).toBe('budget');
    // (3) La riga dichiara di non aver visto il modello, e con quale dei due
    //     motivi: non è uno script, è un tetto.
    expect(riga?.model).toBe(CAPPED_MODEL);
    expect(riga?.counters.spentUsd).toBe(0);
    expect(riga?.counters.usage.inputTokens).toBe(0);
    // (4) L'occorrenza resta legata a UNA identità, come ogni altro giro: il
    //     rifiuto non è un buco in `job_fires`.
    expect(fires.get(job.id, job.nextFireAt.toISOString())?.turnId).toBe(outcome.turnId);
    expect((db.prepare(`SELECT count(*) AS n FROM turns`).get() as { n: number }).n).toBe(1);
  });

  it('sotto il tetto il job gira normalmente — il tetto non è un interruttore generale', async () => {
    const { deps, jobs, fires, provider } = fixture([answer('ecco il brief')]);
    const job = jobs.add({ ...SPEC, perJobUsd: 1 });

    const outcome = await makeJobRunner(deps, fires, null, null, contatore({ [job.id]: 0.4 }))(job, undefined);

    if (!('stopped' in outcome)) throw new Error(`atteso un JobOutcome, ricevuto ${JSON.stringify(outcome)}`);
    expect(outcome.stopped).toBe('answered');
    expect(provider.calls).toBe(1);
  });

  it('un job SENZA tetto gira anche quando nessuno ha cablato il contatore', async () => {
    // La direzione conta: la slice aggiunge un limite opzionale, non un
    // prerequisito nuovo per far girare i job che l'owner ha già.
    const { deps, jobs, fires, provider } = fixture([answer('ecco il brief')]);
    const job = jobs.add(SPEC);
    const outcome = await makeJobRunner(deps, fires)(job, undefined);
    if (!('stopped' in outcome)) throw new Error(`atteso un JobOutcome, ricevuto ${JSON.stringify(outcome)}`);
    expect(outcome.stopped).toBe('answered');
    expect(provider.calls).toBe(1);
  });

  it('un job CON tetto e nessun contatore cablato non parte: fail closed, non fail open', async () => {
    // La stessa disciplina di `exec === null` per gli script. Un default che
    // finge di misurare farebbe passare ogni tetto per non raggiunto, per
    // sempre, e la suite resterebbe verde su un limite che non limita.
    const { deps, jobs, fires, provider } = fixture([]);
    const job = jobs.add({ ...SPEC, perJobUsd: 1 });

    const outcome = await makeJobRunner(deps, fires)(job, undefined);

    if (!('stopped' in outcome)) throw new Error(`atteso un JobOutcome, ricevuto ${JSON.stringify(outcome)}`);
    expect(provider.calls).toBe(0);
    expect(outcome.stopped).toBe('budget');
    expect(outcome.text).toContain('non ha modo');
  });

  it('vale anche per un job script: il tetto è chiesto prima di sapere che tipo di job è', async () => {
    // Uno script non spende, quindi il suo conto non sale mai e questo caso
    // non si presenta in natura — ma il controllo sta *prima* del ramo
    // `script` di proposito: la domanda «posso spendere» non deve dipendere
    // da un ramo che qualcuno potrebbe riordinare.
    const { deps, jobs, fires } = fixture([]);
    const { goal: _ignorato, ...comune } = SPEC;
    const job = jobs.add({ ...comune, kind: 'script' as const, script: 'echo ciao', perJobUsd: 0 });
    let eseguito = false;
    const exec = {
      run: async () => {
        eseguito = true;
        return { stdout: '', stderr: '', code: 0, timedOut: false, truncated: false, durationMs: 0 };
      },
    };
    const outcome = await makeJobRunner(deps, fires, exec, { cwd: '/tmp' }, contatore({}))(job, undefined);
    if (!('stopped' in outcome)) throw new Error(`atteso un JobOutcome, ricevuto ${JSON.stringify(outcome)}`);
    expect(outcome.stopped).toBe('budget');
    expect(eseguito).toBe(false);
  });

  /**
   * Il cablaggio, provato dove si rompe: produttore → registro → gate.
   *
   * Un tetto che legge un contatore che nessuno alimenta è un tetto che non
   * scatta mai. Questa prova fa girare un job **vero** con un `recordSpend`
   * vero (`BudgetEngine`), e poi chiede al motore quanto ha speso *quel* job:
   * se `agent/loop.ts` smettesse di passare `jobId`, o
   * `agent/scheduler-run.ts` smettesse di metterlo nell'input del turno, il
   * numero tornerebbe zero e questa riga andrebbe rossa.
   */
  it('la spesa di un giro di job finisce nel registro attribuita a QUEL job', async () => {
    const { deps, db, jobs, fires } = fixture([answer('ecco il brief')]);
    const budget = new BudgetEngine(db, { monthlyUsd: 100, perTenantDailyUsd: 100 });
    const conSpesa: LoopDeps = {
      ...deps,
      recordSpend: (entry) => {
        budget.record({ ...entry, usd: 0.75 });
        return 0.75;
      },
    };
    const job = jobs.add({ ...SPEC, perJobUsd: 5 });

    await makeJobRunner(conSpesa, fires, null, null, budget)(job, undefined);

    expect(budget.jobMonthUsd(job.id)).toBe(0.75);
    // E la riga del turno porta lo stesso job, cosi' una ripresa dopo un
    // crash (che ricostruisce l'input DAL RECORD) attribuisce alla stessa
    // voce invece di perdere l'attribuzione a meta' turno.
    const turno = db.prepare(`SELECT job_id FROM turns`).get() as { job_id: string | null };
    expect(turno.job_id).toBe(job.id);
    // E la spesa interattiva resta fuori dal conto del job: la colonna è
    // nullable perché «nessun job» è un valore, non un job chiamato ''.
    budget.record({ tenant: 'host', capability: 'llm.chat', model: 'test', inputTokens: 1, outputTokens: 1, usd: 9 });
    expect(budget.jobMonthUsd(job.id)).toBe(0.75);
    expect(budget.monthToDateUsd()).toBe(9.75);
  });
});

describe('un fire non arma ricorrenze (S1, production path)', () => {
  /**
   * La prova che il divieto del kernel è sul percorso che il prodotto usa
   * davvero: un job padre gira con il runtime completo (il tool
   * `schedule_recurring` è registrato, come in `cli/gateway.ts`), il modello
   * chiama `schedule_recurring`, e il giro deve finire con un rifiuto
   * deterministico e **zero** nuove righe in `jobs`.
   *
   * Senza `jobs.schedule` in `forbiddenForSystem` il kernel risponderebbe
   * `draft` (medium + undoable procede) e questa prova troverebbe due righe:
   * è la mutazione load-bearing che la tiene rossa.
   */
  it('il giro tenta schedule_recurring, legge principal_forbidden, non scrive', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-fire-no-selfsched-'));
    const db = new DatabaseCtor(':memory:');
    const turns = new TurnStore(db);
    const todos = new TodoStore(db);
    const jobs = new JobStore(db);
    const fires = new JobFireStore(db);
    const visti: string[] = [];
    const provider: Provider = {
      kind: 'openai-compat',
      chat: async (call?: ChatCall): Promise<ChatResult> => {
        for (const m of call?.messages ?? []) {
          for (const b of m.content as Array<{ type: string; text?: string; content?: string }>) {
            if (b.type === 'tool_result' && b.content) visti.push(b.content);
          }
        }
        if (visti.length === 0) {
          return {
            text: null,
            toolCalls: [{ id: 'c1', name: 'schedule_recurring', args: { cron: '0 9 * * *', goal: 'figlio' } }],
            stopReason: 'tool_use',
            usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
            model: 'test',
          };
        }
        return {
          text: 'ricevuto',
          toolCalls: [],
          stopReason: 'end',
          usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
          model: 'test',
        };
      },
    };
    const tool = makeScheduleTool({ jobs, defaultTimezone: 'Europe/Rome', defaultChannel: 'cli' });
    const caps = new Map([[scheduleCapability.id, scheduleCapability]] as const);
    const deps: LoopDeps = {
      provider,
      profile: CONSERVATIVE,
      model: 'test-model',
      tools: [tool],
      decide: createDecide({ matrix: POLICY_FLOOR, capabilities: new Map(caps), budgetExhausted: () => false, hardened: true }),
      capabilities: new Map(caps),
      tracer: new SimpleTracer(new JsonlExporter(home)),
      sessions: new SessionStore(home),
      turns,
      todos,
      budgetExhausted: () => false,
      systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin.' },
    };
    const padre = jobs.add(SPEC);

    const outcome = await makeJobRunner(deps, fires)(padre, undefined);

    if (!('stopped' in outcome)) throw new Error(`atteso un JobOutcome, ricevuto ${JSON.stringify(outcome)}`);
    expect(outcome.stopped).toBe('answered');
    // Deterministico: il rifiuto del kernel, non un testo del modello.
    expect(visti.some((t) => t.includes('principal_forbidden'))).toBe(true);
    // Zero nuove righe: resta solo il padre.
    expect(jobs.list().map((j) => j.id)).toEqual([padre.id]);
    db.close();
  });
});
