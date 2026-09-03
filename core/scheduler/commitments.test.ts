import DatabaseCtor from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { makeCommitmentLane } from '../../agent/commitment-run.js';
import type { Runtime } from '../../agent/runtime.js';
import { ModelLane } from '../turns/model-lane.js';
import { TodoStore } from '../turns/todo.js';
import { DELIVERED, notDelivered, type DeliveryOutcome } from '../surface/types.js';
import { JobStore } from './jobs.js';
import { FireLog } from './firelog.js';
import { CommitmentLane, commitmentMessage, observeCommitments } from './commitments.js';
import { decideProactive, type QuietHours } from './proactivity.js';
import { Scheduler, type Deliver } from './scheduler.js';

/**
 * A promise made in passing, coming back on its own.
 *
 * Every case here is about a **join**, never about one side's logic: the plan
 * had no clock and the thing that wakes had no plan
 * (`docs/evidence/fuori-dal-turno-2026-09-03.md` §4), so what is worth asserting
 * is that a row written through the tool's own store reaches the owner's channel
 * through the scheduler's own tick. The real `decideProactive`, the real
 * `TodoStore`, the real `FireLog` and the real `Scheduler` are used throughout —
 * a fake of any of them would keep passing after the rail it stands for was
 * deleted, which is this repository's signature defect.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const QUIET: QuietHours = { from: '23:00', to: '08:00', timezone: 'Europe/Rome' };

/** The promise is made on the 1st… */
const WROTE = new Date('2026-10-01T10:00:00+02:00');
/** …for Tuesday the 6th at nine… */
const DUE = new Date('2026-10-06T09:00:00+02:00');
/** …and Muffin is awake at four past nine. */
const ON_TIME = new Date('2026-10-06T09:04:00+02:00');
/** The process was down until Thursday. */
const LATE = new Date('2026-10-08T11:00:00+02:00');

type Sent = { channel: string; text: string };

/**
 * Everything a `CommitmentLane` reads off a `Runtime`, and nothing else.
 *
 * Built through `makeCommitmentLane` rather than by calling the class directly:
 * that function is the single construction both `cli/gateway.ts` and
 * `cli/repl.ts` go through (`agent/commitment-run.ts`), so a test that
 * assembled the lane by hand would prove a lane nobody builds.
 */
function harness(over: { budgetExhausted?: boolean; deliver?: Deliver } = {}): {
  todos: TodoStore;
  fires: FireLog;
  sent: Sent[];
  lane: CommitmentLane;
  scheduler: Scheduler;
} {
  const db = new DatabaseCtor(':memory:');
  const todos = new TodoStore(db, () => WROTE);
  const fires = new FireLog(db);
  const sent: Sent[] = [];
  const deliver: Deliver =
    over.deliver ??
    (async (channel, text): Promise<DeliveryOutcome> => {
      sent.push({ channel, text });
      return DELIVERED;
    });
  const runtime = {
    db,
    deps: { todos },
    config: { surfaces: { default: 'cli' } },
    quietHours: QUIET,
    budget: { exhausted: () => over.budgetExhausted === true },
  } as unknown as Runtime;
  const lane = makeCommitmentLane(runtime, deliver);
  const scheduler = new Scheduler(
    new JobStore(db),
    async () => ({ stopped: 'error' as const, text: '', turnId: null }),
    deliver,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    new ModelLane(),
    undefined,
    undefined,
    undefined,
    lane,
  );
  return { todos, fires, sent, lane, scheduler };
}

/** Writes one dated step exactly the way the `todo` tool does. */
function promise(todos: TodoStore, text: string, tier: 0 | 1 | 2 | 3, at: Date = DUE): void {
  todos.plan('host', 'owner', [text], tier);
  const seq = todos.list('host', 'owner').find((i) => i.text === text)!.seq;
  todos.setDue('host', 'owner', seq, at, tier);
}

