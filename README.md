# muffin-next

Ground-up rebuild of Muffin, following the blueprint in the `Muffin` repo
(`docs/blueprint/`, branch `claude/muffin-muffinos-refactor-37eda9`).

Named `muffin-next` only during the strangler transition — macOS is
case-insensitive, so `muffin` would collide with the existing checkout.
Renamed at cutover.

## Why

`docs/THESIS.md` — what this is betting on, and what the bet commits the design
to. `docs/DESIGN-PRINCIPLES.md` — how decisions get made, so the owner and a
contributor reach the same answer.

## Status

M0 (policy kernel, root of trust, tracing, config) and M1 (agent loop, two
provider adapters, per-model profiles, CLI) are done. M2 — memory: episodes, a
bi-temporal graph carrying provenance, hybrid recall with reranking — passes its
acceptance scenario end to end, with every turn in a separate process and every
question in a fresh session, so recall is the only path from the question to the
answer.

Next: the Telegram connector, then host primitives.

```
muffin                      open the REPL
muffin run "<goal>"         one goal, headless, meaningful exit code
muffin memory why <fact>    the episode a belief came from, verbatim
muffin memory check         graph invariants — no model, no network
muffin doctor               config, keys, database, embedder
```

## Conventions

Normative contracts: `docs/blueprint/09-contratti-m0-m1.md` in the blueprint
repo. Language: English in code and anything facing outward, Italian for the
persona, the prompts and the design records — and never the same content in two
languages (ADR-0020).
