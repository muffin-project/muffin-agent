/**
 * Which `M5-BIS.md` row each acceptance scenario proves, and what outcome it
 * is expected to have today — independent of vitest on purpose.
 *
 * `report.ts` reads this list to cross-reference against the inventory
 * without ever invoking the test runner: importing a vitest test file outside
 * `vitest run` throws the moment it calls `it()` (there is no active suite for
 * it to register into), so the metadata a plain script needs has to live
 * somewhere vitest-free. A scenario file imports its own entry from here for
 * the title, which is the single source of truth — the string cannot drift
 * between "what the report expects" and "what the test is actually called"
 * because there is only one copy of it.
 */

export type Expectation =
  | { kind: 'verde' }
  | {
      kind: 'atteso-rosso';
      /** Why it is false today — the honest answer to "lo avevamo già fatto?". */
      reason: string;
      /** The branch or decision that closes it. Must be a real, checkable name. */
      closedBy: string;
      /**
       * The failure this row's `reason` predicts, checked against the error
       * `scenario()` actually catches — not merely "did it throw".
       *
       * Mandato DAY-1 §4.9 (P39): `it.fails` alone marks a scenario `passed`
       * on *any* throw, so a scenario can keep reading "atteso-rosso, ragione
       * X" long after the code started throwing for reason Y — the reason
       * goes stale and nothing notices, which is exactly the shape D10 was
       * caught in (PR #28: reason cited a branch `slice/taint-in-ingresso`
       * had already closed; the scenario stayed green-as-red for the wrong
       * cause). Required, not optional — an `atteso-rosso` entry without one
       * is the omission this field exists to close.
       */
      expectFailure: RegExp | ((error: unknown) => boolean);
    };

export type ScenarioEntry = {
  /** An M5-BIS row id, e.g. 'A1', 'B8'. */
  row: string;
  /** Full `it()` title — starts with `row` so the report can parse it back out. */
  title: string;
  expectation: Expectation;
};

const verde = (row: string, title: string): ScenarioEntry => ({
  row,
  title: `${row} ${title}`,
  expectation: { kind: 'verde' },
});

const rosso = (
  row: string,
  title: string,
  reason: string,
  closedBy: string,
  expectFailure: RegExp | ((error: unknown) => boolean),
): ScenarioEntry => ({
  row,
  title: `${row} ${title}`,
  expectation: { kind: 'atteso-rosso', reason, closedBy, expectFailure },
});

