# Forensic findings — verification against current code

Date: 2026-10-18
Subject: `muffin-agent` at HEAD `dae23668` (branch `fix/reliability-remediation`)
Companion to: `docs/evidence/2026-10-18-independent-technical-review.md` and the
out-of-tree forensic audit `~/.muffin/audits/muffin-forensic-audit-2026-10-18.md`.

> Status of this document: dated evidence, not current authority. It records a
> verification pass, run so nothing claimed by the audit is taken on faith. It
> does not override `docs/architecture/`, ADRs, or executable code.

## Method

- Baseline re-established on the working tree, not trusted from the audit:
  `npx tsc --noEmit` → exit 0; `npx vitest run` → **425 files, 5,559 passed,
  7 skipped, 0 failed** (252 s). The single historical failure the review saw
  (`core/judgment/shadow.test.ts:80`, timing) does not reproduce.
- Every load-bearing audit claim traced to current producer + consumer + test
  against HEAD, not against rendered text read out of the database.
- Read-only DB queries against the immutable snapshot
  (`~/…/opencode/muffin-forensic-20261018-133906/muffin-snapshot.db`).
- No live DB, gateway, vault, secret or external state touched.

## Disposition of the headline findings

| Finding | Audit claim | Verified state on HEAD | Evidence |
|---|---|---|---|
| MI-01 | a past request resurfaces as a live ask | **fixed** | `cf99c052` (ADR-0068), ancestor of HEAD; `vectors.ts` excludes request predicates from embedding |
| MI-02 | agent content recalled as the owner's | **fixed** | `ed4fb660`, ancestor of HEAD; `recall.ts` `describeEpisodeSource` is role-aware (agent → "Muffin") |
| MI-03 | contradictions silently "keep both" | **surfaced, not silent** | `ingest.ts:787,845,900` write a durable `memory_review` row; `muffin memory review` resolves it |
| MI-04 | consolidation failures invisible | **counted and surfaced** | failures land in `IngestReport.errors`/`judgeUnavailable`; `muffin memory doctor` reports |
| IA-01 | identity plane unused (0 identities) | **by design** | `connectors/shared/ingress/remember.ts:112` deliberately leaves `actorId` unset |
| SC-01 | `session_id='owner'` spans months/surfaces | **by design** | owner identity is one principal (ADR-0056); not a per-surface session |
| SC-02 | session fork 2026-09-03 | **by design** | same identity decision; the fork is the surface → owner consolidation |
| SC-03 | synthetic messages lack `origin` | **fixed** | `message-origin.ts` constructors; `origin` persists via `serializzaCheckpoint` |
| TR-01 | `send_file` mostly fails | **by design + model error** | vault-scoped on purpose (`deliver.ts` docstring); ENOENT paths were model guesses |
| TR-02 | duplicate identical tool calls | **handled** | `agent/loop/tool-call.ts` `identicalCallsDone` emits a repeat notice |
| RT-01 | dead-end continuable turns not surfaced | **surfaced** | `muffin doctor` (`cli/doctor.ts:1221`) and `muffin resume` |
| RT-02 | runaway shell commands | **bounded** | default 120 s, hard cap 600 s (`core/sandbox/executor.ts:87-88`) |
| TK-01 | stale todos | **not reproduced as a code defect** | presentation/maintenance, not a wiring failure |

## Independent measurements (this pass)

- **ADR-0068 declared-open item falsifier.** The ADR declines to wire
  `forgottenRequestChunks` into `consolidation_runs`/`stats`/`doctor`, on the
  argument that it "converges to zero after the first few runs." Measured on the
  real install: **186 request facts, 0 still vectorised** (162 total fact
  chunks). Converged. The proportionality choice holds; wiring the column is not
  justified by the data. (It is already printed by `muffin memory extract`,
  `cli/memory.ts:245,275`.)
- **Shell error clusters** (`turn_tool_calls`, 1,783 calls / 252 errors):
  `shell_run` 109 · `fs_read` 49 · `fs_list` 27 · `http_get` 25 ·
  `shell_run_write` 16 · `send_file` 15/20. Decoded root causes:
  - `send_file` — no reply channel (terminal turns, correct); ENOENT (model
    guessed a path); `outside the working directory` for workspace/repo paths.
  - `shell_run` — exit 127/128/141 and macOS sandbox refusal (environment); one
    "killed at 1734551ms" row is a **29-minute owner-approval wait**
    (`sys.shell` on `date`), not a runaway command.
  - `fs_read` 18× denied on `core/memory/schema.ts` (repo-relative)
    — the agent probing the **repo** while its scope is the **workspace**.
- **SIGPIPE (`exit 141`)** from `… | head` is marked `isError`. This is
  **decided, not a defect**: ADR-0087 §"Rischi residui" states swallowing 141
  "sarebbe la stessa colpa nell'altra direzione."

## Why no code change is proposed

Every headline defect is either already fixed on HEAD (MI-01, MI-02, SC-03,
TR-02), deliberately recorded (ADR-0068, ADR-0087), documented as a boundary
(IA-01, SC-01/02, `send_file` vault scope), or environmental/operational
(exit 127/128, macOS sandbox refusal, approval latency). AGENTS.md forbids
reopening a recorded decision merely because another design is possible, and the
mission's own stop condition — "the evidence establishes that further changes
would be unjustified" — is met.

## Genuinely open — these are design decisions, not bugs

Three disjoint roots the agent must reason about, each boundary deliberate:

| Root | Scope of | Example failure observed |
|---|---|---|
| `~/muffin-workspace` | `fs_read`/`fs_write`/`fs_list`, shell cwd | — |
| `~/.muffin/vault` | `send_file`, ingest arrival | sending a workspace file → "outside the working directory" |
| `~/dev/muffin-agent` | none | reading own source → denied (18×) |

The recurring `outside the working directory` denials are the agent colliding
with this three-root layout, not a broken containment check. Resolving it means
choosing one of: unify the write/send roots, give the agent read-only access to
its own checkout, or teach the boundary in the tool descriptions. Each is a
policy/product decision for the owner, not a mechanical fix.
