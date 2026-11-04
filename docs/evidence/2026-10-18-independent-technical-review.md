# Independent Technical and Strategic Review — muffin-agent

Date: 2026-10-18
Subject repository: `muffin-project/muffin-agent` at HEAD `dae23668` (branch `docs/persona-no-worker`, working tree clean)
Reviewer stance: independent; no incentive to preserve existing work.

> Status of this document: dated evidence, not current authority. It is an
> external review snapshot, recorded so nothing is lost. It does not override
> `docs/architecture/`, ADRs, or executable code. A material decision taken from
> it belongs in an ADR or the relevant authoritative home.

## Scope actually inspected

- Source, ADRs, acceptance manifests, CI workflows, Git/GitHub history.
- Ran `tsc --noEmit` (clean) and `vitest run` (5,558 passed, 1 failed, 7 skipped).
- Did NOT run the acceptance suite locally (spawns real CLI processes; the local
  run exceeded 120 s and was stopped), did NOT run a real provider, did NOT
  execute security exploits.
- SOTA from live web search; OpenClaw and Hermes independently corroborated;
  Letta/LangGraph from a delegated research pass (`[trace]`).

---

## 1. Executive verdict

Muffin is a serious, unusually disciplined system built at the wrong altitude
for its maturity. The engineering process is among the best-documented: 101 ADRs,
an evidence layer, a mutation-tested acceptance suite on the real binary, and a
`docs/evidence/lessons.md` that records what broke while reporting success. Its
central bet is validated by the 2026 security literature: deterministic
enforcement at the tool boundary, provenance-typed memory, and continuity that
survives harness replacement.

But the product ship date has been repeatedly outrun by architectural ambition.
In 75 days: 2,655 commits, 96.7k lines of source, 119.8k lines of tests, 74 open
issues, 6 open PRs, and a 72-row DAY-1 ledger that is nearly closed but whose own
stop-rule ("14 days of real use") has not been met.

Strongest reasons to continue: the differentiator (owner-run continuity + a pure
policy kernel over typed authority) is the one thing no close peer ships, and the
security field has independently converged on it. The runtime genuinely works.

Strongest reasons to change course: (a) the one experiment that matters — daily
use — has not been done, while breadth is being added; (b) the documented
"convergence rule" is falsified by its own code; (c) the self-measured taint
corpus shows the approval-based defense fails exactly when the owner is
compliant.

Recommendation: continue the current architecture, insert a subtraction
milestone before any breadth work, then stop building and dogfood. Do not fork
OpenClaw. Do not adopt a durable-execution framework yet.

---

## 2. Ground-truth audit

### 2.1 Works (verified on the production path)

| Capability | Evidence |
|---|---|
| Turn durability: crash mid-turn -> `interrupted`, resume from row incl. persisted taint | `core/turns/store.ts`, `core/turns/lane.ts`, `agent/loop/durability.ts`; `B5` scenario |
| Exactly-once scheduled occurrences | `core/scheduler/job-fires.ts` |
| Sandboxed shell, fail-closed | `core/sandbox/executor.ts`, `shell-boundary.ts`, `read-scope.ts` |
| Pure deterministic policy kernel, sealed literals | `core/policy/decide.ts`, `matrix.ts`, `defaults/rot/policy.json` |
| Secret boundary enforced structurally | `core/config/secret-boundary.ts` |
| Memory: one `addFact` writer, scheduled consolidation, tainted pre-turn recall | `core/memory/ingest.ts`, `consolidator.ts`, `recall.ts` |
| Minimal provider interface | `agent/providers/types.ts`, `configured.ts` |
| Telegram streaming edits, part-based delivery | `connectors/telegram/transcript.ts`, `delivery.ts` |

`tsc --noEmit` clean. Unit suite: 5,558 passed, 1 failed, 7 skipped (425 files).
The failure is a wall-clock assertion (`core/judgment/shadow.test.ts:80` expects a
fire-and-forget call under 50 ms; measured 80 ms under parallel load; passes 3/3
in isolation). Flaky timing test, not a functional defect.

