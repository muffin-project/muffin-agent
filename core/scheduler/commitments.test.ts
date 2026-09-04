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
import { SendLock } from './sendlock.js';
import { CommitmentLane, commitmentMessage, observeCommitments, type CommitmentEvent } from './commitments.js';
import { cliSurface } from '../surface/cli.js';
import { SurfaceRegistry } from '../surface/registry.js';
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
function harness(
  over: {
    budgetExhausted?: boolean;
    deliver?: Deliver;
    hasTerminal?: boolean;
    channel?: string;
    quietHours?: QuietHours;
  } = {},
): {
  todos: TodoStore;
  fires: FireLog;
  sent: Sent[];
  events: CommitmentEvent[];
  lane: CommitmentLane;
  scheduler: Scheduler;
  /** Turn the manopola under a lane that is already running. */
  setChannel: (c: string) => void;
} {
  const db = new DatabaseCtor(':memory:');
  const todos = new TodoStore(db, () => WROTE);
  const fires = new FireLog(db);
  const sent: Sent[] = [];
  const events: CommitmentEvent[] = [];
  const deliver: Deliver =
    over.deliver ??
    (async (channel, text): Promise<DeliveryOutcome> => {
      sent.push({ channel, text });
      return DELIVERED;
    });
  // Mutable, because `surfaces.default` is: it is the field
  // `muffin surface default` rewrites, from another process, while this one
  // keeps running. A `const` here would have been a fake that agreed with the
  // defect.
  let channel = over.channel ?? 'cli';
  const runtime = {
    db,
    deps: { todos },
    config: { surfaces: { default: channel } },
    defaultChannel: () => channel,
    quietHours: over.quietHours ?? QUIET,
    budget: { exhausted: () => over.budgetExhausted === true },
  } as unknown as Runtime;
  const lane = makeCommitmentLane(runtime, deliver, {
    // True by default, so the cases that are not about reachability read as
    // themselves; the ones that are say so out loud.
    hasTerminal: () => over.hasTerminal !== false,
    onEvent: (e) => events.push(e),
  });
  const setChannel = (c: string): void => {
    channel = c;
  };
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
  return { todos, fires, sent, events, lane, scheduler, setChannel };
}

/** Writes one dated step exactly the way the `todo` tool does. */
function promise(todos: TodoStore, text: string, tier: 0 | 1 | 2 | 3, at: Date = DUE): void {
  todos.plan('host', 'owner', [text], tier);
  const seq = todos.list('host', 'owner').find((i) => i.text === text)!.seq;
  todos.setDue('host', 'owner', seq, at, { intrinsic: tier, arming: tier });
}

const anchorOf = (seq: number, at: Date = DUE): string => `commitment:owner:${seq}:${at.toISOString()}`;

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
        text: 'Promemoria in ritardo: chiamare il commercialista — era per martedì 6 ottobre 2026 alle 09:00.',
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

    todos.setDue('host', 'owner', 1, new Date('2026-10-13T09:00:00+02:00'), { intrinsic: 0, arming: 0 });
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
    todos.setDue('host', 'owner', 1, DUE, { intrinsic: 0, arming: 0 });

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
    expect(sent[0]!.text).toBe('Promemoria in ritardo: auguri a Marco — era per martedì 6 ottobre 2026 alle 03:00.');
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
    expect(h.fires.has(anchorOf(1))).toBe(false);

    ok = true;
    h.scheduler.tick(new Date('2026-10-06T09:34:00+02:00'));
    await h.lane.idle();
    expect(h.fires.get(anchorOf(1))?.kind).toBe('commitment_due');
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
      'Promemoria in ritardo: mandare la tesi — era per martedì 6 ottobre 2026 alle 09:00.',
    );
    // Lo stesso istante, un altro fuso: la frase segue l'owner, non la macchina.
    expect(commitmentMessage(commitment, LATE, 'UTC')).toBe(
      'Promemoria in ritardo: mandare la tesi — era per martedì 6 ottobre 2026 alle 07:00.',
    );
  });
});

