import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { promoteMarker } from './manifest.js';
import {
  acceptanceResults,
  chiaviEsito,
  outcomesOf,
  parseInventoryRows,
  readSuiteJson,
  summarize,
  type InventoryRow,
  type SuiteRunner,
  type TestOutcome,
} from './report.js';
import type { ScenarioEntry } from './manifest.js';

/**
 * `summarize` is the gate, isolated from disk and from spawning the real
 * acceptance suite — `report.ts`'s own module docstring explains why that
 * split exists. These tests build a synthetic inventory row, a synthetic
 * manifest entry and a synthetic vitest result by hand, so the two behaviours
 * readiness-criteria.md#day-1-ready (P39) asks for are each provable in milliseconds:
 *
 *  1. a row the inventory calls `READY` whose scenario is still `atteso-rosso`
 *     fails the report, named.
 *  2. an `atteso-rosso` scenario that is red for an undeclared reason is
 *     `rosso-inatteso`, not silently accepted as "va bene così".
 */

const ready = (id: string): InventoryRow => ({ id, area: 'Test', question: 'domanda?', stato: 'READY', rawStato: 'READY — fatto' });
const blocker = (id: string): InventoryRow => ({ id, area: 'Test', question: 'domanda?', stato: 'BLOCKER', rawStato: 'BLOCKER — manca' });

function attesoRossoScenario(row: string, expectFailure: RegExp = /x/): ScenarioEntry {
  return {
    row,
    title: `${row} scenario finto`,
    expectation: { kind: 'atteso-rosso', reason: 'ragione dichiarata nel manifest', closedBy: 'slice/finta', expectFailure },
  };
}

function verdeScenario(row: string): ScenarioEntry {
  return { row, title: `${row} scenario finto`, expectation: { kind: 'verde' } };
}

/**
 * E4's own species: a row whose claim is proven by the acceptance mechanism
 * existing and running, not by a scenario of its own (a scenario of E4 would
 * be the suite testing itself — see manifest.ts's `provataDalMeccanismo`).
 */
function provataDalMeccanismoScenario(row: string, reason = 'la suite di accettazione non può avere uno scenario di sé stessa'): ScenarioEntry {
  return { row, title: `${row} scenario finto`, expectation: { kind: 'provata-dal-meccanismo', reason } };
}

/** A `TestOutcome` keyed the way `verdictFor`'s suffix match expects: the map key is the scenario's own title. */
function outcomeFor(scenario: ScenarioEntry, outcome: TestOutcome): Map<string, TestOutcome> {
  return new Map([[scenario.title, outcome]]);
}

describe('summarize — the READY/atteso-rosso gate', () => {
  it('fails the report, named, when a READY row still carries an atteso-rosso scenario', () => {
    const scenario = attesoRossoScenario('X1');
    const results = outcomeFor(scenario, { status: 'passed', failureMessages: [] }); // still correctly red
    const summary = summarize([ready('X1')], [scenario], results);

    expect(summary.failed).toBe(true);
    expect(summary.counts.readyWithAttesoRosso).toBe(1);
    expect(summary.lines.join('\n')).toMatch(/READY ma scenario atteso-rosso: promuovi o degrada/);
  });

  it('does NOT fail on the same atteso-rosso scenario when the row is not READY', () => {
    const scenario = attesoRossoScenario('X1');
    const results = outcomeFor(scenario, { status: 'passed', failureMessages: [] });
    const summary = summarize([blocker('X1')], [scenario], results);

    expect(summary.failed).toBe(false);
    expect(summary.counts.readyWithAttesoRosso).toBe(0);
    expect(summary.counts.attesoRosso).toBe(1);
  });

  it('does NOT fail on a READY row whose scenario is verde', () => {
    const scenario = verdeScenario('X1');
    const results = outcomeFor(scenario, { status: 'passed', failureMessages: [] });
    const summary = summarize([ready('X1')], [scenario], results);

    expect(summary.failed).toBe(false);
    expect(summary.counts.readyWithAttesoRosso).toBe(0);
    expect(summary.counts.verde).toBe(1);
  });
});