### 2.2 Incomplete or unverified

- No real-VPS proof: ledger row `A11` is the only non-READY row (`? PARZIALE`).
- macOS/launchd proven only by `plutil -lint` on scratch input.
- The 14-day dogfood has not run.
- Acceptance suite not run in this review (CI does gate on it).

### 2.3 Dead / not-on-the-production-path mechanisms

1. `core/config/openrouter-oauth.ts` (237 LOC) — imported only by its own test.
2. `core/memory/ingest.ts:997 reconcilePendingProposals` — no production caller;
   docstring claims a boot drain that is not built.
3. `core/vault/watcher.ts` — called only from an acceptance test;
   `MUFFIN_VAULT_WATCH` is dead config.
4. `core/automation/rules.ts AutomationRuleStore` — no production reader; ingress
   builds `WorkDeps` without it.
5. `core/scheduler/observe.ts` / `proactivity.ts` — only via manual `muffin observe`.
6. `core/skills/skills.ts` `allowed-tools` — declared, not enforced.

### 2.4 Unnecessary complexity

- The convergence rule (`ARCHITECTURE.md:472`) is falsified: adding one built-in
  tool needs up to six coordinated edits (`agent/tools/<name>.ts`, the `tools`
  literal `agent/runtime.ts:795`, the `capabilities` Map `:1026`,
  `baseToolOrder()` `:332`, `DEFAULT_CORE_TOOL_NAMES`
  `agent/capability-exposure.ts:21`, `maxToolsExposed` in `agent/profiles/*.json`).
  MCP already registers in one call (`agent/runtime.ts:1504-1507`).
  `consumer-local.json` notes record 10->14->15->16->18->19->21->22->23.
- Six concepts for "who owns this": gateway claim (`core/gateway/lock.ts`),
  incarnation (`core/lock/incarnation.ts`), execution owner (`ownership.ts`),
  turn claim (`core/turns/store.ts`), in-process `ModelLane` token,
  `ForegroundGate`/`StandDown`.
- Duplicated code: two reconciliation paths in `ingest.ts`; sleep guard misses
  four inline `setTimeout` copies (`core/gateway/service.ts:215`,
  `connectors/discord/gateway.ts:229`, `cli/update.ts:803`, `testStall` x2);
  `mapStopReason`/`providerErrorFromWire` duplicated across `anthropic.ts` and
  `openai-compat.ts`; near-identical `Scheduler` assembly in `cli/gateway.ts:956`
  and `cli/repl.ts:916`; `cli/model.ts` (1,079 LOC) hand-rolls argument parsing.
- Prose-to-logic ratio: `consolidator.ts` 799 LOC, `ingest.ts` 1,221,
  `recall.ts` 1,150, `connectors/telegram/connector.ts` 3,171.
- Test surface larger than source: 119.8k test LOC vs 96.7k source LOC.

### 2.5 Ambitions without demonstrated product value (yet)

Nodes (ADR-0050), Workers/execution placement, the extension package/capability/
grant system, multi-Home/Capsule, and System One/Jev shadow judging (ADR-0096:
2,198 LOC in `core/judgment/*`, off by default, no consuming path by
construction). Concept-drift risk: "Worker" means execution placement in
`ARCHITECTURE.md`, while `ROADMAP.md` states there is no worker/subagent plane by
decision (ADR-0045); the branch under review is `docs/persona-no-worker`.

---

## 3. SOTA comparison (2026-10-18)

Independently corroborated: OpenClaw (`github.com/openclaw/openclaw`, MIT,
TypeScript/Node 22-24, ~390k stars, owner-run, gateway daemon, 25+ channels incl.
Telegram); Hermes Agent (Nous Research, MIT, Python, ~250k stars). `[trace]` from
the delegated pass: Letta MemFS (git-backed memory filesystem, "dreaming"; shared
memory repos are a Letta-cloud coupling), LangGraph checkpointing, mem0,
Zep/Graphiti, and 2026 agent-security papers (ClawGuard `arXiv:2604.11790`;
"Indirect Prompt Injections: Are Firewalls All You Need" `arXiv:2510.05244v2`;
AgentDojo `arXiv:2406.13352`; MINJA `arXiv:2503.03704`).

