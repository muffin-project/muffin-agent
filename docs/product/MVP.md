# Muffin MVP (trusted alpha)

Status: maintainer proposal, 2026-10-21. Ratification by the owners is requested
on the three points at the bottom; everything else cites decisions already on
record.

This document owns **what MVP means and what proves it**. Phase placement stays
in [ROADMAP.md](ROADMAP.md); DAY-1 requirement status stays in
[requirements-status.md](../status/day1/requirements-status.md); live work is
observed in Git/GitHub.

## Definition

> **Muffin MVP is the first version the owner can live with for fourteen
> consecutive days as the primary personal agent: one entity across surfaces,
> real work that survives restarts, and enough control that using it does not
> require trusting it blindly.**

It is a **product threshold, not a feature count**. A runtime that can be tried
is not an MVP; an agent that can be lived with is (owner directive,
2026-08-15: *«Non chiamerei ancora questo MVP»*). The MVP is earned by proof in
real use, not by shipping a list.

## The one falsifiable claim

For fourteen consecutive days the owner performs the in-scope jobs through
Muffin (Telegram and CLI) **without falling back to another general-purpose
agent**; every fallback is recorded and either fixed or explicitly accepted.
Supporting claim: every in-scope capability family has one acceptance journey on
the real binary, and removing its wiring makes that journey fail (#874).

If the owner reaches for another agent, the MVP is not done — whatever the
feature list says. Fallbacks are the metric, not a footnote.

## In scope (P0)

1. **Entity and character.** One Muffin, recognisable across surfaces and
   restarts; persona/voice applied live; no therapy, coaching or action-plan
   theatre.
2. **Continuity.** Sessions, memory, beliefs and unfinished work survive
   restarts; recall is provenance-aware; the owner can inspect and correct.
3. **Work and effects.** Real multi-step work through native capabilities
   (filesystem, shell, web, documents, media); effects are journaled, reversible
   where claimed, and their uncertainty is visible.
4. **Presence.** The input side stays alive while work runs: queue, steer, stop,
   pause/resume; long work can suspend, wake and report; the owner can always
   tell whether Muffin is working, waiting or asking.
5. **Surfaces.** Telegram (owner-facing) and CLI (developer/operator/recovery)
   both ways, same owner, same session, same entity. Discord stays out of the
   supported path.
6. **Self-knowledge.** Muffin can truthfully say what it can do now, what is
   disabled and why, and what the current turn can actually reach
   (`sys_inspect` / capability search), including catalogue truncation.
7. **Safety and control.** Owner-only by default; taint and policy enforced on
   the production path; secrets never leak; approvals show what will happen;
   backup and restore are proven; install/update/rollback are one path.
8. **Onboarding.** One install command reaches a verified, agent-led first run
   through the real runtime path (#507).
9. **One unattended goal.** A single durable goal can be armed once, wake
   without a new owner message, run through the existing loop/effects
   machinery, survive a continuable interruption, and finish or escalate (#598,
   owner priority 2026-09-19).

## Out of scope until after the fourteen days

- New integrations as a reason to delay proof: email, calendar, browser
  automation, GitHub capability (#871, #872, #873, #665).
- Multi-user, groups beyond the shipped gate, and guest mode (#924).
- Node/mesh/remote execution and the Mac capability Node (ADR-0050). The
  project root is the declared boundary for now.
- Desktop/tray/dashboard as a normal owner command (#863). A read-only control
  projection may be built only if it shortens the dogfood loop; it is not MVP
  surface.
- Extension marketplace, plugin framework, portable Agent Plugins (#672).
- Model breadth, provider presets and new provider adapters (#524).
- New cognitive mechanisms, salience/decay/consolidation work, performance
  tuning. Frozen by default during dogfood unless an observed failure demands
  one.
- Hardware, voice-first UX, public product alpha promises.
- Discord (WIP, out of the supported path; #730/#731/#715).

**Rule:** work that neither moves a scorecard row nor closes a dogfood blocker
does not delay the MVP.

## Proof scorecard

Statuses are honest as of 2026-10-21: *journey exists* means an acceptance file
drives the real binary; *mutation-proven* means the wiring-removal falsifier is
recorded. A row is closed only when both are true.

| Family | Journey | Status | Falsifier / gap |
|---|---|---|---|
| Filesystem read/write/edit | `d-capability` D1–D3, `fs-edit-chirurgico` | journey exists | remove scope guard / undo wiring → journey must fail; mutation run not yet recorded |
| Shell | `d-capability` D4, `b-telegram-journey` #746 | journey exists | offered only after the sandbox probe; headless proves the ASK (command+cwd), while the executor itself is unit/CI-proven |
| Web search + fetch | `d-capability` D7/D9, `b-retry` | journey exists | key/endpoint resolution, SSRF/retry guards; no real-provider search+fetch turn |
| Memory search/propose/recall | `c-memory`, `c-consolidamento`, `c-tempo` | journey exists | mutation run not yet recorded |
| Schedule / wait / todo / event | `job-fires`, `b-continuity`, `c-tempo` | partial | no single turn exercising schedule → occurrence → completion |
| Surfaces both ways | `b-telegram-journey` (B1/B13/B14/D12), `b-una-conversazione`, `b-parita-superfici` | journey exists; B14 re-proven 2026-10-21 | delivery/record removal → red |
| Input while working | `b-busy` + G3 slice 1 | partial | busy enqueue proven at work/router level; foreground/preemption not implemented |
| Capability self-knowledge | `e-cost` E7, `agent/capability-gaps.test.ts` | partial | E7 proves live model/root/exposed list; truncation/disabled truth is unit-proven, not yet on the real binary |
| Autonomy P0 | — | **missing here** | spine #912–#915 in `dev`; #598 gate open |
| Onboarding | `e2e-giro-owner`, `a-lifecycle` | partial | OAuth end-to-end + key persistence on the real `init` path still open (#507) |
| Safety / backup / restore | `a-lifecycle`, `d-capability`, `d15-registro-effetti` | partial | backup+restore proven; full public-alpha security claims out of scope |

The scorecard is the MVP backlog. A family that fails becomes a slice; a family
that passes with its mutation is **proven**, not assumed.

Baseline observed 2026-10-21 on `fix/reliability-remediation` + G2/G3.1/G4/G5:
eight family scenarios run, 28/28 green after B4 was corrected to the ADR-0104
contract (`d-capability`, `c-memory`, `job-fires`, `b-continuity`, `c-tempo`,
`b-busy`, `e-cost`, `fs-edit-chirurgico`). This is a **passing** baseline, not a
mutation proof: the wiring-removal treatment is still what closes a row.

## Sequencing

```text
0  deploy reconcile + baseline on HEAD            (G0, done 2026-10-21; dirty build)
1  #874 scorecard: run each journey, add mutation  (now)
2  G3 presence: foreground/preemption              (now–next)
3  close the eight DAY-1 dogfood blockers          (now)
4  #507 onboarding                                 (next)
5  #598 one durable unattended goal                (next)
6  fourteen-day owner dogfood                      (the gate)
   ↓
   MVP / trusted alpha
```

The 14-day window must run on HEAD. While the live install is behind, the
window measures old code and the result is not evidence.

## Why this boundary

The repository already has more breadth than the MVP needs: 425 test files,
5,569 passing tests, 33 acceptance scenarios (64 manifest rows), 38 open issues in the
"MVP / trusted alpha" milestone. The risk is not missing features; it is
**unproven wiring and unbounded scope**. #874 exists because a mechanism
existing is not proof the production path reaches it. This MVP says: prove the
spine, live with it for two weeks, and let observed failures — not the milestone
list — choose what comes next.

## Owner ratification requested

1. The in/out boundary above, especially: no new integrations, no Node/mesh, no
   dashboard as owner surface, and Discord out.
2. Autonomy P0 (#598) **inside** the MVP rather than after it.
3. Telegram + CLI as the only supported surfaces for the fourteen days, with
   everything else opt-in and outside the promise.