describe('summarize — the atteso-rosso failure signature', () => {
  it('flags rosso-inatteso when an atteso-rosso scenario fails for an undeclared reason', () => {
    const scenario = attesoRossoScenario('X2');
    const results = outcomeFor(scenario, {
      status: 'failed',
      failureMessages: ['Error: X2 è rosso, ma non per la ragione dichiarata nel manifest ("ragione dichiarata nel manifest"). Errore visto invece: un crash del tutto scollegato'],
    });
    const summary = summarize([blocker('X2')], [scenario], results);

    expect(summary.failed).toBe(true);
    expect(summary.counts.unexpectedRed).toBe(1);
    expect(summary.counts.attesoRossoOraVerde).toBe(0); // not silently read as "promote me"
    expect(summary.lines.join('\n')).toMatch(/ROSSO-INATTESO\s+X2.*firma diversa da quella dichiarata/);
  });

  it('flags atteso-rosso-ora-verde only when the failure carries this row\'s own promote marker', () => {
    const scenario = attesoRossoScenario('X3');
    const results = outcomeFor(scenario, {
      status: 'failed',
      failureMessages: [`${promoteMarker('X3')}: la funzione non ha più lanciato — promuovi lo scenario a \`verde\``],
    });
    const summary = summarize([blocker('X3')], [scenario], results);

    expect(summary.failed).toBe(true); // still fails — it needs promoting — but via a different counter
    expect(summary.counts.attesoRossoOraVerde).toBe(1);
    expect(summary.counts.unexpectedRed).toBe(0);
  });

  it('does not cross-match another row\'s promote marker', () => {
    // X4's failure carries X5's marker — a copy-paste of the wrong row id, or
    // two rows sharing a title prefix. Must not be misread as X4's own promotion.
    const scenario = attesoRossoScenario('X4');
    const results = outcomeFor(scenario, {
      status: 'failed',
      failureMessages: [`${promoteMarker('X5')}: la funzione non ha più lanciato`],
    });
    const summary = summarize([blocker('X4')], [scenario], results);

    expect(summary.counts.attesoRossoOraVerde).toBe(0);
    expect(summary.counts.unexpectedRed).toBe(1);
  });

  it('still passes an atteso-rosso scenario through when it stays red for the declared reason', () => {
    const scenario = attesoRossoScenario('X6');
    const results = outcomeFor(scenario, { status: 'passed', failureMessages: [] });
    const summary = summarize([blocker('X6')], [scenario], results);

    expect(summary.failed).toBe(false);
    expect(summary.counts.attesoRosso).toBe(1);
  });
});

describe('summarize — pre-existing gates stay intact', () => {
  it('fails on a READY row with no scenario at all', () => {
    const summary = summarize([ready('X1')], [], new Map());
    expect(summary.failed).toBe(true);
    expect(summary.counts.readyWithoutScenario).toBe(1);
  });

  it('fails on a verde scenario that broke for real', () => {
    const scenario = verdeScenario('X7');
    const results = outcomeFor(scenario, { status: 'failed', failureMessages: ['Error: assertion boom'] });
    const summary = summarize([blocker('X7')], [scenario], results);
    expect(summary.failed).toBe(true);
    expect(summary.counts.unexpectedRed).toBe(1);
  });

  it('fails on a manifest entry whose row does not exist in the inventory (orphan)', () => {
    const scenario = verdeScenario('Z9');
    const summary = summarize([blocker('X1')], [scenario], new Map());
    expect(summary.failed).toBe(true);
    expect(summary.counts.orphanRows).toBe(1);
  });
});

describe('summarize — provata dal meccanismo (E4: la suite non può testare sé stessa)', () => {
  it('counts a provata-dal-meccanismo row as covered — never nessuno scenario, never readyWithoutScenario', () => {
    const scenario = provataDalMeccanismoScenario('E4');
    // No vitest outcome at all: a provata-dal-meccanismo row never registers a
    // real `it()` (scenario.ts refuses to — it would be the suite proving
    // itself), so an empty results map is the only input this kind of row can
    // ever actually receive from runSuiteToJson().
    const summary = summarize([ready('E4')], [scenario], new Map());

    expect(summary.failed).toBe(false);
    expect(summary.counts.readyWithoutScenario).toBe(0);
    expect(summary.counts.nessunoScenario).toBe(0);
    expect(summary.counts.provataDalMeccanismo).toBe(1);
    expect(summary.lines.join('\n')).toMatch(/provata dal meccanismo\s+E4/);
  });

  it('is a distinct verdict even when the row is not READY', () => {
    const scenario = provataDalMeccanismoScenario('E4');
    const summary = summarize([blocker('E4')], [scenario], new Map());

    expect(summary.failed).toBe(false);
    expect(summary.counts.provataDalMeccanismo).toBe(1);
  });
});

