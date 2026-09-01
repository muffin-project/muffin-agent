# M5 reconciliation — 2026-08-22

> **Superata — evidence storica, non un piano d'azione.**
> Questa passata fotografa il repository al 2026-08-22. Il 2026-08-25 la
> milestone RETURN TO OWNER (`docs/blueprint/M5-BIS.md`) ha riclassificato le
> righe che qui risultano da costruire: A6/A7/A8 (migrazioni versionate,
> backup validato) e D12 (l'ASK che mostra l'azione) hanno ora un meccanismo
> in HEAD e residui di sola osservazione. Anche i conteggi di branch qui
> elencati sono relativi a un `dev` di circa trenta commit fa.
> Chi legge questo file come lista di lavoro rifà cose già chiuse.


**Role:** working evidence, non-normative until the full pass is closed.  
**Observed runtime baseline:** `dev@81a61ead94f1cc18800b2623e84138fb7b2a0a06`.  
**Semantic baseline:** current `idea/runtime-topology` Architecture/Security + ADR-0050/0051/0052.

The old M5 summary (`16 READY · 32 BLOCKER · 7 OUT`) is not used as truth. This
pass starts from each row's question and asks what is actually missing now.

## Classification vocabulary

- **READY-observed** — current evidence already appears sufficient for the row's
  current claim; final M5 promotion still happens only after this pass checks the
  relevant evidence/profile.
- **MECHANISM** — code/schema/wiring required; acceptance alone cannot close it.
- **EVIDENCE** — the substantive mechanism is present; what remains is the
  verification profile's evidence, integrated acceptance or a real environment.
- **REAL-MODEL / REAL-SURFACE / REAL-MACHINE** — special evidence where a fake
  would materially change the claim.
- **COMPOSITE** — broad row whose residual truth depends on other mechanism and
  evidence rows; do not create a second implementation just to satisfy the label.
- **OUT→ROADMAP** — deliberately outside the 14-day Gate, with future phase
  placement owned by `docs/ROADMAP.md`.
- **REFRAME** — old row wording was narrower than the product/architecture now
  decided. Preserve proven subclaims, rewrite the Gate question instead of
  implementing stale prose.

## A · Installation / lifecycle

| Row | Current reality | Classification | Proposed reconciliation |
|---|---|---|---|
| A1 Boot | supervisor/gateway SIGKILL/replacement, suspended-turn resume and due-job recovery already proven; real reboot remains final battery | READY-observed + REAL-MACHINE final battery | Keep READY; do not pretend the final owner-machine reboot is already done. |
| A2 Identity | real owner `identity.md` reaches production prompt; character harness exists | REAL-MODEL evidence | Keep BLOCKER until one authorised run on the actual Gate model set + review. No runtime feature slice. |
| A3 Persona | persona/voice reach production prompt; 17-probe/18-property character harness exists | REAL-MODEL evidence | Same root as A2; close together. |
| A4 Config | hand-edit + validation/reseal mechanics exist | EVIDENCE | Add/cover config/reseal integrated journey; no new config subsystem. |
| A5 Doctor | tampered RoT is detected/named with remedy | READY-observed | Keep READY. |
| A6 Upgrade | no general versioned upgrade/migration path | MECHANISM | Same root as A7: schema evolution + explicit upgrade path. |
| A7 Migration | SQLite CHECK/schema evolution still lacks shared versioned runner/proof from populated old DB | MECHANISM / CRITICAL | Build with A6 before dogfood data becomes valuable. |
| A8 Backup | only cold-copy evidence; resident WAL/gateway hot backup + restore verbs absent | MECHANISM / CRITICAL | Hot backup/restore after schema evolution. |
| A9 Local setup | isolated `init --local`, secret reuse and home guard already accepted | READY-observed | Keep READY. |

## B · Runtime continuity / surfaces