Decisive finding: the 2026 security literature converges from content classifiers
toward deterministic, out-of-band enforcement at the tool-call boundary — exactly
`core/policy/decide.ts` + effect rows + sealed `rot/policy.json`. OpenClaw still
ships sandboxing off by default and a tool allow/deny + `tools.elevated` escape,
not a typed decision kernel.

Closest match: OpenClaw. Do not fork it: you would inherit its allow/deny security
model and rewrite the 10% you bet on; 390k stars / tens of thousands of commits is
unmaintainable for a one-owner product; adopting a platform abandons the moat.

Reusable: MCP as the tool-extension standard (already used); OpenClaw's memory
tier design as reference; Letta MemFS if inspectability becomes a need;
DBOS/Temporal/Restate/LangGraph-checkpointer semantics only as a fallback.

---

## 4. Architecture decision

Recommended: continue (Option A), with a mandatory subtraction milestone and a
scope freeze until dogfood completes.

| Alternative | Migration cost | Maintenance | Operational risk | Lock-in | Time to usable | Verdict |
|---|---|---|---|---|---|---|
| A. Evolve + subtract | none | reducible | low | none | shortest | Recommended |
| B. Minimal core + existing components | medium-high | lower long-term | medium | medium | longer | Partial — adopt selectively |
| C. Fork OpenClaw | high | high | high | high | long | Reject |

Retain: policy kernel + effect rows + sealed RoT; evidence/beliefs split with one
reconciliation path; effect WAL and turn durability; ingress->compose->Work waist;
acceptance/mutation-test harness; "model proposes, kernel decides".

Simplify: converge tool registration to one call; collapse the six ownership
concepts to two documented levels; delete the duplicated reconciliation path;
auto-derive `maxToolsExposed`; dedupe sleep, provider error mapping,
cross-connector helpers, Scheduler assembly.

Remove: dead mechanisms in 2.3 (wire or delete).

Replace: nothing load-bearing. Consider replacing hand-rolled `cli/model.ts`
parsing with `parseArgs`.

Defer: Nodes/Node protocol, Worker/subagent plane, extension package system,
Discord return, proactive triggers beyond `commitment_due`, System One
consumption, multi-Home/Capsule, Docker productization, Python compute workers.

