# Alpha onboarding — 2026-09-12

Status: **execution plan + dated design evidence**, not runtime authority and not a second roadmap.

This document exists so the pre-25/09 onboarding work can survive chat/session boundaries. Product phase placement remains in `docs/ROADMAP.md`; current work remains observed Git/PR state + `docs/work/handoff.md`; security and runtime semantics remain in their existing authorities.

## Commissioned outcome

Before the source-public target of **2026-09-25**, the supported happy path should approach:

```text
one install command
→ Muffin understands the machine
→ one verified inference route exists
→ Muffin starts
→ Muffin configures Muffin with the owner
→ configuration is verified, not merely written
→ optional capabilities are proposed just in time
```

The user should configure **boundaries and consent**; Muffin should configure implementation details.

This is not the Public Alpha gate by itself. It is the installation/onboarding substrate needed for that gate.

## Measured current Muffin shape

### Already strong

- `install.sh` owns OS prerequisites, Node >=22, source checkout, build, launcher, `muffin init`, and supervised gateway installation.
- `muffin init` already probes the real sandbox path, detects an OpenAI-compatible local runtime, infers provider from key shape, chooses model families, writes secrets outside argv/env, creates Home/DB/Root of Trust, and is idempotent/resumable.
- the runtime already has durable turns with `runnable | running | waiting | interrupted | done`; `TurnLane` picks up interrupted rows after a process dies. This is the preferred continuity substrate for agent-led onboarding.
- model/provider, surface, search, gateway, secret and recovery operations already exist as explicit control-plane commands.

### Measured friction / mismatch

1. The documented `curl ... install.sh | sh` path is not actually interactive: the piped shell is not a TTY, so without `MUFFIN_API_KEY_FILE` the script installs the command, prints `muffin init`, and exits. The public promise says one command; the production path is currently two.
2. `install.sh` duplicates platform knowledge already owned by runtime probes. On macOS it currently suggests `brew install bubblewrap ...` even though the shipped sandbox mechanism is Seatbelt and Bubblewrap is Linux-only.
3. Fresh users are asked implementation questions (provider/model family/main/light model) before they have enough context to make good choices.
4. `init` finishes by telling the owner to run `muffin doctor`; configuration and observed working state are still separate moments.
5. optional capabilities are configured as commands/wizards rather than being proposed by the agent at the moment they are useful.
6. no first-run path yet lets the agent safely configure its own environment through typed setup capabilities.

## Current peer / platform evidence

### OpenClaw

Current OpenClaw onboarding establishes inference first, verifies the chosen route with a real completion, then starts the agent/gateway and lets later setup happen conversationally. Interrupted baseline setup resumes. This is useful prior art for the sequencing, not architecture authority.

Primary source: https://docs.openclaw.ai/start/onboarding-overview

### OpenRouter OAuth PKCE

OpenRouter supports OAuth PKCE for local-first/CLI apps and explicitly supports localhost callbacks on arbitrary ports. After authorization, the CLI exchanges the code for a user-controlled API key. Therefore Muffin can offer a no-copy/paste recommended auth path without a Muffin-operated credential proxy.

Primary source: https://openrouter.ai/docs/guides/overview/auth/oauth

### OpenRouter free router

`openrouter/free` is a real router, not a documentation alias. OpenRouter selects among available free models while filtering for request requirements such as tool calling, image input and structured output. It is not quality-stable enough to be the universal recommended production route, but it is a first-class zero-cost onboarding choice and must not be forgotten.

Primary source: https://openrouter.ai/openrouter/free/

### Telegram Managed Bots

Telegram Managed Bots are fully owned by the user who creates them. The owner can still manage them through BotFather like any owned bot; the designated manager bot can additionally obtain/rotate the managed bot token and edit access settings. The manager therefore can be a **provisioning plane**, while the resulting Muffin instance uses the managed bot token directly from the owner's Home. Runtime traffic does not need to traverse a Muffin/Centria server.

Primary sources:
- https://core.telegram.org/api/bots/managed-bots
- https://core.telegram.org/method/bots.exportBotToken
- https://core.telegram.org/bots/api

## Product decisions frozen for this initiative

### 1. Bootstrap, setup and personal onboarding are three layers