| Row | Current reality | Classification | Proposed reconciliation |
|---|---|---|---|
| B1 Conversation | tenant-scoped continuity exists; real Telegram leg is not proven | REAL-SURFACE evidence | Close in one real Telegram owner journey together with ingress/delivery, not a new session architecture. |
| B2 Long-running | durable Turn/lane exists, but old "change `runTurn` to `enqueueTurn`" remedy is now too narrow | **REFRAME + MECHANISM / CRITICAL** | Rewrite as: a Surface continues durable receipt while Work is alive, and later input can COLLECT/STEER/FOLLOWUP/INTERRUPT at safe boundaries. ADR-0052 owns the shape. |
| B3 Wait | durable wait releases execution and is resumed by gateway lane | READY-observed | Keep READY. |
| B4 Todo | durable todo/taint/context behaviour exists | READY-observed | Keep READY. |
| B5 Resume | crash-interrupted turn resumes from durable row | READY-observed | Keep READY. |
| B6 Retry | provider transport retry exists, but tool/network/failure recovery remains incomplete | MECHANISM | One failure/retry family; avoid per-tool ad-hoc retries where semantics differ. |
| B7 Scheduler | occurrence→Turn idempotency and crash windows are proven | READY-observed | Keep READY; ADR-0052 generalises the lesson without changing scheduler identity. |
| B8 Delivery | negative failure state + durable delivery semantics exist; positive real Telegram leg belongs to owner journey | READY-observed + REAL-SURFACE final evidence | Keep row READY only if current profile evidence is accepted; exercise Telegram positive leg before final Gate. |
| B9 Proactivity | broad inferred triggers not needed for owner 14-day baseline | OUT→ROADMAP | MVP/evidence-driven proactivity; explicit jobs/reminders remain current functionality. |
| B10 Telegram media | text/docs mostly work; images do not reach provider as image blocks | MECHANISM | DAY-1: multi-image/multi-file + image-capable provider path + explicit errors. Compose with B16/ADR-0052 rather than separate media architecture. |
| B11 Streaming | CLI/REPL + Telegram streaming/placeholder path already wired and accepted | READY-observed | Keep READY. |
| B12 Overflow | huge tool result becomes destructive placeholder, no durable file handle | OUT→ROADMAP | MVP/context-pressure UX, promoted only by dogfood. |
| B13 Progress | structural progress consumer missing, but placeholder/streaming covers baseline presence | OUT→ROADMAP | MVP if dogfood shows streaming/placeholder insufficient. |
| B14 Attachment | `send_file`→Surface.deliverFile exists on real surfaces | EVIDENCE | Integrated file-production/delivery journey only. |
| B15 Owner binding | identify/impersonation guard exists; stable owner binding is still ordinary config, not protected authority | MECHANISM / security | Protect pairing/binding; future Nodes use ADR-0050 local ceiling but DAY-1 Telegram needs its own protected binding now. |
| B16 Ingress parsing | old forward/caption/filename minimum is proven, but new DAY-1 product contract is broader | **REFRAME + MECHANISM / CRITICAL** | Rewrite current row around typed multipart input + per-part provenance/taint for text/files/images/audio/reply relations used in DAY-1. Generic metadata envelope beyond real consumers remains OUT→ROADMAP/public-alpha. |
| B17 Discord resume | Discord not in 14-day personal surface set | OUT→ROADMAP | Public-alpha parity if Discord is a supported surface. |

### B2/B16/#78 relationship

Do not throw away `slice/inbound-unit`. Keep its durable inbox, event identity,
accept/bind/settle, crash matrix and idempotency evidence. Mediate the single
incorrect equivalence:

```text
old: update_id → exactly one Turn
new: native event → exactly-once semantic consumption
                  → one composition
                  → one target Work
                  (N events may share one Work)
```

B2 owns receipt while busy + routing into live/subsequent Work. B16 owns the
shape/provenance of the composed multipart ingress. B10 owns the concrete
Telegram media consumer. This avoids inventing three competing ingress stacks.