describe('outcomesOf — the one reading of vitest JSON, whether this script ran the suite or CI did', () => {
  it('keys every assertion by its trimmed fullName and never leaves failureMessages undefined', () => {
    const out = outcomesOf({
      testResults: [
        {
          assertionResults: [
            { fullName: ' X1 scenario finto ', status: 'passed' },
            { fullName: 'X2 scenario finto', status: 'failed', failureMessages: ['boom'] },
          ],
        },
      ],
    });
    expect(out.get('X1 scenario finto')).toEqual({ status: 'passed', failureMessages: [] });
    expect(out.get('X2 scenario finto')).toEqual({ status: 'failed', failureMessages: ['boom'] });
    expect(out.size).toBe(2);
  });
});

/**
 * Il buco che il judge di `slice/linux-la-macchina-che-conta` ha nominato, e
 * che è più vecchio di quella slice: `summarize` cammina l'inventario, quindi
 * un file `.accept.ts` che non registra un requisito DAY-1 non viene visitato
 * affatto. `b-job-script` è esattamente quel caso. Prima di questi test, il suo
 * rosso — non il suo salto: il suo **rosso** — non produceva nessuna riga,
 * nessun contatore e nessun exit code: per chi legge il report che il mandato
 * readiness-criteria.md#day-1-ready tratta come gate autoritativo, indistinguibile da uno scenario mai
 * scritto.
 */
describe('summarize — ciò che vitest ha eseguito e nessuna riga rivendica', () => {
  it('un rosso fuori inventario fa fallire il report, nominato', () => {
    const results = new Map<string, TestOutcome>([
      ['evals/acceptance/b-job-script.accept.ts > il job parte davvero', { status: 'failed', failureMessages: ['contain_failed'] }],
    ]);
    const summary = summarize([], [], results);

    expect(summary.failed).toBe(true);
    expect(summary.lines.join('\n')).toMatch(/FUORI INVENTARIO ROSSO/);
    expect(summary.lines.join('\n')).toContain('b-job-script');
  });

  it('un salto dichiarato fuori inventario si stampa senza far fallire', () => {
    // La distinzione che rende utile la riga sopra: «non provabile qui» è una
    // dichiarazione, «skipped» e basta no.
    const results = new Map<string, TestOutcome>([
      ['«il job parte davvero» [non provabile qui: bwrap non monta /proc]', { status: 'skipped', failureMessages: [] }],
    ]);
    const summary = summarize([], [], results);

    expect(summary.failed).toBe(false);
    expect(summary.lines.join('\n')).toMatch(/fuori inventario\s+non provabile qui/);
  });

  it('uno skip muto fuori inventario resta un rosso', () => {
    const results = new Map<string, TestOutcome>([
      ['b-job-script > il job parte davvero', { status: 'skipped', failureMessages: [] }],
    ]);
    expect(summarize([], [], results).failed).toBe(true);
  });

  it('non ripete ciò che l\'inventario ha già raccontato', () => {
    // Senza questo, ogni scenario del manifest comparirebbe due volte: una
    // come requisito DAY-1 e una come «fuori inventario».
    const scenario = verdeScenario('X1');
    const summary = summarize([ready('X1')], [scenario], outcomeFor(scenario, { status: 'passed', failureMessages: [] }));

    expect(summary.failed).toBe(false);
    expect(summary.lines.join('\n')).not.toMatch(/fuori inventario/);
  });
});

