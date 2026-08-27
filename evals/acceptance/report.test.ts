import { describe, expect, it } from 'vitest';
import { promoteMarker } from './manifest.js';
import { outcomesOf, summarize, type InventoryRow, type TestOutcome } from './report.js';
import type { ScenarioEntry } from './manifest.js';

/**
 * `summarize` is the gate, isolated from disk and from spawning the real
 * acceptance suite — `report.ts`'s own module docstring explains why that
 * split exists. These tests build a synthetic inventory row, a synthetic
 * manifest entry and a synthetic vitest result by hand, so the two behaviours
 * mandato DAY-1 §4.9 (P39) asks for are each provable in milliseconds:
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
    // ever actually receive from runAcceptanceSuite().
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
 * un file `.accept.ts` che non registra una riga M5-BIS non viene visitato
 * affatto. `b-job-script` è esattamente quel caso. Prima di questi test, il suo
 * rosso — non il suo salto: il suo **rosso** — non produceva nessuna riga,
 * nessun contatore e nessun exit code: per chi legge il report che il mandato
 * DAY-1 §4.9 tratta come gate autoritativo, indistinguibile da uno scenario mai
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
    // come riga di Gate e una come «fuori inventario».
    const scenario = verdeScenario('X1');
    const summary = summarize([ready('X1')], [scenario], outcomeFor(scenario, { status: 'passed', failureMessages: [] }));

    expect(summary.failed).toBe(false);
    expect(summary.lines.join('\n')).not.toMatch(/fuori inventario/);
  });
});
