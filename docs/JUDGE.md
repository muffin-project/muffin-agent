# Independent judge

This file defines the fresh review used for **CRITICAL** claims. FAST and
STANDARD are verified/integrated by the orchestrator under `ORCHESTRATION.md`.

A task does not become CRITICAL because it is long, autonomous or complicated.
It becomes CRITICAL because the claim crosses a risk boundary named by the
profile: authority/policy, taint/provenance, egress, secrets/RoT, durable schema,
backup/restore data risk, effects, exactly-once/idempotency, concurrency/fencing,
crash recovery, sandbox/containment or another boundary whose failure can cause
silent unsafe behaviour, data loss or duplicate effects.

## Mandate

**Review the guarantee, not the diff.**

Start from the production entry point and try to falsify the claim. A correct
mechanism with no real caller is not a working guarantee. A green test that
would stay green if the load-bearing wiring were removed is not evidence for
that wiring.

The judge is independent: fresh context, no implementation ownership, no
commits/pushes/merges.

## Five mandatory questions

Every CRITICAL review answers:

1. **Is the claim true at this head?**
2. **Does the production path actually reach the mechanism?**
3. **What material failure path can falsify it, and is that path covered?**
4. **Does the recorded evidence prove this claim rather than a nearby one?**
5. **Did the change create another risk that invalidates the claimed safety?**

Everything else is conditional.

## Conditional attack modules

Use only the modules relevant to the claim.

### Wiring and composition

- Trace entrypoint -> parsing/canonicalisation -> policy/decision -> execution ->
  durable outcome/delivery.
- Remove or bypass the load-bearing seam when mutation is part of the evidence
  budget. Which test fails for the expected reason?
- **Restore from a copy, never from git.** Take the copy *before* mutating and
  put it back with `cp`:

  ```
  cp <file> /tmp/base      # before mutating
  ...mutate, run the tests...
  cp /tmp/base <file>      # restore
  ```

  `git checkout -- <file>` and `git restore <file>` return the file to the
  **index or HEAD**, not to what it held a minute ago. During a mutation test
  the repairs under examination are usually uncommitted, so that command
  deletes exactly them and leaves the defective version in place — which then
  passes the wrong tests. This has happened twice here, the second time after
  it had been written down, which is why it is written *here*, next to the step
  that reaches for it. A guard hook refuses the dangerous form
  (`.claude/hooks/guard-restore-discard.mjs`), but hooks load at session start
  and a judge cannot rely on one being armed.

  To recover when it has already happened: `git checkout stash@{0} -- <file>`,
  or the reflog.
- Ask what two individually correct rules do to each other after N executions,
  not only after one.

### Authority / taint / egress / secrets

- Can untrusted bytes influence a resource or effect without the expected gate?
- Are principal, tenant, provenance and taint preserved through replay/history?
- Is a value described as secret kept outside logs, prompts, persisted tool
  content and subprocess environment as claimed?
- Does an allowlist/policy inspect the canonical resource actually executed?

### Effects / exactly-once / crash recovery

- Identify the durable identity/idempotency key.
- Enumerate crash points around intent, effect, outcome and delivery.
- Distinguish "not done", "done", and "possibly done"; do not silently turn
  uncertainty into retry.
- Verify claim ownership/fencing before a worker mutates durable state.

### Schema / migration / backup

- Start from populated prior state, not only a fresh database.
- Prove forward migration preserves canonical data and constraints.
- Test interruption/restart where a partial migration or hot backup can matter.
- Derived indexes/caches may rebuild; canonical evidence/work/effects/authority
  must not depend on that accident.

### Sandbox / containment

- Test the actual runtime boundary, not presence of a binary/config file.
- Try filesystem/network/env/process escape relevant to the claim.
- Fail closed when containment is unavailable if the capability promises
  containment.

### Generality

- Replace the dominant fixture with a second tenant/surface/provider/resource
  when the claim is meant to be generic.
- Look for hard-coded `host`, Telegram, one provider, one path or one principal
  masquerading as a structural guarantee.

## Evidence reuse

Do **not** rerun evidence merely because the judge is a new context.

A recorded proof may be reused when it names the head/SHA, command/scenario,
pre-fix or mutation state, observed failure and observed pass. Rerun it when:

- relevant code/tests changed;
- the evidence is incomplete or ambiguous;
- the judge suspects the test proves the wrong thing;
- a new mutation/fault is itself the review finding.

Independent review means independent reasoning, not duplicate compute.

## Findings

Each material finding is one of:

- **defect** — claim false or unsafe;
- **unproven** — claim may hold but evidence/production reach is missing;
- **follow-up** — real issue outside the current claim that does not invalidate
  it;
- **nit** — non-blocking local quality issue; use sparingly.

A finding blocks the slice only when it invalidates the current claim, prevents
its verification or creates a material unsafe/data-loss/duplicate-effect risk in
the same production path. Otherwise record it as follow-up and let the slice
converge.

For every blocking finding, state:

- exact production path/location;
- failing scenario or missing proof;
- at least one admissible repair direction;
- what evidence would turn the verdict.

## Verdicts

Exactly one:

- **MERGE** — the CRITICAL claim holds with sufficient evidence.
- **ADJUST** — specific blocking fixes are small enough to repair without
  changing the premise; another fresh review follows.
- **SPLIT** — multiple claims are coupled so review cannot establish them
  independently.
- **REJECT** — the premise/shape is wrong, not merely the implementation.
- **BLOCKED** — a required owner decision, environment or evidence is missing.

`MERGE`, `REJECT` and `BLOCKED` are terminal for the current review cycle.
`ADJUST`/`SPLIT` require a new fresh judge after repair/restructure.

Do not loop indefinitely. After repeated non-terminal reviews expose the same
root cause or stop producing new falsifiable evidence, escalate the shape to the
owner/orchestrator instead of adding ceremony.

## Report format

Keep the report compact:

```text
Claim reviewed:
Head/SHA:
Verdict:

Blocking findings:
- ...

Follow-ups:
- ...

Evidence inspected/reused/run:
- ...

Questions asked with no finding:
- ...
```

"Questions asked with no finding" matters: it tells the next reviewer which
attack surfaces were actually considered without turning every review into a
permanent checklist.

## Engagement rules

- Try to falsify, not confirm.
- Open the cited code/evidence; do not cite from memory.
- Do not mutate Git history or change branches in a shared worktree.
- Temporary probes/fixtures are removed before the review ends.
- Report uncertainty explicitly. `not proven` is preferable to invented
  confidence.
