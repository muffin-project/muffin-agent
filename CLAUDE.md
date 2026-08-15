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

## Map — don't duplicate, point

| You want… | Go to |
|---|---|
| Where we are · the MVP push · load-bearing files | `docs/blueprint/STATE.md` (**first**) |
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
