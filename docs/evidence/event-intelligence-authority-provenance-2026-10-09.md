# Event Intelligence authority, provenance, and replay — 2026-10-09

## Question and measured failure

Should PR #851 be integrated as-is after its exact-head checks, or does its production wake path still fail an authority, provenance, or crash-replay invariant?

Observed on `dev@f5363619d5c9f3c4b2a91ef8626a7fde8a286027` composed with PR #851 HEAD `274694a52a1234fc17716ea9319a2db82167097d`:

- `event_watch_sources` returns MCP source metadata at taint 3 and fences it as data.
- `event_watch_create` and `event_watch_manage` are declared `effect: context`, `risk: low`, and the ordinary kernel therefore permits a persistent watcher mutation at taint 3 for an owner. This watcher can later wake autonomous work.
- An EI match enters `enqueueTurn` with `system:automation` and taint 3, but `enqueueTurn` serializes its input with `ownerMessage`; `guidaIlTurno` later rebuilds that same input as `ownerMessage` again. Durable checkpoint provenance therefore says owner-authored for externally triggered bytes.
- `drive` also records every opening input as quotable owner text. A URL carried in a wake could therefore bypass the existing “quoted URL” exception at the egress parameter gate even if the message were merely relabeled after checkpointing.
- Receipt identity is deterministic and also becomes the Muffin Turn id. The production adapter's `hasReceipt` asks the TurnStore whether that id already exists. Existing tests replay the same occurrence in one runtime; they do not restart after Turn commit but before EI marks delivery complete.

## Existing invariant and production path

The existing policy kernel is the authority boundary. `runTool` returns on `deny`, asks through the existing approval/delegation path on `ask`, and only then records an effect and calls the handler. `POLICY_FLOOR` already forbids `events.trigger.create` and `events.trigger.manage` to system principals. The Event Intelligence wake already uses the normal TurnStore, loop, principal, tenant, taint, effect log, and delivery path.

The repair must preserve those existing mechanisms. It must not add a second authorization engine, scheduler, receipt store, or event log.

## Decision table

| Claim | Candidate | Evidence for | Counter-evidence / cost | Decision |
|---|---|---|---|---|
| A hostile MCP result cannot silently create or mutate a durable watch | A. Reclassify watch mutations on the existing `host` effect row as `risk: medium`, `reversible: no`; let the kernel's current approval/delegation path decide. Keep system-principal deny. | `host` already asks for non-reversible effects; the owner sees the existing approval request and arguments; Manual/Auto/Yolo retain their existing meanings; DENY remains terminal. | A model can still request the mutation, so an explicit owner approval or already-scoped delegation is required. This is deliberate for state that can launch future unattended work. | Choose A. No policy engine or new authority surface. |
| | B. Add per-tool `maxTaint: 0` so every tainted owner request is deterministically denied. | Stronger against an owner turn whose current taint came from a page/server. | This blocks even a deliberate owner request in an otherwise useful conversation after reading external data; the normal kernel already has an ask path for this durable action. | Reject as unnecessarily restrictive; preserve confirmation and explicit delegation semantics. |
| | C. Hide/disable watch mutations until another runtime exists. | Removes this path. | Removes an existing capability without fixing its truthful policy declaration or wake provenance. | Reject. |
| External wake bytes are not owner-authored | A. Reuse the current per-message `Message.origin` marker with a distinct `external` origin for the EI input. Persist it in the existing provider checkpoint, carry it into the preamble rebuilt by `guidaIlTurno`, and pass it to the existing quoted-URL gate. | No schema or state store required; the current checkpoint already persists message-level origin; event wake is one user message and its whole content is conservatively tainted 3. A wake URL stays unquoted and is checked by the existing egress policy. | The owner-authored continuation instruction inside the rendered wake is also marked external; this loses precision but cannot create authority. | Choose A. Revisit per-part provenance only if a consumer demonstrates a need for it. |
| | B. Add a provenance column or new durable event envelope. | More explicit typed state. | Duplicates provenance already carried on each `Message`; requires migration and more consumers without improving this single-message wake. | Reject. |
| | C. Keep `owner` origin and rely on taint/fencing prose. | No code or migration. | Fails the explicit durable-provenance invariant and makes the checkpoint lie about authorship. | Reject. |
| The Turn/receipt crash window creates no duplicate work | A. Fault-inject at the boundary after TurnStore commit and before EI delivery completion; restart both runtimes against the same isolated stores; let existing deterministic receipt and `hasReceipt` recovery run. | Existing protocol already carries stable wake/receipt identity and TurnStore persistence. A restart test falsifies the exact missing guarantee without adding state. | The two stores are not one transaction. Recovery depends on stable receipt identity and the runtime receipt lookup remaining wired. | Choose A; fail the slice if replay creates a second Turn or execution. |
| | B. Put EI receipts and Turns in one new shared transactional store. | Could make acknowledgment atomic. | Couples the external dependency to Muffin Turn storage and adds a second schema integration before the existing receipt protocol has been fault-tested. | Reject absent a failing A test. |
| | C. Treat same-process replay as sufficient. | Lowest test cost. | Does not cross the process-loss boundary or prove the retry state recovers. | Reject. |

