# G0 real-agent reconciliation — 2026-10-13

## Claim and decision

CRITICAL: a compiled-CLI journey must demonstrate model-selected progressive
capability discovery and a settled write, then an independently observed refusal
of an out-of-workspace write. This is a bounded CLI witness, not acceptance of
all #874 capability families or Telegram.

Recovered #881 at `ee9347e7`, preserving the existing branch/history and two
uncommitted scene refinements. The candidate incorporates dev `d37e032b`
(provider convergence #884). Archived OpenRouter runs remain positive PASS /
negative BLOCKED; they do not prove the new negative claim.

The production path is registered `fs_write.resolveEffectPath` →
`resolveInScope` → containment check, called by DRAFT preflight before
`undo.take` and `TurnStore.recordIntent`. A scope rejection currently shares
`draft_snapshot_failed` with an unrelated snapshot failure. Thus requiring only
kernel DENY misclassifies a real containment refusal; accepting generic errors
would certify the wrong failure path.

| Candidate | Evidence and falsifier | Decision |
| --- | --- | --- |
| Keep DENY-only oracle | Policy chooses DRAFT for reversible writes; resolver rejects before intent. Cannot witness this existing guard. | Reject |
| Match error text / unchanged file | Snapshot failures and model refusals also leave the file unchanged. | Reject |
| Add containment discriminant to existing PathDenied and existing call span | Correlated DRAFT + typed resolver refusal + zero DB intents + unchanged sentinel distinguish the actual path; removing discriminant must fail. | Choose |
| Replace policy or containment framework | No measured guard defect; changes authority instead of correcting evidence. | Reject |

The runtime correction is mechanical observability: no policy, schema, approval
or path-permission change. The new real-provider option reuses the compiled CLI,
canonical ChatGPT adapter delivered in #883, and the same scene oracles. It reuses
only an explicitly marked synthetic private test Home in place; copying tokens
or building a second agent runner would add credential movement and duplicate
production mechanics. A fixed model, bounded fetch observation, unique sessions
and workspace, and unchanged original config/profile hashes are required.

## Verification recorded so far

- Focused filesystem/preflight integration: 3 files, 57 tests PASS. Real
  `buildRuntime`/registered tool path; synthetic provider only for deterministic
  boundary coverage, never labelled real-model acceptance.
- Mutation: remove only `outside_scope` at the containment throw → integration
  FAIL (`undefined` rather than expected correlated attribute). Restore source
  from a copy → 57 tests PASS.
- Oracle suite: 13 tests PASS, including rejection of generic errors, unrelated
  traces/parents, stale spans, missing DB evidence, recorded intents and absent
  sentinel hashes.
- Live compiled-CLI positive/negative witness: NOT_RUN on this candidate yet.
- Exact-head CI / independent review / integration: NOT_RUN on this candidate.

The ChatGPT adapter cannot send `max_output_tokens` on the plan route. A token cap
must not be claimed for that route; enforce local deadlines/request limits and
report provider usage only when actually supplied. No paid provider fallback,
autoapproval, installed gateway or personal Home is part of this witness.