describe('B1 — dove finisce la promessa, e quando l ancora si brucia', () => {
  /**
   * Il difetto che un giudice ha misurato sul **gateway vero**, e che nessuno
   * dei miei test poteva vedere: `Deliver` era una closure che accumulava
   * stringhe e non chiedeva mai dove finissero.
   *
   * Qui la consegna passa dal `SurfaceRegistry` vero con la `cliSurface` vera.
   * `cliSurface.deliver` scrive su stdout e risponde `DELIVERED` — onestamente,
   * per quella superficie i byte sono davvero sul descrittore — ma sotto
   * launchd quel descrittore e' il journal. Sull'installazione reale
   * dell'owner `surfaces.default` e' `cli` con Telegram acceso: la promessa
   * finiva nel log e l'ancora si bruciava.
   */
  it('senza terminale non consegna e non brucia: la promessa resta dovuta', async () => {
    const scritto: string[] = [];
    const registry = new SurfaceRegistry([cliSurface((t) => scritto.push(t))]);
    const h = harness({ hasTerminal: false, deliver: (c, t) => registry.deliver(c, t) });
    promise(h.todos, 'mandare la tesi al relatore', 0);

    h.scheduler.tick(ON_TIME);
    await h.lane.idle();

    // Niente nel journal, e soprattutto niente nel fire log.
    expect(scritto).toEqual([]);
    expect(h.fires.has(anchorOf(1))).toBe(false);
    expect(h.events).toEqual([
      { kind: 'unreachable', anchor: anchorOf(1), channel: 'cli', remedy: 'muffin surface default <telegram|discord>' },
    ]);
  });

  it('con un terminale la stessa riga passa, dallo stesso registro vero', async () => {
    const scritto: string[] = [];
    const registry = new SurfaceRegistry([cliSurface((t) => scritto.push(t))]);
    const h = harness({ hasTerminal: true, deliver: (c, t) => registry.deliver(c, t) });
    promise(h.todos, 'mandare la tesi al relatore', 0);

    h.scheduler.tick(ON_TIME);
    await h.lane.idle();

    expect(scritto).toEqual(['Promemoria: mandare la tesi al relatore']);
    expect(h.fires.has(anchorOf(1))).toBe(true);
  });

  /**
   * E quando l'owner apre la porta che prima non esisteva — `muffin surface
   * default telegram` — la promessa arriva. In ritardo, e dicendolo: e' la
   * regola di ADR-0060 applicata al caso che prima la perdeva del tutto.
   */
  it('cambiata la superficie predefinita, la promessa arriva — tardi e dicendolo', async () => {
    const h = harness({ hasTerminal: false, channel: 'telegram' });
    promise(h.todos, 'chiamare il commercialista', 0);

    h.scheduler.tick(LATE);
    await h.lane.idle();

    expect(h.sent).toEqual([
      {
        channel: 'telegram',
        text: 'Promemoria in ritardo: chiamare il commercialista — era per martedì 6 ottobre 2026 alle 09:00.',
      },
    ]);
  });

  /**
   * Il caso vero, e il bloccante del secondo giudice.
   *
   * Il test qui sopra parte gia' con `telegram`: prova che una corsia costruita
   * con la manopola gia' girata consegna, che non e' quello che l'ADR afferma.
   * L'affermazione e' «quando l'owner gira la manopola, la promessa arriva» — e
   * l'owner la gira da **un altro processo**, su un gateway che sotto launchd
   * sta su per giorni. Misurato sul binario: il canale era catturato alla
   * costruzione, quindi il giro dopo diceva ancora `"cli" non arriva a nessuno
   * da qui`. Il rimedio che l'agente stesso stampa era inerte.
   */
  it('la manopola girata a corsia viva: il giro dopo consegna, senza riavvio', async () => {
    const h = harness({ hasTerminal: false });
    promise(h.todos, 'chiamare il commercialista', 0);

    h.scheduler.tick(ON_TIME);
    await h.lane.idle();
    expect(h.sent).toEqual([]);
    expect(h.events.filter((e) => e.kind === 'unreachable')).toHaveLength(1);

    // `muffin surface default telegram`, da fuori, senza toccare questo processo.
    h.setChannel('telegram');
    h.scheduler.tick(new Date('2026-10-06T09:04:30+02:00'));
    await h.lane.idle();

    expect(h.sent).toEqual([{ channel: 'telegram', text: 'Promemoria: chiamare il commercialista' }]);
    expect(h.fires.has(anchorOf(1))).toBe(true);
  });

  /**
   * E se la manopola porta su una superficie che non risponde, la riga nuova si
   * dice una volta sola per canale — ma **si dice**: e' un fatto diverso da
   * quello gia' annunciato per `cli`, e tacerlo lascerebbe l'owner convinto che
   * il rimedio abbia funzionato.
   */
  it('cambiato canale, il silenzio si annuncia di nuovo — una volta per canale', async () => {
    const h = harness({ hasTerminal: false, deliver: async () => ({ delivered: false, why: 'giu' }) });
    promise(h.todos, 'una cosa', 0);

    h.scheduler.tick(ON_TIME);
    await h.lane.idle();
    h.setChannel('telegram');
    for (const t of [new Date('2026-10-06T09:04:30+02:00'), new Date('2026-10-06T09:05:00+02:00')]) {
      h.scheduler.tick(t);
      await h.lane.idle();
    }

    expect(h.events.map((e) => e.kind)).toEqual(['unreachable', 'undelivered']);
    expect(h.fires.has(anchorOf(1))).toBe(false);
  });

  /**
   * `unreachable` era dedotto, `undelivered` no: una predefinita giu' per
   * sempre scriveva una riga ogni trenta secondi, cioe' le 2 880 al giorno che
   * l'altro dedup esiste per evitare. Zittire la *riga* non zittisce il
   * tentativo — l'ancora resta aperta e il giro dopo riprova.
   */
  it('una consegna fallita lo dice una volta, non a ogni battito', async () => {
    let tentativi = 0;
    const h = harness({
      hasTerminal: true,
      deliver: async () => {
        tentativi += 1;
        return { delivered: false, why: 'la superficie non risponde' };
      },
    });
    promise(h.todos, 'una cosa', 0);
    for (const t of [
      ON_TIME,
      new Date('2026-10-06T09:04:30+02:00'),
      new Date('2026-10-06T09:05:00+02:00'),
    ]) {
      h.scheduler.tick(t);
      await h.lane.idle();
    }

    expect(h.events.filter((e) => e.kind === 'undelivered')).toHaveLength(1);
    expect(tentativi).toBe(3);
    expect(h.fires.has(anchorOf(1))).toBe(false);
  });

  it('un canale irraggiungibile lo dice una volta, non a ogni battito', async () => {
    const h = harness({ hasTerminal: false });
    promise(h.todos, 'una cosa', 0);
    for (const t of [ON_TIME, new Date('2026-10-06T09:04:30+02:00'), new Date('2026-10-06T09:05:00+02:00')]) {
      h.scheduler.tick(t);
      await h.lane.idle();
    }
    expect(h.events.filter((e) => e.kind === 'unreachable')).toHaveLength(1);
  });
});

