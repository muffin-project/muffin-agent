# Model proposal attribution: bounded correction

Observed base: `dev@1808cc1dfb2656c199cec006b6e0b259aed4d822`.
Claim: the registered `memory_propose` tool cannot choose an owner-authored
producer for a tuple that the model interpreted. CRITICAL (provenance).

The shipped tool accepted `kind: owner-stated` from the model, persisted it as
`producer=owner-stated`, and activated a fact with `origin=said`. Three new
registered-runtime regressions fail on the base: unrelated accountant data,
changed relation (`work in` versus `work on`), and legitimate remembering.
The original owner episode remains authenticated evidence; an extracted tuple
is an interpretation, even when it agrees with that episode.

The recovered #858 candidate blocks several attacks but its 372-line matcher
also accepts both relation variants after dropping prepositions. Its forget
path can retire a residence fact for `Forget my work project Rome` because a
unique retrieval hit is mistaken for an exact target. Fresh review: SPLIT.
The original staged candidate is preserved; neither mechanism is imported here.

| Option | Benefit | Counter-evidence / cost | Decision |
|---|---|---|---|
| Runtime assigns model tuples `agent-inference`; sources and reconciler stay unchanged | Removes model authority over attribution without restricting natural language or adding approval | Correct direct requests also produce inferred tuples; source evidence still records the owner's actual words | Choose for this bounded claim |
| Recover and expand the lexical equivalence matcher | Some exact short statements become owner-stated | Demonstrated meaning loss, earlier clause bypasses, language restrictions and maintenance | Reject for this slice |
| Require owner approval of every tuple | Explicit human-authored projection could establish stronger authority | Redundant confirmation conflicts with #858; current approval resource summaries are not structural identity | Separate product/security decision |
| Remove intentional proposal tool | Removes this attribution path | Loses immediate remembering; automatic extraction still interprets statements | Reject |

Prior art does not require a lexical grammar: pinned [Hermes memory tool](https://github.com/NousResearch/hermes-agent/blob/53bc70c5ee8544040cd9f0708d25c0f55276a44b/tools/memory_tool.py)
exposes model-authored memory edits; [OpenClaw memory](https://github.com/openclaw/openclaw/blob/94b92ccb37c8f7b83ef859b0a1dd24cad6d29497/docs/concepts/memory.md)
separates notes/history and documents action authority. These are different
product contracts, not proof of safe attribution in Muffin.
[CaMeL v2](https://arxiv.org/abs/2503.18813v2) separates trusted query control
from untrusted data; it motivates an authority boundary, not adopting its
architecture or treating word overlap as semantic proof.

The schema no longer offers `kind`; legacy extra arguments cannot select a
producer. Existing evidence validation, taint floor, identity, locking,
reconciliation, truthful receipts and replay behavior remain the execution path.
No data migration, second writer, or automatic relabeling of old facts.

Falsifiers: any tool-supplied kind becomes owner-stated; source evidence or taint
is lost; ordinary remembering no longer commits; replay creates another belief.
Required proof: registered-runtime negative and positive outcomes, existing
proposal/ingest tests, a fresh CRITICAL verdict, and exact-head required CI.
This slice does not close #858: forget target binding, consumed steering, and
extraction's separate `origin=said` behavior remain distinct unresolved claims.

## Verification

- Before the source repair, all three registered-runtime regressions fail:
  tool-authored tuples become `producer=owner-stated`, `origin=said`.
- After repair: proposal, runtime-wiring, canonical proposal, and ingest tests:
  **137 passed, 1 skipped** (the pre-existing sandbox-dependent runtime case).
  The updated registered contract also passes its three targeted cases, including
  a modern call without `kind`. Typecheck, compile and diff check pass.
- Compiled CLI real-model witness at `4ebce728fd397059c16bc5a93de42a2bd3899487`:
  two actual `gpt-6.1-sol` Responses requests, both HTTP 200, answered turn,
  model-selected `memory_propose`, schema and call omit `kind`. Independent
  read-only SQLite oracle verifies accepted proposal #2, active fact #2,
  `agent-inference` / `inferred`, original request episode #15, matching turn,
  and preserved runtime taint 2. No approval was injected.
- The existing authorized synthetic direct-inference Home was reused in place;
  no token was copied or read by the runner. Temporary profile removed; config
  and existing profile hashes matched. Wire recorder enforced fixed model,
  10-request / 180-second ceilings and no alternate inference route. Actual
  run used two requests in about 18 seconds. Remote output-token cap is not
  enforced by this ChatGPT route; active stream and parent deadlines bound time.
- Private evidence: `/private/tmp/muffin-memory-producer-live-aUWUe0/` with wire,
  CLI result and independently computed `oracle.json`. The runner and oracle
  are one-off private fixtures, not a new repository harness.
- Rebase onto `dev@ad04ff81` changes only the already-integrated doctor deadline
  and its regression compared with the live-tested tree. Memory, provider, loop,
  and CLI execution paths are byte-identical, so the live proof is reusable.
- Fresh CRITICAL review and required exact-head CI remain pending. Full #858
  acceptance is not claimed.
