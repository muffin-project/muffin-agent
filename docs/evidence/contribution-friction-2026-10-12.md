# Contribution friction — 2026-10-12

The universal DCO gate on owner PRs blocked existing internal work before
verification and acceptance could run. The owner chose to retain the external
DCO and OSI-only relicense grant while exempting owner-delegated internal work.
This is a contribution-policy decision, not a certification of historical rights.

| Option | Evidence and tradeoff |
| --- | --- |
| Universal per-commit DCO | Simple gate, but repeated internal certification does not prove identity or rights and blocked the observed delivery. |
| Scoped owner-internal exception | Removes that blocker using the existing checker; preserves external authorship and sign-off checks. Relies on the authenticated owner PR controller, not author-name authentication. |
| Inbound AGPL only | Less external friction, but provides no additional grant for a future MIT release. |
| New persistent CLA bot | Can reuse agreements, but adds infrastructure for a problem already solved by a small scope change. |

Primary peer sources inspected on this date:

- [Hermes contribution guide](https://github.com/NousResearch/hermes-agent/blob/main/CONTRIBUTING.md): inbound MIT and ordinary PR/testing expectations; no per-commit DCO requirement appeared in the guide.
- [OpenClaw contribution guide](https://github.com/openclaw/openclaw/blob/main/CONTRIBUTING.md): AI-assisted PRs welcome, evidence and review remain; sensitive work retains human security approval. The inspected guide/CI did not surface a DCO/CLA gate.
- [OpenHands official guide](https://github.com/OpenHands/docs/blob/main/overview/contributing.mdx): MIT, proportional review and CI. The inspected workflow inventory did not surface a DCO/CLA gate.
- [Codex guide](https://github.com/openai/codex/blob/main/docs/contributing.md): currently does not accept external code PRs. Its retained [CLA](https://github.com/openai/codex/blob/main/docs/CLA.md) covers past/future contributions; its [workflow](https://github.com/openai/codex/blob/main/.github/workflows/cla.yml) reuses stored acceptance. This supports agreement reuse, not copying its current contribution restrictions.

These observations cover the inspected public documents, not all organizational
legal instruments. Peer MIT licensing does not establish permission to change
Muffin's existing AGPL contributions. The owner retains that product decision.

Falsifier: an imported unsigned external commit must still fail beneath an
unsigned owner tip, through the actual command invoked by Actions. An unsigned
owner-only canonical PR must pass; the same commit in a fork or another user's
PR must fail. A raw two-SHA invocation must not invent owner authority.
