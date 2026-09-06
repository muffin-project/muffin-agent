# Security

This document owns Muffin's **current security model and promises**. It describes
what the system is trying to make true at its trust boundaries. Exact literals,
allowlists and schemas live in shipped configuration and code; proof that a
particular DAY-1 journey currently holds lives in tests/evals and
`docs/work/day1/requirements-status.md`.

The historical threat-model lineage remains in
`docs/history/rebuild-2026/03-threat-model.md` and related ADRs/audits. Those records explain
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
`defaults/rot/policy.json`, in `ROW_FLOOR` (`core/policy/matrix.ts`) and in the
capability declarations, not in this prose. `defaultMaxTaint` is no longer the
ceiling: ADR-0053 moved that to the effect row, and left the field readable so a
home sealed before it still parses.

### Fencing: marking, not preventing

Content that did not come from the owner is wrapped in a nonce-carrying fence
before it reaches the model (`fence()`, `core/memory/spotlight.ts`), and the
sentinel is stripped from the body so a hostile body cannot close the fence
early. Two separate claims live here and they must not be merged:

- **Marking is deterministic.** Code wraps the bytes on the way out of the tool,
  whatever the model is thinking, and the nonce is generated after the content
  was written.
- **Obedience is not.** Whether the model treats a fenced block as data is its
  judgement, and the adversarial corpus has watched it fail. Fencing is
  provenance, not prevention: it makes "external content arrives marked as
  external" a true sentence about this system, and it stops there.

Until 2026-09-03 that sentence was true of the network doors and false of the
disk. `fence()` was called by `agent/tools/http.ts`, `search.ts`, `mcp.ts` and
`document.ts`; `fs_read`, `fs_list`, `fs_search` and `shell_run` returned
`tier: DISK_TIER` and nothing else, so a file the owner had been sent and saved
reached the model indistinguishable from his own prose — the entry point four of
the seven scenes in `evals/security/attacks` use. Those four doors now go
through the same function (`fenceDisk`, `agent/tools/fs.ts`, imported by
`shell.ts`), and no tier or effect row moved with them.

Two doors stay outside the fence on purpose, and the reasons are recorded where
they are enforced. `skill_read` (tier 1) returns owner-installed skill files,
which are instructions by design — and ADR-0059 strengthened rather than
weakened that: skills live under the Muffin home, `mandatoryGuards` puts the
home in `denyWrite`, and the workspace is outside it, so neither `fs_write` nor
`shell_run` can plant a skill file. `process_list` (tier 1) returns the host
describing itself; the cost to an attacker is an approved `shell_run`, not code
execution on the host, and on macOS `ps -eo comm` is a full executable path
(measured: lines up to ~205 characters) rather than the 15-character `comm`
Linux gives. It stays a marginal channel — whoever holds `shell_run` already has
its stdout, which *is* fenced now — and it is written down at its real width
rather than at a flattering one.

Two more doors carry bytes off the disk that **cannot** be fenced at all:
`loadImage` (`agent/images.ts`) and the voice path
(`connectors/telegram/connector.ts`) hand the model an image or audio block, and
a block of media has no text frame to put a marker in. Their tier is right
(`maxTier(tierOf(principal), contentTaint)`), and that is the whole defence.

So **the absence of a fence is not a statement that content is trusted**, and
the operating block of the system prompt says so to the model in those words —
which is the load-bearing half of that sentence, precisely because these four
doors exist.

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
- the capability's **effect row** — where the bytes of the effect land — which
  owns the taint ceiling and says whether irreversibility is decisive on that
  row. The rows are the ones the threat model's matrix has always printed, and
  since ADR-0053 the kernel executes that table instead of a risk class plus a
  ceiling pinned by hand on each declaration. A declaration may tighten its own
  row and never widen it; `core/policy/effect-rows.test.ts` asserts every
  shipped cell;
