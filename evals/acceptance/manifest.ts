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

const rosso = (row: string, title: string, reason: string, closedBy: string): ScenarioEntry => ({
  row,
  title: `${row} ${title}`,
  expectation: { kind: 'atteso-rosso', reason, closedBy },
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
  rosso(
    'B8',
    'delivery: a job whose remote delivery is not actually wired is still marked as run',
    'core/scheduler/scheduler.ts calls markRan unconditionally after a delivery attempt, whether ' +
      'or not anything was actually delivered — cli/gateway.ts has no remote channel wired yet, so ' +
      'the message goes to stderr ("consegna remota da cablare") and the job is recorded as done anyway',
    'slice/superfici',
  ),
  verde('C1', 'memory write: something said in one turn is shown to the model recalling a later one'),
  rosso(
    'C4',
    'recall: a superseded fact is invisible to search until --history asks for it',
    'the fixture writes both facts straight through `store.addFact`/`store.supersede`, skipping the ' +
      'backlog indexing in core/memory/ingest.ts — so nothing here is ever embedded and the semantic ' +
      'half has nothing to find; `searchEpisodes` (the text half) only ever returns episodes, never ' +
      'facts, flag or no flag; and the query "ristorante preferito" carries no capitalised word for ' +
      '`extractCandidateNames` to pick up, so the one-hop graph expansion never fires either — none of ' +
      'the three retrieval paths reaches this fact, so even the active belief ("da Luigi") never turns ' +
      'up before --history is even asked',
    'evals/acceptance/scenarios/c-memory.accept.ts (harness fixture — no slice scheduled yet)',
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
  ),
  rosso(
    'D10',
    'security: a turn that read untrusted content cannot use it to reach an unlisted host',
    'egress.json ships with an empty allowlist and the kernel asks rather than denies for an owner ' +
      'turn out of allowlist — a tainted turn is supposed to be denied outright (threat model §b), and ' +
      'that branch is exactly what slice/taint-in-ingresso is still closing',
    'slice/taint-in-ingresso',
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
