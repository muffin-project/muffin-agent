# Tenant-scoped vector backlog repair — 2026-10-09

**Status:** dated evidence, not authority. **Base:** `31f1f6064e727102ecfcf12fffa0cce609901768`.

## Claim and observation

The existing doctor counts unindexed vector sources across tenants and tells the
owner to run `muffin memory extract`. The command's consolidation lane runs for
`host`; `VectorIndex.indexBacklog` also requires one tenant. Consequently a
non-host source could remain outside semantic recall even though the repair
command appeared to drain the reported backlog.

This is a vector-maintenance gap, not authorization to turn group messages into
owner facts. `Consolidator` intentionally refuses fact extraction outside
`host`: the extractor cannot reliably infer which human speaker a group `role`
represents. `recall` already supplies the conversation tenant to vector search,
and `chunks_vec` stores tenant as its partition key.

## Decision

Keep the existing ingestion lane and add one globally bounded page of
vector-only indexing for non-host tenants after its host page. Each result
retains its source tenant in both `chunks` and `chunks_vec`; the page is written
in one transaction while the existing durable memory lock is held. The same
path serves automatic end-of-turn ingestion and the manual repair command. The
200-row page ceiling is global, not per tenant.

This closes the misleading doctor-to-command path without adding a scheduler or
second memory writer. Changing doctor to count only `host` would conceal an
existing recall gap. Running fact extraction for groups would violate the
owner-fact boundary. Leaving group vectors permanently unindexed would discard
the existing tenant-partitioned recall capability.

## Peer evidence and limits

- [OpenClaw memory search](https://docs.openclaw.ai/concepts/memory-search)
  documents explicit session-memory scope and excludes group transcripts from
  cross-conversation recall. This supports preserving scope; it does not prove
  Muffin's product policy.
- [Letta attaching and detaching memory blocks](https://docs.letta.com/tutorials/attaching-detaching-blocks/)
  makes block access depend on explicit attachment. This is a useful comparison
  for tenant-local access, not a reason to introduce a second memory model.

The selected behavior is an inference from Muffin's existing tenant key and
recall path: index a group's evidence under that same group key, never merge it
into `host`, and never send it through fact extraction.

## Falsifiers and verification

- In-memory tests create two group tenants and `host`, drain one global row at a
  time, and verify that each tenant's search returns only its own evidence.
- A production-command integration test verifies that group evidence becomes
  searchable while remaining pending for fact extraction, with zero model chat
  calls; a second connection is refused the memory writer lock while embedding
  is in progress.
- The live owner-installation counters and memory content are deliberately not
  recorded in this repository.