/**
 * Un rosso da **errore di caricamento**: la stessa classe di guasto del blocco
 * qui sopra, spostata dal caso «assertion rossa» al caso «file che non si
 * carica». Non è ipotetica — è proprio il guasto di questa slice, i
 * `._<nome>.accept.ts` che bsdtar infilava nel tar e che vitest raccoglieva e
 * falliva a caricare: il conteggio scendeva da 4 a 3 e il report diceva OK.
 *
 * La forma del JSON è misurata su vitest 2.1.9, non ricordata: un file che
 * lancia all'import produce `numTotalTests 0`, `numFailedTests 0`,
 * `numFailedTestSuites 1`, e in `testResults` una voce `{ status: "failed",
 * assertionResults: [], message: "import-time boom" }`.
 */
describe('outcomesOf — un file che non si è caricato', () => {
  const nonCaricato = () => ({
    testResults: [
      {
        name: '/app/evals/acceptance/scenarios/._a-lifecycle.accept.ts',
        status: 'failed' as const,
        message: 'Error: import-time boom\n  at …',
        assertionResults: [],
      },
      {
        name: '/app/evals/acceptance/scenarios/a-lifecycle.accept.ts',
        status: 'passed' as const,
        assertionResults: [{ fullName: 'X1 scenario finto', status: 'passed' as const }],
      },
    ],
  });

  it('lo fa esistere come esito rosso, con il messaggio di caricamento', () => {
    const out = outcomesOf(nonCaricato());
    const chiave = [...out.keys()].find((k) => k.includes('._a-lifecycle'));
    expect(chiave).toBeDefined();
    expect(out.get(chiave!)).toEqual({ status: 'failed', failureMessages: ['Error: import-time boom\n  at …'] });
  });

  it('lo nomina prima del percorso, così il troncamento a 110 caratteri non se lo mangia', () => {
    const chiave = [...outcomesOf(nonCaricato()).keys()].find((k) => k.includes('._a-lifecycle'))!;
    expect(chiave.startsWith('[file non caricato] ')).toBe(true);
  });

  it('non inventa un esito per un file rosso che ha davvero corso', () => {
    const out = outcomesOf({
      testResults: [
        {
          name: '/app/x.accept.ts',
          status: 'failed',
          message: 'un test è rosso',
          assertionResults: [{ fullName: 'X1 scenario finto', status: 'failed', failureMessages: ['boom'] }],
        },
      ],
    });
    expect(out.size).toBe(1);
    expect(out.has('X1 scenario finto')).toBe(true);
  });

  it('fa fallire il report, nominato, invece di far scendere il conteggio in silenzio', () => {
    const scenario = verdeScenario('X1');
    const summary = summarize([ready('X1')], [scenario], outcomesOf(nonCaricato()));

    expect(summary.counts.verde).toBe(1);
    expect(summary.counts.fuoriInventarioRossi).toBe(1);
    expect(summary.failed).toBe(true);
    expect(summary.lines.join('\n')).toMatch(/FUORI INVENTARIO ROSSO — \[file non caricato\].*_a-lifecycle/);
  });
});

/**
 * `chiaviEsito` è l'unica ricerca: il verdetto di una riga e la deduplica di
 * «fuori inventario» guardano per costruzione gli stessi esiti, quindi non
 * possono divergere.
 *
 * I nomi qui sotto hanno la forma che vitest produce davvero — `"<describe>
 * <titolo>"`, con **uno spazio**, misurato sul reporter JSON di 2.1.9 — e non
 * il titolo nudo: nella suite vera ogni scenario vive dentro un `describe`, e
 * un test scritto sulla forma nuda sarebbe verde per una ragione che non
 * c'entra col meccanismo.
 */
const DESCRIBE = 'acceptance · il giro dell owner';

