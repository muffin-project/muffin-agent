# Provider/model configuration convergence — 2026-10-12

Claim: the owner can select provider and model independently for main and light
through one guided entrypoint and its shortcuts, preserving the other lane.
Profile: CRITICAL (credential destinations, persistent configuration migration,
and per-provider accounting). Base observed: dev `e9640e5e`.

The interrupted candidate was recovered from the existing temporary clone,
including its uncommitted runtime and CLI work. No personal Home or installed
gateway is used for verification.

## Measured problem

The base config has a single provider and two model IDs. Runtime wraps the main
provider for light. `muffin model light` on the ChatGPT route delegates to
`chatgpt use`, which overwrites both model IDs and the provider. Separate login,
catalog and selection commands make switching one lane affect the other.

| Candidate | Supporting evidence | Counter-evidence and consequence | Decision |
| --- | --- | --- | --- |
| Keep one provider and fix model-only selection | Minimal diff | Cannot assign different providers to main and light | Rejected: fails the agreed outcome |
| Extend existing config with an independent light connection | Reuses existing adapters, secret references, factory and writer; legacy connection can be copied without changing routes | Duplicates connection settings when lanes use the same endpoint; callers must resolve the correct lane | Chosen bounded schema-3 extension; one effective-provider helper and lane-preserving changes |
| Introduce a named connection map plus references from cognitive roles | Useful for many accounts/roles | Adds IDs, migration and dangling-reference behavior before a consumer needs them; does not itself solve authorization or accounting | Defer until actual multi-account reuse shows a defect in the smaller shape |
| Remove light and curate memory with the main agent | Potential simplification | Changes memory behavior, cost and autonomy without comparative evidence | Separate empirical question; not a prerequisite for configuration delivery |

The unified selection path preserves existing generic OpenAI-compatible endpoint
semantics: catalog evidence is not a guarantee of inference entitlement. ChatGPT
selection verifies actual inference and memory policy; no implicit paid fallback
is introduced. Missing catalog pricing remains unknown, never evidence of free
inference. API-dollar accounting and ChatGPT-plan quota remain separate.

## Prior art inspected

- [Hermes model CLI](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/models.py): a combined provider/model entrypoint is useful UX prior art, not a reason to import its account/runtime architecture.
- [OpenClaw model concepts](https://docs.openclaw.ai/concepts/models): authentication and model selection have explicit responsibilities; its broader profile/fallback machinery is not required by Muffin's two-lane claim.
- [Anthropic Models API](https://platform.claude.com/docs/en/api/models/list): native `/v1/models`, pagination with `after_id`, bounded page size. Native authentication must not be confused with OpenAI-compatible Bearer catalog requests.

Sources checked on 2026-10-12; mutable peer links identify inspected prior art,
not pinned implementation evidence for Muffin. Existing ChatGPT public-protocol
research and acceptance remain in `chatgpt-plan-provider-2026-10-12.md`.

## Falsifiers

Changing main changes light's provider, model, routing policy or credential
reference; light inference/reload uses main's credentials or spending route;
legacy migration rewrites a Home merely on read; failed selected-route
verification saves the candidate; configuration/diagnostics expose credential
values; guided and shortcut selection produce different persistent semantics.

Tests use isolated synthetic Homes and independent request/config/spend oracles.
Real external provider acceptance, local regression, required CI and integration
are reported separately. Research on autonomous memory must hold the reader,
task set and context/call budget constant before justifying a new writer.

## Verification observed

- Typecheck, compiled CLI, changed-file Biome error checks and diff checks passed.
- The host unit gate ran 410 files: 406 passed, four failed with five assertions
  tied to the changed provider display, named credential fixture, normalized
  config and two-lane online probe. Those four files passed after correction
  (86 tests); a final six-file focused gate passed 105 tests. Seven existing
  skips remain skips. Hosted CI must still verify the final composition.
- The slow piped-key fixture unnecessarily invoked `npx` from an empty working
  directory and tried to write the host npm cache. It now invokes the already
  installed tsx binary, preserving the delayed-stdin reproduction without a
  network/cache dependency.
- Real isolated lane witness: the compiled CLI selected Ollama `qwen3:8b` for
  light and preserved ChatGPT `gpt-6.1-sol` on main. The actual runtime light
  wrapper produced the correlated nonce tool call on Ollama; the real pinned
  ChatGPT main probe returned its exact nonce tool call. The synthetic test
  configuration was restored byte-for-byte; no personal Home was changed.
- The tiny generic probe initially exhausted its 128-token output allowance
  before Ollama returned a tool. That result remains unverified for that probe;
  the separate local runtime call used an explicit 1024-token allowance and
  passed. No probe cap was weakened and no paid-provider fallback was used.
- Fresh independent review reproduced cross-destination credential forwarding
  and the repeated-failed-reload fallback before repair, and verified the image
  routing through the exported production caller after repair. Their regression
  tests fail on the disconnected wiring rather than accepting a model claim.

Provider-route calls are evidence of the selected connections and tool protocol,
not a claim that every memory/capability family or authentic Telegram rendering
has passed. #881 retains its own discovery/negative-authority acceptance scope.
