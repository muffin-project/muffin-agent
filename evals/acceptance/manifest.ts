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
    }
  | {
      /**
       * Not "no scenario yet" and not "red on purpose" — a row this suite
       * structurally cannot have a scenario *for*, because the row's own
       * claim is "this mechanism exists and runs against the real binary",
       * and a scenario proving that would be the suite testing itself. What
       * proves the claim instead is every other `verde` entry in this same
       * manifest: each one already is `muffin` run as a real process (see
       * report.ts's module docstring) — that is the evidence, not a missing
       * one. Judge, PR #54 giro 2: E4 was mis-filed under `nessuno scenario`
       * next to seven rows that genuinely have none yet.
       */
      kind: 'provata-dal-meccanismo';
      /** Why this row cannot carry a scenario of its own. */
      reason: string;
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

const provataDalMeccanismo = (row: string, title: string, reason: string): ScenarioEntry => ({
  row,
  title: `${row} ${title}`,
  expectation: { kind: 'provata-dal-meccanismo', reason },
});

export const MANIFEST: readonly ScenarioEntry[] = [
  verde(
    'A1',
    'continuity: a gateway SIGKILLed mid-life is replaced by a supervisor-started one that resumes a suspended turn and fires a due job, each exactly once',
  ),
  verde(
    'A2',
    "identity: the installed rot/identity.md — this home's own, not defaults/ — reaches the real system prompt sent to the provider, and `muffin prompt show` matches it",
  ),
  verde(
    'A3',
    'persona: the installed persona.md/voice.md reach the real system prompt in canonical order (persona, identity, voice), and `muffin prompt show` on the same home is byte-identical to what the provider actually received',
  ),
  verde('A5', 'doctor: a tampered sealed root-of-trust file is caught and named, with a remedy'),
  verde('A8', 'backup: copying the home directory and restoring it keeps memory findable'),
  verde(
    'A9',
    'setup locale: `init --local` builds a second, throwaway home that reuses a persisted secret through the same chain — never a copy — and refuses a directory that is or contains the real home',
  ),
  // New (slice/e2e-giro-owner): every other row in this block proves one link
  // of the owner's chain in isolation. Nobody drove the chain itself — clean
  // machine to a real reply on a real surface, with the platform's own
  // supervisor holding the gateway up, ending in an `uninstall` that keeps
  // only what was explicitly `--persist`ed. `muffin gateway install` in
  // particular had a unit generator with unit tests on its *text* and no
  // scenario that ever asked the platform's own parser to accept it end to
  // end. `core/gateway/unit.test.ts` already proves each platform's unit
  // passes its own parser in isolation (`systemd-analyze verify` / `plutil
  // -lint`) — this scenario is the one that runs both checks again from
  // inside a full install/gateway/uninstall journey, so a regression in *how
  // the journey calls the planner* (not just the planner's own output) goes
  // red here too.
  verde(
    'A10',
    "e2e owner journey: clean machine to a delivered reply on a real surface — `secret set --persist` warns when a home copy shadows it, `doctor` is honest about exactly which warnings are expected at each step, `gateway install`'s unit passes the platform's own parser (systemd-analyze on Linux, plutil on macOS — never the real launchd label on this machine), a live gateway pairs Telegram and delivers a real turn, a second process recalls it, and `uninstall` leaves only the `--persist`ed secret behind",
  ),
  verde('B1', 'continuity: what was said in one process is recalled by a later one, same session'),
  verde('B3', 'wait: a turn that asks to wait persists and RELEASES the process instead of holding it'),
  verde('B4', 'todo: a plan written by one process is shown, unasked, to the next one in the session'),
  verde('B5', 'resume: a process killed mid-turn leaves a row the next boot names and the gateway finishes'),
  // New (slice/job-fires, owner decision 2026-08-17): the fire-claim/identity
  // gap A1's own comment named as "owned elsewhere" — a real SIGKILL landed
  // between job_fires binding a fire and its turn actually being written,
  // and a second one landed between that turn reaching `done` and Scheduler
  // ever calling deliver/markRan. Both recover to exactly one turn and
  // exactly one delivery, and the fake provider's own request log — not just
  // the database — is the evidence the model was never called twice.
  verde(
    'B7',
    'job-fires: a real SIGKILL between binding a fire and creating its turn, and another between the turn finishing and settlement, both recover to exactly one delivered turn — the model called exactly once',
  ),
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
  // New (slice/egress-params, mandato inv. 7 / audit P04-1): the row's own
  // BLOCKER text said "solo scenario mancante" — the mechanism (allowlist,
  // redirect recheck, SSRF floor) was already `impl solida`. This scenario is
  // that missing proof, extended to cover the gap the audit found: the
  // allowlist checked the HOST only, so a tainted turn could still put chosen
  // bytes in an allowlisted URL's query string. Does not promote the row —
  // see the note on D7 below and the PR body: a live "allow, fetch succeeds"
  // leg stays unproven at this layer (would need a real reachable host),
  // unrelated to what this scenario closes.
  verde(
    'D6',
    'http: a query string on an allowlisted host answers to the same params ceiling as an unlisted host — after tainted content, ask for the owner and never fetched without one',
  ),
  // New (slice/egress-params, mandato inv. 7 / audit P04-2): `sys.search`
  // declared `resourceKind: 'none'` and never reached the kernel's egress
  // branch at all — the query left with zero policy inspection at any taint.
  // Proves the fix reaches the real binary: after tainted content, `ask` is
  // the decision on record and the search backend is never called. Per the
  // mandate, this does NOT promote D7 to READY — the happy path (a real
  // search actually returning results) is still unproven at this layer,
  // because `tavilyBackend`'s endpoint is a compiled constant with no seam to
  // point at a fake server from a subprocess, and hitting the real Tavily API
  // from this suite is out of scope (no real providers).
  verde(
    'D7',
    'web search: the query now answers to the kernel — after tainted content, a search asks the owner and the backend is never called unapproved',
  ),
  // Nuovo (slice/skill-di-serie). La riga D9 chiedeva «la prova stretta al
  // profilo richiesto (injection/fake-close + production wiring)». Il recinto
  // era già provato in unità; il cablaggio no, e non era provabile: nessuna
  // skill veniva spedita, quindi su un'installazione vera la sezione non
  // esisteva proprio e `skill_read` non aveva un oggetto. Costruire una skill
  // dentro lo scenario avrebbe misurato lo scenario.
  verde(
    'D9',
    'skills: a fresh install already knows how to do something, the model activates a skill and gets its body, and a skill description that fakes a fence close loses the attempt',
  ),
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
  // Extended (slice/session-taint, MANDATO-DAY-1 invariant 2): a second,
  // same-session run that reads nothing of its own still inherits taint 3
  // from the first turn's reply, reinjected as history — the triage probe's
  // "LAUNDERED" finding, closed and pinned to the real binary.
  verde(
    'D10',
    'security: a turn that read untrusted content cannot use it to reach an unlisted host, and a later ' +
      'clean turn in the same session still carries the inherited taint',
  ),
  verde('E1', 'budget: a turn that would cross the monthly cap is stopped before it spends'),
  verde('E2', 'cost: the REPL answers how much has been spent this month, in dollars'),
  // Narrower than E3's own question ("posso ricostruire cosa è successo?") —
  // it does not promote the row past the acceptance-scenario gap M5-BIS
  // still names for it. What it proves is the P34-2 half ADR-0048 closes: a
  // tool result that happens to contain a secret-shaped string never reaches
  // `turn_tool_calls.content` in the clear, through the real binary and a
  // real home database, not a unit-level fake.
  verde('E3', 'tracing: a tool result that looks like a secret is redacted before it reaches the durable record'),
  // E4 is this suite's own row ("acceptance test reali, non solo unit?") —
  // giving it a scenario would mean the acceptance mechanism registering a
  // test of itself, which proves nothing a passing suite does not already
  // prove more directly. What actually establishes E4's claim is every verde
  // row above and below: each spawns `muffin` as a real process against a
  // real (temp) $HOME, never `runTurn()` with hand-substituted dependencies
  // (module docstring, report.ts). report.ts/summarize() reads this kind and
  // counts E4 as covered instead of filing it under `nessuno scenario`.
  provataDalMeccanismo(
    'E4',
    'tests: acceptance tests run for real, against the real binary — not just unit',
    'la suite di accettazione non può avere uno scenario di sé stessa: ogni riga verde di questo manifest è già la prova che i test sono reali',
  ),
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