- capability risk/reversibility/rerunnability metadata;
- the two acts the turn performs **without a tool** — replying on the
  originating channel and writing a memory episode — which since ADR-0055 are
  declared capabilities (`surface.reply`, `memory.write`) the kernel itself
  owns rather than a runtime registers. The shipped floor allows both at every
  taint: what this buys is a decision that exists, tunable by a sealed
  `policy.json` and visible as `muffin.policy_decision` on every reply and
  every episode of a turn. A proactive nudge composes inside a turn and so is
  decided, but its final delivery (`cli/observe.ts`) and its episode
  (`agent/observe-run.ts`) happen outside the loop and pass no door;
  `decideProactive` refuses a trigger above tier 1 at the source, and vault
  ingest writes its own episodes outside this boundary too;
- sealed policy and egress configuration;
- budget state;
- Root-of-Trust health.

An undeclared capability does not exist for the runtime. A caller that declares a
resource-bearing capability but fails to supply the matching canonical resource
must fail closed rather than skip the relevant gate.

The model never chooses its own risk class, taint ceiling or constitutional
exception.

### When the kernel asks a human, and when it does not (ADR-0074)

A confirmation is requested **if and only if** the capability declares
`reversible: 'no'` **and** its effect row declares `asksForIrreversible` — the
host machine, third-party code (MCP), a new outward recipient. Nothing else in
the risk/taint path produces one. A declaration with an undo executes as a
`draft` — checkpoint first, effect second — at every taint below its ceiling.
A declaration with nothing to take back, on a row where that does not decide
(`surface.reply`, `memory.write`, `surface.send_file`), is allowed: a reply is
the conversation itself, and an approval prompt that gates replies cannot be
delivered.

Three mechanisms this replaced, named because each one existed and decided
things until 2026-09-06:

- **Ambient taint no longer produces an `ask`.** It still refuses above the
  row's ceiling (`denyAbove`, ADR-0044, unchanged) and still stamps
  provenance; it no longer turns an `allow` or a `draft` into a question. §13
  carries the measurement that decided this.
- **`risk` no longer produces an `ask`.** It still decides safe mode, the
  budget gate, and the fail-safe that *queues* a high-risk request from an
  autonomous `system`/`agent` principal instead of auto-approving it.
- **`hardened` no longer skips one.** The `hardened && owner && taint === 0`
  auto-allow is gone: `muffin rot harden` answers "who may rewrite the rules",
  not "can this command be undone".

Egress is a separate authority and is untouched by this: model-composed bytes
riding out in a URL's query or fragment still ask the owner and refuse every
other principal (ADR-0071), and a search's text answers to its own ceiling
(ADR-0072). Both remain sources of an `ask` that has nothing to do with the
rule above.

