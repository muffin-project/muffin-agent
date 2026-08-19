# Security

This document owns Muffin's **current security model and promises**. It describes
what the system is trying to make true at its trust boundaries. Exact literals,
allowlists and schemas live in shipped configuration and code; proof that a
particular DAY-1 journey currently holds lives in tests/evals and
`docs/blueprint/M5-BIS.md`.

The historical threat-model lineage remains in
`docs/blueprint/03-threat-model.md` and related ADRs/audits. Those records explain
how the model evolved; this page is the current map.

## 1. Security objective

Muffin is a personal agent with real authority over an owner's machine and
services. Its primary security problem is not only classic remote compromise.
It is **confused-deputy execution**: untrusted content reaching a capable model
and influencing effects that carry the owner's authority.

The system therefore separates:

```text
meaning                 authority
(model)                  (kernel)
   │                        │
   └── proposes action ─────┤
                            ▼
                     deterministic decision
```

The model may interpret content, infer intent and choose a proposed action. It
must not be able to rewrite the facts used to decide whether that action is
permitted.

## 2. Protected assets

At minimum the model protects:

- owner identity and authority bindings;
- personal evidence, beliefs and files;
- secrets and authentication material;
- unfinished work and durable occurrence identities;
- effect intent/outcome state needed to avoid duplicate or lost actions;
- spending and action budgets;
- the Root of Trust and policy configuration;
- the ability to tell the owner when state is unknown or degraded.

A failure that silently reports success is treated as more dangerous than an
honest refusal.

## 3. Principals and tenant boundary

Authority comes from transport/runtime identity, never from natural-language
content.

A surface resolves a principal from a stable authenticated subject. Display
names, usernames, biographies, filenames, quoted messages and message content
may describe a person; none of them grants owner authority.

The first deployment is single-owner, but principal, tenant and surface remain
explicit dimensions so accumulated data is not retrofitted from an implicit
`host == owner == everyone` model later.

## 4. Provenance and taint

Content trust and speaker identity are different axes.

The trust scale is monotone within an execution context: once a turn has consumed
less-trusted bytes, later summarisation or model output cannot make those bytes
more trusted merely by rewriting them.

The current semantics are broadly:

- tier 0 — owner-origin content;
- tier 1 — confirmed/locally controlled context with narrower uncertainty;
- tier 2 — content whose authorship is not reliably the owner, including generic
  disk reads and forwarded/third-party material;
- tier 3 — external tool/web/MCP-style content.

The authoritative current ceilings and policy literals live in
`defaults/rot/policy.json` and capability declarations, not in this prose.

History must preserve the taint of content that is reinjected later. A session
transcript is not a trust laundromat. Speaker/actor metadata must also survive
recall: "trusted" is not equivalent to "the owner said this".

## 5. The policy kernel

The policy kernel is pure and deterministic. It decides from typed facts such as:

- principal and tenant;
- declared capability;
- canonical resource;
- current taint;
- capability risk/reversibility/rerunnability metadata;
- sealed policy and egress configuration;
- budget state;
- Root-of-Trust health.

An undeclared capability does not exist for the runtime. A caller that declares a
resource-bearing capability but fails to supply the matching canonical resource
must fail closed rather than skip the relevant gate.

The model never chooses its own risk class, taint ceiling or constitutional
exception.

## 6. Egress

Egress has more than one form.

### Tool/network egress

HTTP/search and other outbound capabilities are policy-gated. Host allowlisting
alone is insufficient: model-chosen bytes in query/fragment/search parameters
are also security-relevant. Above the configured taint threshold the owner may
be asked only where the policy deliberately permits an ASK; other principals are
refused.

### Model-provider egress

A remote LLM provider is itself a **privileged data recipient**. System prompt,
selected history, recalled memory and tool results included in a model request
have left the owner's machine when sent to that provider.

The current runtime trusts the configured provider to receive the assembled
context. Muffin does not yet claim a per-evidence `local-only`/`cloud-allowed`
policy. Any such future policy must live at the provider boundary and be explicit
about what can still be inferred after redaction.

Optional local PII/privacy transforms may reduce exposure to cloud providers but
are best-effort transformations, not a substitute for structural secret
handling.

## 7. Secrets

Known secret values must not enter Muffin's general data plane.

The structural rule is:

```text
secret reference
      │
      ▼
privileged resolver
      │
      ▼
authorised sink only
```

