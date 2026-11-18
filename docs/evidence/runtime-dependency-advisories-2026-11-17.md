# Runtime dependency advisories, 2026-11-17

Observation against `origin/dev` `2a2453116250eacc324dfa9582da074bf0677c8d`,
then against the lockfile on `slice/runtime-dependency-advisories`. This note
records the production audit and the caller each high resolved to. It is not
a security acceptance and it does not change `docs/architecture/SECURITY.md`.

PR #923 was compared and left untouched. It targets `main`, its `dco` check
fails, and its `package.json` diff only proposes `@modelcontextprotocol/client`
2.3.0 plus a vitest dev bump.

## Audit

Command, both times: `npm audit --omit=dev --package-lock-only`.

Before, on `2a245311`:

```text
5 high severity vulnerabilities
@modelcontextprotocol/client  2.0.0 - 2.2.0
@modelcontextprotocol/server  2.0.0 - 2.2.0
zod  <4.6.6
  node_modules/@anthropic-ai/sandbox-runtime/node_modules/zod
  node_modules/mcp-event-intelligence/node_modules/zod
@anthropic-ai/sandbox-runtime  *  depends on vulnerable versions of zod
mcp-event-intelligence  *  depends on vulnerable versions of @modelcontextprotocol/server and zod
```

Metadata: high 5, critical 0. No other severities.

After the lockfile change, the same command reported metadata high 0,
critical 0, and no vulnerability entries. `npm ci --ignore-scripts` from that
lockfile installs one Zod 4.6.7, client 2.3.0, and server 2.3.0. `npm ls zod`
marks `@anthropic-ai/sandbox-runtime`, `@modelcontextprotocol/server`, and
`mcp-event-intelligence` as overridden and dedupes every Zod edge to 4.6.7.

## Chains

### `@modelcontextprotocol/client` 2.0.0, now 2.3.0

- GHSA-6qxp-vccf-f47h, `>=2.0.0 <2.2.0`. OAuth client can send stored
  credentials to an authorization server named by the MCP server. The advisory
  says stdio clients are not affected.
- GHSA-6prh-2h8m-c8cw, `>=2.0.0 <2.3.0`. HTTP transports and OAuth requests
  followed cross-origin redirects. The advisory says stdio clients are not
  affected.
- Caller: `core/mcp/connect.ts` constructs `Client` and `StdioClientTransport`
  only. A repository search finds no `StreamableHTTPClientTransport`,
  `SSEClientTransport`, or SDK OAuth provider on a production path.
- Disposition: direct pin `2.3.0`, the smallest published release that exits
  both ranges. 2.4.0 adds unrelated client breaking changes and was not
  required to clear the audit.

### `@modelcontextprotocol/server` 2.0.0, now 2.3.0

- GHSA-jm63-cq47-j5jp, GHSA-46jr-4wx8-v453, GHSA-rvq5-wwqv-78pq, all
  `>=2.0.0 <2.3.0`. Shared HTTP transport instances, validation memory
  exhaustion on one HTTP request, and bearer tokens accepted for another
  resource.
- GHSA-f897-62hf-6gxq, `>=2.0.0 <2.1.0`. HTTP body and JSON-RPC batch limits.
- Caller: Muffin production does not import the package. The only repository
  import is the stdio fixture `core/mcp/fixtures/echo-server.mjs`.
  `mcp-event-intelligence@0.11.0` depends on server `2.0.0`, but its embedded
  entry (`scripts/embedded-host-kit.mjs`, the module
  `agent/event-intelligence.ts` imports) does not. The server import inside
  that package is `scripts/mcp-stdio-server.mjs`. A search of this repository's
  `*.ts`, `*.mjs`, `*.js`, `*.json`, and `*.sh` finds no spawn of that binary.
- Disposition: direct devDependency and a scoped override both set `2.3.0`,
  so the production tree cannot keep the package's exact `2.0.0` pin. The
  real stdio fixture suite (`core/mcp/mcp.test.ts`, 23 tests) passed against
  that server.

### `zod` below 4.6.6 — GHSA-mrhx-c7xc-m3w5

The advisory is an unbounded issue list while a constrained array is
validated (`$ZodArray` / `handleArrayResult`). Patched in 4.6.6. The direct
dependency already resolved to 4.6.7 under `^4.5.4`; the manifest now pins
`4.6.7`, which is inside that range and is the current patched release.

Two nested copies were still inside the audit:

- `mcp-event-intelligence@0.11.0` pins `zod@4.6.5`. Its embedded host kit
  validates trigger `events` and clause `where` with `.max(32)`. That module
  is reached by `attachEventIntelligence`. A probe of the published 4.6.5
  tarball rejected a 40-element array at `.max(32)` and still ran the element
  check 40 times. The same probe on 4.6.7 ran it 0 times. Upstream 1.0.0
  still pins 4.6.5 and adds a `pg` dependency, so the package was not bumped.
  Scoped override: `mcp-event-intelligence.zod` = `4.6.7`.
- `@anthropic-ai/sandbox-runtime@0.0.80` depends on `zod@^3.25.0` and resolved
  3.25.76. That tarball contains an unpatched `v4/core/schemas.js`
  (`handleArrayResult` and `$ZodArray`); the package's own sandbox code
  imports `zod/v3` only (`dist/sandbox/sandbox-config.js` and
  `dist/sandbox/decider-client.js`). `SandboxManager.initialize` stores the
  caller config and does not call the schema parser. The executor builds that
  config in `core/sandbox/executor.ts` and passes it to `initialize`.
  Published 0.0.83 still depends on `zod@^3.25.0`, and the library comment in
  `sandbox-config.js` says `zod/v3` exists so a consumer may resolve Zod 4.
  Scoped override: `@anthropic-ai/sandbox-runtime.zod` = `4.6.7`.
  `SandboxRuntimeConfigSchema.safeParse` of the off-network shape used by the
  executor returned success. On this Mac, `core/sandbox/executor.test.ts`
  passed 21 tests with one platform skip, and `core/sandbox/probe.test.ts`
  passed 24 with one skip, through the real Seatbelt path. Linux bubblewrap
  was not run locally.

No high remains in the production audit. Nothing was marked owner-accepted.
