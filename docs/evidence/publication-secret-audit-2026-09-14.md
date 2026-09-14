# Publication secret audit — 2026-09-14

Scope: issue #464 (publication safety), plan `docs/work/source-public-2026-09-25/`
§1.2. Scanner pass on HEAD + full reachable history. This note records method and
verdict; it does not replace the remaining manual steps (§Residual).

## Method

- Tool: gitleaks 8.30.1 (installed via brew for this audit), default ruleset,
  `gitleaks detect --source .` on the full clone.
- Range: **1124 commits**, ~72.6 MB scanned.
- Complement: `git ls-files` for tracked `*.db`/dumps/`*.pem`/`id_rsa`/`*.key`/
  backups; `git grep /home/user` over HEAD for owner machine paths.

## Verdict: no real secret in HEAD or history (default ruleset)

100 findings, **6 distinct matched strings, all synthetic fixtures**:

| String | Where | Why it is not a secret |
|---|---|---|
| `MUFFIN_CHARACTER_D13_KEY` | `evals/character/run.test.ts` (+64 embeds in generated `docs/derived/architecture-map/mappa.html`) | env var *name*, not a value |
| `temperature/thinking` | generated `mappa.html` files | ordinary words in embedded snippets |
| `abcdef123456` | `core/tracing/redact.ts:114` (doc comment) | example token in a comment |
| `sk-liveTESTKEY1234567890` | `core/tracing/redact.test.ts` | test vector, "TESTKEY" in name |
| `sk-or-v1-fixture` | `core/config/inventory.test.ts` | "fixture" in name |
| `sk-or-v1-QUESTA-CHIAVE-NON-DEVE-MAI-USCIRE` | `agent/secret-read.test.ts` | canary ("this key must never go out") |
| `sk-ant-abc123DEF456ghi789xyz` | `core/tracing/redact.test.ts` (×2 commits) | sequential-pattern fake in a redaction test |
| `ghp_4A2b6C8d…` | `core/mcp/registry.test.ts` | sequential-pattern fake (`4A2b6C…`) |

Rule breakdown: 97 `generic-api-key`, 2 `curl-auth-header`, 1 `github-pat` —
all rows above. Tracked-file check: no `.db`, dump, pem, key or backup files
(excluding the `cli/backup.*` *source* files, matched by name only). No
`/home/user` path in any tracked file at HEAD.

## Residual (not covered by a scanner, still required before the flip)

1. Owner personal-data prose in history/evidence (conversation quotes, machine
   specifics a regex cannot judge) — owner review, #464.
2. GitHub-side deletion of the #396 body revision from edit history (manual step,
   authors/write users only).
3. Re-run this scan at the cutover gate on the exact promoted candidate.
