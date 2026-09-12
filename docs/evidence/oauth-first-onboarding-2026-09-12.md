# OAuth-first onboarding — 2026-09-12

Status: **owner product direction + dated evidence** for #507. This does not replace provider/security authorities; it constrains onboarding choices.

## Decision

For every external service used during Muffin onboarding or progressive setup, choose the lowest-friction delegated authorization route that preserves user ownership:

```text
OAuth / browser authorization
→ provider-native managed authorization with equivalent ownership
→ masked secret / API-key entry
→ manual advanced configuration
```

If a service exposes a production-usable OAuth flow, **OAuth is the recommended happy path**. API-key copy/paste remains a recovery/advanced fallback, not the default UX.

The owner should grant **authority**, not perform credential plumbing.

This applies to inference providers, search, source-control/productivity integrations, future account-linked capabilities and any optional setup proposed by Muffin. It does not mean that Muffin may authorize itself: browser/account consent still belongs to the owner, and the resulting credential remains outside model context.

## Security / sovereignty invariants

OAuth-first is an ergonomics decision, not a relaxation of the security model.

- No Muffin/Centria credential proxy when the provider supports a local/native flow.
- Prefer PKCE for public/local clients where the provider supports it.
- OAuth verifier/code/access/refresh tokens never enter model context, argv, generic environment, traces, normal DB rows or Git.
- Credentials land only in the authoritative secret backend owned by the user's Muffin installation.
- Provider/browser authorization is an owner action; the model may propose it but never silently grant it.
- After authorization, **configured != working**: execute the real capability path and report success only after observation.
- Logout/revoke/re-auth must remain possible without rebuilding Home.
- Manual keys remain supported where OAuth is unavailable or broken.

## Current applications

### OpenRouter

Recommended inference auth is OAuth PKCE with a loopback callback on local/desktop installs and the provider's headless PKCE path on SSH/VPS. The returned user-controlled API key is written directly to Muffin's persistent secret backend. PR #514 owns the protocol core.

`openrouter/free` remains a first-class zero-cost model route, but it is only called working after Muffin's real inference/tool-capability probe passes.

Primary source: https://openrouter.ai/docs/guides/overview/auth/oauth

### Tavily

Current Muffin `muffin search tavily` requires an API key and already handles the remaining plumbing: persistent secret storage, config, egress consent/reseal and runtime registration.

Tavily now exposes browser OAuth through both its CLI (`tvly login`) and its Remote MCP server. The Remote MCP path explicitly supports OAuth without an API key in the URL and selects an account key server-side. Therefore the Alpha search UX should **investigate OAuth before polishing manual key entry**.

Important boundary: current Muffin `sys.search` calls Tavily's native API; Tavily's documented OAuth access token is clearly specified for the Remote MCP flow, not yet proven interchangeable with the native Search API key. Do not pretend those credentials are equivalent.

Decision fork for the implementation spike:

1. if Tavily documents/supports OAuth credentials for the native Search API, keep `sys.search` native and authorize directly;
2. otherwise evaluate Tavily Remote MCP OAuth as the zero-key route while preserving the native API-key backend as fallback;
3. do **not** build a Muffin-hosted token exchange merely to hide a copied key.

Primary sources:
- https://docs.tavily.com/documentation/tavily-cli
- https://docs.tavily.com/documentation/mcp

### Telegram

Telegram Managed Bot provisioning is not OAuth, but it is the same product rule: prefer provider-native user-owned provisioning over token plumbing. The managed bot remains owned by the user and runtime traffic remains direct; manual BotFather setup remains the fallback.

## Falsifier

A future integration whose recommended onboarding tells a normal Alpha user to open a dashboard, create/copy a long-lived API key and paste it into Muffin **while the same provider exposes a suitable delegated browser authorization flow** is a product regression unless a documented security/protocol constraint explains why OAuth cannot be used.