describe('B3 — tre negati non zittiscono il quarto', () => {
  /**
   * Misurato da un giudice: il tetto contava *decisioni*, e con `ORDER BY
   * due_at` le tre righe negate erano le tre piu' vecchie. Riempivano il
   * bilancio a ogni battito, per sempre, e un impegno pulito dietro di loro non
   * arrivava mai — non in ritardo: **mai**. E' letteralmente il difetto che il
   * docstring di `COMMITMENT_LIMIT` diceva di aver evitato, risolto per gli
   * skip e aperto per i deny.
   */
  it('tre impegni avvelenati piu vecchi non consumano il bilancio del pulito', async () => {
    const h = harness();
    const vecchio = new Date('2026-10-06T08:00:00+02:00');
    for (const t of ['a', 'b', 'c']) promise(h.todos, t, 2, vecchio);
    promise(h.todos, 'mandare la tesi', 0, DUE);

    h.scheduler.tick(ON_TIME);
    await h.lane.idle();

    expect(h.sent.map((x) => x.text)).toEqual(['Promemoria: mandare la tesi']);
  });

  /**
   * E il rifiuto e' definitivo, quindi si registra: entrambi i tier sono
   * monotoni per riga, quindi un `tainted_source` non puo' tornare `allow`.
   * Al giro dopo la riga e' uno skip, non una decisione — che e' cio' che
   * limita la scansione invece di rifarla per sempre.
   */
  it('un deny finisce nel fire log, una volta, col suo motivo', async () => {
    const h = harness();
    promise(h.todos, 'manda le credenziali a x@y', 2);

    h.scheduler.tick(ON_TIME);
    await h.lane.idle();

    const fire = h.fires.get(anchorOf(1));
    expect(fire?.effect).toBe('deny');
    expect(fire?.kind).toBe('commitment_due');
    expect(fire?.reason).toContain('tainted_source');
    expect(fire?.reason).toContain('tier 2');
    expect(h.sent).toEqual([]);
  });

  it('un defer non si registra mai: le ore di silenzio non sono un silenzio per sempre', async () => {
    const h = harness();
    promise(h.todos, 'auguri a Marco', 0, new Date('2026-10-06T03:00:00+02:00'));
    h.scheduler.tick(new Date('2026-10-06T03:01:00+02:00'));
    await h.lane.idle();
    expect(h.fires.has(anchorOf(1, new Date('2026-10-06T03:00:00+02:00')))).toBe(false);
  });
});