describe('chiaviEsito — quali esiti appartengono a una riga', () => {
  it('trova lo scenario per suffisso, che è come vitest unisce describe e it', () => {
    const results = new Map<string, TestOutcome>([
      [`${DESCRIBE} X1 scenario finto`, { status: 'passed', failureMessages: [] }],
    ]);
    expect(chiaviEsito('X1 scenario finto', results)).toEqual([`${DESCRIBE} X1 scenario finto`]);
  });

  it('trova lo scenario anche quando `annunciaSalto` gli ha appeso il motivo', () => {
    const nome = `${DESCRIBE} X1 scenario finto [non provabile qui: bwrap non monta /proc]`;
    expect(chiaviEsito('X1 scenario finto', new Map([[nome, { status: 'skipped', failureMessages: [] }]]))).toEqual([nome]);
  });

  it('non trova niente quando vitest non ha registrato lo scenario', () => {
    expect(chiaviEsito('X1 scenario finto', new Map())).toEqual([]);
  });

  it('li raccoglie tutti invece di prendere il primo inserito', () => {
    const results = new Map<string, TestOutcome>([
      [`regressione di X1 scenario finto`, { status: 'failed', failureMessages: ['boom'] }],
      [`${DESCRIBE} X1 scenario finto`, { status: 'passed', failureMessages: [] }],
    ]);
    expect(chiaviEsito('X1 scenario finto', results)).toHaveLength(2);
  });
});

/**
 * Il verde falso costruito dal giudice, con i nomi nella forma vera.
 *
 * Lo scenario reale è `skipped` con motivo dichiarato — quindi il suo nome
 * **non** finisce col titolo — e un test estraneo inserito prima ci finisce.
 * Con una ricerca a cascata la riga prendeva l'esito dell'estraneo e stampava
 * `verde`, lo scenario vero (mai esercitato) finiva in «fuori inventario · non
 * provabile qui» senza contare come rosso, e il report usciva 0 su una riga che
 * nessuno aveva eseguito.
 */
describe('summarize — un titolo ambiguo è un difetto, non un ballottaggio', () => {
  const scenario = verdeScenario('X1');
  const ambiguo = (): Map<string, TestOutcome> =>
    new Map([
      [`regressione di ${scenario.title}`, { status: 'passed' as const, failureMessages: [] }],
      [
        `${DESCRIBE} ${scenario.title} [non provabile qui: bwrap non contiene su questo host]`,
        { status: 'skipped' as const, failureMessages: [] },
      ],
    ]);

  it('non stampa verde su una riga che nessuno ha eseguito: esce rosso', () => {
    const summary = summarize([ready('X1')], [scenario], ambiguo());

    expect(summary.counts.verde).toBe(0);
    expect(summary.counts.unexpectedRed).toBe(1);
    expect(summary.failed).toBe(true);
  });

  it('nomina i candidati invece di sceglierne uno', () => {
    const righe = summarize([ready('X1')], [scenario], ambiguo()).lines.join('\n');
    expect(righe).toContain('titolo ambiguo');
    expect(righe).toContain(`regressione di ${scenario.title}`);
  });

  it('non li lascia anche fra i fuori inventario: sono rivendicati, e già contati una volta', () => {
    expect(summarize([ready('X1')], [scenario], ambiguo()).counts.fuoriInventario).toBe(0);
  });
});

/**
 * Il salto dichiarato di una riga di manifest, dall'etichetta che `scenario.ts`
 * scrive fino al verdetto contato.
 *
 * Il ramo era irraggiungibile dalla produzione: `scenario()` intitolava il test
 * saltato con la **riga** (`"B12 [non provabile qui: …]"`) e `report.ts` lo
 * cercava per suffisso del **titolo di manifest**, quindi usciva prima con
 * `nessuno-scenario` — e lo stesso test si contava due volte, una come riga
 * scoperta e una come «fuori inventario».
 */
