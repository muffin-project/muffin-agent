import { describe, expect, it } from 'vitest';
import { promoteMarker } from './manifest.js';
import { summarize, type InventoryRow, type TestOutcome } from './report.js';
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