A known secret value must not become normal model context, transcript text, tool
arguments/results, approval text, durable turn content, trace/log output, CLI
output, argv or a generic inherited process environment.

`secret://...` references may travel through ordinary configuration because they
are identifiers, not secret values.

Secret input uses channels that do not expose the value in argv (stdin or hidden
interactive input). A legacy/plaintext env source is not a supported bootstrap
contract.

Redaction remains defence in depth for unknown secret-like strings. It is not the
primary guarantee: arbitrary text pasted by the owner may contain a credential in
a shape the detector does not know.

## 8. Filesystem and process containment

Generic agent shell/filesystem capability is not equivalent to the parent
process's full authority.

The sandbox boundary must:

- confine allowed filesystem scope;
- preserve explicit deny-read locations, especially secret backends;
- avoid inheriting the parent's complete environment;
- make the path authorised by policy correspond to the path the OS will touch;
- fail conservatively when containment cannot be established.

Symlink, hardlink, ancestor-symlink and path-canonicalisation behaviour are part
of the security claim rather than filesystem edge cases.

Process inspection should expose only the information required by the declared
capability; command-line arguments are particularly sensitive because they may
contain secrets or private data.

## 9. MCP and external code

MCP has two distinct trust boundaries:

1. the **protocol/tool boundary** — tool name/description/schema, invocation and
   returned content;
2. the **server process boundary** — the code that Muffin launches locally.

Pinning or validating the first does **not** automatically contain the second.
The current stdio transport launches the configured server as a local child and
can resolve explicitly declared `secret://` references into that server's
process environment. The MCP SDK avoids wholesale parent-environment inheritance,
but that does not prove the server cannot read other owner-accessible files or
make its own network connections.

Therefore, until process-level containment/capability manifests are implemented
and proven:

> **A third-party local MCP server is part of the trusted computing base.**

For DAY-1, either only explicitly trusted MCP servers should be used or MCP should
be treated as unavailable where the Gate requires stronger containment.

The future extension model should make authority explicit: filesystem roots,
network destinations, secret references and capabilities should be declared and
reviewable rather than implied by installing arbitrary code.

## 10. Effects, crash uncertainty and exactly-once identity

Safety includes not doing the same real-world work twice.

Before a non-trivial effect begins, Muffin needs durable intent. After execution,
it records an outcome. A crash between those states may leave an honest
`possibly happened` condition; the system must not convert uncertainty into an
automatic retry for a non-rerunnable effect.

Stable external events (scheduled occurrences, inbound update ids) should bind to
one durable work identity. "The inbox row exists" is not sufficient if a crash
can still create a second turn and repeat model/tool execution.

Delivery is an effect with its own uncertainty: completed computation and
definitely delivered output are different facts.

## 11. Root of Trust

The Root of Trust contains constitutional material the runtime may not silently
weaken: identity floor, policy floors/ceilings, hard deny lists, egress/budget
configuration and other sealed material explicitly designated as such.

A detected divergence moves the runtime toward conservative behaviour until the
owner deliberately reseals/restarts as required by the implementation.

The Root of Trust must remain small. Ordinary preferences, plugin settings and
behavioural tuning should not become constitutional merely because they matter.

## 12. Current known boundaries

This section names architectural boundaries without assigning Gate status; Gate
status lives only in `M5-BIS.md`.

- **Configured cloud provider receives model context.** There is no per-item
  local/cloud privacy policy yet.
- **Local MCP process containment is not established by MCP schema pinning.**
  Treat third-party MCP server code as trusted until a stronger boundary lands.
- **Unknown credentials pasted as arbitrary text are best-effort redacted, not
  structurally knowable.** Known stored secrets have the stronger boundary.
- **Reversible effect/undo semantics are not claimed here until the reusable
  journal path is implemented and Gate-proven.**
- **A security mechanism is not considered real merely because its module or
  unit tests exist.** Production wiring and failure-path evidence are required.

## 13. What this document does not own

- Exact policy numbers or lists — `defaults/rot/*.json` and capability
  declarations own them.
- Database columns — schema/migration code owns them.
- Whether a specific Gate row is READY — `M5-BIS.md` owns status.
- Historical findings or exploit transcripts — audits/research own evidence.
- Why a decision changed — ADRs own the rationale/history.

When a security promise changes, update this document. When only the mechanical
implementation changes while preserving the promise, update code/tests and the
relevant ADR/evidence instead of copying mechanics here.