describe('summarize — un salto dichiarato su una riga del manifest', () => {
  const scenario = verdeScenario('X1');
  const saltato = (): Map<string, TestOutcome> =>
    new Map([
      [
        `acceptance · il giro > ${scenario.title} [non provabile qui: bwrap non contiene su questo host]`,
        { status: 'skipped' as const, failureMessages: [] },
      ],
    ]);

  it('lo conta come «non provabile qui», con il motivo che l\'host ha dato', () => {
    const summary = summarize([ready('X1')], [scenario], saltato());
    expect(summary.counts.nonProvabile).toBe(1);
    expect(summary.counts.nessunoScenario).toBe(0);
    expect(summary.lines.join('\n')).toContain('bwrap non contiene su questo host');
    expect(summary.failed).toBe(false);
  });

  it('non lo conta anche come fuori inventario', () => {
    expect(summarize([ready('X1')], [scenario], saltato()).counts.fuoriInventario).toBe(0);
  });

  it('non tronca un motivo che contiene a sua volta una parentesi quadra', () => {
    const results = new Map<string, TestOutcome>([
      [
        `${scenario.title} [non provabile qui: bwrap: execvp argv[0]: No such file]`,
        { status: 'skipped', failureMessages: [] },
      ],
    ]);
    // Sul **verdetto**, non sulla riga stampata: con il motivo troncato lo
    // scenario non si ritrova affatto e finisce fra i «fuori inventario», che
    // ne stampano comunque il nome per intero — cioè la riga passerebbe anche
    // con il difetto addosso.
    const summary = summarize([ready('X1')], [scenario], results);
    expect(summary.counts.nonProvabile).toBe(1);
    expect(summary.lines.join('\n')).toContain('bwrap: execvp argv[0]: No such file');
  });
});

describe('summarize — la deduplica non può ingoiare un rosso', () => {
  it('un rosso fuori inventario che cita un titolo di manifest resta un rosso', () => {
    // `nome.includes(t)` sussumeva `nome.endsWith(t)`: la condizione era solo
    // `includes`, e questo esito spariva in silenzio.
    const scenario = verdeScenario('X1');
    const results = new Map<string, TestOutcome>([
      [scenario.title, { status: 'passed', failureMessages: [] }],
      [`fuori inventario che parla di ${scenario.title} e poi rompe`, { status: 'failed', failureMessages: ['boom'] }],
    ]);
    const summary = summarize([ready('X1')], [scenario], results);

    expect(summary.counts.fuoriInventarioRossi).toBe(1);
    expect(summary.failed).toBe(true);
  });
});

/**
 * Tre ingoi silenziosi della stessa famiglia, misurati dal giudice di questa
 * slice e chiusi qui: un rosso che sparisce per omonimia, un rosso che arriva
 * senza dire di quale file parla, e un rosso che sparirebbe se questa lettura
 * per-file si disallineasse dal formato di vitest.
 */
describe('outcomesOf — i modi rimasti di perdere un rosso', () => {
  it('su due file con lo stesso fullName tiene il peggiore, non l\'ultimo', () => {
    const out = outcomesOf({
      numFailedTestSuites: 1,
      testResults: [
        {
          name: '/app/a.accept.ts',
          status: 'failed',
          assertionResults: [{ fullName: 'X1 scenario finto', status: 'failed', failureMessages: ['boom'] }],
        },
        {
          name: '/app/b.accept.ts',
          status: 'passed',
          assertionResults: [{ fullName: 'X1 scenario finto', status: 'passed' }],
        },
      ],
    });
    expect(out.size).toBe(1);
    expect(out.get('X1 scenario finto')).toEqual({ status: 'failed', failureMessages: ['boom'] });
  });

  it('dice quale file non si è caricato, non solo che uno non lo ha fatto', () => {
    // Il percorso è lungo come lo scrive vitest quando la suite gira dal
    // laptop e non dal container: `runSuiteToJson` la lancia con `cwd:
    // REPO`, e il reporter mette percorsi assoluti. Con il solo percorso in
    // testa, il troncamento a 110 caratteri della riga di `summarize` cadeva
    // dentro il prefisso e si mangiava proprio il basename — si imparava che
    // *un* file non si era caricato, non quale.
    const lungo =
      '/Users/qualcuno/dev/muffin-agent/.claude/worktrees/agent-ae21909b235cbeda/evals/acceptance/scenarios/._a-lifecycle.accept.ts';
    expect(lungo.length).toBeGreaterThan(110);

    const out = outcomesOf({
      numFailedTestSuites: 1,
      testResults: [{ name: lungo, status: 'failed', message: 'boom', assertionResults: [] }],
    });
    expect(summarize([], [], out).lines.join('\n')).toContain('._a-lifecycle.accept.ts');
  });

  it('grida se vitest dichiara suite rosse e questa lettura non ne vede nessuna', () => {
    // La controprova a costo zero: `numFailedTestSuites` era già nel JSON e
    // nessuno lo leggeva. Se il formato cambia, questa lettura smette — e il
    // modo in cui smetterebbe è in silenzio.
    expect(() =>
      outcomesOf({
        numFailedTestSuites: 2,
        testResults: [
          {
            name: '/app/a.accept.ts',
            status: 'passed',
            assertionResults: [{ fullName: 'X1 scenario finto', status: 'passed' }],
          },
        ],
      }),
    ).toThrow(/disallineata dal formato di vitest/);
  });

  it('non grida quando il rosso dichiarato è visibile come assertion', () => {
    expect(() =>
      outcomesOf({
        numFailedTestSuites: 1,
        testResults: [
          {
            name: '/app/a.accept.ts',
            status: 'failed',
            assertionResults: [{ fullName: 'X1 scenario finto', status: 'failed', failureMessages: ['boom'] }],
          },
        ],
      }),
    ).not.toThrow();
  });
});

