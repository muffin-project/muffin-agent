# Public Alpha readiness criteria

This document owns one question only:

> **When may Muffin be called a product Public Alpha rather than source-public/pre-alpha?**

It does not own source-public publication safety, DAY-1 status, roadmap placement or implementation ordering.

- Source-public/pre-alpha safety and community strategy: `docs/project/OPEN-SOURCE-STRATEGY.md`.
- DAY-1 readiness: `docs/status/day1/readiness-criteria.md`.
- Deferred capability placement: `docs/product/ROADMAP.md`.
- Current implementation/status: observed Git/GitHub state.

## Milestone separation

The repository becoming public is not this gate.

```text
source-public / pre-alpha
→ DAY-1 READY
→ 14-day owner dogfood
→ trusted alpha with deliberately different users
→ PUBLIC ALPHA
```

Source-public means people may inspect, run and contribute to unfinished software. Public Alpha means Muffin has enough product integrity that a non-founder can reasonably install and use it while accepting clearly stated alpha limitations.

The terminal question is:

> **If a person who did not build Muffin installs it today, what already-knowable problem will force them to call the founder, lose continuity, or abandon Muffin for normal work?**

A known answer that is central to the supported product path is a blocker until fixed, explicitly removed from the supported path, or deliberately accepted as a clearly bounded Alpha limitation.

## Gate A — Installable without founder knowledge

A supported clean machine must reach the first useful normal Muffin conversation without manual repository archaeology or founder intervention.

Required evidence:

- one documented supported install entry point;
- no mandatory config-file editing on the recommended path;
- no mandatory understanding of Node/npm/SQLite/PATH/launchd/systemd;
- provider/inference authorization has a low-friction recommended path;
- OAuth/browser authorization is preferred whenever the provider offers a suitable delegated flow; manual API keys remain fallback;
- model choices are presented as product-level presets with enough family information for technical users, not `main`/`light` plumbing;
- `openrouter/free` is available as a first-class zero-cost route when its real capability probe passes;
- interrupted bootstrap/setup is resumable or safely re-runnable;
- a failed step names the observed failure and an actionable recovery path.

Target UX metrics for the recommended local path:

- manual install commands: **1**;
- mandatory config edits: **0**;
- mandatory copied API keys when supported OAuth exists: **0**;
- mandatory technical questions before first useful chat: **0**;
- owner decisions before first useful chat: **<= 2**, excluding an account-provider's own login/consent screen.

## Gate B — Configured means observed working

Muffin must not declare setup success because files were written.

For every capability required by the supported Alpha path, onboarding/doctor/acceptance must exercise the production mechanism closely enough to catch a broken configuration.

Minimum journey includes, where applicable:

- real inference request;
- tool/structured call compatibility on the selected model route;
- sandbox containment through the real runtime mechanism;
- gateway/service start;
- controlled gateway restart and healthy return;
- memory write → later retrieval roundtrip;
- surface roundtrip for each surface called supported by the Alpha path;
- scheduler wake-up when background scheduling is part of the supported path;
- update/rollback/restore checks described by the relevant gates below.

Optional capability failure may defer that capability; it must not be relabelled as working.

## Gate C — One continuous Muffin survives ordinary boundaries

Restarting a process, opening a new session, changing a supported surface or changing a supported model/provider must not silently create a different logical agent.

Required:

- canonical owner conversation/session semantics remain coherent across supported surfaces;
- durable turns/work survive ordinary process death according to their declared semantics;
- unfinished work/waits/approvals do not disappear at gateway restart;
- deliberate self-restart during setup/work checkpoints before process replacement and resumes from durable state;
- model/provider switching does not fork identity, memory or canonical work state;
- recovery re-observes real state rather than trusting a persisted “setup done” flag.

The exact model is replaceable compute. Muffin's continuity is not.

## Gate D — Memory has a usable owner loop

Public Alpha does not require sophisticated cognition, ontology or perfect recall. It does require that the core memory contract is usable and correct enough for an owner to trust it during normal work.

Required journey:

```text
experience/fact arrives
→ canonical write/reconciliation
→ later recall/use
→ owner correction/supersession
→ owner forget/retire
→ provenance explains why the current belief exists
```

Required evidence:

- recall-quality measurement exists and can get worse visibly;
- corrections do not leave two equally-live contradictory truths without surfacing the conflict;
- forget/retire uses the canonical semantic writer and does not rely on ad-hoc DB/shell edits;
- no known resurrection path bypasses the declared forgetting semantics on the supported journey;
- memory provenance remains inspectable.

New cognitive machinery is not an Alpha blocker unless observed dogfood/trusted-alpha evidence demonstrates that its absence breaks normal use.

## Gate E — Work persists beyond a chat turn

Muffin's promise is not fulfilled if commitments disappear when the response ends.

Required:

- pending/waiting/interrupted work is durable;
- due work is re-evaluated after restart;
- background ownership has a clear liveness mechanism rather than relying on the next user message;
- completed, failed and uncertain outcomes are distinguishable;
- irreversible/non-rerunnable effects do not get duplicated merely because recovery could not observe the first outcome;
- the owner can inspect what Muffin believes it is still doing/waiting for.

