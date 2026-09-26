import { describe, expect, it } from 'vitest';
import type { TurnCounters, TurnRecord, TurnStatus } from '../../core/turns/store.js';
import { zeroLifetime } from '../../core/turns/store.js';
import { TurnRun } from './run-state.js';
import { providerMessages } from './provider-checkpoint.js';

/**
 * Fetta 6 della decomposizione (Fase A, §3): l'unico cambio di *forma* del
 * lotto. I locali mutabili di `guidaIlTurno` diventano campi di un oggetto,
 * così che le fette 7 e 8 possano portarne fuori i consumatori senza una firma
 * a dieci parametri.
 *
 * Un movimento di forma non ha un test naturale — il comportamento è lo stesso
 * — quindi questo file misura le tre proprietà che la *forma nuova* rende
 * falsificabili, e che il disegno nomina una per una:
 *
 *  1. `resumes` non è scrivibile e non cambia lungo il turno;
 *  2. `counters()` non consegna mai lo stato vivo, nemmeno annidato;
 *  3. `contextBuilt` viene dai contatori del record, mai dal suo `status`.
 */

const counters = (over: Partial<TurnCounters> = {}): TurnCounters => ({
  iterations: 0,
  recoveriesUsed: 0,
  transportRetriesLeft: 3,
  truncationsUsed: 0,
  toolCallsMade: 0,
  nudgedForCompletion: false,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  spentUsd: 0,
  resumes: 0,
  contextBuilt: false,
  ...over,
});

const record = (over: { counters?: Partial<TurnCounters>; status?: TurnStatus } = {}): TurnRecord => ({
  id: 't1',
  principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
  tenant: 'host',
  surface: 'cli',
  sessionId: 's1',
  inputText: null,
  providerLease: { model: 'test', checkpoint: [{ role: 'user', content: [{ type: 'text', text: 'ciao' }] }] },
  taint: 0,
  counters: counters(over.counters),
  replyTo: null,
  jobId: null,
  status: over.status ?? 'running',
  wakeAt: null,
  waitFor: null,
  claimedBy: null,
  claimedAt: null,
  claimToken: null,
  outcome: null,
  delivery: null,
  leaseIndex: 0,
  continuableReason: null,
  lifetime: zeroLifetime(),
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
});

const fresh = { resumed: false, wokenFromWait: false };

describe('TurnRun: counters() consegna una copia', () => {
  it('lo stato del turno non cambia se chi riceve i contatori li muta', () => {
    const run = new TurnRun(record({ counters: { iterations: 2, toolCallsMade: 5 } }), fresh);
    const snapshot = run.counters();

    snapshot.iterations = 99;
    snapshot.toolCallsMade = 99;
    snapshot.contextBuilt = true;

    expect(run.iterations).toBe(2);
    expect(run.toolCallsMade).toBe(5);
    expect(run.contextBuilt).toBe(false);
  });

  it('`usage` è copiato anche se è annidato — il caso che una copia superficiale manca', () => {
    // `usage` è l'unico campo dei contatori che è un oggetto, ed è quello che
    // il turno muta sul posto (`run.usage.inputTokens += …`). Una `counters()`
    // che copiasse solo il livello esterno consegnerebbe comunque il
    // riferimento vivo: la riga già scritta cambierebbe sotto chi l'ha scritta,
    // e chi legge i contatori potrebbe alterare la spesa del turno.
    const run = new TurnRun(record(), fresh);
    const primo = run.counters();

    run.usage.inputTokens += 40;

    expect(primo.usage.inputTokens).toBe(0);
    expect(run.counters().usage.inputTokens).toBe(40);
    expect(run.counters().usage).not.toBe(run.usage);

    run.counters().usage.outputTokens = 1234;
    expect(run.usage.outputTokens).toBe(0);
  });

  it('due chiamate non condividono nessun oggetto', () => {
    const run = new TurnRun(record(), fresh);
    expect(run.counters()).not.toBe(run.counters());
    expect(run.counters().usage).not.toBe(run.counters().usage);
    expect(run.counters()).toEqual(run.counters());
  });

  it("l'ordine delle chiavi del blob durevole è quello di prima dell'estrazione", () => {
    // I contatori finiscono su una riga come `JSON.stringify(counters)`: un
    // riordino dei campi cambia i byte scritti senza cambiare nessun valore.
    const run = new TurnRun(record(), fresh);
    expect(Object.keys(run.counters())).toEqual([
      'iterations',
      'recoveriesUsed',
      'transportRetriesLeft',
      'truncationsUsed',
      'toolCallsMade',
      'nudgedForCompletion',
      'usage',
      'spentUsd',
      'resumes',
      'contextBuilt',
      'activeModelMs',
    ]);
  });
});