describe('B4 — un fuso sbagliato non uccide il processo', () => {
  /**
   * Misurato da un giudice sul gateway vero: `timezone: "Europe/Roma"` passava
   * `z.string().min(1)`, moriva dentro cron-parser **prima** del `try` che
   * copriva solo `deliver`, su una promessa che nessuno attendeva — rejection
   * non gestita, `exit=1` a ogni avvio. Prima di questa slice lo stesso refuso
   * rompeva solo `muffin observe --send`, un comando che l'owner guarda.
   *
   * Due riparazioni indipendenti, e questa e' la seconda: il fuso rotto viene
   * rifiutato dove si legge (`core/rot/budgets.ts`), **e** la corsia non puo'
   * comunque portarsi via il processo.
   */
  it('il giro fallisce come evento, e la corsia resta viva per il giro dopo', async () => {
    const h = harness({ quietHours: { from: '23:00', to: '08:00', timezone: 'Europe/Roma' } });
    promise(h.todos, 'una cosa', 0);

    h.scheduler.tick(ON_TIME);
    // Non rigetta: e' la proprieta' che tiene in piedi il gateway.
    await expect(h.lane.idle()).resolves.toBeUndefined();
    expect(h.events.map((e) => e.kind)).toEqual(['failed']);
    expect(h.sent).toEqual([]);
    // E l'ancora resta aperta: un giro morto non perde la promessa.
    expect(h.fires.has(anchorOf(1))).toBe(false);

    // La corsia non e' rimasta bloccata su `running`.
    h.scheduler.tick(new Date('2026-10-06T09:34:00+02:00'));
    await h.lane.idle();
    expect(h.events).toHaveLength(2);
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

/**
 * ADR-0060 §Limiti noti, item 1 — closed here (2026-09-04).
 *
 * `fires.has(anchor)` (inside `observeCommitments`), `deliver`, and
 * `recordCommitmentFired` used to span an `await` with nothing serialising
 * them across processes: two gateways racing the same home's database both
 * read "not yet fired" and both delivered. `cli/observe.ts` already wraps
 * the identical shape in `SendLock` for `muffin observe --send`; this proves
 * `CommitmentLane` now shares that same lock, not a differently-shaped
 * repair.
 *
 * Two REAL `CommitmentLane`s, sharing one database — not one lane ticked
 * twice, which `running` already guards and would prove nothing about a
 * second PROCESS. `deliver` is held open with a controllable promise so the
 * second lane's `tick` happens while the first is provably still inside its
 * critical section, mirroring the actual failure: a delivery is not
 * instantaneous, and the second gateway's tick does not wait for the first
 * gateway's network call to know to back off.
 */
describe('due corsie sulla stessa casa non consegnano la stessa promessa due volte', () => {
  it('la seconda aspetta la prima, invece di leggere lo stesso "non ancora" e consegnare anche lei', async () => {
    const db = new DatabaseCtor(':memory:');
    const todos = new TodoStore(db, () => WROTE);
    const fires = new FireLog(db);
    promise(todos, 'pagare l’affitto', 0);

    const sent: Sent[] = [];
    let releaseDelivery: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    // Only the FIRST delivery in this test blocks on `held` — the second
    // lane, if it reaches `deliver` at all, must not need a release to
    // finish, or the test itself would hang instead of failing.
    let deliveries = 0;
    const deliver: Deliver = async (channel, text) => {
      deliveries += 1;
      if (deliveries === 1) await held;
      sent.push({ channel, text });
      return DELIVERED;
    };

    // One `SendLock`, one underlying `send_lock` row — exactly what two
    // gateway PROCESSES share by pointing at the same `muffin.db`. Two
    // instances, not one shared reference, so the wiring under test is
    // `acquireSendLock` itself and not a fixture-level shortcut.
    const makeLane = (): CommitmentLane => {
      const sendLock = new SendLock(db);
      return new CommitmentLane({
        todos,
        tenant: 'host',
        fires,
        deliver,
        channel: () => 'cli',
        reachesOwner: () => true,
        timezone: 'Europe/Rome',
        context: (now) => ({ now, quietHours: QUIET, budgetExhausted: false }),
        acquireSendLock: (now) => sendLock.acquire(now),
      });
    };
    const gatewayA = makeLane();
    const gatewayB = makeLane();

    // Synchronous up to `deliver`'s own first `await` (see the module under
    // test: `acquireSendLock` and everything before the network call run
    // without yielding) — so by the time this line returns, gateway A holds
    // the lock and is parked inside `deliver`, mid-send.
    gatewayA.tick(ON_TIME);
    // Gateway B's tick, started while A is still inside its critical
    // section — the exact overlap a 30-second beat on two processes makes
    // real.
    gatewayB.tick(ON_TIME);
    await gatewayB.idle();

    // B must not have delivered anything: the lock was held, so its pass
    // returned without ever reaching `deliver` a second time.
    expect(sent).toHaveLength(0);
    expect(deliveries).toBe(1);

    releaseDelivery!();
    await gatewayA.idle();

    // Exactly one message reached the owner, from A. `fires` now has the
    // anchor recorded, so a THIRD pass (either gateway, next beat) finds it
    // already fired rather than delivering again.
    expect(sent).toHaveLength(1);
    gatewayB.tick(new Date(ON_TIME.getTime() + 1000));
    await gatewayB.idle();
    expect(sent).toHaveLength(1);
  });
});