**Bootstrap** is deterministic machine work: install runtime, command, prerequisites and create the minimum Home needed to start.

**Setup** is agent-led reconciliation of the installation: inspect real state, propose actions, apply typed/idempotent operations, verify outcomes.

**Personal onboarding** is a small identity seed plus progressive learning during real work. It must not become a SaaS profile questionnaire.

### 2. Do not persist a lying setup checklist

Technical setup state should be derived from real facts whenever possible:

```text
provider authenticated?
inference verified?
sandbox really contains?
gateway running?
restart survived?
workspace writable under the intended scope?
surface connected?
backup/restore proof present?
```

Persist only what cannot be re-derived safely:

- owner choices / consent;
- explicit defer/decline choices that should not be nagged again immediately;
- minimal owner identity seed;
- normal durable conversation/turn state;
- durable effect/intent records already required by the runtime.

This makes restart recovery a reconciliation problem rather than a wizard-state migration problem.

### 3. Muffin configures Muffin through typed setup capabilities, not unrestricted shell

Candidate temporary/owner-only capability family:

```text
setup.inspect
setup.inference_connect
setup.gateway_apply
setup.workspace_apply
setup.surface_connect
setup.search_connect
setup.verify
setup.finish
```

Names are provisional. The invariant is not: the model may decide **what** setup action is useful; deterministic code owns **how** it is applied and verified.

No setup capability silently widens authority. Filesystem/network/surface/account boundaries still require owner consent through the normal policy/effect model.

### 4. Restart continuity uses the normal durable-turn model

Do not invent an onboarding execution engine.

A setup turn is a real durable owner turn. If the process dies unexpectedly, the existing `interrupted` recovery path is the substrate.

For a **deliberate gateway restart**, do not execute `restart` in the middle of an uncheckpointed tool call. The desired shape is two-phase:

```text
agent decides restart is required
→ durable intent / setup fact is recorded
→ current turn checkpoints or suspends at a known boundary
→ control plane performs restart outside the uncertain model/tool call
→ new gateway observes the outstanding setup work
→ turn/work resumes and re-inspects real state
→ verification proves the restarted gateway is healthy
```

Exact wiring requires a CRITICAL design slice because it touches crash recovery/effect semantics.

### 5. Minimum personal seed before the first open-ended conversation

Muffin should not begin with an empty model of the owner, but it also should not run an interview.

Required first-run seed:

1. **How should I call you?** — preferred name/address form; this is owner identity, not an inferred fact.
2. **Language** — infer from the interaction/locale when reliable; ask only if ambiguous.
3. **One optional open field:** “Is there anything I should know immediately before we start?” — skippable.

Machine timezone/locale/device facts are inspected rather than asked.

Everything else — work, projects, habits, preferences, relationships, workflows — should be learned during real tasks and promoted through the normal memory/person-model rules.

### 6. Model UX uses stable product presets; technical users still see the family

The happy path should not expose `main` and `light` as decisions.

Candidate owner-facing choices:

```text
Recommended (Qwen)
Best quality (Anthropic)
Free (OpenRouter/free)
Local (<detected family/model>)
Advanced
```

The exact model IDs remain model-catalog/runtime data and may change without rewriting onboarding prose. `Advanced` exposes current provider/main/light controls.

`openrouter/free` is a first-class onboarding choice. It must be verified with Muffin's actual required capability set before being called working; routing can select different underlying free models across calls.

### 7. Recommended auth is OpenRouter OAuth, not API-key copy/paste

Desktop/local happy path:

```text
OpenRouter recommended
→ bind temporary localhost callback on an arbitrary free port
→ generate PKCE S256 verifier/challenge + state
→ open browser
→ owner authorizes
→ callback returns code
→ exchange code directly with OpenRouter
→ write resulting key into Muffin's persistent secret backend
→ immediately run a real inference/tool-capability probe
```

Fallbacks remain:

- pasted API key through the existing masked stdin path;
- local runtime if detected;
- explicit provider/advanced setup.

The OAuth key never enters model context, argv, generic environment, DB, logs or Git.

### 8. Configured != working

Onboarding completion is based on observed checks, not the existence of config files.

Candidate verification matrix:

```text
model request / real completion
streaming path (where supported)
tool call / structured tool request
sandbox containment
memory write → recall roundtrip
gateway start
controlled gateway restart → healthy recovery
surface roundtrip (only for configured surfaces)
scheduler wake-up (once background service is enabled)
backup creation; restore proof when required by Alpha gate
```

A failed optional check is reported and can defer the optional capability; it does not automatically block the first useful conversation.

### 9. Progressive proposals replace pre-configuration

After the minimum setup, Muffin proposes capabilities when context makes them useful:

- owner asks for web work → offer search setup;
- owner asks for mobile/async contact → offer Telegram;
- owner repeatedly works in a directory → offer to adopt/authorize a workspace;
- owner asks for a reminder → ensure gateway/scheduler are working;
- a local runtime appears later → offer a provider/model change, not an unsolicited migration.

A declined optional proposal is remembered long enough not to nag; this is an owner preference, not technical state.

### 10. Telegram managed provisioning is optional and sovereign

Recommended future path:

```text
Muffin proposes Telegram
→ manager bot requests creation of a managed bot (or deep link)
→ user chooses name/username in Telegram
→ manager receives managed-bot update
→ manager fetches the managed bot token
→ token is handed once to the owner's Muffin setup channel
→ Muffin stores token locally
→ access is restricted to owner by default where the Telegram API supports it
→ Muffin talks to Telegram directly with that bot token
```

Manual BotFather/token setup remains available and must not be second-class for sovereignty/recovery.

Open decision before implementation: the secure one-time token handoff from manager bot to the local Muffin instance. Runtime user messages must never be proxied through the manager service merely because provisioning used it.

## Challenge table

| Problem | Candidate A | Candidate B | Candidate C | Decision |
|---|---|---|---|---|
| setup progression | explicit wizard state machine | derive real state + persist only owner choices | no setup persistence at all | **B** |
| self-configuration | model gets shell | typed setup capabilities | keep all manual CLI setup | **typed capabilities** |
| inference auth | copy/paste API key | OpenRouter OAuth PKCE | Muffin-hosted auth proxy | **OAuth PKCE + existing key fallback** |
| model choice | provider/main/light wizard | product presets with family labels | no choice | **presets + Advanced** |
| restart | tool calls `systemctl restart` mid-turn | two-phase durable checkpoint then restart | never restart during setup | **two-phase** |
| first personal context | full questionnaire | minimal identity seed | zero questions | **minimal seed** |
| optional integrations | configure everything first | just-in-time proposals | docs only | **just in time** |
| Telegram creation | BotFather only | Managed Bot provisioning + manual fallback | project-hosted shared bot/runtime | **Managed + manual** |

## Execution plan before 2026-09-25

The initiative is intentionally split into narrow slices. Do not stack them deeply: integrate a prerequisite into `dev`, then branch the dependent slice from fresh `dev`.

### S0 — plan/research persistence

Profile: **FAST**.

Claim: another worker can reconstruct the intended Alpha onboarding and its decision forks without this chat.

Evidence: this document + authoritative-roadmap/handoff pointers only; no runtime behaviour.

### S1 — honest one-command bootstrap

Profile: **STANDARD**; sandbox-remedy edits become CRITICAL only if containment semantics change (they should not).

Claim: the documented install command reaches interactive first-run on a real terminal instead of stopping at “run `muffin init`”, and platform-specific dependency advice matches the actual sandbox implementation.

Required:

- preserve a real controlling terminal for onboarding when invoked through `curl | sh`;
- do not weaken secret handling;
- remove Linux-only Bubblewrap advice from macOS path;
- installer hands directly into first-run/onboarding;
- clean-install acceptance catches the pipe/TTY production path.

### S2 — inference-first UX + `openrouter/free`

Profile: **STANDARD**.

Claim: a fresh owner can get to a **verified working inference route** without understanding provider/main/light implementation details.

Required:

- stable preset labels with family in parentheses;
- `Free (OpenRouter/free)` included;
- `Advanced` preserves full provider/model controls;
- real completion/tool compatibility check before the route is called working;
- exact model IDs remain centralized runtime/catalog data.

### S3 — OpenRouter OAuth PKCE

Profile: **CRITICAL** because it handles a newly issued secret and outward auth protocol.

Claim: the recommended local install can authorize OpenRouter without copying an API key and without a Muffin-operated credential proxy.