export const MANIFEST: readonly ScenarioEntry[] = [
  verde('A1', 'boot: a fresh install starts on its own, and a second launch finds its own state'),
  verde('A5', 'doctor: a tampered sealed root-of-trust file is caught and named, with a remedy'),
  verde('A8', 'backup: copying the home directory and restoring it keeps memory findable'),
  verde('B1', 'continuity: what was said in one process is recalled by a later one, same session'),
  verde('B3', 'wait: a turn that asks to wait persists and RELEASES the process instead of holding it'),
  verde('B4', 'todo: a plan written by one process is shown, unasked, to the next one in the session'),
  verde('B5', 'resume: a process killed mid-turn leaves a row the next boot names and the gateway finishes'),
  verde('B11', 'streaming: the real binary, driven with --stream over a pipe, delivers the answer through the SSE path and exits clean'),
  // Promoted (this slice): `Deliver` returns a typed `DeliveryOutcome` and
  // `Scheduler.settle` is markRan's only caller (ADR-0035 §1, PR #42). The
  // fire still advances on a failed delivery — that stays true on purpose,
  // so the model is not re-billed to re-send text already sitting in
  // `outcome.text` — but the turn's own `delivery` column now records
  // `failed:<why>` instead of `sent`, and `doctor`'s "consegne" check
  // (`core/turns/store.ts`'s `undelivered()`, wired PR #42) names it. That is
  // the real fix to "un job che dice «inviato» è arrivato?": not that the fire
  // stops moving, but that "arrived" stops being a lie.
  verde(
    'B8',
    'delivery: a job whose channel is not actually connected never has that recorded as `sent` — the ' +
      'turn keeps `failed:<why>`, and `doctor` names it',
  ),
  verde('C1', 'memory write: something said in one turn is shown to the model recalling a later one'),
  // Promoted (this slice): the retrieval gap the old reason described is
  // real (vector search never sees a fact inserted straight through
  // `store.addFact`, and `searchEpisodes` never returns facts at all) — but
  // C4's own claim is about the one-hop graph path (`02-ontologia.md` §9),
  // which `extractCandidateNames` (core/memory/recall.ts) only enters from a
  // *capitalised* word in the query. A fixture whose entity is a proper name
  // ("Ristorante preferito", capitalised on purpose) is what that path is
  // for — not a workaround, the shape of query C4 is actually about. Verified
  // both calls surface the right fact (`strategie: … graph`) before writing
  // this: `muffin memory search` without `--history` returns only "da
  // Luigi", with it returns both, "da Mario" marked RITIRATO.
  verde(
    'C4',
    'recall: a superseded fact is invisible to search until --history asks for it',
  ),
  verde(
    'D1',
    'file read: a symlink inside the workspace cannot walk fs_read past the real scope, real path or real deny-list',
  ),
  verde('D2', 'file write: asking to write a file gets an honest refusal, not a silent no-op'),
  rosso(
    'D3',
    'undo: a file modification the model made can be reverted by the owner',
    'no undo journal exists (M5-BIS §1) — fs.write only ever reaches the kernel\'s `draft` verdict, ' +
      'which agent/loop.ts refuses outright, so there has never been a modification for an undo path ' +
      'to revert; "modello di reversibilità" is still an open owner decision per STATE.md, not yet a slice',
    'M5-BIS §1 (decisione owner aperta: modello di reversibilità)',
    // The scenario's own thrown message when `muffin undo` is still an
    // unknown command (cli/main.ts:237-238, exit 78) — not the CLI's raw
    // stderr, the assertion built on top of it. The day `undo` stops being
    // unknown, this stops matching and the scenario is a real green, which is
    // exactly the promotion signal.
    /muffin undo.*non esiste ancora/,
  ),
  // Promoted (this slice): the reason this carried (`slice/taint-in-ingresso`
  // still open) went stale the moment that slice merged (2026-08-15) and
  // its judge round 2 closed the failure-path gap too (PR #28, STATE.md
  // "Taint in ingresso — chiuso"). What stayed wrong after the merge was the
  // scenario's own assertion, not the kernel: a call the kernel denies never
  // reaches `runTool`'s execution path, so it never writes a
  // `turn_tool_calls` row — the scenario was asserting a signal the deny
  // path structurally cannot produce. Probed directly before rewriting: the
  // turn's `taint` is 3 and its `messages` carry the tool_result naming
  // `resource_denied` for the `http_get` call; no row for it in
  // `turn_tool_calls` at all, confirming PR #28's own finding.
  verde(
    'D10',
    'security: a turn that read untrusted content cannot use it to reach an unlisted host',
  ),
  verde('E1', 'budget: a turn that would cross the monthly cap is stopped before it spends'),
  verde('E2', 'cost: the REPL answers how much has been spent this month, in dollars'),
  // Narrower than E5's own question — see the scenario's own docstring in
  // e-cost.accept.ts. The row stays `?` in M5-BIS.md; only one failure class
  // (the contradiction judge) is proven explicit-and-explained here.
  verde('E5', 'judge failure: an unreadable judge answer is explained on `muffin memory review`, not repeated verbatim'),
] as const;

export function entry(row: string): ScenarioEntry {
  const found = MANIFEST.find((s) => s.row === row);
  if (!found) throw new Error(`nessuna voce nel manifest per la riga ${row}`);
  return found;
}

/**
 * The marker `scenario.ts` throws when an `atteso-rosso` function stops
 * throwing at all, and the one `report.ts` greps `failureMessages` for to
 * tell "promote me" apart from "red for the wrong reason" — both show up as
 * an ordinary vitest failure, so the two files need one shared spelling
 * rather than each hard-coding a copy that could drift apart.
 */
export function promoteMarker(row: string): string {
  return `ATTESO_ROSSO_ORA_VERDE(${row})`;
}
