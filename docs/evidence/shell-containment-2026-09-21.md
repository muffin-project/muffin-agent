# Shell containment contract — falsifiers, decision, Linux results (2026-09-21/22)

Owns the evidence behind issues #638 (AF_UNIX gateway re-entry), #642
(Bubblewrap CVE-2026-87766 posture) and #645 (whole-host shell reads). The
current contract lives in `docs/architecture/SECURITY.md` §9; this file is the
dated record of what was observed, what was chosen, and what would reverse it.

Base at drafting: `origin/dev` at `6649663f944dae1ecae536012c19e615a64363e0`.
Rebased 2026-09-22 onto `d21d7dfdb0ef5425eb1a324a434d9de5508a75d0` (after
#659); work: `slice/shell-containment-638-642-645`, head `4fe4508a` after the
fail-closed commit (macOS pass first at `177ad194`). Environment: macOS 26 /
seatbelt for the base falsifiers; the Linux falsifiers of §5 were executed
2026-09-22 on `centria-zero` (Ubuntu 26.04, bwrap 0.11.1, AppArmor userns
profile installed) against this branch — first at `177ad194`, re-run
identical at `4fe4508a` — never manufactured, now no longer HOLD.

## 1. Falsifiers against base (all HOLD = vulnerability present)

Executed 2026-09-21 on the base commit with the production classes
(`mandatoryGuards`, `SandboxExecutor.runReadOnly`, `SessionStore`,
`ForwardHost` + real control socket, `sandboxOkDetail`):

- **F1 (#638):** `socketPathFor(home).path` (`home/gateway.sock`) is NOT covered
  by `mandatoryGuards(home, workspace).denyRead` (13 entries, none matching).
  Same-uid child + `allowAllUnixSockets: true` (`core/sandbox/executor.ts`
  `networkOff`) + `--ro-bind / /` ⇒ reachable on Linux. `chmod 0600` alone
  cannot close this by construction.
- **F2 (#638, control protocol):** `SessionStore.open('../../evil-traversal')`
  resolves to `<tmp>/evil-traversal.jsonl`, outside `<home>/sessions/`.
  `forward.ts readRunRequest` accepted any non-empty `sessionId`, and an
  accepted `run` is reconstructed as
  `principal: { kind: 'owner', connector: 'cli', externalId: 'local' }`,
  tenant `host`, with no caller taint — approvals round-trip on the same
  connection, so the requester answers its own prompts.
- **F3 (#645):** canary outside workspace and outside `denyRead`, read via
  production `runReadOnly` on macOS/seatbelt: exit 0, content visible. The
  exposure is not Linux-only. (`executor.test.ts` already pinned the
  limit: "reads outside it are NOT contained".)
- **F4 (#638, authority):** `runViaGateway` against a live `ForwardHost`
  executes with the owner principal above; invalid `sessionId` was not
  rejected before execution.
- **F5 (#642):** `sandboxOkDetail({ available: true, mechanism: 'bubblewrap' })`
  is an ok-level green line with no patch statement; no CVE/version check
  exists anywhere in `core/` or `cli/`.

## 2. Upstream / OS facts (primary sources, 2026-09-21)

- GHSA-pxhw-h44j-8pfx (published 2026-08-26): symlink traversal via `/oldroot`
  during setup; attacker needs files created by `bwrap` on
  attacker-controlled filesystem content (e.g. malicious app image); fixed in
  **upstream 0.12.0** (`openat2` `RESOLVE_IN_ROOT`); `< 0.12.0` affected;
  setuid builds unfixable by backport.
- USN-8779-1 (2026-09-17): fixed releases incl. `0.9.0-1ubuntu0.2` (noble).
- USN-8779-2 / Launchpad `0.9.0-1ubuntu0.3` (2026-09-17): **reverted** the
  CVE-2026-87766 fix (Flatpak regression, LP #2167621) pending a complete fix.
  Current Ubuntu CVE status for noble/jammy/resolute: **Vulnerable**.
- Consequence: any gate on `>= 0.9.0-1ubuntu0.2` is obsolete and backwards
  (the reverted `…0.3` compares greater while vulnerable). It is not
  implemented; `bubblewrap-version.test.ts` pins that absence. `bwrap
  --version` prints the upstream triple only, never the distro revision.

## 3. Muffin's exact invocation (measured in pinned srt 0.0.71)

- `networkOff()` sets `allowAllUnixSockets: true` on Linux, which skips the
  `apply-seccomp` stage entirely (`linux-sandbox-utils.js`: "Skipping seccomp
  filter - allowAllUnixSockets is enabled") — kept because upstream #428/#429
  break seccomp on Ubuntu 24.04.
- Filesystem: `--ro-bind / /`, then `--bind` per `allowWrite` (workspace,
  scratch), `--tmpfs`/`--ro-bind /dev/null` per `denyRead`, credential masks,
  `--dev /dev`, `--proc /proc`, proxy socket `--bind`s. Reads are deny-only;
  srt has **no allowlist for reads**, and skips deny entries that do not exist
  at wrap time. Deny globs are stripped on Linux.
- CVE applicability to this invocation is **undetermined**: the write scope
  (workspace) can hold attacker-controlled symlinks (cloned repo), and `bwrap`
  creates host mount-point stubs for absent deny paths. srt does
  resolve-before-mask and symlink checks, but the flaw is in `bwrap` setup
  itself. Ruling it out needs the Linux proof in §5, not prose.

## 4. Decision table

| Issue | Measured failure | Candidate A (chosen) | Candidate B | Candidate C (remove) | Why A |
|---|---|---|---|---|---|
| #638 socket | F1: socket reachable; F4: fresh owner turn | Deny socket+pointer in `mandatoryGuards.denyRead` (wiring, both lanes, fs+sandbox share the list) | Per-request nonce file | Disable gateway `run` | Filesystem ACLs cannot separate same-uid; a file nonce would live in sandbox-readable state. Unreachability is the narrow containment fix the issue prefers. |
| #638 protocol | F2: session path escape | Token alphabet (`isSafeControlToken`) enforced at `readRunRequest` AND `SessionStore.open` | Reject only at one layer | Leave open, document | Two layers because the channel and the path join are different owners; either alone re-opens the hole from the other side. |
| #642 | F5: green without proof | Fail-closed: one shared `assessShellBoundary` — shell lanes + job executor exposed only on behavioral pass AND trusted patch posture (`patched` only for upstream ≥ 0.12.0, else `unverified`); runtime omits the tools, doctor reports behavioral result and patch posture as separate facts | Ubuntu-revision gate; probe-only gate with doctor-only warning | Remove sandbox verdict | The revision gate is factually wrong after USN-8779-2; a probe-only gate with a doctor-only warning let runtime expose `shell_run` on bwrap 0.11.1 while doctor could only warn (the disagreement #642 filed); removing the verdict hides host state instead of grading it. |
| #645 | F3: whole-host reads as low-risk project lane | Fail-closed: flip `sys.shell` to `reversible: 'no'` → ask-always (ADR-0091), plus the statements (tool description, capability comment, doctor detail, SECURITY.md, `it.fails` canary) | Parse shell strings to block absolute paths | Leave `reversible: 'yes'`, document only | Linux measurement 2026-09-22 (§5): reads cover `~`, `/var/tmp` and host disk through production `runReadOnly`; pinned srt 0.0.71 has no read allowlist, so an allow-scoped surface is not constructible in-lane; shell-string parsing is bypassable theatre; the product call is fail-closed — disclosure into the model's context has no undo, so ADR-0074's own rule (ask ⇔ irreversible) puts the lane on the asking side. Document-only was the original Candidate A and is now rejected as masking: a stated exposure with a free-running gate is not a boundary. |

Chosen contract: **contained execution cannot reach the control channel;
every caller-controlled protocol token is alphabet-checked at two layers;
doctor never reports a green boundary it cannot prove; whole-host reads are
stated everywhere instead of implied AND gated behind an owner ask on every
call (ADR-0091).** Capability reduction was applied where provable (socket
surface, protocol surface, ask-gating of the read lane); read allow-scoping
needs a read-allowlisting runtime and stays a named reversal condition of
ADR-0091 rather than a HOLD left silent.

## 5. Linux falsifiers — executed 2026-09-22 (all closed as stated)

Host: `centria-zero`, Ubuntu 26.04, `bwrap 0.11.1`, AppArmor userns profile
installed (`bwrap --unshare-all … true` OK). Checkout of this branch at
`4fe4508a` (fail-closed head; first run at `177ad194`, re-run same counts),
`npm ci`, `MUFFIN_REQUIRE_SANDBOX=1`:

1. **§5(1) control socket — PASS (2/2).**
   `core/sandbox/canale-controllo-irraggiungibile.test.ts` ran (not skipped)
   and passed: served `gateway.sock` unreachable from production
   `mandatoryGuards` + `runReadOnly`, zero owner turns minted. Static deny
   (`core/rot/guards.test.ts`) holds live.
2. **§5(2) read-only containment — PASS (28/28 + 126).**
   `confine-sola-lettura.test.ts` + `executor.test.ts` under real bwrap: 28
   pass, `it.fails` canary still documenting whole-host exposure.
   `bubblewrap-version.test.ts` + `cli/doctor.test.ts` +
   `core/rot/guards.test.ts`: 126 pass; with bwrap 0.11.1 (< 0.12.0) doctor
   reports `unverified` → warn, fail-closed as specified.
3. **§5(3) CVE-2026-87766 probe against the pinned srt 0.0.71 argv — no host
   write observed.** Production argv carries **no** `--dir` flag (the literal
   GHSA vector); creation flags are `--ro-bind / /`, write-scope/scratch
   `--bind`s, `--tmpfs` deny dirs, `--ro-bind /dev/null` stubs. Shape A
   (workspace `sub/` → symlink to host dir, `SRT_DEBUG=1`): log shows
   `Resolved symlinked deny path … → <host>/hooks` then
   `Skipping non-existent deny path not within allowed paths` — resolve-before-mask
   plus the allowWrite check stop the vector; host dir empty, watch silent.
   Shape B (control, deny path a real host dir): the `--ro-bind /dev/null`
   stub mounts live and the watcher sees the ghost, then
   `Cleaned up bwrap mount point`. Raw bwrap without srt: `Read-only file
   system` / ENOENT, nothing created. One invocation, one host, upstream
   still unpatched at 0.11.1: this closes "needs a Linux proof" for the
   *observed* shapes; it does not move the version floor.
4. **§5(4) read allow-scoping vs ask-gating — RESOLVED as ask-gating
   (ADR-0091).** Host-read scope measured the same day through production
   `mandatoryGuards` + `SandboxExecutor.runReadOnly`: canary READ outside the
   workspace, READ in `~`, READ `/var/tmp`, host disk READ; denyRead control
   on `secrets/` NOT_READ (deny holds — re-run at `4fe4508a`; an earlier
   draft of the ad-hoc probe used `rot/` as the control, but `rot/` is
   deny-*write* only by design and reading it is not a deny failure). With
   no read allowlist in pinned srt,
   allow-scoping is not constructible in-lane; the product call landed on
   fail-closed: `shellCapability.reversible: 'yes' → 'no'`, kernel asks every
   call, both lanes of the shell now on the asking side of ADR-0074's rule.
   The `it.fails` canary stays: the *scope* is still allow-by-default, and
   flipping it still needs a real allow-scoped surface.

## 6. What would reverse this

- srt (or a replacement) gains read allowlisting or working Unix-socket
  blocking on Ubuntu 24.04 → narrow the warn surface, flip the canary, and —
  for reads specifically — a new ADR may return a *scoped* `sys.shell` to
  `reversible: 'yes'` with the measurement that justifies it (ADR-0091 names
  this as its own reversal condition).
- Upstream/distro ships a complete CVE-2026-87766 fix for the pinned
  invocation AND the §5(3) probe shapes pass on the patched floor →
  `patched` floor moves, warn copy changes.
- The §5(1) probe goes red on Linux → the deny does not hold live: fail
  closed further (socket relocation out of the bind, peer-credential binding
  via `SO_PEERCRED`, or disabling `run` while contained) — never silence.
- A product call reversing ADR-0091 (owner accepts whole-host reads as
  free-running again) → new ADR, not an edit of 0091; the evidence in §5
  stands either way.
