import DatabaseCtor from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from './store.js';
import { ABSENCE_DEFAULTS, absenceAnchor, detectAbsences, overdueProbability } from './absence.js';

/**
 * Il detector di assenza, provato sulle cose che possono renderlo un firehose.
 *
 * Ogni caso qui sotto è un modo in cui questo file può sembrare giusto e non
 * esserlo: la raffica che azzera gli intervalli, il ritmo raro scambiato per
 * silenzio, l'evidenza di gruppo che arma un nudge privato. Le soglie non si
 * testano su un numero tondo ma su due entità nello stesso database con lo
 * stesso `now`, perché la regola non è "quanti giorni" — è il delta rispetto al
 * ritmo di quella cosa lì.
 */

const HOST = 'host';
const T0 = Date.parse('2026-01-01T09:00:00Z');
const DAY = 86_400_000;
/** Giorno `n` della finta storia, come ISO. */
const at = (days: number): string => new Date(T0 + days * DAY).toISOString();
const now = (days: number): Date => new Date(T0 + days * DAY);

function harness(): { db: Database; store: MemoryStore } {
  const db = new DatabaseCtor(':memory:');
  return { db, store: new MemoryStore(db) };
}

type MentionOpts = { tier?: 0 | 1 | 2 | 3; tenant?: string; asObject?: boolean };

/**
 * Una menzione = un episodio più un fatto che nomina l'entità. Passa dalla API
 * vera dello store: un test che scrive righe a mano proverebbe che so scrivere
 * lo stesso INSERT due volte.
 */
function mention(h: ReturnType<typeof harness>, name: string, days: number, opts: MentionOpts = {}): number {
  const tenant = opts.tenant ?? HOST;
  const tier = opts.tier ?? 0;
  const when = at(days);
  const entityId = h.store.upsertEntity(tenant, name, 'thing', when);
  const episodeId = h.store.addEpisode({
    tenantId: tenant,
    connector: 'cli',
    threadKey: 't1',
    role: 'user',
    kind: 'message',
    content: `qualcosa su ${name}`,
    trustTier: tier,
    createdAt: when,
  });
  // Da oggetto serve un soggetto diverso: "il libro di Marco" nomina Marco
  // quanto "Marco ha letto".
  const otherId = opts.asObject ? h.store.upsertEntity(tenant, 'Giusto', 'person', when) : entityId;
  h.store.addFact({
    tenantId: tenant,
    subjectId: opts.asObject ? otherId : entityId,
    predicate: 'menzionato',
    ...(opts.asObject ? { objectId: entityId } : { objectValue: 'x' }),
    episodeId,
    trustTier: tier,
    confidence: 0.9,
    extractionV: 1,
    recordedAt: when,
  });
  return entityId;
}

const names = (rows: { name: string }[]): string[] => rows.map((r) => r.name);

describe('overdueProbability', () => {
  it('è la coda di Lomato attesa, su numeri calcolati a mano', () => {
    // Un gap pari all'arco storico, un solo intervallo osservato: metà.
    expect(overdueProbability(10, 10, 1)).toBeCloseTo(0.5, 10);
    // Stesso gap, cinque intervalli: 2^-5. Più storia ⇒ lo stesso silenzio è
    // più strano, che è tutto il punto della predittiva.
    expect(overdueProbability(10, 10, 5)).toBeCloseTo(0.03125, 10);
    expect(overdueProbability(30, 10, 2)).toBeCloseTo(1 / 16, 10);
  });

  it('mostra che la regola "media × 3" non è una soglia al 5% quando la storia è corta', () => {
    // Il conto che il vecchio detector faceva implicitamente: gap = 3 × media,
    // con media = span/n. Nel limite di n grande tende a e^-3 = 0,0498; con due
    // intervalli — il minimo che accettiamo — vale 0,16. Un falso allarme ogni
    // sei entità invece che ogni venti: questa riga è la ragione per cui la
    // soglia qui è p e non k.
    const pAtThreeTimesMean = (n: number) => overdueProbability(3 * (10 / n), 10, n);
    expect(pAtThreeTimesMean(2)).toBeCloseTo(0.16, 2);
    expect(pAtThreeTimesMean(2)).toBeGreaterThan(ABSENCE_DEFAULTS.alpha * 3);
    // E ci arriva piano: a cinquanta intervalli è ancora 0,054, non 0,0498. La
    // regola ×3 è la coda giusta solo nel limite, e nessuna storia personale ha
    // cinquecento menzioni della stessa cosa.
    expect(pAtThreeTimesMean(50)).toBeGreaterThan(Math.exp(-3));
    expect(pAtThreeTimesMean(50)).toBeLessThan(0.06);
    expect(pAtThreeTimesMean(500)).toBeCloseTo(Math.exp(-3), 3);
  });

  it('non chiama anomalo ciò di cui non sa niente', () => {
    // Nessun intervallo, o tutte le menzioni nello stesso istante: p = 1, mai
    // sotto alpha. Se qui tornasse 0 il detector sparerebbe su ogni entità
    // nominata una volta sola.
    expect(overdueProbability(1000, 10, 0)).toBe(1);
    expect(overdueProbability(1000, 0, 5)).toBe(1);
  });
});

