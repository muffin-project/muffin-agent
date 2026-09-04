/**
 * Which `requirements-status.md` row each acceptance scenario proves, and what outcome it
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
       * readiness-criteria.md#day-1-ready (P39): `it.fails` alone marks a scenario `passed`
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
  /** A DAY-1 requirement id, e.g. 'A1', 'B8'. */
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
  // New (slice/journey-lifecycle): the row was BLOCKER only for a missing
  // scenario — `muffin config` is read-only by design (ADR-0036,
  // `cli/config.ts:7,22-37`) and the mechanism (`listConfigKnobs`, `muffin
  // rot reseal`) already existed. Proves both halves of ADR-0036's split on
  // the real binary: an unsealed knob (`models.main` in `config.json`)
  // changes what the provider actually receives with no reseal in between,
  // and a sealed knob (`rot/budgets.json`) changes what the binary *does*
  // (a hand-edited cap of 0 stops a turn) before `muffin rot reseal`, which
  // is what stops `doctor` from calling the edit tampering — never a
  // precondition for the value binding.
  verde(
    'A4',
    'config: an unsealed knob (config.json) binds with no reseal, a sealed knob (rot/budgets.json) binds before reseal too, and `muffin rot reseal` is what clears doctor — all three witnessed by the real binary and `muffin config --json`',
  ),
  // New (slice/journey-lifecycle): `muffin update` (`cli/update.ts`) exists
  // (9f56484, 26/08) but had no acceptance scenario. `cmdUpdate` gives a
  // spawned `muffin update` no way to point at anything other than the real
  // git checkout (`findCheckoutRoot`'s own docstring walks to the MAIN
  // worktree) and the real system bin directories — running it as a real
  // child process from this suite would mutate the actual repository this
  // agent runs from. So this exercises `runUpdate` — the exact function
  // `cmdUpdate` calls with only argv-parsing on top — redirected at only the
  // two inputs its own doc comments name as the test seam (`moduleDir`,
  // `bindirs`); `git`, `npmCi`, `smokeTest`, `readNewSchemaVersion` and
  // `backup` are all the real defaults, running for real against a real
  // throwaway checkout+origin, and `backup` runs against the real, populated
  // `$MUFFIN_HOME` the real spawned binary built earlier in the same
  // scenario. Does not exercise `cmdUpdate`'s own argv parsing or its
  // interactive restart prompt, which carry no logic of their own.
  verde(
    'A6',
    'update: a validated backup is taken before the launcher swap, and content written before the update is still there after — the real mechanism, redirected only at the checkout root and the bindirs',
  ),
  // New (slice/journey-lifecycle): `rebuildTable`/`SchemaAheadError` were
  // proven at the unit level (RETURN S2); the acceptance gap was that no
  // scenario ran the real binary against a real, POPULATED database with a
  // migration actually pending — `install()` alone stamps every migration
  // fresh (`stampFresh`) and never runs an `up()`. Rewinds a real database's
  // `schema_version` stamp (never its data) to simulate a pre-migration
  // install, lets the real binary discover and run the pending migration on
  // its own next boot, and asserts rows survive, the migration's own
  // backfill actually took effect (not just "the column exists"), and a
  // database stamped ahead of the code's own version is refused before
  // anything is written. `MIGRATIONS` today has no `rebuildTable`-based
  // entry (only additive `ALTER TABLE`), so the CHECK-widening escape hatch
  // stays unreached by this scenario — see its own comment.
  verde(
    'A7',
    "migration: a real additive migration runs against a real populated database on the binary's own boot, rows survive and the migration's backfill is actually active, and a database stamped ahead of the code refuses before writing",
  ),
  // Riscritto (slice/journey-lifecycle, riconciliazione 02/09): la versione
  // precedente copiava la home con `cpSync` — provava il filesystem, non i
  // verbi. Ora esercita `muffin backup`/`muffin restore` (`cli/backup.ts`)
  // per davvero: il file di backup dichiarato esiste ed è quick_check-ato
  // indipendentemente, il contenuto scritto DOPO il backup sparisce dal
  // restore (sostituisce, non aggiunge) e la copia-di-cortesia che
  // `restoreFrom` mette da parte esiste sul disco.
  verde('A8', 'backup: `muffin backup` and `muffin restore` — a real snapshot, replacing (not merging) the live database, memory findable after'),
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
  verde(
    'B2',
    'busy input: a message sent while a turn is alive is acknowledged at once and answered after it, and /stop interrupts the live turn (ADR-0054)',
  ),
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
  // New (slice/journey-telegram): B13/B14/D12 were BLOCKER only for lack of a
  // scenario that drives the mechanism over the real Telegram surface — the
  // rows' own text names each mechanism as already in HEAD. This is that
  // missing proof, against a fake Bot API server (`evals/acceptance/
  // telegram.ts`) and a real `muffin gateway`, alongside B1's own Telegram
  // half (a plain, unmanifested scenario — see `b-telegram-journey.accept.ts`'s
  // own docstring for why that one does not register here).
  verde(
    'B13',
    'progress telegram: a scripted multi-round turn produces one status message, edited in place (never a second one), throttled, and replaced by the real answer',
  ),
  verde(
    'B14',
    'attachment telegram: `send_file` reaches `sendDocument` on the real binary, with the real filename and byte length, to the owner\'s chat',
  ),
  verde(
    'D12',
    'ask telegram: the ASK shows the command and cwd plus the taint reason, an owner\'s button press resumes the suspended turn exactly once, and a non-owner\'s press decides nothing',
  ),
  // New (slice/b10-immagini-ed-errori, issue #361): the row was BLOCKER only
  // because the fake Bot API this suite drives `muffin gateway` against had
  // no `getFile` — the mechanism (`ImageBlock` via `ingest()`, since
  // b815751) was already in HEAD but unreachable from an acceptance
  // scenario. `evals/acceptance/telegram.ts` now serves `getFile` and the
  // `/file/bot<token>/<file_path>` download route (`FakeTelegram.plantFile`).
  // The row's error half is proven alongside, as a plain unmanifested `it()`
  // in the same file — see `b-immagini-ed-errori.accept.ts`'s own docstring
  // for why (manifest is 1:1 per row, same reasoning as B1's Telegram half).
  verde(
    'B10',
    'immagini telegram: una foto vera attraversa il Bot API finto, il download e il vault, e arriva al modello come `image_url` con i byte esatti scaricati',
  ),
  // New (slice/journey-capability): B6 was BLOCKER only for a missing
  // scenario — the mechanism (`eseguiConRitentativi`, MAX_TOOL_RETRIES=2) is
  // already unit-proven (`agent/tool-retry.test.ts`) with a fake tool. What
  // was never proven is `agent/tools/http.ts` wired to the real binary. A
  // completed 503-then-200 round trip through a local fake server turns out
  // to be unreachable from this harness: `addressVeto`
  // (`core/net/egress.ts#isForbiddenAddress`, called on every hop) refuses
  // every address a subprocess-local test can bind a listener to — loopback,
  // all of RFC1918, CGNAT, link-local, multicast/reserved and their IPv6
  // equivalents — independent of the allowlist. Same class of gap the
  // manifest already accepts for D7's tavily happy path. Does not promote the
  // row past `?`: what this proves instead, on the real binary, is that the
  // SSRF floor holds even past an explicit allowlist entry, that the refusal
  // is never retried (bounded, not a silent retry loop on a dead target), and
  // that the refusal travels the ordinary `tier: 0` result path rather than
  // an exception.
  verde(
    'B6',
    'retry boundary: an explicitly allowlisted loopback host is still refused by the address floor — never reaches the network, and the refusal is recorded once, not retried',
  ),
  // Promoted (this slice): `Deliver` returns a typed `DeliveryOutcome` and
  // `Scheduler.settle` is markRan's only caller (ADR-0035, PR #42). The
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
  // New (slice/journey-memoria). C2's row named the exact gap: extraction is
  // wired at turn end (`agent/runtime.ts`'s `onTurnEnd`) but nothing had ever
  // driven it through the real binary. `muffin run` cannot demonstrate this —
  // its trailing-edge timer is unref'd and `runtime.close()` disarms it in
  // the same tick the turn finishes — so this drives a real job through a
  // real gateway subprocess and never calls `muffin memory extract`.
  verde(
    'C2',
    "extraction: a real gateway process, with nothing calling `muffin memory extract`, produces a fact from a turn's own words within the trailing-edge debounce",
  ),
  // New (slice/journey-memoria). C3's row named three things together: a
  // backlog bigger than one page fully drains, an exact-duplicate pair only
  // `sweepDuplicates` can catch gets caught, and `muffin memory review`
  // shows a contradiction the judge left open — all through one
  // `muffin memory extract` and one `muffin memory review`, both real
  // processes.
  verde(
    'C3',
    'consolidation: a 27-episode backlog drains fully in one `memory extract`, an exact-duplicate pair only the sweep can catch is retired, and `memory review` shows the contradiction the judge left open',
  ),
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
  // New (slice/journey-memoria). C6's row asked for the temporal graph
  // itself: `factsAsOf`/`nearestFactTo` (`core/memory/store.ts`) and `asOf`
  // as the one parameter both the CLI and the `memory_search` tool take,
  // proven through both surfaces with the exact "Anna until August, Bruno
  // after" shape `factsAsOf`'s own docstring reasons through.
  verde(
    'C6',
    'temporal graph: "who was X in May" answers correctly through --as-of on the CLI and through a real turn calling the memory_search tool with as_of',
  ),
  // New (slice/journey-memoria). C7's row named the gap precisely:
  // `connectors/telegram/document-arrival.test.ts` proves attachment→vault→
  // reindex→episode in-process, and the fake Telegram serves no file
  // downloads — so this drives the path that is reachable from the CLI,
  // `muffin vault add`, with a real (byte-built) PDF and a real scan.
  verde(
    'C7',
    "documents: a real PDF's text reaches an episode and is findable by search, and a scanned PDF with no text layer fails explicitly instead of indexing empty",
  ),
  verde(
    'D1',
    'file read: a symlink inside the workspace cannot walk fs_read past the real scope, real path or real deny-list',
  ),
  // New (slice/journey-capability): the row was BLOCKER only for a missing
  // scenario. shell_run is registered only when the sandbox probe held on
  // this host (agent/runtime.ts), and sys.shell is `high` risk — single-user
  // (the only mode `install()` builds) always asks, and headless `muffin run`
  // has no approval channel. The honest boundary this scenario proves: the
  // tool is offered (sandbox proven live), and the resulting ASK shows the
  // exact command and cwd — not that the command executes end to end, which
  // stays the unit suite's and the CI gate's proof.
  verde(
    'D4',
    'shell: a scripted shell_run is only ever offered after a live sandbox probe, and the resulting ASK shows the real command and cwd',
  ),
  // New (slice/journey-capability): same shape as D4 for sys.process.kill —
  // process_list/process_kill act on the host's real process table, not a
  // sandbox. list proves pid+command name reach the model with no argv
  // leaked (PS_ARGV asks for comm, never args); kill proves the pid reaches
  // the ASK, never the real signal — sys.process.kill is `high` risk, same
  // single-user/no-channel boundary as D4.
  verde(
    'D5',
    'process: a real long-lived child is listed by pid and command name with no argv leaked, and killing it stops on the same headless ASK boundary as shell',
  ),
  // Riscritto (slice/undo-journal): asseriva che il file NON atterrasse, che
  // era vero e non era la domanda della riga. `draft` senza registro di undo
  // non è «in sicurezza», è «non c'è». Ora prova le due metà: il file c'è, e
  // `muffin undo` lo toglie.
  verde('D2', 'file write: the model writes a real file, and the copy taken first makes it revertible'),
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
    'web search: after tainted content a search runs (ADR-0072), and a policy.json that lowers searchMaxTaint puts the ask back — the gate is a knob, not a removed line',
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
  // Promosso (slice/undo-journal). Era atteso-rosso con la ragione giusta —
  // non c'era registro, e `draft` era rifiutato da `agent/loop.ts`, quindi non
  // esisteva nemmeno una modifica da disfare. Ora esistono entrambi, e lo
  // scenario è stato riscritto insieme alla promozione: controllare che
  // `muffin undo` non sia più un comando sconosciuto era la domanda giusta
  // finché la risposta era «non esiste», ed è la domanda sbagliata il giorno
  // dopo. D2 copre la creazione (undo = togliere), questo la modifica
  // (undo = rimettere il contenuto di prima).
  verde('D3', 'undo: a file the model overwrote goes back to what it said before'),
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
  // Extended (slice/session-taint, taint through session history): a second,
  // same-session run that reads nothing of its own still inherits taint 3
  // from the first turn's reply, reinjected as history — the triage probe's
  // "LAUNDERED" finding, closed and pinned to the real binary.
  verde(
    'D10',
    'security: a turn that read untrusted content may still read a page (ADR-0066) but cannot leave with ' +
      'bytes it composed (ADR-0071), and a later clean turn in the same session still carries the inherited taint',
  ),
  // La riga era READY **senza** scenario e il secondo gate del rapporto la
  // bocciava, correttamente: due test in `runtime-wiring.test.ts` provano il
  // meccanismo, non che il binario lo raggiunga. D3 copre il disco; questo
  // copre l'altra meta' della domanda della riga — «e un ripristino che disfa
  // anche il turno?».
  verde('D11', 'checkpoint: `muffin undo` marks the turn and the memory episode, not only the disk'),
  verde('E1', 'budget: a turn that would cross the monthly cap is stopped before it spends'),
  verde('E2', 'cost: the REPL answers how much has been spent this month, in dollars'),
  // Extended (slice/journey-lifecycle): still narrower than E3's own full
  // question in one respect (it does not exercise every span shape the row
  // could name), but now covers both halves the row's BLOCKER text asked
  // for: the P34-2 secret-redaction half ADR-0048 closes (a tool result that
  // happens to contain a secret-shaped string never reaches
  // `turn_tool_calls.content` in the clear) AND reconstructing an arbitrary
  // turn via `muffin trace turn <id>`/`muffin trace grep` — asserted as
  // isolation (the reconstruction of turn B never shows turn A's tool call,
  // and vice versa), not merely "the command printed something". One
  // scenario, not two: `report.ts`'s manifest is 1:1 per row.
  verde(
    'E3',
    'tracing: a tool result that looks like a secret is redacted before it reaches the durable record, and an arbitrary turn is reconstructed — and only that turn — via `trace turn`/`trace grep`',
  ),
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
  // e-cost.accept.ts. The row stays `?` in requirements-status.md; only one failure class
  // (the contradiction judge) is proven explicit-and-explained here.
  verde('E5', 'judge failure: an unreadable judge answer is explained on `muffin memory review`, not repeated verbatim'),
  // New (slice/journey-capability): the row was BLOCKER only for a missing
  // scenario — the mechanism (sys_inspect, #176) already read from the same
  // authoritative sources as `doctor`/`prompt show`. Proves the acceptance
  // criterion the row itself states: asking twice, with a real condition
  // (the main model) changed in between through `muffin model main`, must
  // show the new state and not repeat the old one.
  verde(
    'E7',
    "self-inspection: sys_inspect answers with this instance's live config, and after a real `muffin model main` change the second answer reflects it instead of repeating the first",
  ),
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