Do not build now: general plugin framework, compute scheduler, event log,
provider-native commodity tool adapters (#856), browser automation in core
(#853), programmatic tool composition (#855).

---

## 5. Evaluation plan

Keep and extend the existing harness (34 acceptance scenarios on the real binary,
mutation-tested, cross-referenced by `evals/acceptance/manifest.ts` + `report.ts`).
The gap is product-level measurement.

Baseline: HEAD `dae23668`, one owner, one provider lane. Variants: no-memory,
no-scheduler, reranker off, consolidation off, fixed tool cap vs tool-search,
shadow judge on/off.

Metrics per completed task: verified completion rate; silent failures and
unintended effects; human interventions; duplicate/incorrect actions; p50/p95
latency and recovery time; tokens and USD per successfully completed task;
security failures. Primary gate: cost per completed task and interventions per
completed task.

Ablations: taint ceiling A-vs-B (done; B lost 0/7); reranker on/off;
consolidation on/off; shadow judge on/off; fixed cap vs tool search.

---

## 6. Security findings

No deployment blocker found. Sandbox fail-closed, secret boundary structural,
identity fail-closed (`core/surface/types.ts:540`).

Mitigate before public/internet exposure:
1. Streaming renders unscrubbed deltas (`agent/loop/round.ts:1138-1174`).
2. Search is an exfiltration channel at taint 3 (ADR-0072); hard-floor
   `paramsMaxTaint <= 1`.

Known/accepted: approval-based defense fails under owner compliance (corpus 4/7
unattended, 6/7 with owner as they actually answered; the one stop was a code
floor, not policy); MCP server = trusted computing base until process containment
(`SECURITY.md` §10); single-user RoT detects, does not prevent (B15 reservation);
open sandbox residuals (hardlink inode alias; mid-command git-hook symlink #865);
dead `MUFFIN_VAULT_WATCH`; unenforced `skill.allowed-tools`.

Supply chain: `@anthropic-ai/sandbox-runtime` pinned exactly (ADR-0026) but moving
fast (0.0.71->0.0.80 in this diff); `core/sandbox/read-scope.ts:17` still says
"srt 0.0.71" while `package.json` pins 0.0.80.

---

## 7. Prioritized execution plan

Non-goals for all: no new channels, no Nodes/Workers, no extension framework, no
new cognitive mechanism.

- M0 — Freeze new breadth (immediate, 0 cost).
- M1 — Subtraction pass (short, low risk): one-call tool registration; delete/wire
  the four dead mechanisms; collapse ownership vocabulary; dedupe. Falsifier: if
  convergence cannot make "add a tool" one edit without behaviour change, the
  complexity is structural and Option B becomes honest.
- M2 — Prove the owner loop on a real host: close `A11`; run acceptance + e2e
  Telegram on the real host.
- M3 — 14-day dogfood with the §5 metrics. Stopping condition: if real tasks still
  need another agent and the failure is not one fixable primitive, the thesis is
  falsified and Options B/C return.
- M4 — Security floors + honesty cleanup (overlap M2): delta scrub; hard-floor
  `paramsMaxTaint`; resolve vault-watcher and skill `allowed-tools`; fix the srt
  version comment; decide on ADR-0075.
- M5 — Extend evaluation with product metrics and ablations.
- M6 (evidence-gated) — after M3, the top observed fallback becomes the next
  capability.

---

## 8. Decision register

| # | Unknown / assumption | Experiment |
|---|---|---|
| 1 | Is continuity+authority the moat? | M3 dogfood: does the owner stop using other agents/apps? |
| 2 | Does breadth hurt tool selection at N tools? | fixed cap vs tool search; wrong-tool rate |
| 3 | Does consolidation improve task success? | consolidation on/off |
| 4 | Does the shadow judge ever change a decision? | calibration report; else remove 2.2k LOC |
| 5 | Is asking for `sys.shell` every time sustainable? | measure ask-approval rate during dogfood |
| 6 | Does the bespoke lane/job-fires scale? | dogfood; adopt DBOS/Restate only on concrete failure |
| 7 | Does macOS/launchd work end-to-end? | M2 on the real Mac, reboot included |
| 8 | Can a fresh VPS install be clean? (`A11`) | M2 |
| 9 | Are the six ownership concepts all necessary? | M1 collapse attempt |

---

## 9. Sources

- Repo: `docs/architecture/ARCHITECTURE.md`, `SECURITY.md`;
  `docs/status/day1/requirements-status.md`, `critical-path.md`;
  `docs/product/THESIS.md`, `VISION.md`, `ROADMAP.md`;
  `docs/evidence/lessons.md`, `eval-taint-corpus-avversariale-2026-09-03.md`;
  `docs/decisions/0045,0048,0050,0051,0072,0073,0074,0075,0091,0095,0096`;
  `evals/acceptance/manifest.ts`; `.github/workflows/ci.yml`;
  `agent/runtime.ts`, `agent/loop/*`, `core/policy/*`, `core/sandbox/*`,
  `core/memory/*`, `core/gateway/*`, `core/scheduler/*`.
- SOTA (web, 2026-10-18): OpenClaw, Hermes Agent, Letta, LangGraph, mem0,
  Zep/Graphiti (partly `[trace]`).
- Research: ClawGuard `arXiv:2604.11790`; `arXiv:2510.05244v2`;
  `arXiv:2406.13352`; `arXiv:2503.03704`; `arXiv:2410.10813`; `arXiv:2504.13171`.

Limitations: acceptance suite, real-provider paths and security exploits were not
executed here; SOTA items without independent corroboration are marked `[trace]`;
delegated line references were not all re-opened by the reviewer.