A feature-rich chat loop with forgotten commitments is not Public Alpha.

## Gate F — It can act without silently widening authority

Alpha can have limitations. It cannot have an authority model that depends on the user trusting model judgement where deterministic boundaries are already known.

Required:

- Root of Trust / sealed boundaries remain outside model self-authority;
- secrets stay outside model context and ordinary traces;
- setup follows: **the owner configures boundaries; Muffin configures details**;
- model-executable setup actions are named, schema-bounded, host-scoped and cannot become generic config/shell authority;
- account authorization, filesystem-scope grants, sealed egress expansion and equivalent boundary changes are explicit owner actions;
- no double-consent UX where prose “yes” is followed immediately by a second indistinguishable approval;
- privacy/egress behaviour is understandable enough that a normal technical Alpha user can tell what leaves the machine;
- no ignored known Critical/High issue on the supported Alpha path.

Known unsupported authority surfaces should be absent or clearly unavailable, not half-enabled.

## Gate G — Continuity can be recovered, moved and updated

An owner must not accumulate valuable personal continuity that only survives while one installation and one disk remain healthy.

Public Alpha requires a minimal proven continuity-preservation story, not necessarily the final Capsule design.

Required:

- backup can be created and its scope is documented;
- restore is exercised on a fresh/isolated Home and yields usable canonical continuity;
- derived state may be rebuilt rather than treated as sacred bytes;
- update is transactional/atomic enough to avoid destroying the previous usable runtime;
- rollback is exercised;
- one Home can be moved/recovered without silently changing owner identity or losing canonical memory/work semantics;
- secrets/authority material have explicit handling during backup/migration rather than accidental copying.

Full active-active replication, appliance migration and a polished “Capsule” product are not required for Alpha.

## Gate H — Replaceable compute is true in production

The product must demonstrate that model/provider choice is compute underneath one agent, not an architectural fork.

Required:

- one recommended inference route is reliable enough for Alpha;
- at least one real supported provider/model change is exercised after the agent has accumulated state;
- state/config/memory/work survive that change;
- requested model/router, resolved model and billing identity are not silently conflated;
- routing/cost/reasoning capability truth is inspectable;
- a free/dynamic router is not treated as quality-stable merely because it is convenient for onboarding.

Perfect local inference is not required. Local compute remains an important supported direction, not an Alpha blocker by itself.

## Gate I — Proven outside the founder lab

A unit/integration suite is necessary and insufficient for a personal agent.

Before Public Alpha:

1. owner reaches DAY-1 READY;
2. owner completes the 14-day observation-first dogfood window;
3. 2–5 deliberately different trusted-alpha users exercise the supported install/use/update/recovery journey;
4. at least one trusted-alpha user is not contributing code and does not have founder context;
5. failures requiring founder intervention are recorded and classified rather than silently coached through.

Useful diversity includes macOS, Linux/VPS, a technical non-contributor, a less-technical user, and security/open-source instincts where possible. Exact people are not architecture; different failure surfaces are.

The gate is not “zero bugs”. It is that the supported journey no longer relies on hidden founder knowledge.

## Deployment contract — unresolved gate fork

Public Alpha must name one recommended deployment topology. This decision changes scope materially.

### Candidate L — local Home first

```text
Muffin Home + runtime live on the machine where normal work happens
```

If this is the Alpha golden path, a remote Mac capability Node is **not** an Alpha blocker. Nodes can mature during Alpha/trusted expansion.

### Candidate V — always-on remote Home first

```text
Home/runtime on owner's VPS or always-on host
+ normal daily work still expected on the owner's Mac
```

If this is the Alpha golden path, the first Mac capability Node becomes an Alpha requirement: otherwise the recommended deployment loses ordinary local capability as soon as Home moves remote.

Do not accidentally require both topologies at Public Alpha. Choose one golden path and label the other experimental/advanced until proven.

## Explicit non-blockers

The following do **not** enter Public Alpha merely because they are desirable:

- polished desktop GUI;
- wearable/pendant hardware;
- complete voice interface;
- mature Telegram group support;
- Discord/WhatsApp feature parity;
- marketplace/community extension catalog;
- native Windows support;
- perfect local inference;
- multi-user/team product;
- Gmail/Calendar/Health/history import breadth;
- advanced person ontology, salience/decay/reasoning research;
- self-improvement machinery;
- subagent swarm/parallel coding architecture;
- every open GitHub issue;
- final stable-release compatibility/support guarantees.

A non-blocker may be promoted only by observed evidence: if its absence makes the chosen supported Alpha journey fail, record the failure and promote the concrete requirement rather than the whole feature category.

## Exit verdict

Public Alpha is **GO** only when every gate above that applies to the chosen golden path has executable/current evidence and no central known blocker remains.

The final review asks the terminal question against a clean install and against trusted-alpha evidence:

> **What already-known problem would make this person call the founder, lose continuity, or abandon Muffin for normal work?**

If the answer is a supported-path property we already know how to reproduce, the verdict is NO until it is fixed, scoped out explicitly, or accepted as a bounded Alpha limitation with its cost understood.
