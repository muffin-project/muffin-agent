# Symphony / OpenCode compatibility pilot — 2026-10-04

Claim: the official Symphony reference can drive a bounded OpenCode worker in
its own issue clone without giving the worker the tracker credential, a second
scheduler or merge authority. Verification profile: CRITICAL (process and
credential boundary), requiring an independent JUDGE review on the candidate.

## Current and alternatives

Muffin `dev@3ea2fb9` retains its own runtime/program orchestration and
`main <- dev <- slice` integration. Existing `WORKFLOW.md` uses explicit
`agent:symphony`, concurrency 1 and an operator-provided Codex container. #754
records a completed Codex canary to #785, plus read-only OpenCode orientation;
that is not evidence that OpenCode implements app-server. No active PR owns
this bridge. Centria `main@ffc2ea9` is main-only; its canonical reserved-path
predicate, exact-head review attestation and GitHub ruleset remain authoritative.

| Candidate | Evidence | Counter-evidence / decision |
|---|---|---|
| Set `codex.command: opencode run` directly | OpenCode officially supports non-interactive run | Symphony requires app-server initialization, thread/turn replies and streamed lifecycle; JSON events are different. Rejected. |
| Use OpenCode ACP or HTTP directly | Official CLI documents ACP stdio and HTTP server/session endpoints | Reference Symphony does not consume ACP/HTTP. Changing the runner creates an upstream fork; repeated per-repo forks would duplicate commodity infrastructure. Rejected for this bounded pilot. |
| Keep Codex / remove OpenCode seam | Existing #754 canary proves a bounded Codex path | Does not satisfy the explicitly requested OpenCode execution. Remains fallback if compatibility stops buying evidence. |
| Adapt only the app-server subset, leave coordination upstream | Source pin has native GitHub labels, reconciliation, claims and workspace hooks | Must prove real handshake, actual OpenCode events, EOF cancellation, host-only credentials and publication restrictions. Chosen subject to these tests and review. |

The bridge implements only initialize/initialized, thread/start, one turn/start,
progress/failure/operator input and host dynamic `github_api` calls. MCP maps the
scoped GitHub tool and `publish_branch` into OpenCode. The host broker owns the privileged app-server stream; OpenCode runs in a separate
Docker process namespace with only its issue clone, read-only adapter/config/base
bundle and dedicated model-auth file mounted. Candidate Git commands run inside
that container; host Git uses a separate unmounted mirror. The
model receives canonical issue identity, owner, acceptance, current failure and
exact write-set, rather than a program prompt. No provider model/credential is
hardcoded; project/user plugin loading is disabled for isolation.

Hermes [CLI source](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/main.py)
and OpenClaw [automation documentation](https://docs.openclaw.ai/automation/cron-jobs)
provide prior art for bounded non-interactive execution and service-owned job
lifecycle. They do not establish compatibility with Symphony's protocol. No
Hermes/OpenClaw scheduler or session database is adopted.

## Primary sources and falsifiers

- [Symphony SPEC](https://github.com/openai/symphony/blob/be10a1b79df723d6d7612b5651c8522704dafb2e/SPEC.md): command must speak compatible app-server over stdio; tracker secrets should remain host-side.
- [Reference source/operations](https://github.com/openai/symphony/tree/be10a1b79df723d6d7612b5651c8522704dafb2e/elixir): GitHub adapter, labels on dispatch/continuation, retry, stop and terminal cleanup already exist.
- [OpenCode CLI](https://opencode.ai/docs/cli/), [server](https://opencode.ai/docs/server/), [permissions](https://opencode.ai/docs/permissions/): run JSON, explicit model and non-interactive permissions; neither HTTP nor ACP is Codex app-server.
- OpenCode 1.18.33 real binary in the local Docker worker image. Source inspection of `run` showed stdin is read to EOF. The real-binary fixture stalled when stdin inherited Symphony's stream; closing worker stdin fixed it. This is a measured compatibility finding, not inferred equivalence.

Executed locally: 114 official tracker/core/workspace tests passed; the added
official AppServer/Workspace fixture passed for both repo configs; 22 bridge
tests passed in the real OpenCode Docker image, including a real launcher/container/MCP localhost model
fixture with no external model call. Hosted CI and independent review must be
read on the eventual PR head; these local results do not authorize merge.

Limitations: one trusted host; opt-in ordinary exact-file scopes only; no
production deploy, reserved dispatch, auto-merge, autonomous program selection
or live-issue CI-repair claim. API-published remote SHAs are returned explicitly
and own CI evidence. The reference remains evaluation software; no general
production certification or availability guarantee is claimed. A real issue
pilot requires operator-provisioned scoped host and model credentials.

Kill criteria: if a material app-server change requires a widening shim, scope
or credential authority cannot be enforced, or repeated real failures require
a custom scheduler/work graph, remove the seam and use the proven Codex path.
No existing maintainer/delegation glue is removed until real accepted work and
recovery evidence demonstrate replacement of its specific consumer.

## Existing integrations audited after operator steering

- [OpenSymphony](https://github.com/Swiftyos/OpenSymphony/tree/8d101a06d995b555e0c23044e2b6d11c35fad942): existing OpenCode HTTP/SSE backend, but Linear-specific tracker/tooling and `SYMPHONY_LINEAR_API_KEY` passed to the worker (`open_code/app_server.ex:234`). Adoption also imports multi-project/backend/effort routing. Not the requested bounded GitHub reference seam.
- [symphony-linear](https://github.com/skorokithakis/symphony/tree/bc8456b73ac431ff796536c56350e4fb53f0459a): actual OpenCode run/resume plus bubblewrap, GitHub Projects v2 adapter. Useful prior art for separate sandboxed worker processes and clearenv. Adopting it replaces official reference scheduling/tracker lifecycle and adds project mutation/session state; it does not supply a standalone app-server adapter for this reference.
- [OpenCnid Symphony](https://github.com/OpenCnid/symphony/tree/dbf7bde5e0f7aec5bbd57fc548dfb324fc578839): Rust implementation, Codex/Claude backends and file/Linear trackers, no shipped OpenCode/GitHub combination at the audited head.
- [opencode-bridge](https://github.com/goldtetsola/opencode-bridge): Responses-compatible model/mission runtime, not a launcher for OpenCode CLI under Symphony; adopting its mission/event-log authority would add the framework excluded by scope.

Independent pre-commit review rejected broker/worker sharing one container/UID:
the worker must not reach the privileged app-server stream. The revised broker
runs on the host with only scoped authenticated MCP reachable from Docker.
Review also found worker-controlled host Git config, stale-base publication and
worker-clone policy imports. Mirror/bundle refresh, ancestry checks and trusted
config policy now cover these seams; fixture records include a real MCP roundtrip.
No claim of a full independent MERGE verdict is made until candidate review.

Exact-head review on 05d6d02 also falsified runtime-dependent service locking
and retry publication after base advancement on an existing PR. Repairs use a
per-user repository identity lock, stable issue identity and validated merge
parents preserving remote branch history without force. Regression fixtures
exercise both failures; a fresh final-head review remains required.

Hosted first-head evidence: bridge/local-model and all 115 upstream tests passed,
but job cleanup failed because Docker root owned bind-mounted build artifacts.
The upstream fixture now runs as the invoking UID. Required verifica exposed
the existing no-trigger-path-filters invariant; the optional pilot workflow now
uses an unfiltered PR trigger, without weakening the invariant/test.
