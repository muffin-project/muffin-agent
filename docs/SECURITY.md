# Security

This document owns Muffin's **current security model and promises**. It describes
what the system is trying to make true at its trust boundaries. Exact literals,
allowlists and schemas live in shipped configuration and code; proof that a
particular DAY-1 journey currently holds lives in tests/evals and
`docs/blueprint/M5-BIS.md`.

The historical threat-model lineage remains in
`docs/blueprint/03-threat-model.md` and related ADRs/audits. Those records explain
how the model evolved; this page is the current map.

A boundary can be architecturally decided before its runtime mechanism ships.
When that is true, this document names the implementation gap explicitly rather
than claiming enforcement that does not exist yet.

## 1. Security objective

Muffin is a personal agent with real authority over an owner's machines and
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

With Nodes there is a second permanent assumption: **the authoritative Home can
itself be compromised**. Pairing a device must therefore not turn Home compromise
into unconditional remote control of that device.

## 2. Protected assets

At minimum the model protects:

- owner identity and authority bindings;
- personal evidence, beliefs and files;
- secrets and authentication material;
- unfinished work and durable occurrence identities;
- effect intent/outcome state needed to avoid duplicate or lost actions;
- spending and action budgets;
- the Root of Trust and policy configuration;
- Node identity, pairing and host-local authority once Nodes exist;
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

A Node identity is another orthogonal identity. "This is the paired MacBook" is
not the same claim as "the owner authorised every capability on this MacBook".

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

The same rule applies to intentional memory. Under ADR-0051 the model may emit a
`MemoryProposal`/candidate belief, but it does not choose tenant, speaker/source,
trust/taint or active canonical status. Those are derived from runtime evidence
and the current execution context. A model that has read tier-3 content cannot
rewrite that content into a tier-0 candidate merely by saying it in its own
voice.

Agent-generated and pipeline-generated inferences must remain distinguishable
from owner/source-stated evidence. Ordinary recall must not present a pending
proposal as an active belief. Only the Home-owned reconciliation path may
activate, merge, contradict or supersede canonical Beliefs.

This boundary reduces memory-poisoning surface from confused-deputy/model
behaviour; it is **not** a defence against a fully compromised Home process that
can arbitrarily mutate its own storage. The compromised-Home threat model is
handled separately for remote Node authority by the local ceiling in §6.

Cross-host transport does not automatically change speaker identity. It does,
however, create a locality/transport boundary that must remain observable when a
future policy distinguishes same-host, owner-controlled-host and third-party
recipients.

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

A Node does **not** add another authority engine that can grant what the Home
kernel refused. It contributes only a monotone local restriction. For a Node
execution:

```text
Home-authorized request
        ∩
Node local policy
        ∩
OS / physical device permission
        =
effective executable authority
```

## 6. Home ↔ Node trust boundary

ADR-0050 defines the Node security contract.

A paired Node may expose filesystem, shell, screen, camera, microphone,
notifications, location, local models, hardware or other host-local capability.
Because those powers belong to the host, **the host keeps a local ceiling that
the Home cannot remotely widen or bypass**.

The Node may:

- deny a capability the Home would otherwise allow;
- require a local approval;
- narrow paths, apps, sensors, actuators or other resources;
- fail closed if a required local approval channel is unavailable.

The Home cannot turn a local `deny` into `allow` by transmitting an "owner
approved" assertion. A break-glass or policy widening must originate through a
locally authenticated mechanism or an equivalent authority rooted at the Node.

This property exists specifically for a compromised or malicious Home. It is not
an ergonomics preference.

### Pairing and connection identity

Pairing establishes which durable Node identity the Home is talking to. It does
not establish unlimited trust.

A Node has stable identity separate from a connection lease. A reconnect must
not create a new Node or silently reset policy. The eventual protocol must
provide authentication and replay/session protections appropriate to its
transport.

### Approval binding

A Node approval must be bound to the exact execution plan it authorises. At
minimum the authoritative facts include the target Node, capability,
authority-bearing canonical arguments/resource, work/effect identity and a
validity bound.

Changing command, path, target or equivalent authority-bearing facts invalidates
the prior approval. The runtime must not ask about one action and execute a
semantically widened one afterwards.

### ACK is not outcome

A remote execution has several distinct facts:

```text
request received / ACK
execution started
execution outcome
semantic commit at Home
```

They must not collapse. A transport ACK does not prove an effect happened; a
worker outcome does not become canonical merely because a remote process said
so.

The current runtime does **not yet implement the Node protocol**. Therefore none
of the Node properties above should be read as a claim that a remote Mac is
currently protected by code that has not been written. They are constraints on
the first implementation.