describe('TurnRun: `resumes` è calcolato una volta e non si muove', () => {
  it('non è scrivibile: un getter senza setter lancia invece di contare due volte', () => {
    const run = new TurnRun(record({ counters: { resumes: 1 } }), { resumed: true, wokenFromWait: false });
    expect(run.resumes).toBe(2);

    // Il guasto che questa riga esclude: `MAX_RESUMES` è un tetto sul numero di
    // riprese di una riga, e un turno che incrementasse `resumes` anche qui —
    // oltre al conteggio fatto una volta dal record in costruzione — spenderebbe
    // il budget al doppio della velocità e rifiuterebbe di riprendere un turno
    // ancora sano. `readonly` in TypeScript è una promessa a compile time; un
    // getter senza setter è la stessa promessa a runtime.
    expect(() => {
      (run as unknown as { resumes: number }).resumes = 7;
    }).toThrow(TypeError);
    expect(run.resumes).toBe(2);
  });

  it('non cambia lungo il turno, per quanto il resto si muova', () => {
    const run = new TurnRun(record({ counters: { resumes: 2 } }), { resumed: true, wokenFromWait: true });
    const iniziale = run.resumes;

    for (let i = 0; i < 5; i++) {
      run.iterations += 1;
      run.toolCallsMade += 1;
      run.usage.inputTokens += 10;
      run.spentUsd += 0.01;
      run.contextBuilt = true;
      expect(run.counters().resumes).toBe(iniziale);
    }

    expect(run.resumes).toBe(iniziale);
  });

  it("una ripresa che non spende budget non incrementa (`wait` risolto è progresso, non un crash loop)", () => {
    // `spendeIlBudget`: un turno svegliato da una `wait` che aveva armato lui
    // stesso ha *progredito*, quindi non paga il budget anti-crash-loop.
    const wokenFromWait = new TurnRun(record({ counters: { resumes: 3 } }), { resumed: true, wokenFromWait: true });
    const crashResume = new TurnRun(record({ counters: { resumes: 3 } }), { resumed: true, wokenFromWait: false });
    const primaEsecuzione = new TurnRun(record({ counters: { resumes: 3 } }), fresh);

    expect(wokenFromWait.resumes).toBe(3);
    expect(crashResume.resumes).toBe(4);
    expect(primaEsecuzione.resumes).toBe(3);
  });

  it("una continuazione concessa dall'owner non spende il budget anti-crash-loop", () => {
    // P0-B, decisione `resumes`: MAX_RESUMES limita i giri che uccidono il
    // processo, non le continuazioni esplicite (autenticate, a ritmo umano).
    // Azzerarlo qui cancellerebbe l'evidenza dei crash in mezzo alle
    // continuazioni — la stessa forma vietata per `suspend` — e un turno che
    // alterna continuazioni e crash non scatterebbe mai. Le continuazioni si
    // contano a parte, in `lifetime.leases`.
    const continued = new TurnRun(record({ counters: { resumes: 2 } }), {
      resumed: true,
      wokenFromWait: false,
      continued: true,
    });
    expect(continued.resumes).toBe(2);
    expect(continued.continued).toBe(true);
    // E un crash dentro la lease continuata paga come sempre.
    const crashInside = new TurnRun(record({ counters: { resumes: 2 } }), { resumed: true, wokenFromWait: false });
    expect(crashInside.resumes).toBe(3);
  });
});

describe('TurnRun: `contextBuilt` viene dai contatori, non dallo status', () => {
  /**
   * Sono due fatti diversi che coincidono solo sulle righe fortunate. Il
   * preambolo non è idempotente (scrive l'episodio dell'owner, chiama il
   * recall, appende alla sessione, e — peggio — *ricostruisce* il transcript
   * dal file di sessione buttando via il batch di tool a metà che il crash ha
   * lasciato). `contextBuilt` è la sola cosa che dice se ha già girato.
   */
  const statuses: TurnStatus[] = ['runnable', 'running', 'waiting'];

  it('una riga con il preambolo già fatto lo dice, qualunque sia lo status', () => {
    for (const status of statuses) {
      const run = new TurnRun(record({ counters: { contextBuilt: true }, status }), fresh);
      expect([status, run.contextBuilt]).toEqual([status, true]);
    }
  });

  it('una riga senza preambolo lo dice, qualunque sia lo status', () => {
    // Il caso che una derivazione dallo status sbaglierebbe in silenzio: una
    // riga `waiting` o `running` ripresa dopo un crash *dentro* il preambolo
    // non l'ha mai finito, ed è esattamente ciò che il flag esiste per coprire.
    for (const status of statuses) {
      const run = new TurnRun(record({ counters: { contextBuilt: false }, status }), fresh);
      expect([status, run.contextBuilt]).toEqual([status, false]);
    }
  });
});

describe('TurnRun: il transcript parte dal record senza restarci attaccato', () => {
  it('è una copia: quello che il turno scrive non muta la riga letta da disco', () => {
    const riga = record();
    const run = new TurnRun(riga, fresh);

    expect(run.messages).toEqual(providerMessages(riga));
    expect(run.messages).not.toBe(providerMessages(riga));

    run.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'ciao a te' }] });
    expect(providerMessages(riga)).toHaveLength(1);
  });

  it('il preambolo può ricostruirlo sul posto, e chi ne tiene il riferimento lo vede', () => {
    // `guidaIlTurno` fa `messages.length = 0; messages.push(...buildContext(...))`
    // invece di riassegnare, perché ogni funzione annidata ne tiene lo stesso
    // riferimento. Il campo è `readonly` sul riferimento, non sul contenuto.
    const run = new TurnRun(record(), fresh);
    const riferimento = run.messages;

    run.messages.length = 0;
    run.messages.push({ role: 'user', content: [{ type: 'text', text: 'contesto ricostruito' }] });

    expect(riferimento).toHaveLength(1);
    expect(riferimento[0]?.content[0]).toEqual({ type: 'text', text: 'contesto ricostruito' });
  });
});