The approval text names the irreversible effect ("non si torna indietro:
cambia questa macchina — `sys.shell`") plus the concrete action derived from
the call's arguments. The turn's taint appears on the surfaces underneath it,
as context — *this turn has read external content* — never as the cause.

A sealed `rot/policy.json` may tighten a row in both of its fields: lower
`denyAbove`, or turn `asksForIrreversible` on where the floor leaves it off.
It may not turn one off. A file still carrying the removed `askAbove` field is
**rejected** naming that field, and the kernel falls back to the compiled
floor — an unknown key in the root of trust must not be read as a gate that no
longer exists.

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

**Reading a URL and reaching a host to act on it are two different authorities
(ADR-0066).** The kernel's egress branch (`core/policy/decide.ts`) distinguishes
them by resource kind: `url-read` (`sys.http`, GET-only) is answered without
consulting the host allowlist at all — any public host is reachable, by owner
decision, and neither the tool nor the kernel re-checks a redirect target
against a list that no longer applies to it. `url` (acting — writing,
executing, sending through a model-chosen host; no shipped capability uses it
today) still answers to `rot/egress.json` exactly as before: off the list is a
hard refusal above low taint, never a silent skip.

Both kinds answer to the same two floors, because the host is never the only
channel that matters. First, an address floor independent of any list
(`core/net/egress.ts#isForbiddenAddress`): loopback, RFC1918, CGNAT,
link-local (the cloud metadata endpoint lives there) and their IPv6
equivalents are refused on every hop, DNS-resolved before connecting, for a
literal IP without even touching DNS. This is what stands between an open
read and the machine's own network, and it does not depend on `rot/egress.json`
holding anything. Second, model-chosen bytes in query/fragment/search
parameters are security-relevant regardless of how the host was reached: above
`paramsMaxTaint` the owner is asked and shown the exact URL, and every other
principal is refused — never a silent pass. `rot/egress.json` remains
load-bearing for what it still governs: `url` (acting) capabilities, and
which third-party endpoints (e.g. a configured search backend) get registered
at boot.

**A residual is known and not closed by this split**
(`docs/evidence/muffin-nei-gruppi-2026-09-04.md` §6.1–6.2): `paramsMaxTaint`
is 2, and a group member's turn starts at taint 2 by construction
(`tierOf(member)`) — not after reading something, but from the first message.
The params gate fires only above its ceiling, so it never fires for a group
turn that has not yet read tier-3 content, regardless of which host the
request reaches. This predates ADR-0066 (it applied identically to an
allowlisted host before this split) and is not this document's or that ADR's
fix; it is named here so this section does not read as a stronger guarantee
than the code gives for a group tenant.

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
- keep that scope **disjoint from Muffin's own installation** — see below;
- preserve explicit deny-read locations, especially secret backends;
- avoid inheriting the parent's complete environment;
- make the path authorised by policy correspond to the path the OS will touch;
- fail conservatively when containment cannot be established.

The workspace a turn writes in and the directory the process happens to run in
are two different questions. Conflating them cost the supervised gateway its
own state: the unit anchors `WorkingDirectory` to the Muffin home on purpose
(ADR-0035), and until ADR-0059 that home was also the write scope, so
`.rot-anchor`, `muffin.db`, `voice.md` and `sessions/` were writable from a
turn whose content came from a forwarded message or a fetched page. The home is
installation state: nothing legitimate reaches it through the shell or
filesystem tools, and the boundary is enforced twice — the workspace is a
sibling directory, and the home is denied outright whatever the per-call scope
says.

Read access to the home is a separate, still-open question: a contained command
can read `muffin.db` and the session log, and what leaves is governed by taint
and egress rather than by this boundary.

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
be treated as unavailable where DAY-1 requires stronger containment.

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

**In two questions, before the formal prose** — because "root of trust",
"seal", "safe mode" and "harden" are really the answer to only two questions,
and `muffin doctor` (`cli/doctor.ts`) has to say it in these terms, not the
four below, before it says anything else:

1. *Has anything touched these files?* If yes, and nobody confirmed it, Muffin
   restricts itself rather than trust a file it cannot vouch for — that is
   "safe mode". `reseal` is the owner saying "I changed that file on purpose;
   take the new version as true" — only he can say it, because that is exactly
   what distinguishes his edit from an intrusion.
2. *Can anything touch these files?* Today, in `single-user`, Muffin
   *detects* tampering but cannot *prevent* it, because a process running as
   the owner can undo the read-only bits by itself. `rot harden` prints the OS
   commands that make prevention real — it needs `sudo`, which is why it
   prints them instead of running them. The consequence the owner feels every
   day: without real prevention, no high-risk capability can ever become a
   silent allow — `sys.shell` always asks.

**A capability-setup verb (`muffin search <provider>`, `muffin mcp add
--host`) may widen `rot/egress.json` and reseal, and that is the same act as
`rot reseal`, not a smaller one (ADR-0058).** It goes through one shared
function (`widenEgressForCapability`, `core/rot/egress-writer.ts`) that: asks
one question naming the exact host(s) about to be added, answers it only when
a real interactive terminal is wired in (never from a flag — none exists to
skip it), and refuses with a printed manual remedy otherwise.

**The `isatty(0)` gate is ergonomics, not the security boundary — say this
precisely, because the first version of this section did not.** An
independent review ran the production `SandboxExecutor` under bwrap on Linux
and allocated a real pty for `sys.shell`'s grandchild with `script -qc
"…" /dev/null`: the grandchild then observes `process.stdin.isTTY === true`,
and a second independent review reproduced bwrap in Docker and mutated
`p.rot` out of `denyWrite` — behind that same real pty, the grandchild really
does write the file once the deny is gone, which is what makes the deny
itself the thing worth believing rather than an assumption nobody tried to
break. macOS/seatbelt denies the pty allocation outright (the exact OS error
text for that denial is not load-bearing and differs by machine — this repo
has seen both `openpty: Operation not permitted` and `out of pty devices`),
which is why the original claim ("stdin is never a TTY") tested green here
for the wrong reason. The boundary that actually holds, on both platforms,
pty or no pty, is the write-deny on `~/.muffin/rot` (`mandatoryGuards`,
`core/rot/guards.ts`) — the same mandatory deny-write list `agent/runtime.ts`
builds the production sandbox with, which the sandboxed child cannot lift
even by naming `paths(home).rot` explicitly in its own write scope
(mandatory beats explicit), and which fails with `EPERM` under seatbelt and
`EROFS` under bwrap. `core/rot/egress-shell-escalation.test.ts` proves both
the pty (where a pty can be allocated at all — it skips cleanly, loudly, and
fails instead of skipping under `MUFFIN_REQUIRE_SANDBOX=1`) and the
write-deny that holds regardless.

Every widening is still an addition the owner named explicitly, validated as
a bare hostname before anything is asked or written (`isValidEgressHost`,
`core/rot/egress-writer.ts`) — including a leading/trailing space or a
trailing newline, which a third independent review found slipping through a
first cut of that function: it validated a copy it had trimmed internally,
while the untrimmed value (with the whitespace still inside it) was what
actually got written and sealed — a shell variable with a trailing newline is
exactly the ordinary case that produces one. The validator now trims nothing
at all: whitespace anywhere in the string fails the same per-label check
that also rejects a scheme, a port, a path, a userinfo, or a comma-separated
list, because none of those characters can appear inside a DNS label either
— one regex applied per label after splitting on `.`, not a second,
separately-maintained character blacklist. Nothing is inferred from a URL or
pre-filled.

The rest of this section formalises those two questions for whoever
implements or verifies the mechanism, not for whoever reads `muffin doctor`.

The Root of Trust contains constitutional material the runtime may not silently
weaken: identity floor, policy floors/ceilings, hard deny lists, egress/budget
configuration, the owner binding (`rot/owner.json` — which account each surface
recognises as the owner, written by pairing and resealed in the same act) and
other sealed material explicitly designated as such. A sealed binding that does
not verify authenticates nobody, and does not fall back to `config.json`: the
process that could tamper with the sealed file is the same one that can rewrite
the unsealed copy, so a fallback would make the seal a suggestion.
The seal is a detection boundary, not a prevention one: in `single-user` mode
the sealed files share the owner's OS user and permissions, so a process that
can rewrite `config.json` can also reseal a consistent chain, and that state is
indistinguishable from a legitimate pairing. Only `hardened` mode (`muffin rot
harden`) puts the seal out of that process's reach.

A detected divergence moves the runtime toward conservative behaviour until the
owner deliberately reseals/restarts as required by the implementation.

The Root of Trust must remain small. Ordinary preferences, plugin settings and
behavioural tuning should not become constitutional merely because they matter.

Node-local policy is not automatically part of the Home Root of Trust: its
security value comes precisely from being independently enforceable at the Node.
Its eventual storage/protection mechanism belongs to the Node implementation and
must not be remotely mutable merely because the Home owns its own RoT.

## 13. Current known boundaries

This section names architectural boundaries without assigning DAY-1 status; DAY-1
status lives only in `docs/work/day1/requirements-status.md`.

- **Configured cloud provider receives model context.** There is no per-item
  local/cloud privacy policy yet.
- **The Node protocol does not exist in the current runtime.** ADR-0050 defines
  its future authority/security contract; current code does not yet enforce it.
- **Surface and Node execution placement are still the same `cwd`, found
  2026-09-03.** ADR-0050 §3 separates them on paper. The supervised gateway
  does not: `WorkingDirectory=${home}` (`core/gateway/unit.ts`) with no `cwd`
  override in `cli/gateway.ts` means the shell tool's write scope is the
  Muffin home on that surface, and the same request from a REPL elsewhere on
  the same machine gets a different answer. This is an open design question
  requiring a `docs/RESEARCH.md` pass and an ADR, not a decided direction —
  see `docs/ROADMAP.md` "First Mac capability Node" and
  `docs/evidence/il-lavoro-che-viene-2026-09-03.md`.
- **Intentional agent memory write is not implemented yet.** ADR-0051 requires a
  proposal/reconciliation boundary; current `memory_search` read surface should
  not be mistaken for that future capability.
- **Local MCP process containment is not established by MCP schema pinning.**
  Treat third-party MCP server code as trusted until a stronger boundary lands.
- **Unknown credentials pasted as arbitrary text are best-effort redacted, not
  structurally knowable.** Known stored secrets have the stronger boundary.
- **Reversible effect/undo semantics are not claimed here until the reusable
  journal path is implemented and DAY-1-proven.**
- **A security mechanism is not considered real merely because its module, ADR
  or unit tests exist.** Production wiring and failure-path evidence are
  required.
- **Ambient context taint is the incumbent *ceiling*, and since 2026-09-06 it
  is no longer a reason to ask.** §4 and §5 use provenance tier both as a
  property of data and, after taking the maximum over the context, as a
  turn-wide authority input. That is still true of the **ceiling**: above a
  row's `denyAbove` the capability is out of reach, and ADR-0044 is unchanged.
  It is no longer true of the confirmation. ADR-0074 removed `askAbove` from
  the rows because the measurement said the gate was not gating what it was
  for: on the real installation, **all 35 approvals ever requested were
  `sys.shell` at taint 2, and 32 were granted** — a prompt conceded nine times
  out of ten is a reflex, not a decision — while what the taint actually shut
  down was `fs.write`, the one write in the system that takes a checkpoint and
  has `muffin undo` behind it. The same signal appeared in the character eval:
  5 of the 6 `agentic` failures of the main model were turns stopped on an
  approval nobody was there to give (`docs/evidence/tool-use-2026-09-06.md`).
  On a headless process — the VPS, a scheduler job — such a prompt is an
  `exit 3`, which is a prohibition in disguise. A confirmation now follows
  irreversibility, which is the question it was always for; the taint keeps the
  ceiling, the provenance stamps and the context line on the prompt.

  The precision of the ambient scalar **as a ceiling** remains an open
  question, not a settled one. Dogfood shows the cost: owner-directed work
  becomes unreachable after reading disk or external content, even when that
  content did not choose the action. A task/action-flow model — binding
  authority to *what asked for an action* rather than to the highest tier merely
  present — is an
  **unresolved hypothesis**. It may replace the incumbent only if a comparative
  evaluation demonstrates better utility **without material security
  regression**, and an ADR written before that comparison exists would be
  deciding the question instead of answering it. Nothing in this document adopts
  it: current semantics are exactly as §4 and §5 state them. The dated eval
  design is lineage, in
  `docs/history/design-notes/security-v2-eval-contract-2026-08-29.md`; the
  2026-09-02 measurement of what the incumbent actually gates — including the
  sink asymmetry between `fs.write`, `surface.send_file` and a plain reply — is
  in `docs/evidence/decision-memo-taint-2026-09-02.md`. Two thirds of that
  asymmetry are since closed: ADR-0053 put `surface.send_file` on the `reply`
  row, and since ADR-0055 the plain reply passes through the kernel as
  `surface.reply` — semantics unchanged, the floor allows it at every taint, but
  the act is now decided, tunable and traced rather than unwatched.

  **The comparative evaluation now exists, and it does not settle the
  hypothesis.** `evals/security/` holds the three artefacts the 2026-09-02 memo
  listed as missing: an executable candidate-B adapter deciding on
  `(effect class × sink × who chose the resource × reversibility)` — an
  experiment, unreachable from the runtime by construction and asserted so — an
  adversarial corpus that runs the real binary and measures whether an injection
  *succeeds* rather than which verdict is printed, and predeclared metrics with
  the kill criterion. The 2026-09-03 run
  (`docs/evidence/eval-taint-corpus-avversariale-2026-09-03.md`) found: four of
  seven attacks complete with no human at all, six of seven if the owner answers
  the approval the way the real installation's owner answered 32 of 35 times,
  and **candidate B beats the incumbent on none of them**. By the kill criterion
  the incumbent stays. The corpus also located the guards that actually stopped
  things, and none of them was the ambient scalar: the egress allowlist, the
  tool's own SSRF floor, and a single approval prompt. Two sinks —
  `surface.reply` and `memory.write` — have no guard at all and the corpus
  observes attacks completing through both, which is the floor those rows
  declare rather than a regression. Nothing here adopts or retires the
  hypothesis: the numbers are one macOS corpus with no observable network
  exfiltration, and a material reversal would be an ADR, not an edit to this
  paragraph.

  **2026-09-04 (ADR-0066): the egress allowlist stopped being one of those
  three guards for `sys.http`.** Reading is now open by owner decision —
  `sys.http` declares a `url-read` resource, and `core/policy/decide.ts` never
  consults `egressAllowed` for it — so the allowlist named above governed a
  mechanism this document's own §7 now describes differently (below). Rerun
  identical on the same seven scenes after that change: 4/7, 6/7, 7/7, still
  candidate B beats the incumbent on none of them — the sentence above is
  historically accurate for the run it describes and is not the current
  mechanism for `sys.http`. What actually stopped the egress scene in both
  runs was the tool's SSRF floor (the measurement sink is loopback); the
  allowlist's absence changed nothing observable in that scene precisely
  because the floor, not the list, was already doing the stopping. An eighth
  scene added the same day — a hostile page instructing the *next* request to
  carry a secret in its query string — measures the same floor holding for the
  read/act split this ADR introduces; see ADR-0066 for the full corpus
  before/after and the residual (`docs/evidence/muffin-nei-gruppi-2026-09-04.md`
  §6.1) it names but does not close: `paramsMaxTaint` does not gate a group
  turn's first message, because that principal's own floor taint already
  equals the ceiling.

  **2026-09-06 (ADR-0074): the third of those three guards changed shape.**
  The corpus found that what stopped things was the egress allowlist, the
  tool's own SSRF floor, and *a single approval prompt* — and this ADR moved
  when that prompt fires. It no longer fires because the turn is tainted; it
  fires because the act cannot be undone, on every taint including 0 and on a
  hardened install. On the corpus's own terms the change cuts both ways and
  neither direction is claimed here without a rerun: the scenes where the
  attack completed *because the owner approved* are unaffected (the prompt was
  shown and granted either way), while `sys.shell` at taint 0 — previously an
  auto-allow under `hardened` — now prompts, and `fs.write` after a read no
  longer does. The corpus has **not** been rerun against this kernel; the
  numbers above describe the runs they name and are not restated as current.

## 14. What this document does not own

- Exact policy numbers or lists — `defaults/rot/*.json` and capability
  declarations own them.
- Database columns — schema/migration code owns them.
- Node transport/wire format — implementation may choose it only while
  preserving ADR-0050's contract.
- Whether a specific DAY-1 requirement is READY — `docs/work/day1/requirements-status.md`
  owns status.
- Historical findings or exploit transcripts — `docs/evidence/` owns them.
- Why a decision changed — ADRs own the rationale/history.

When a security promise changes, update this document. When only the mechanical
implementation changes while preserving the promise, update code/tests and the
relevant ADR/evidence instead of copying mechanics here.