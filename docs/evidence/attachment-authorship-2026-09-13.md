# Attachment authorship boundary

**Question.** Can text extracted from an attachment or audio be promoted as a
personal belief of the sender merely because the sender uploaded it?

**Observed tree.** Reviewed PR #530 head `8f963c791fde5ab08b9071592c197cbc8743462d`
against `dev` `9974a555235f653b81f0c7109f8e4fef43dfe002`, 2026-09-13. In
`connectors/discord/connector.ts`, attachment ingestion returns the extracted
document outline inside a plain `line`; `connectors/shared/ingress/router.ts`
then treats an arrival without `part` as `{source: 'author', tier: 0}`.
`core/memory/ingest.ts` assigns `speakerName: 'owner'` to every user-role
episode. Telegram's shared audio path also renders a transcript in the
`trascrizione` fence, while PR #530's `core/memory/authorship.ts` currently
allows that label into speaker-attributed extraction.

**Current invariant.** `connectors/shared/ingress/types.ts` defines a voice-note
transcription as `source: 'derived'`, explicitly not `author`: the words were
produced by a model reading audio, and a transcription error is not something
the sender said. `docs/SECURITY.md` separately defines tier 2 as content whose
authorship is not reliably the owner, including third-party material. Thus
content provenance and content trust are separate axes; authentication of the
uploader does not establish authorship of attachment bytes. This is consistent
with OWASP's treatment of uploaded and retrieved material as potentially
untrusted input and with the emerging empirical work on persistent memory
poisoning (see sources below).

| Candidate | Evidence and trade-off | Decision |
|---|---|---|
| A. Carry attachment/transcription provenance to the durable episode; extract only explicitly sender-authored text/captions; retain derived material for recall. | Preserves search and response context while preventing a speaker-label rewrite during extraction. Adds a small production-path seam and tests. | **Choose.** It follows the already-shipped ingress contract and keeps the change reversible. |
| B. Keep transcript and document text eligible, but special-case only Discord documents. | Does not cover audio whose speaker is unverified; duplicates policy across connectors and contradicts `source: 'derived'`. | Reject. The failure class is provenance, not a Discord-specific format. |
| C. Remove all attachment-derived text from turns and recall. | Reduces injection exposure, but loses useful document/audio evidence and is broader than the demonstrated memory-promotion defect. | Reject for this slice. Retain existing fences/taint and distinguish recall from belief extraction. |

**Chosen claim.** Only typed sender-authored message text and typed, non-forwarded
captions are eligible to become that sender's personal beliefs. Extracted
documents and transcripts remain available as tiered/fenced episodic evidence
for recall, but do not become owner facts without a later explicit typed
confirmation. This may lose convenient automatic remembering of genuine owner
voice notes; an explicit caption or follow-up text remains eligible.

**Falsification tests.** Exercise connector producer → shared ingress → durable
episode → memory extraction for (1) a Discord PDF containing a personal claim
and (2) a Telegram voice transcript. Verify full derived content remains
recallable, source/tier survives persistence, neither text is sent to owner
fact extraction, and typed text/caption still is. Removing the provenance handoff
must make these integration tests fail.

**External evidence and limits.** OWASP's Agentic Top 10 identifies memory
poisoning and calls out uploads and peer-agent exchanges as potentially
untrusted/partially trusted sources ([OWASP Top 10 for Agentic Applications](https://genai.owasp.org/download/52117/?tmstv=1765059207)). A recent preprint
reports stealthy memory injection across several personal-agent architectures,
including filesystem and vector-backed memory; this is emerging evidence, not
independent proof of Muffin's risk or of this exact mitigation
([When Claws Remember but Do Not Tell, arXiv:2607.05189](https://arxiv.org/abs/2607.05189)).
Peer implementations also expose provenance-aware memory operations, e.g.
[OpenClaw memory provenance and deletion](https://docs.openclaw.ai/concepts/memory-provenance),
but that does not establish a universal design requirement. Muffin's own
contract and the end-to-end tests remain the deciding evidence.