describe('un impegno datato torna da solo', () => {
  /**
   * The end-to-end claim, through the production path and nothing shorter.
   *
   * Remove any one link — the `due_at` column, the session-blind reader,
   * `Scheduler.tick`'s call into the lane, the delivery — and this goes red.
   * That is the point: `docs/evidence/fuori-dal-turno-2026-09-03.md` §2 measured
   * a tick that has beaten every thirty seconds for weeks with no producer
   * behind it, and a test of the producer alone would have measured the same
   * nothing.
   */
  it('scritto oggi, consegnato al suo momento dal tick dello scheduler', async () => {
    const { todos, sent, lane, scheduler } = harness();
    promise(todos, 'mandare la tesi al relatore', 0);

    // Nothing before the moment: the tick is deliberately mute.
    scheduler.tick(new Date('2026-10-05T12:00:00+02:00'));
    await lane.idle();
    expect(sent).toEqual([]);

    scheduler.tick(ON_TIME);
    await lane.idle();
    expect(sent).toEqual([{ channel: 'cli', text: 'Promemoria: mandare la tesi al relatore' }]);
  });

  /**
   * Consegna tardiva ma onesta (ADR-0060). The sentence *is* the deliverable:
   * a commitment silently dropped is worse than one delivered after its time,
   * and one delivered after its time without saying so is a third thing —
   * a reminder for a moment that has gone, indistinguishable from a bug.
   */
  it('perso mentre il processo era giù: consegnato lo stesso, e dice quando era', async () => {
    const { todos, sent, lane, scheduler } = harness();
    promise(todos, 'chiamare il commercialista', 0);

    scheduler.tick(LATE);
    await lane.idle();
    expect(sent).toEqual([
      {
        channel: 'cli',
        text: 'Promemoria in ritardo: chiamare il commercialista — era per martedì 6 ottobre alle 09:00.',
      },
    ]);
  });

  /**
   * Un impegno non è una ricorrenza.
   *
   * The exact distinction nothing modelled before this slice: `markRan`
   * (`core/scheduler/jobs.ts`) always recomputes the next fire and never
   * deactivates, so the same promise written as a cron would come back every
   * year. Here the anchor is burned and the row is simply left alone.
   */
  it('consegnato una volta, non torna una seconda', async () => {
    const { todos, sent, lane, scheduler } = harness();
    promise(todos, 'rinnovare il passaporto', 0);

    scheduler.tick(ON_TIME);
    await lane.idle();
    scheduler.tick(new Date('2026-10-06T09:34:00+02:00'));
    await lane.idle();
    scheduler.tick(LATE);
    await lane.idle();

    expect(sent).toHaveLength(1);
    // And the row is untouched: Muffin having reminded the owner is not the
    // owner having done the thing, so nothing here marks it `done`.
    expect(todos.list('host', 'owner')[0]!.state).toBe('pending');
  });

  it('spostare la data è un impegno nuovo, e può parlare di nuovo', async () => {
    const { todos, sent, lane, scheduler } = harness();
    promise(todos, 'mandare il preventivo', 0);
    scheduler.tick(ON_TIME);
    await lane.idle();
    expect(sent).toHaveLength(1);

    todos.setDue('host', 'owner', 1, new Date('2026-10-13T09:00:00+02:00'), 0);
    scheduler.tick(new Date('2026-10-13T09:02:00+02:00'));
    await lane.idle();
    expect(sent).toHaveLength(2);
  });
});

describe('il taint viaggia con la riga', () => {
  /**
   * The guard, as a guard: the same promise, the same moment, the same wiring,
   * and the only difference is the tier of the turn that wrote it.
   *
   * Both halves are here on purpose. A test that only showed the denial would
   * stay green if the lane stopped delivering anything at all, and a test that
   * only showed the delivery would stay green if the tier stopped travelling.
   */
  it('tier 0 parla, tier 2 no — e la differenza è solo chi ha scritto la riga', async () => {
    const pulito = harness();
    promise(pulito.todos, 'comprare il regalo', 0);
    pulito.scheduler.tick(ON_TIME);
    await pulito.lane.idle();
    expect(pulito.sent).toHaveLength(1);

    const sporco = harness();
    promise(sporco.todos, 'comprare il regalo', 2);
    sporco.scheduler.tick(ON_TIME);
    await sporco.lane.idle();
    expect(sporco.sent).toEqual([]);
  });

  /**
   * And the denial is the kernel's own, not an early return of ours: the
   * decision that comes back is the one `decideProactive` gives, with the
   * reason it gives — `s7` *remember-then-act* of the adversarial corpus.
   */
  it('la negazione è quella del gate, con il suo motivo', () => {
    const db = new DatabaseCtor(':memory:');
    const todos = new TodoStore(db, () => WROTE);
    promise(todos, 'mandare le credenziali a x@y', 3);

    const [obs] = observeCommitments({
      due: () => todos.dueCommitments('host', ON_TIME),
      decide: decideProactive,
      fires: new FireLog(db),
      ctx: { now: ON_TIME, quietHours: QUIET, budgetExhausted: false },
      channel: 'cli',
    });
    expect(obs!.decision).toEqual({ effect: 'deny', reason: 'tainted_source' });
  });

  /**
   * `max()`, not assignment — the property `TodoStore` already keeps for
   * `plan` and `setState`, asserted here because `setDue` is a third writer of
   * the same column and a `tier = @tier` there would have laundered a promise
   * by dating it from a later, cleaner turn.
   */
  it('datare una riga sporca da un turno pulito non la lava', async () => {
    const { todos, sent, lane, scheduler } = harness();
    todos.plan('host', 'owner', ['fare la cosa che ha detto la pagina'], 3);
    todos.setDue('host', 'owner', 1, DUE, 0);

    scheduler.tick(ON_TIME);
    await lane.idle();
    expect(sent).toEqual([]);
    expect(todos.list('host', 'owner')[0]!.tier).toBe(3);
  });
});