describe('parseInventoryRows — una barra dentro una cella non fa sparire la riga', () => {
  const riga = (stato: string) => `| A6 | Upgrade | Aggiornare il codice non distrugge dati? | ${stato} |`;

  it('legge una riga il cui stato contiene un `\\|` sfuggito, che in Markdown è legale', () => {
    const rows = parseInventoryRows(riga(String.raw`READY — chiuso da ADR-0057: \|--channel <main\|dev>\|`), 'finto.md');
    expect(rows.map((r) => r.id)).toEqual(['A6']);
    expect(rows[0]!.stato).toBe('READY');
    expect(rows[0]!.rawStato).toContain('main');
    expect(rows[0]!.rawStato).toContain('dev');
  });

  it('e la stessa riga senza barre si legge identica — la tolleranza non cambia il caso normale', () => {
    const rows = parseInventoryRows(riga('READY — chiuso da ADR-0057'), 'finto.md');
    expect(rows.map((r) => r.id)).toEqual(['A6']);
    expect(rows[0]!.area).toBe('Upgrade');
    expect(rows[0]!.question).toBe('Aggiornare il codice non distrugge dati?');
  });

  it('una barra NON sfuggita non fa sparire la riga in silenzio: il parser rifiuta e nomina la riga', () => {
    // 05/09/2026: la riga E1 scritta con `<dollari|none>` spariva dall'inventario
    // e il rapporto accusava il manifest («scenario E1 orfano»), come il
    // docstring del parser già prevedeva. Il rifiuto manda al file giusto.
    expect(() => parseInventoryRows(`${riga('READY — a | b')}\n${riga('READY — sano')}`, 'finto.md')).toThrow(
      /riga A6 in finto\.md non si legge/,
    );
  });

  it('il separatore `|---|` continua a non essere una riga di dati', () => {
    expect(() => parseInventoryRows('|---|---|---|---|', 'finto.md')).toThrow(/parser è disallineato/);
  });
});