Required:

- PKCE S256 + random state;
- localhost/127.0.0.1 arbitrary port callback;
- bounded timeout/cancel path;
- direct code exchange;
- persistent secret backend only;
- no token/key in logs, argv, generic env, DB or model context;
- manual-key fallback remains.

### S4 — setup inspection + typed action substrate

Profile: **CRITICAL** where actions touch authority/effects; individual pure inspection code may be STANDARD.

Claim: Muffin can inspect its own installation and apply a bounded set of idempotent setup changes through typed capabilities, with owner authority separate from model judgement.

Start smaller than the full list:

1. `setup.inspect` — pure facts;
2. gateway install/enable action;
3. workspace action;
4. verification action.

Surface/search actions can reuse the same shape afterward.

### S5 — restart-safe onboarding

Profile: **CRITICAL**.

Claim: an onboarding turn can request a gateway-changing action, cross the restart, and continue exactly once from durable state without duplicating setup effects or losing owner context.

Use existing TurnStore/TurnLane recovery. Add new durable state only if the existing turn/effect records cannot express the boundary after a concrete prototype demonstrates the gap.

### S6 — personal identity seed + handoff into normal conversation

Profile: **STANDARD**, escalating if it changes canonical identity/memory semantics.

Claim: before the first open-ended task, Muffin knows the owner's preferred name and any explicitly provided immediate context, without creating a questionnaire or bypassing canonical memory provenance.

### S7 — dynamic capability proposals

Profile: **STANDARD** per capability; CRITICAL when a proposal widens authority/network/secret boundaries.

Claim: an unavailable optional capability is offered at the moment it becomes relevant, and setup can complete without sending the owner to docs/manual config.

### S8 — Telegram Managed Bot provisioning

Profile: **CRITICAL** because it crosses account authority + secret handoff.

Claim: a user can create their own Telegram bot with low friction, the user remains owner, the local Muffin instance receives the bot credential securely, and normal runtime traffic is direct between Muffin and Telegram.

This slice waits for a separate decision on the one-time token handoff protocol. The manual BotFather path stays supported throughout.

### S9 — configured-vs-working acceptance journey

Profile: **STANDARD/CRITICAL by checks exercised**.

Claim: a clean machine journey proves the supported Alpha onboarding outcome rather than merely asserting that files were written.

At minimum measure:

- one manual install command;
- zero required config-file edits;
- zero required technical questions on the recommended route;
- no more than two owner decisions before first useful chat;
- interrupted setup is resumable;
- inference and core tool path are observed working;
- gateway/background path is observed working when enabled.

## Ordering

```text
S0
↓
S1 ──→ S2 ──→ S3
          ↓
          S4 ──→ S5 ──→ S6 ──→ S7
                              ↓
                              S8

S9 grows with each integrated slice and becomes the final pre-Alpha journey.
```

S1/S2 are the minimum source-public UX target. S3–S7 are the desired pre-25/09 Alpha-onboarding substrate; if schedule pressure appears, do not trade away secret/restart safety for a cosmetic “agent-led” demo.

## Falsifiers / kill criteria

Reverse or simplify the design if any of these become true:

- deriving setup state from reality repeatedly costs more complexity or latency than a tiny explicit state record, and a measured failure demonstrates it;
- durable turns cannot safely cross a deliberate gateway restart without a second persistent orchestration primitive;
- `openrouter/free` fails Muffin's minimum required tool/capability probe often enough that presenting it as a first-class “working” choice is misleading;
- OAuth PKCE requires a project-hosted credential component for the supported platform (current OpenRouter docs say it does not);
- Managed Bot token handoff cannot be designed without routing normal user traffic or retaining user bot credentials centrally;
- agent-led setup needs unrestricted shell to remain useful — that means the setup capability boundary is wrong and must be redesigned, not widened silently.

## Definition of completion for this initiative

The initiative is complete when a supported clean machine can reach a first useful normal Muffin conversation through the recommended path with:

- one install command;
- verified inference;
- no mandatory config editing;
- minimal identity seed;
- setup facts inspected by Muffin;
- optional changes proposed conversationally;
- any gateway restart/recovery proven through durable state;
- failures reported as facts with actionable recovery;
- secrets and authority boundaries no weaker than before onboarding existed.
