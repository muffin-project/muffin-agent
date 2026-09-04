---
name: Feature / capability request
about: Propose a new capability, tool, or surface for Muffin
title: ''
labels: enhancement
assignees: ''
---

<!--
This is the request half of the research/challenge protocol in
docs/RESEARCH.md. A non-mechanical change to runtime, authority, provenance,
memory, or a durable schema goes through that pass before implementation —
this template asks for the inputs that pass needs, so a maintainer isn't
starting from zero.
-->

## What problem does this solve

<!-- The failure or gap this addresses — ideally something observed, not
imagined. "It would be nice if" is weaker evidence than "I hit this using
Muffin for X". -->

## Does this touch a trust boundary

<!-- Does it change authority, permissions, provenance/taint, egress,
sandboxing, secrets, approval semantics, memory/recall, or a durable
schema/protocol? If yes, please read docs/RESEARCH.md before writing code —
this class of change needs the challenge pass first, and a PR that skips it
will be asked to do it before review. -->

- [ ] Yes, this touches one of the above
- [ ] No, this is additive/mechanical

## Proposed shape

<!-- What you're proposing, concretely enough to critique. Pseudo-code, a CLI
sketch, or a short design note are all fine — this does not need to be a full
spec. -->

## Alternatives considered

<!-- What else could solve this problem, and why this shape over those. A
peer system's approach is prior art, not authority (`AGENTS.md`) — say what
you looked at and why it does or doesn't transfer here. -->

## Scope / non-goals

<!-- What this explicitly does not try to solve, so review doesn't drift. -->