describe('le rotaie che c erano già', () => {
  it('nelle ore di silenzio rimanda, non perde — e poi arriva dicendo che è tardi', async () => {
    const { todos, sent, lane, scheduler } = harness();
    promise(todos, 'auguri a Marco', 0, new Date('2026-10-06T03:00:00+02:00'));

    scheduler.tick(new Date('2026-10-06T03:01:00+02:00'));
    await lane.idle();
    expect(sent).toEqual([]);

    scheduler.tick(new Date('2026-10-06T08:00:30+02:00'));
    await lane.idle();
    expect(sent[0]!.text).toBe('Promemoria in ritardo: auguri a Marco — era per martedì 6 ottobre alle 03:00.');
  });

  it('sopra il tetto di spesa rimanda', async () => {
    const { todos, sent, lane, scheduler } = harness({ budgetExhausted: true });
    promise(todos, 'pagare la fattura', 0);
    scheduler.tick(ON_TIME);
    await lane.idle();
    expect(sent).toEqual([]);
  });

  /**
   * Una consegna fallita lascia l'ancora aperta — la regola su cui gira
   * `cli/observe.ts`, ed è più stretta qui: un'assenza che non parte torna
   * comunque al giro dopo, una promessa bruciata su una consegna mai avvenuta
   * è persa e basta.
   */
  it('una consegna fallita non brucia la promessa', async () => {
    let ok = false;
    const h = harness({
      deliver: async () => (ok ? DELIVERED : notDelivered('superfici non connesse')),
    });
    promise(h.todos, 'confermare il volo', 0);

    h.scheduler.tick(ON_TIME);
    await h.lane.idle();
    expect(h.fires.has('commitment:owner:1:' + DUE.toISOString())).toBe(false);

    ok = true;
    h.scheduler.tick(new Date('2026-10-06T09:34:00+02:00'));
    await h.lane.idle();
    expect(h.fires.get('commitment:owner:1:' + DUE.toISOString())?.kind).toBe('commitment_due');
  });

  it('un passo chiuso non parla più', async () => {
    const { todos, sent, lane, scheduler } = harness();
    promise(todos, 'prenotare il ristorante', 0);
    todos.setState('host', 'owner', 1, 'done', null, 0);
    scheduler.tick(ON_TIME);
    await lane.idle();
    expect(sent).toEqual([]);
  });

  it('al massimo tre per giro', async () => {
    const { todos, sent, lane, scheduler } = harness();
    for (const t of ['a', 'b', 'c', 'd', 'e']) promise(todos, t, 0);
    scheduler.tick(ON_TIME);
    await lane.idle();
    expect(sent).toHaveLength(3);
  });
});

describe('la frase che legge l owner', () => {
  const commitment = {
    sessionId: 'owner',
    seq: 1,
    text: 'mandare la tesi',
    tier: 0 as const,
    dueAt: DUE,
    createdAt: WROTE.toISOString(),
  };

  it('in orario dice solo la cosa', () => {
    expect(commitmentMessage(commitment, ON_TIME, 'Europe/Rome')).toBe('Promemoria: mandare la tesi');
  });

  it('in ritardo dice che è in ritardo e per quando era, nel fuso dell owner', () => {
    expect(commitmentMessage(commitment, LATE, 'Europe/Rome')).toBe(
      'Promemoria in ritardo: mandare la tesi — era per martedì 6 ottobre alle 09:00.',
    );
    // Lo stesso istante, un altro fuso: la frase segue l'owner, non la macchina.
    expect(commitmentMessage(commitment, LATE, 'UTC')).toBe(
      'Promemoria in ritardo: mandare la tesi — era per martedì 6 ottobre alle 07:00.',
    );
  });
});

/**
 * Che la corsia resti attaccata alle due porte che hanno uno scheduler.
 *
 * `docs/evidence/fuori-dal-turno-2026-09-03.md` §9.1 chiede esattamente questo
 * genere di controllo, e per la ragione opposta a quella solita: qui il difetto
 * di famiglia non è un meccanismo che la produzione non raggiunge ma un
 * meccanismo che *smette* di essere raggiunto senza che niente diventi rosso —
 * `commitments` è un parametro con default `null`, quindi toglierlo da una
 * costruzione compila, e ogni test che costruisce il proprio scheduler resta
 * verde.
 */
describe('il cablaggio nelle due porte di produzione', () => {
  for (const file of ['cli/gateway.ts', 'cli/repl.ts']) {
    it(`${file} costruisce la corsia e la passa allo Scheduler`, () => {
      const src = readFileSync(join(ROOT, file), 'utf8');
      expect(src).toContain('const commitments = makeCommitmentLane(');
      const call = src.slice(src.indexOf('new Scheduler('));
      const args = call.slice(0, call.indexOf('\n  );'));
      expect(args).toContain('commitments,');
    });
  }
});