## C · Memory / acquisition

| Row | Current reality | Classification | Proposed reconciliation |
|---|---|---|---|
| C1 Memory write | evidence-first acquisition and later recall already accepted | READY-observed | Keep READY for automatic acquisition. ADR-0051 intentional MemoryProposal is default MVP unless dogfood proves it is necessary before Day 1. |
| C2 Extraction | automatic ingestion/extraction wiring exists | EVIDENCE | Journey J1; no new mechanism. |
| C3 Consolidation | consolidator/drain/dedup/review exists | EVIDENCE | Same J1 as C2. |
| C4 Recall/history | active vs superseded recall accepted in declared scope | READY-observed | Keep READY; known lower-case one-hop limitation is not silently widened into the claim. |
| C5 Provenance/why | owner CLI `memory why` exists, model cannot intentionally inspect provenance mid-turn | MECHANISM | Add model-facing read-only provenance primitive from same store; acceptance with document/memory journey. |
| C6 Temporal graph | as-of/history primitives and tool wiring exist | EVIDENCE | J1 temporal acceptance. |
| C7 PDF/docs | full text ingest/document_read path exists; scanned-only failure explicit | EVIDENCE | J2 acceptance. OCR/visual-layout understanding stays future unless another DAY-1 consumer requires it. |
| C8 Audio | audio is stored as opaque media, no transcription | **MECHANISM — owner decision resolved** | Voice is DAY-1. Remove "if needed". Minimal path: original audio Evidence → transcription (local/owner-controlled where configured) → typed transcript with provenance → composed input. |
| C9 Context pressure | no prompt-space signal; no 14-day consumer proven | OUT→ROADMAP | MVP/context-pressure experiment after dogfood. |
| C10 World state | conceptual distinction exists; no schema consumer | OUT→ROADMAP | Research/consumer-before-schema. |

## D · Capability / security

| Row | Current reality | Classification | Proposed reconciliation |
|---|---|---|---|
| D1 File read | realpath/symlink scope accepted | READY-observed | Keep READY. |
| D2 File write | reversible `draft` remains refused, so real safe write is unusable | MECHANISM / CRITICAL | Same root D3/D11: undo journal/snapshot enables reversible effects without converting draft to allow. |
| D3 Undo | no undo command/journal | MECHANISM / CRITICAL | Same root D2/D11. |
| D4 Shell | sandbox mechanism and Linux CI evidence exist | EVIDENCE / CRITICAL profile reconciliation | Put in integrated shell/process journey; do not rebuild sandbox. |
| D5 Process | typed list/kill exists; no Gate acceptance | EVIDENCE | Integrated shell/process journey. Owning arbitrary long-lived background processes remains OUT→ROADMAP unless dogfood needs it. |
| D6 HTTP | egress/query-param policy mechanism and deny/ask scenario exist; happy allow/fetch leg not proven in acceptance | EVIDENCE | J5 positive path with controlled reachable endpoint or equivalent evidence. No new HTTP architecture. |
| D7 Web search | query reaches kernel and tainted deny/ask path is accepted; real successful search leg absent | EVIDENCE / REAL-SERVICE if required | Prove happy path without weakening suite isolation; owner-machine real search can satisfy final leg if that is the narrowest honest evidence. |
| D8 MCP hot lifecycle | pinning/drift/restart removal is sufficient for 14-day scope | OUT→ROADMAP | Public-alpha hot lifecycle if MCP becomes supported extension surface. |
| D9 Skills | M5 text is stale: descriptions are nonce-fenced, fake-close neutralised, body returns tier 1, and production `buildRuntime` injects `skillsPromptSection` | **EVIDENCE-RECONCILE** | No mechanism slice. Verify existing red/mutation/judge evidence against the required profile; likely promote READY if sufficient, otherwise add the narrow missing proof only. |
| D10 Security | current declared taint/egress property accepted | READY-observed | Keep READY. |
| D11 Checkpoint | effect WAL exists; pre-effect snapshot/undo does not | MECHANISM / CRITICAL | Same D2/D3 root. Snapshot failure must fail closed when snapshot is the safety precondition. |
| D12 ASK | current approval lacks complete concrete plan/taint explanation and durable re-entry | MECHANISM / CRITICAL where effect/authority sensitive | Build one durable approval semantics; future Node local approval reuses ADR-0050's ExecutionPlan binding. |