describe('detectAbsences', () => {
  it('misura il delta dal ritmo, non i giorni: stesso now, due verdetti opposti', () => {
    const h = harness();
    // Dal dentista si va ogni sei mesi: novanta giorni di silenzio sono la norma.
    for (const d of [0, 180, 360, 540]) mention(h, 'dentista', d);
    // In palestra si andava ogni due giorni: venti giorni sono un fatto.
    for (const d of [600, 602, 604, 606, 608, 610]) mention(h, 'palestra', d);

    const found = detectAbsences(h.db, HOST, now(630));

    expect(names(found)).toEqual(['palestra']);
    // Il dentista tace da più giorni della palestra ed è quello che NON esce.
    const dentista = 630 - 540;
    const palestra = 630 - 610;
    expect(dentista).toBeGreaterThan(palestra);
  });

  it('una raffica è un\'occasione sola, altrimenti il detector spara su tutto', () => {
    const h = harness();
    // Cinque fatti dallo stesso momento di attenzione: un messaggio che nomina
    // la stessa cosa cinque volte. Senza coalescenza gli intervalli valgono
    // minuti, l'arco storico crolla e qualunque gap diventa impossibile — il
    // firehose costruito per sbaglio dentro l'antidoto al firehose.
    for (const m of [0, 1, 2, 3, 5]) mention(h, 'bug', 600 + m / 1440);

    const found = detectAbsences(h.db, HOST, now(660));

    expect(names(found)).toEqual([]);
    // E lo stesso numero di menzioni, distanziate, è un pattern vero.
    const spread = harness();
    for (const d of [600, 610, 620, 630, 640]) mention(spread, 'bug', d);
    expect(names(detectAbsences(spread.db, HOST, now(700)))).toEqual(['bug']);
  });

  it('separa due occasioni distanti dall\'inizio della raffica, non dall\'ultima menzione', () => {
    const h = harness();
    // 0, +30min, +90min: la terza sta a 60 minuti dalla seconda ma a 90
    // dall'inizio, ed è un'occasione nuova. Contando dall'ultima menzione, una
    // conversazione lunga tutta la sera collasserebbe in un punto solo.
    const hour = 1 / 24;
    for (const d of [600, 600 + hour / 2, 600 + 1.5 * hour, 610, 620, 630, 640]) {
      mention(h, 'progetto', d);
    }

    const found = detectAbsences(h.db, HOST, now(700));

    expect(found).toHaveLength(1);
    // Sei: la mezz'ora si fonde nella prima, l'ora e mezza no. Contando
    // dall'ultimo elemento sarebbero cinque, e il test resterebbe verde su un
    // detector che appiattisce una serata intera in un punto.
    expect(found[0]!.occasions).toBe(6);
  });

  it('l\'evidenza di un gruppo non arma niente', () => {
    const h = harness();
    // Rail #1 del gate, applicato alla fonte: un estraneo che nomina X venti
    // volte e poi smette non può produrre un nudge nel canale privato
    // dell'owner. È il memory-poisoning dormiente, che qui entrerebbe *per
    // assenza* — un percorso che il gate a valle non vedrebbe come sporco.
    for (const d of [600, 602, 604, 606, 608, 610]) mention(h, 'tizio', d, { tier: 2 });

    expect(detectAbsences(h.db, HOST, now(630))).toEqual([]);
  });

  it('non esce dal tenant', () => {
    const h = harness();
    for (const d of [600, 602, 604, 606, 608, 610]) {
      mention(h, 'palestra', d, { tenant: 'group:telegram:42', tier: 0 });
    }
    expect(detectAbsences(h.db, HOST, now(630))).toEqual([]);
    expect(names(detectAbsences(h.db, 'group:telegram:42', now(630)))).toEqual(['palestra']);
  });

  it('conta le menzioni anche quando la credenza è stata ritirata', () => {
    const h = harness();
    for (const d of [600, 602, 604, 606, 608, 610]) mention(h, 'palestra', d);
    // Averne parlato è attenzione, e resta attenzione dopo che il fatto è
    // scaduto. Filtrando su expired_at si misurerebbe cosa credi adesso, non
    // quando te ne sei occupato — e un'entità di cui hai cambiato idea
    // sparirebbe dal radar proprio mentre diventa interessante.
    h.db.prepare(`UPDATE facts SET expired_at = ?`).run(at(611));

    expect(names(detectAbsences(h.db, HOST, now(630)))).toEqual(['palestra']);
  });

  it('conta anche le menzioni da oggetto', () => {
    const h = harness();
    for (const d of [600, 602, 604, 606, 608, 610]) mention(h, 'Marco', d, { asObject: true });
    expect(names(detectAbsences(h.db, HOST, now(630)))).toContain('Marco');
  });

  it('tace sotto il pavimento assoluto, per quanto anomalo sia il conto', () => {
    const h = harness();
    // Ritmo di mezza giornata: tre giorni di silenzio sono già p < 0,05, e non
    // c'è niente da chiedere a nessuno. La statistica è giusta, la domanda no.
    for (const d of [600, 600.5, 601, 601.5, 602]) mention(h, 'caffè', d);

    expect(detectAbsences(h.db, HOST, now(605))).toEqual([]);
    // Stessa identica storia: è il pavimento a fermarla, non la soglia.
    expect(names(detectAbsences(h.db, HOST, now(605), { minGapDays: 1 }))).toEqual(['caffè']);
  });

  it('due menzioni non sono un pattern, e la formula lo sa già da sola', () => {
    const h = harness();
    // Un solo intervallo osservato: dieci giorni fra le due volte, duecento di
    // silenzio. La predittiva è (1 + 200/10)^-1 = 0,0476 — sotto alpha per un
    // pelo, dopo un gap venti volte l'arco storico. È l'affermazione del
    // docstring ("un intervallo pretende 19×") messa alla prova invece che
    // asserita: nessuna costante impone quella lentezza, la impone la formula.
    for (const d of [600, 610]) mention(h, 'tizio', d);
    expect(overdueProbability(200, 10, 1)).toBeLessThan(ABSENCE_DEFAULTS.alpha);

    // E nonostante il conto la passi, il pavimento sulle occasioni la ferma:
    // due volte non sono un ritmo in nessuna lingua.
    expect(detectAbsences(h.db, HOST, now(810))).toEqual([]);
    expect(names(detectAbsences(h.db, HOST, now(810), { minOccasions: 2 }))).toEqual(['tizio']);
    // Poco meno di 19× e tace comunque: la soglia non è il numero di occasioni.
    expect(detectAbsences(h.db, HOST, now(790), { minOccasions: 2 })).toEqual([]);
  });

  it('quando il tetto taglia, taglia le meno strane', () => {
    const h = harness();
    // Quattro silenzi veri, anomalia decrescente col numero di occasioni: più
    // storia ⇒ p più piccolo a parità di rapporto gap/arco.
    const rhythms: [string, number[]][] = [
      ['a', [600, 602, 604, 606, 608, 610, 612, 614]],
      ['b', [600, 602, 604, 606, 608, 610]],
      ['c', [600, 603, 606, 609]],
      ['d', [600, 605, 610]],
    ];
    for (const [name, days] of rhythms) for (const d of days) mention(h, name, d);

    const found = detectAbsences(h.db, HOST, now(660));

    expect(found).toHaveLength(ABSENCE_DEFAULTS.limit);
    expect([...found].sort((x, y) => x.p - y.p)).toEqual(found);
    // La quarta esiste ed è quella scartata: il tetto non è un filtro casuale.
    const uncapped = detectAbsences(h.db, HOST, now(660), { limit: 10 });
    expect(uncapped).toHaveLength(4);
    expect(names(found)).not.toContain(names(uncapped)[3]);
  });

  it('riporta i numeri che giustificano la domanda', () => {
    const h = harness();
    for (const d of [600, 602, 604, 606, 608, 610]) mention(h, 'palestra', d);

    const [found] = detectAbsences(h.db, HOST, now(630));

    // Un nudge la cui evidenza non è ispezionabile è il vecchio "ho notato" con
    // i modi buoni: chi legge deve poter rifare il conto.
    expect(found).toMatchObject({ occasions: 6, spanDays: 10, gapDays: 20 });
    expect(found!.p).toBeCloseTo(Math.pow(3, -5), 10);
    expect(found!.lastSeen).toBe(at(610));
  });
});

describe('absenceAnchor', () => {
  it('cambia quando il silenzio è un silenzio nuovo', () => {
    const h = harness();
    for (const d of [600, 602, 604, 606, 608, 610]) mention(h, 'palestra', d);
    const first = absenceAnchor(detectAbsences(h.db, HOST, now(630))[0]!);

    // Ne parli di nuovo, poi taci di nuovo: è un altro silenzio e può parlare.
    mention(h, 'palestra', 640);
    const second = absenceAnchor(detectAbsences(h.db, HOST, now(680))[0]!);

    expect(second).not.toBe(first);
    // Ma lo stesso silenzio, riletto, resta lo stesso: è ciò su cui il dedup
    // del gate poggia, e senza questa metà si nota una cosa sola per sempre.
    expect(absenceAnchor(detectAbsences(h.db, HOST, now(690))[0]!)).toBe(second);
  });
});