## Peer and specification evidence

- CaMeL's primary paper separates trusted-query control/data flow from untrusted retrieved values and applies capabilities at runtime. It supports preserving the distinction between a trusted owner request and an untrusted event result; it does not imply Muffin should import a second interpreter or agent loop: https://arxiv.org/abs/2503.18813.
- Progent's primary paper describes deterministic, least-privilege enforcement over tool calls and explicit handling of policy expansion. It supports keeping enforcement in the existing kernel. Its policy DSL and LLM-generated task policies are not needed for this measured case: https://arxiv.org/abs/2504.11703.
- The current MCP Tools specification says clients MUST treat tool annotations as untrusted unless the server is trusted. Therefore metadata or annotations cannot establish authority for a persistent Muffin mutation: https://modelcontextprotocol.io/specification/2025-11-25/server/tools.

These sources support deterministic enforcement and explicit provenance. They do not prove that Muffin's current wiring satisfies either; the falsifiers below do.

## Verification and falsifiers

1. Through production `runTurn`, an owner turn observes hostile source metadata and attempts a watch mutation. In Manual mode it must reach the normal owner approval path. Declining or lacking an approver must leave no persisted watch; explicitly approving may persist it.
2. An autonomous `system:automation` principal must remain denied and must not discover or execute watch mutations, regardless of taint or delegation mode.
3. A real attached EI wake must persist `system:automation`, taint 3, and `external` input provenance. The subsequent normal context assembly must retain that origin, and its bytes must not set `DecisionRequest.quoted` for a URL. The recovery test now carries a URL in the matched event through a process restart, resumes with `resumeTurn`, has the scripted model call the registered `http_get` capability, and captures the `sys.http` `DecisionRequest` after the normal loop/kernel path. It asserts `resource.kind === 'url-read'`, the exact external URL, and `quoted === false`; the test replaces only the handler with a network-free stub, and asserts the kernel does not invoke it at taint 3.
4. Inject a process-loss boundary after the canonical Turn transaction commits and before EI acknowledges delivery. Reopen the Muffin TurnStore and EI state, process the due replay, and assert one Turn row for the deterministic receipt and no second execution.
5. Any failed assertion means the CRITICAL claim remains unready; exact-head CI alone cannot substitute for this evidence or the required independent judge.

The provenance handoff is mutation-proven: changing `guidaIlTurno` to call `snapshot.recordInput(input.text)` without `input.inputOrigin` made the recovery test fail with the captured URL decision changing from `quoted: false` to `quoted: true`. Restoring the production handoff made the test pass again. This closes the composition gap identified by the first independent review; a fresh review of the resulting tree is still required.

Final local verification on the candidate tree:

- The focused Event Intelligence, recovery, discovery, and permission suites pass: 5 files, 25 tests. The real `runTurn` owner path reads hostile event metadata, then explicitly approves both watch creation and pause at taint 3; both effects complete. The parallel denial test leaves no watch after the owner declines.
- The authority mutation was also falsified: restoring `events.trigger.create` to `effect: context`, `risk: low`, `reversible: undoable` made the production regression fail because no approval was requested.
- `npm run typecheck` and `npm run compile` pass.
- The full local suite ran 405 files: 5,203 passed, 15 skipped, 61 failed. Seatbelt-backed cases fail because this macOS environment reports `sandbox-exec: sandbox_apply: Operation not permitted`; containment was not relaxed. The other five failures were reproduced on the exact PR base HEAD `274694a`: the TypeSafe secret-fixture expectation, the slow GPG key-producer fixture, and shell-tool visibility/description assertions caused by the same unavailable sandbox. The full local suite is therefore not green and cannot replace the required exact-head Actions gate.

## Chosen claim

Keep the custom runtime and EI library. Make persistent watch mutation use the existing explicit approval/delegation mechanism, mark wake input as external in the existing message checkpoint, and prove the existing receipt-recovery protocol across restart. No second policy, event, or receipt subsystem is justified by the observed failure.
