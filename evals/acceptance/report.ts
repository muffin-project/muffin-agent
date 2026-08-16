#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST, type ScenarioEntry } from './manifest.js';

/**
 * The command M5-BIS.md's state is derived from, instead of asserted by hand.
 *
 * ORCHESTRATION.md §12: an inventory's fourth, forbidden answer is "we hadn't
 * thought about it" — a row with no scenario is exactly that, silently. This
 * prints, for every row in the live inventory: a passing scenario, a scenario
 * that broke for real, a scenario still red on purpose (and why, and what
 * closes it), or no scenario at all. Rows this rig cannot exercise — a real
 * model, real audio hardware — get a fifth, explicit answer: "not provable
 * here", which the inventory itself does not allow but a report about the
 * inventory has to be able to say instead of mis-filing them as "no scenario".
 *
 * Runs the acceptance vitest project as a real subprocess (`npx vitest run
 * --reporter=json`) rather than re-implementing pass/fail: vitest's own
 * `it.fails` already tells the difference between "broke for real" and "still
 * red on purpose" (verified against the installed 2.1.9 with a throwaway probe
 * before relying on it — `it.fails` reports a thrown assertion as `passed` in
 * the JSON output and a non-throwing one as `failed`). This script only has to
 * cross-reference that against the manifest and the inventory.
 */

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const M5_BIS = join(REPO, 'docs', 'blueprint', 'M5-BIS.md');

type Stato = 'READY' | 'OUT' | 'BLOCKER' | '?';

type InventoryRow = { id: string; area: string; question: string; stato: Stato; rawStato: string };

/**
 * Reads the inventory tables directly from the live document — never a copy —
 * so the report is always about today's M5-BIS.md, not the one that existed
 * when this script was written. A row without a matching table line is a sign
 * the parser needs updating, not that the row does not exist.
 */
function parseInventory(): InventoryRow[] {
  const text = readFileSync(M5_BIS, 'utf8');
  const rows: InventoryRow[] = [];
  for (const line of text.split('\n')) {
    const m = /^\|\s*([A-Z]\d{1,2})\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/.exec(line);
    if (!m) continue;
    const [, id, area, question, rawStato] = m as unknown as [string, string, string, string, string];
    let stato: Stato;
    if (rawStato.startsWith('READY')) stato = 'READY';
    else if (rawStato.startsWith('OUT')) stato = 'OUT';
    else if (rawStato.startsWith('BLOCKER')) stato = 'BLOCKER';
    else if (rawStato.startsWith('?')) stato = '?';
    else continue; // not a data row (header, or a `|---|` separator)
    rows.push({ id, area, question, stato, rawStato });
  }
  if (rows.length === 0) throw new Error(`nessuna riga trovata in ${M5_BIS} — il parser è disallineato dal formato`);
  return rows;
}

/**
 * Rows this harness structurally cannot exercise, with the reason written
 * once here rather than left to be inferred from "no scenario". Kept to
 * genuine impossibilities — no real audio hardware, no real model to judge
 * against — not to rows nobody has gotten to yet, which stay honestly
 * "nessuno scenario".
 */
const NOT_PROVABLE_HERE: Record<string, string> = {
  C8: 'richiede una trascrizione audio reale — property 2 del brief vieta chiavi/chiamate a pagamento in questa suite',
};

type VitestJsonResult = {
  testResults: Array<{
    assertionResults: Array<{ fullName: string; status: 'passed' | 'failed' | 'pending' | 'skipped' }>;
  }>;
};

