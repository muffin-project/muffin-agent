# CLAUDE.md — START HERE

This repo is the **single source** for Muffin: the code plus the design, research,
decisions and state that produced it. Clone `muffin-agent` and you have everything
(`docs/blueprint/adr/0031`). The old `Muffin` repo is **production only** now,
frozen as a design source until cutover — author here, never there.

**Read `docs/blueprint/STATE.md` first.** It is the handoff — where we are, what
the MVP still needs, and the load-bearing files to read before touching memory,
the loop, or the policy kernel. It survives the compact; this router does not
repeat it.

**The MVP is a usage threshold, not a feature checklist.** Gate 1 in
`docs/blueprint/04-roadmap.md` §"I due gate": the owner uses Muffin as a daily
agent for two consecutive weeks without falling back to the old one (except
groups). The substrate M0–M5 is built; the work is closing "built" → "used every
day".

## The two zero-context entry points

`/loop` with no arguments is the normal continuation command. Claude Code loads
`.claude/loop.md`, reconstructs repository-wide state, closes any active review
before starting new work, and advances the DAY-1 READY inventory. The command
is deliberately not a synonym for "pick a nearby TODO".

`/goal` is a Claude Code built-in and a bare invocation only displays the active
or most recently achieved goal; it cannot infer a new one from this repository.
Start it once with this canonical condition, then let it continue across turns:

> `/goal Porta Muffin a DAY-1 READY come definito in M5-BIS, seguendo .claude/loop.md e ORCHESTRATION.md; non chiudere blocker senza evidenza.`

DAY-1 READY starts the fourteen-day personal-use window. Group work continues
in parallel but group activation waits until that window completes. A
single-user default must still use the general tenant/surface/capability shape:
"groups later" never authorizes a host-only shortcut.

## How much verification this change needs — read this before working

Pick the profile **before** implementing, and write it in the PR: **FAST**
(docs, state, generated views, tests-only, mechanical fixes), **STANDARD**
(ordinary reversible product/runtime work), **CRITICAL** (effect journal,
irreversible effects, authority/kernel, taint, egress, Root of Trust, secrets,
durable schema, backup/restore, concurrency, exactly-once, crash recovery,
sandbox, destructive operations). The rule and the evidence each profile owes
are `docs/ORCHESTRATION.md` §17; the classification procedure a zero-context
session follows is `.claude/loop.md` §3. Only CRITICAL needs a fresh judge.

Context is a resource: this file is a map, not a manual. Load a document when
the task makes it load-bearing (`.claude/loop.md` §2), not on every iteration.

## Map — don't duplicate, point

| You want… | Go to |
|---|---|
| Where we are · the MVP push · load-bearing files | `docs/blueprint/STATE.md` (**first**) |
| **How much verification this change needs** (FAST/STANDARD/CRITICAL) | `docs/ORCHESTRATION.md` §17 · `.claude/loop.md` §3 |
| The sequence toward Day 1 · what is in flight | `docs/blueprint/gate1/PERCORSO-CRITICO.md` |
| The two gates (MVP, cutover) + roadmap M0–M7 | `docs/blueprint/04-roadmap.md` |
| Architecture + the *why* of each decision | `docs/blueprint/` + `docs/blueprint/adr/` |
| Normative contracts (types, formats, floors) | `docs/blueprint/09-contratti-m0-m1.md` |
| Threat model — kernel, taint, sandbox | `docs/blueprint/03-threat-model.md` |
| Cognitive corpus — read before designing an organ | `docs/blueprint/knowledge/` |
| How to work here (triggers, not wishes) | `docs/PRACTICES.md` · `AGENTS.md` |
| How the work is **decided and verified** — the control loop, when to stop and ask, why a subagent's word is not evidence | `docs/ORCHESTRATION.md` |
| The bet · how decisions are made · what broke | `docs/THESIS.md` · `docs/DESIGN-PRINCIPLES.md` · `docs/lessons.md` |
| Curated scientific/cognitive foundations | `docs/foundations/` |

Conventions that are not preferences — the English/Italian split, never delete
rows, trust never rises, data lives only in `~/.muffin/` — are in `AGENTS.md`.
Read it before you change anything.
