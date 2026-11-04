# Event-trigger provenance follow-up — 2026-10-09

## Question

Can an external MCP event influence the model while Muffin presents its identifiers as clean trigger data or records its wake text as owner-authored input?

## Observed Muffin behavior

The exact PR candidate 274694a52a1234fc17716ea9319a2db82167097d is based on dev f5363619d5c9f3c4b2a91ef8626a7fde8a286027. Its production path is:

    host-owned MCP Events connection
    → Event Intelligence v0.11.0 event occurrence
    → trigger list/inspect adapter or activation
    → ordinary TurnStore / tool-result path
    → model context and the existing permission snapshot

Two defaults fail closed neither way they should:

1. adaptPortableTool() serializes trigger-list and trigger-inspect results as JSON with tier CLEAN, although inspection lineage includes sourceRef.eventName and sourceRef.sourceEventId supplied by event sources. Those fields accept arbitrary strings. The event-source list is already fenced, but a later read of a persisted match is not.
2. Event activation renders Muffin's continuation plus fenced external evidence, sets a system principal and taint 3, then calls enqueueTurn(). enqueueTurn() writes that initial text with ownerMessage(). The durable checkpoint therefore says origin: owner for bytes the owner did not author.
3. The same wake text is passed to snapshot.recordInput() without source context. The current rule treats any input without a tool capability as owner-quotable, so an external URL embedded in an event can be mistaken for a URL quoted by the owner.

A local red run on the exact PR tree failed both falsifiers: the system principal's URL was treated as quoted, and the wake checkpoint origin was owner. The trigger-read assertions are placed after those checks so the next red run reaches the adapter output itself.

## Decision table

| Candidate | Evidence and cost | Decision |
|---|---|---|
| Keep the existing tool and TurnStore path; return mixed trigger data with owner-managed fields separated from a nonce-fenced external-data block, mark mixed results tier 3, and carry the existing tool message origin into the durable opening checkpoint. Let the permission snapshot count an opening URL as owner-quoted only for an owner principal and owner-origin input. | Reuses the existing fence, TrustTier, MessageOrigin, kernel and TurnStore. Adds no authority path or event-specific policy engine. | **Choose.** |
| Add field-by-field, per-value trust labels to provider messages and decisions. | More precision, but changes durable message/result contracts and every consumer of those values. The current scalar result tier already needs to rise when any external occurrence evidence is present. | **Defer until a real consumer needs mixed-tier policy decisions.** |
| Remove trigger inspection or disable Event Intelligence wakes. | Avoids the path by removing existing capability, even though the ordinary tool and work lanes already have the correct fencing and kernel primitives. | **Reject; loses useful behavior unnecessarily.** |
| Adopt a separate prompt-injection framework/interpreter for Event Intelligence. | CaMeL demonstrates provenance-aware control/data separation, but its interpreter and capability model solve a wider problem than this single adapter seam. | **Reject for this slice; retain its boundary principle.** |

## External comparison

The current MCP Skills extension requires hosts to treat server-provided skill content as untrusted model input and preserve its origin. MCP's tool-annotation guidance also makes clear that annotations are hints, not enforcement. These sources support a host-owned provenance boundary; they do not establish that every Event Intelligence field is malicious. CaMeL's primary paper demonstrates the value of separating trusted control from untrusted data, while also using a substantially larger execution model. Muffin already has a narrower tier and Message.origin path that can express this correction without importing that architecture.

## Chosen behavior and falsifier

- Trigger definitions and host lifecycle remain readable as owner-managed records.
- Source event references, match evidence and lineage are presented in a distinct event_trigger_evidence fence; a mixed trigger-read result raises the normal turn taint to 3.
- An EI wake remains system:automation, keeps taint 3 and uses the existing tool evidence origin in its initial durable checkpoint. No owner authority is added.
- Only an owner-authored opening message may make its exact URL count as owner-quoted. External/search tool outputs retain their existing explicit policy.
- A synthetic host-owned MCP source injects instruction-shaped event names and IDs. The production adapter must return them inside the fence at tier 3; the owner-authored reminder must remain in the separate managed section. The real TurnStore row and its provider-message replay must retain origin: tool.

The claim is falsified if removing the adapter projection leaves those trigger-read assertions green, if the resumed provider context no longer carries the persisted wake opening as tool-origin, or if removing the principal/origin check lets a system URL set DecisionRequest.quoted=true. The system-wake assertion and the owner-principal external-input mutation cover separate paths: system principals receive tool-origin input by construction, while the mutation proves that a persisted tool-origin message cannot be promoted to owner provenance for an owner principal.

This does not claim that the gateway has a persisted message.received caller, that a hostile event achieved an external effect, or that WakeOwnerBindings survives restart. Existing system principal, kernel, taint and fail-closed restart behavior remain the authority.

## Sources

- [MCP Skills extension security considerations](https://skills.extensions.modelcontextprotocol.io/specification/stable/skills)
- [MCP maintainer guidance on tool annotations](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/)
- [CaMeL, “Defeating Prompt Injections by Design”](https://arxiv.org/abs/2503.18813)

## Verification result

- RED on the exact PR head: the event-list adapter returned tier 0 for event-source-controlled fields, and the permission snapshot treated a system wake URL as quoted.
- GREEN: 90 focused tests passed across event intelligence, TurnStore replay, context assembly, the permission snapshot, URL provenance, and the existing egress/link-following regressions.
- Added a production-runtime recovery regression: a hostile EI URL is loaded from the real TurnStore through `resumeTurn` and reaches the real `sys.http` kernel decision with `quoted: false`; the system wake is denied before the HTTP handler. A second owner-principal turn with durable `origin: tool` receives `ask` for the same external path instead of executing. The test replaces only the HTTP handler with an inert sentinel and disables memory for this isolated decision.
- RED/GREEN mutation: changing the resume projection to label every opening as `owner` changed the external owner-path outcome from `ask` to `answered`, so the owner-principal regression failed; the exact source copy was restored. The EI system-wake path separately asserts that its resumed provider message retains `origin: tool` and that the real kernel receives `quoted: false`. Final check after both paths were pinned: `agent/event-intelligence.test.ts` — 3/3 passed; `npm run typecheck` and `git diff --check` passed.
- GREEN: typecheck and production compile passed.
- The complete PR-head suite reported 5,205 passed, 15 skipped, and 61 failed. The changed-path tests remained green. A clean clone of the exact PR head reproduced the five non-sandbox failures in ask-shadow, cli/main, schema-conformance, and tool-descriptions; the full-run failures also include real containment tests that cannot start because sandbox-exec fails even on an allow-all probe in this managed macOS session. No sandbox rule was relaxed.
- A synthetic MCP Events connection exercised the actual embedded Event Intelligence adapter, persistent trigger inspection, wake delivery, TurnStore checkpoint, engine replay, and provider context. No owner Home, provider request, external account, or real event server was used.
- This follow-up is still local and uncommitted. PR #851 remains at ADJUST; no DCO attestation or integration is claimed.