## 7. Egress and locality

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
have reached that provider.

The current runtime trusts the configured provider to receive the assembled
context. Muffin does not yet claim a per-evidence
`local-only`/`owner-controlled-only`/`cloud-allowed` policy. Any such future
policy must live at the provider/placement boundary and be explicit about what
can still be inferred after redaction.

### Owner-controlled cross-host locality

Sending data from a Home on a VPS to a paired Mac Node is a real network/locality
transition even when both endpoints belong to the owner. It must be observable
and authenticated. It is not automatically equivalent to disclosing the same
data to a third-party model provider, and future policy should not flatten those
two trust relationships into one boolean `remote` flag.

Optional local PII/privacy transforms may reduce exposure to cloud providers but
are best-effort transformations, not a substitute for structural secret
handling.

## 8. Secrets

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

A future Node/Worker protocol must preserve the same rule: it may resolve an
explicitly authorised secret reference at the privileged sink that needs it; it
must not copy the Home's generic environment or use the protocol as a new secret
data plane.

Redaction remains defence in depth for unknown secret-like strings. It is not the
primary guarantee: arbitrary text pasted by the owner may contain a credential in
a shape the detector does not know.

## 9. Filesystem, process and worker containment

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

Moving an executor to another process or Node is not itself containment. The
execution boundary must still enforce the declared capability and local ceiling.

## 10. MCP and external code

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

A future Node capable of hosting extensions does not change this rule: pairing
the Node does not make arbitrary extension code trusted.

## 11. Effects, crash uncertainty and exactly-once identity

Safety includes not doing the same real-world work twice.

Before a non-trivial effect begins, Muffin needs durable intent. After execution,
it records an outcome. A crash between those states may leave an honest
`possibly happened` condition; the system must not convert uncertainty into an
automatic retry for a non-rerunnable effect.

Native ingress events and scheduled occurrences need stable idempotency identities,
but transport event identity is not necessarily work identity: multiple native
events may first compose one user intent. Once durable work/effect identity is
created, replay or reconnect must not produce duplicate model/effect/delivery
execution.

Delivery is an effect with its own uncertainty: completed computation and
definitely delivered output are different facts.

For remote Nodes the same effect semantics cross the protocol. Lost connection
after `started` but before outcome must remain uncertain; it must not become
"never happened" merely because the Home did not receive the final frame.

## 12. Root of Trust

The Root of Trust contains constitutional material the runtime may not silently
weaken: identity floor, policy floors/ceilings, hard deny lists, egress/budget
configuration and other sealed material explicitly designated as such.

A detected divergence moves the runtime toward conservative behaviour until the
owner deliberately reseals/restarts as required by the implementation.

The Root of Trust must remain small. Ordinary preferences, plugin settings and
behavioural tuning should not become constitutional merely because they matter.

Node-local policy is not automatically part of the Home Root of Trust: its
security value comes precisely from being independently enforceable at the Node.
Its eventual storage/protection mechanism belongs to the Node implementation and
must not be remotely mutable merely because the Home owns its own RoT.

## 13. Current known boundaries

This section names architectural boundaries without assigning Gate status; Gate
status lives only in `M5-BIS.md`.

- **Configured cloud provider receives model context.** There is no per-item
  local/cloud privacy policy yet.
- **The Node protocol does not exist in the current runtime.** ADR-0050 defines
  its future authority/security contract; current code does not yet enforce it.
- **Intentional agent memory write is not implemented yet.** ADR-0051 requires a
  proposal/reconciliation boundary; current `memory_search` read surface should
  not be mistaken for that future capability.
- **Local MCP process containment is not established by MCP schema pinning.**
  Treat third-party MCP server code as trusted until a stronger boundary lands.
- **Unknown credentials pasted as arbitrary text are best-effort redacted, not
  structurally knowable.** Known stored secrets have the stronger boundary.
- **Reversible effect/undo semantics are not claimed here until the reusable
  journal path is implemented and Gate-proven.**
- **A security mechanism is not considered real merely because its module, ADR
  or unit tests exist.** Production wiring and failure-path evidence are
  required.

## 14. What this document does not own

- Exact policy numbers or lists — `defaults/rot/*.json` and capability
  declarations own them.
- Database columns — schema/migration code owns them.
- Node transport/wire format — implementation may choose it only while
  preserving ADR-0050's contract.
- Whether a specific Gate row is READY — `M5-BIS.md` owns status.
- Historical findings or exploit transcripts — audits/research own evidence.
- Why a decision changed — ADRs own the rationale/history.

When a security promise changes, update this document. When only the mechanical
implementation changes while preserving the promise, update code/tests and the
relevant ADR/evidence instead of copying mechanics here.