function runAcceptanceSuite(): Map<string, 'passed' | 'failed' | 'pending' | 'skipped'> {
  const outFile = join(mkdtempSync(join(tmpdir(), 'muffin-accept-report-')), 'results.json');
  const result = spawnSync(
    'npx',
    ['vitest', 'run', '--config', 'vitest.acceptance.config.ts', '--reporter=json', `--outputFile=${outFile}`],
    { cwd: REPO, encoding: 'utf8', timeout: 10 * 60_000 },
  );
  // vitest exits non-zero when any test fails, which an unexpected red
  // legitimately does — the JSON file is written either way, so a non-zero
  // exit here is not itself an error for this script.
  let json: VitestJsonResult;
  try {
    json = JSON.parse(readFileSync(outFile, 'utf8')) as VitestJsonResult;
  } catch (error) {
    throw new Error(
      `la suite di accettazione non ha prodotto un JSON leggibile (exit ${result.status}):\n` +
        `${result.stdout}\n${result.stderr}\ncausa: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    rmSync(join(outFile, '..'), { recursive: true, force: true });
  }
  const byTitle = new Map<string, 'passed' | 'failed' | 'pending' | 'skipped'>();
  for (const file of json.testResults) {
    for (const a of file.assertionResults) byTitle.set(a.fullName.trim(), a.status);
  }
  return byTitle;
}

type RowVerdict =
  | { kind: 'verde' }
  | { kind: 'rosso-inatteso'; detail: string }
  | { kind: 'atteso-rosso'; reason: string; closedBy: string }
  | { kind: 'atteso-rosso-ora-verde'; reason: string; closedBy: string }
  | { kind: 'non-provabile-qui'; reason: string }
  | { kind: 'nessuno-scenario' };

function verdictFor(row: InventoryRow, scenariosForRow: ScenarioEntry[], results: Map<string, string>): RowVerdict {
  if (scenariosForRow.length === 0) {
    const reason = NOT_PROVABLE_HERE[row.id];
    return reason ? { kind: 'non-provabile-qui', reason } : { kind: 'nessuno-scenario' };
  }
  // One scenario per row today (the manifest is 1:1); a row with more than one
  // is reported on the first, since a mixed verdict across scenarios for the
  // same row would need its own presentation this suite does not need yet.
  const scenario = scenariosForRow[0]!;
  // vitest's fullName joins the describe block and the it title with a space —
  // a suffix match is what survives that without hard-coding the describe text
  // here too.
  const status = [...results.entries()].find(([full]) => full.endsWith(scenario.title))?.[1];
  if (status === undefined) {
    return { kind: 'nessuno-scenario' }; // registered in the manifest, but vitest never ran it
  }
  if (scenario.expectation.kind === 'verde') {
    return status === 'passed' ? { kind: 'verde' } : { kind: 'rosso-inatteso', detail: `stato vitest: ${status}` };
  }
  // atteso-rosso: `it.fails` reports `passed` when the assertion threw as
  // expected, `failed` the day it stops throwing — see the module docstring.
  return status === 'passed'
    ? { kind: 'atteso-rosso', reason: scenario.expectation.reason, closedBy: scenario.expectation.closedBy }
    : { kind: 'atteso-rosso-ora-verde', reason: scenario.expectation.reason, closedBy: scenario.expectation.closedBy };
}

function main(): void {
  const inventory = parseInventory();
  const results = runAcceptanceSuite();

  const byRow = new Map<string, ScenarioEntry[]>();
  for (const s of MANIFEST) byRow.set(s.row, [...(byRow.get(s.row) ?? []), s]);

  const lines: string[] = [];
  let unexpectedRed = 0;
  let readyWithoutScenario = 0;
  let verde = 0;
  let attesoRosso = 0;
  let nessunoScenario = 0;
  let nonProvabile = 0;
  let attesoRossoOraVerde = 0;

  /**
   * A manifest entry whose row id does not exist in the live inventory.
   *
   * The loop below walks `inventory`, not `byRow` — so before this check
   * existed, a typo'd id (`Z9`) or a row M5-BIS.md renumbered away from under
   * the manifest simply never got visited: not printed, not counted, exit
   * code untouched. The header still said "N scenari" (`MANIFEST.length`
   * does not care), and the row it was supposed to prove looked exactly like
   * one nobody had written a scenario for yet. Silent, and one level above
   * the exact class of gap this whole report exists to surface — found by a
   * judge, not by this file, which is the reason to fix it here rather than
   * trust a future reader to notice a scenario count that does not add up.
   */
  const orphanRows = [...byRow.keys()].filter((row) => !inventory.some((r) => r.id === row));
  for (const row of orphanRows) {
    lines.push(
      `  ORFANO             ${row}  nel manifest ma non in M5-BIS.md — ${byRow
        .get(row)!
        .map((s) => s.title)
        .join('; ')}`,
    );
  }

  for (const row of inventory) {
    const verdict = verdictFor(row, byRow.get(row.id) ?? [], results);
    switch (verdict.kind) {
      case 'verde':
        verde++;
        lines.push(`  verde              ${row.id}  ${row.area}`);
        break;
      case 'rosso-inatteso':
        unexpectedRed++;
        lines.push(`  ROSSO-INATTESO     ${row.id}  ${row.area} — ${verdict.detail}`);
        break;
      case 'atteso-rosso':
        attesoRosso++;
        lines.push(`  atteso-rosso       ${row.id}  ${row.area} — ${verdict.reason} (chiude: ${verdict.closedBy})`);
        break;
      case 'atteso-rosso-ora-verde':
        attesoRossoOraVerde++;
        lines.push(
          `  ATTESO-ROSSO→VERDE ${row.id}  ${row.area} — la ragione dichiarata non vale più, promuovi lo scenario ` +
            `a verde (era: ${verdict.reason})`,
        );
        break;
      case 'non-provabile-qui':
        nonProvabile++;
        lines.push(`  non provabile qui  ${row.id}  ${row.area} — ${verdict.reason}`);
        break;
      case 'nessuno-scenario':
        nessunoScenario++;
        if (row.stato === 'READY') readyWithoutScenario++;
        lines.push(`  nessuno scenario   ${row.id}  ${row.area}${row.stato === 'READY' ? '  ⚠️  riga READY' : ''}`);
        break;
    }
  }

  process.stdout.write(`Accettazione M5-BIS — ${inventory.length} righe, ${MANIFEST.length} scenari\n\n`);
  process.stdout.write(`${lines.join('\n')}\n\n`);
  process.stdout.write(
    `verde ${verde} · atteso-rosso ${attesoRosso} · rosso-inatteso ${unexpectedRed} · ` +
      `atteso-rosso→verde ${attesoRossoOraVerde} · non provabile qui ${nonProvabile} · ` +
      `nessuno scenario ${nessunoScenario} · orfano ${orphanRows.length}\n`,
  );

  if (unexpectedRed > 0 || readyWithoutScenario > 0 || attesoRossoOraVerde > 0 || orphanRows.length > 0) {
    process.stdout.write(
      `\nFALLITO: ${unexpectedRed} rosso-inatteso, ${readyWithoutScenario} riga READY senza scenario, ` +
        `${attesoRossoOraVerde} atteso-rosso da promuovere, ${orphanRows.length} scenario orfano nel manifest.\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write('\nOK: nessun rosso inatteso, nessuna riga READY scoperta, nessuno scenario orfano.\n');
}

main();
