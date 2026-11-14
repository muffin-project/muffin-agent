# OpenRouter OAuth wire-up and account profiles — 2026-11-04

Status: **dated evidence** for the slice that makes OpenRouter PKCE reachable
from init/config and adds a minimal multi-account profile. It does not replace
`docs/user/PROVIDERS.md`, `docs/architecture/SECURITY.md`, or ADR-0105.

Verification profile: **CRITICAL**. The slice handles authorization codes and
writes provider keys through the existing secret backend. It does not change
the secret store, the Root of Trust, or egress policy.

## Measured failure

`core/config/openrouter-oauth.ts` implements OpenRouter PKCE (loopback and
headless) and is imported only by its own test
(`docs/evidence/2026-10-18-independent-technical-review.md`). `muffin init` on
a TTY still asks for a masked API key, and an empty Enter skips that prompt
with no confirmation (`cli/prompt.ts`). ChatGPT plan login already stores
several profile ids in `secrets/chatgpt` and selects one
(`muffin chatgpt login|select|status`). OpenRouter has no equivalent, so a
second OpenRouter account cannot be listed or selected. Anthropic stays a
Console/API key; there is no claude.ai OAuth client in the tree.

## Decision table

```text
measured failure
  OpenRouter PKCE is not on a user-facing path. Empty Enter skips the key
  prompt. A second account per provider is possible for ChatGPT only.

current mechanism
  One apiKeyRef per inference lane (ADR-0099). Keys go to the authoritative
  secret backend. ChatGPT profiles live inside the ChatGPT credential file,
  not in config.json. openrouter-oauth.ts stops below UI and storage on
  purpose.

candidate A — wire the existing module
  CLI calls beginLocal/beginHeadless + exchange, writes the returned key with
  writeAuthoritativeSecret under the OpenRouter secret name, sets main to
  openai-compat + the OpenRouter base URL, then runs verifyInferenceRoute.
  Extra accounts are secret-name profiles (openrouter_api_key_<id>) recorded
  in a key-free index. ChatGPT profiles stay in their own store. muffin auth
  lists and switches both.

candidate B — new AuthProfile + keychain before any login
  Peer note (OpenClaw ordered profiles, OS keychain, cli-delegate for Claude
  and Grok). Replaces the secret backend and adds subscription OAuth the
  owner forbade for Claude and xAI in this slice.

candidate C — do not add profiles
  Wire a single OpenRouter key only. Multi-account stays "ChatGPT has it,
  OpenRouter does not." Smaller, and it leaves the requested list/select
  outcome false.

evidence
  OAuth-first onboarding (2026-09-12) already names this PKCE flow and
  "configured != working". ADR-0099 deferred a connection registry because no
  measured multi-account defect existed yet; ChatGPT profiles have since
  shipped inside one credential file. OpenRouter's documented PKCE returns a
  user-scoped API key, so it fits the current secret backend. Claude
  subscription OAuth is not a third-party option (owner decision, 2026-11-04
  peer note). xAI has no public third-party client to add here.

counter-evidence
  A metadata index can drift from secret files. Listing also discovers
  canonical secret names, and a corrupt index fails closed instead of being
  rewritten from a misread. File-backed secrets remain the install's backend;
  this slice does not claim a keychain. Login retargets the main lane only;
  switch retargets lanes that already use that provider (ADR-0099).

security
  Verifier, code, and key stay out of argv, config.json, traces, and command
  output. The index stores provider, id, method, and secret name. Loopback
  stays inside openrouter-oauth.ts (127.0.0.1, one-shot path). Anthropic
  login is refused. No .claude read, no Claude Code client_id, no xAI client.

falsifier
  Reverse this if OpenRouter PKCE stops returning a user-scoped key the
  openai-compat adapter can send, or if listing/switching an account changes
  the other lane's provider kind or model. Also reverse the "no Claude
  OAuth" half only with a new owner decision; ADR-0105 does not permit it.

chosen claim
  Candidate A. Candidate B solves a storage problem this install does not
  have and pulls in forbidden providers. Candidate C misses multi-account.
```

## What landed

- `muffin init` on a TTY offers OpenRouter OAuth first. Empty Enter selects
  that option. Skipping is an explicit choice plus confirmation. Pasting a
  key remains choice 2. Headless init still reads stdin.
- `muffin auth login openrouter` is the same PKCE path (loopback, or code
  paste under SSH / `--code`). Success writes `secret://openrouter_api_key`
  (or `openrouter_api_key_<id>` for `--new`) and points **main** at
  OpenRouter. Light is left alone.
- The post-auth probe is `verifyInferenceRoute`. Output says working only
  when that probe passes. A failed probe keeps the key and the config.
- `muffin auth status|list|switch` reads ChatGPT profile ids from the
  existing ChatGPT store and key profiles from the index plus discovered
  secret names. It does not copy tokens into the index.
- `promptSecret` asks before treating an empty Enter as a skip. Ctrl+D is
  still an immediate cancel.
- Anthropic and xAI/Grok OAuth are refused by `muffin auth login`.

## Non-goals

Provider-side spending limits on the minted OpenRouter key, OS keychain,
Claude Agent SDK delegation, and any xAI client. Muffin's own budget seal is
unchanged.