describe('acceptanceResults — la suite gira una volta sola, senza timeout fragile (#556)', () => {
  // Il guasto originale: la suite da 645s superava il `timeout: 10 * 60_000`
  // di spawnSync, che la uccideva a 10 minuti netti — nessun JSON, exit
  // null, report sempre rosso su laptop anche a suite verde. Questi test
  // guidano la cucitura (`SuiteRunner`) con una finta che scrive un JSON
  // prefabbricato nel file che vitest scriverebbe, invece di lanciare
  // vitest davvero: "una run, un JSON, un lettore" si prova in millisecondi,
  // senza aspettare davvero 11 minuti.
  type SpawnCall = { command: string; args: readonly string[]; options: { cwd: string; encoding: 'utf8' } };

  const canned = (titoli: string[]): string =>
    JSON.stringify({
      numFailedTestSuites: 0,
      testResults: [
        {
          name: 'scenarios/finto.accept.ts',
          status: 'passed',
          assertionResults: titoli.map((fullName) => ({ fullName, status: 'passed', failureMessages: [] })),
        },
      ],
    });

  const fintaRun = (chiamate: SpawnCall[], payload?: string, status: number | null = 0): SuiteRunner => {
    return (command, args, options) => {
      chiamate.push({ command, args, options });
      const out = args.find((a) => a.startsWith('--outputFile='))!.slice('--outputFile='.length);
      if (payload !== undefined) writeFileSync(out, payload);
      return { status, stdout: '', stderr: '' };
    };
  };

  const senzaEnv = <T>(fn: () => T): T => {
    const saved = process.env.MUFFIN_ACCEPT_RESULTS;
    delete process.env.MUFFIN_ACCEPT_RESULTS;
    try {
      return fn();
    } finally {
      if (saved === undefined) delete process.env.MUFFIN_ACCEPT_RESULTS;
      else process.env.MUFFIN_ACCEPT_RESULTS = saved;
    }
  };

  it('esegue la suite esattamente una volta e ne consuma il JSON con lo stesso lettore del path CI', () => {
    const chiamate: SpawnCall[] = [];
    const esiti = senzaEnv(() => acceptanceResults(fintaRun(chiamate, canned(['X1 scenario finto']))));

    expect(chiamate).toHaveLength(1);
    expect(chiamate[0]!.command).toBe('npx');
    expect(chiamate[0]!.args).toContain('--reporter=json');
    expect(esiti.get('X1 scenario finto')).toEqual({ status: 'passed', failureMessages: [] });
  });

  it('non passa alcun timeout wall-clock allo spawn: il fragile N minuti di #556 non esiste più', () => {
    const chiamate: SpawnCall[] = [];
    senzaEnv(() => acceptanceResults(fintaRun(chiamate, canned(['X1 scenario finto']))));

    expect(chiamate).toHaveLength(1);
    expect(chiamate[0]!.options).not.toHaveProperty('timeout');
  });

  it('un exit non-zero con JSON valido si consuma comunque: un rosso non è un errore di harness', () => {
    const rosso = JSON.stringify({
      numFailedTestSuites: 1,
      testResults: [
        {
          name: 'scenarios/finto.accept.ts',
          status: 'failed',
          assertionResults: [{ fullName: 'X1 scenario finto', status: 'failed', failureMessages: ['boom'] }],
        },
      ],
    });
    const esiti = senzaEnv(() => acceptanceResults(fintaRun([], rosso, 1)));

    expect(esiti.get('X1 scenario finto')).toEqual({ status: 'failed', failureMessages: ['boom'] });
  });

  it('JSON mancante — la suite uccisa come dal timeout originale — fallisce loud nominando exit e causa', () => {
    expect(() => senzaEnv(() => acceptanceResults(fintaRun([], undefined, null)))).toThrow(
      /la suite di accettazione non ha prodotto un JSON leggibile \(exit null\)/,
    );
  });

  it('JSON corrotto fallisce loud con la causa, non con un secondo giro silenzioso', () => {
    const chiamate: SpawnCall[] = [];
    expect(() => senzaEnv(() => acceptanceResults(fintaRun(chiamate, 'non json{', 0)))).toThrow(
      /la suite di accettazione non ha prodotto un JSON leggibile[\s\S]*causa:/,
    );
    expect(chiamate).toHaveLength(1);
  });

  it('il path CI con MUFFIN_ACCEPT_RESULTS non riesegue la suite e fallisce loud su file illeggibile', () => {
    const chiamate: SpawnCall[] = [];
    const saved = process.env.MUFFIN_ACCEPT_RESULTS;
    process.env.MUFFIN_ACCEPT_RESULTS = '/percorso/che/non/esiste/results.json';
    try {
      expect(() => acceptanceResults(fintaRun(chiamate, canned(['X1 scenario finto'])))).toThrow(
        /MUFFIN_ACCEPT_RESULTS=\/percorso\/che\/non\/esiste\/results\.json non è un JSON/,
      );
      expect(chiamate).toHaveLength(0);
    } finally {
      if (saved === undefined) delete process.env.MUFFIN_ACCEPT_RESULTS;
      else process.env.MUFFIN_ACCEPT_RESULTS = saved;
    }
  });

  it('readSuiteJson lancia la causa grezza sul file mancante: sarà il chiamante a nominare la provenienza', () => {
    expect(() => readSuiteJson('/percorso/che/non/esiste/r.json')).toThrow(/ENOENT/);
  });
});