## E · Economy / observability

| Row | Current reality | Classification | Proposed reconciliation |
|---|---|---|---|
| E1 Budget | monthly cap works; per-job/work bound absent | MECHANISM | Add bounded work/job spend where runaway background work can consume the owner budget. |
| E2 Cost | month/day spend visible and accepted | READY-observed | Keep READY. |
| E3 Tracing | trace/redaction mechanisms exist and secret boundary is accepted; generic reconstruct-a-turn acceptance absent | EVIDENCE | One generic trace reconstruction case, preferably reused inside another journey. |
| E4 Acceptance | real-binary acceptance mechanism exists and derives coverage from manifest/M5 | READY-observed | Keep READY; do not write a test whose only job is "test the tests". |
| E5 Failure | one judge failure class accepted, while provider/network/tool/delivery/scheduled-work classes depend on other rows | COMPOSITE | Do not build an `E5 subsystem`. Close B6/ASK/delivery/failure paths, then run an integrated failure synthesis and reclassify. |
| E6 Act caps | iteration cap does not bound parallel tool calls per model response | MECHANISM | Enforce real per-turn/action bound and test a multi-tool batch that attempts to exceed it. |
| E7 Self-inspection | no model-facing live-runtime inspection primitive | MECHANISM | `sys.inspect` read-only, sourced from the same authoritative readers as doctor/prompt/status; distinguish design from live state. |

## Working bucket totals — not Gate counts yet

Before resolving D9's existing evidence and the few composite/final-real-world
claims, the rows group approximately as:

```text
MECHANISM / REFRAME-mechanism   17
EVIDENCE / real-environment     15
COMPOSITE                        1
OUT → ROADMAP                    7
READY-observed                  15
                                --
                                55
```

These are **work classifications**, not proposed final M5 states. For example a
row can remain M5 `BLOCKER` while classified `EVIDENCE`; `READY-observed` still
needs the reconciliation pass to ensure no later code/architecture invalidated
its evidence.

If D9's already-recorded CRITICAL evidence is sufficient, it moves from
`EVIDENCE` to `READY-observed`; no code change is implied.

## Architecture-driven corrections that are no longer optional

1. **B2** must stop claiming that replacing one function call closes long-running
   surface UX. ADR-0052 requires durable receipt while Work is live plus explicit
   later-input semantics.
2. **B16** must stop calling the old narrow forward/caption minimum the whole
   DAY-1 ingress boundary. Typed multipart + provenance for actual DAY-1 media is
   required; the hypothetical universal envelope remains future work.
3. **C8** loses the "owner decision pending" branch. Voice is DAY-1.
4. **#78** is mediated, not discarded: exactly-once event identity remains
   CRITICAL, while event id == Turn id is superseded.
5. Every deliberate `OUT` receives a Roadmap destination; M5 does not become the
   future backlog.

## Residual checks before editing M5

- trace the exact existing evidence/profile for D9 skill-description fencing and
  decide whether it is READY without ceremony;
- confirm no later dev change invalidated the READY-observed rows;
- decide the narrowest honest positive-path evidence for D6/D7 and real Telegram
  B1/B8/B10/B16 journey;
- verify whether B14/C2/C3/C6/C7/D4/D5/E3 can be covered by a small number of
  integrated journeys rather than one scenario each;
- after those checks, rewrite M5 questions/status/evidence and recompute counts
  from the rows, then update PERCORSO only where order/dependency changed.