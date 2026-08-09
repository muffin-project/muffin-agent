# muffin-agent

Ground-up rebuild of Muffin, following the blueprint in the `Muffin` repo
(`docs/blueprint/`, branch `claude/muffin-muffinos-refactor-37eda9`).

`muffin-agent` is the repository and npm package; the product, the command and
the identity stay `muffin` (ADR-0012). The slug carries `-agent` only because
`muffin` is taken on npm and, on this Mac, collides with the old checkout — at
cutover the repo can reclaim the bare name.

## Why

`docs/THESIS.md` — what this is betting on, and what the bet commits the design
to. `docs/DESIGN-PRINCIPLES.md` — how decisions get made, so the owner and a
contributor reach the same answer. `docs/lessons.md` — what has broken, with the
numbers, because in this kind of system the characteristic failure is damage
that reports success.

## Install

Node >= 22. From a clone:

```sh
./install.sh
```

It builds the bin, then links a `muffin` command into `~/.local/bin`. On Linux
Mint `/usr/bin/muffin` is the Cinnamon window manager; the installer detects a
foreign `muffin` on the PATH and installs as `muffin-agent` rather than shadow
it — never writing into a system dir, never `sudo` (blueprint ADR-0012). Take
the name anyway with `MUFFIN_CMD=muffin ./install.sh`.

For development, `npm link` gives the same `muffin` command against the working
tree.

## Status

M0 (policy kernel, root of trust, tracing, config) and M1 (agent loop, two
provider adapters, per-model profiles, CLI) are done. M2 — memory: episodes, a
bi-temporal graph carrying provenance, hybrid recall with reranking — passes its
acceptance scenario end to end, with every turn in a separate process and every
question in a fresh session, so recall is the only path from the question to the
answer. The vault indexes documents structurally, carries their context into
every chunk, and has a check that compares the directory against the index
rather than trusting the hash that maintains it.

M3 (host primitives: a sandboxed executor, `sys.shell`/`process`/`http`, an MCP
client gated against silent rug-pulls, runtime `SKILL.md`), M4 (Telegram: a
durable inbox, a renderer, media into the vault) and M5 (the scheduler:
DST-correct cron jobs and a proactivity gate that only speaks on a
high-confidence signal) are in. `muffin` runs as one process — the REPL plus
every enabled surface.

Next: the live bot proof end to end, and the owner decisions the blueprint parks.

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
