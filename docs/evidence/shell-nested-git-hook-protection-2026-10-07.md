# Nested Git hook writes from one shell command

**Claim:** a `shell_run_write` call may write ordinary project files and create
a nested Git repository, but cannot create a direct active hook below
`nested/.git/hooks`, even when that repository is created during the same
compound shell command.

## Observed failure and production path

Live `dev` was `f27a467ab54945473e7f96cb04c019fa4cf852b4`; issue [#862](https://github.com/muffin-project/muffin-agent/issues/862)
records the same-shell reproduction. `agent/runtime.ts` registers
`makeShellWriteTool`; `agent/tools/shell.ts` forwards that tool to
`SandboxExecutor.run`; `core/sandbox/executor.ts` pre-enumerates existing
`.git/hooks` directories before it compiles the sandbox profile. A nested
repository created later in that shell call is absent from the concrete deny
list. Deeper pre-enumeration cannot close this timing gap.

## Challenge and choice

| Candidate | Finding |
|---|---|
| Extend the pre-command scan | Cannot see a directory created after the scan. Rejected. |
| Parse shell text for `git init`, redirections or hook names | Shell syntax is composable and obfuscatable; a parser would be an incomplete second policy boundary. Rejected. |
| Deny hook paths in the OS sandbox profile and test that profile through the real runtime door | The kernel evaluates each filesystem operation after the path exists. It leaves ordinary writes and nested repositories available. Chosen. |
| Replace arbitrary shell with a narrower Git/repository capability | A possible broader redesign, but no current primitive covers coding workflows; outside this bounded invariant. |

On native Linux, the shared bwrap profile retains `userns`, explicitly allows the
operations bwrap and its child need, and denies write/link access to every
active hook filename documented by Git. It uses an explicit `pix` stack for
bwrap children because bwrap sets `no-new-privs`; the stacked children keep the
hook denies. The policy leaves
`*.sample` template files writable. The initial hosted run loaded a
`default_allow` profile, but the production child still created the hook; that
run did not isolate whether mode, profile attachment, or child stacking caused
it. The candidate uses enforce mode with an explicit child stack. The self-test
reads `/proc/self/attr/current` with the same shell builtin that attempts each
hook write, and includes that label in a failure diagnostic. The hosted job
records the AppArmor parser version. The exact-head Linux run must confirm the
denied writes and rule-removal mutation before this bounded claim is accepted.
[Ubuntu AppArmor profile syntax](https://manpages.ubuntu.com/manpages/noble/man5/apparmor.d.5.html)

The profile uses `attach_disconnected` to match the upstream bwrap policy;
Ubuntu's AppArmor documentation warns that this mode can alias disconnected
paths. That residual remains visible while the real bwrap boundary is tested.
The path deny is not a complete defense against a `.git/hooks` directory
symlink: AppArmor checks the resolved target path, and Git follows that symlink
during hook lookup. Issue #862's claim remains limited to direct hook writes
through the real `.git/hooks` directory. Issue [#865](https://github.com/muffin-project/muffin-agent/issues/865)
tracks production-path acceptance for this symlink redirection; it is separate
from #657's `.gitattributes` driver issue.

The installed macOS build did **not** keep this guarantee on the production
path. On 2026-10-09, `muffin doctor` on the owner's host, build `31f1f6064e72`,
returned `git_hooks_unprotected`: the real Seatbelt-wrapped self-test created
`nested/.git/hooks/applypatch-msg` (and reported hardlink, rename and alias
doors). SRT's built-in glob is rooted at the gateway process cwd, while Muffin
passes each turn's workspace cwd separately. The host-level deny therefore
missed hook paths under a workspace elsewhere on disk.

The candidate adds exact active-hook leaf globs to each macOS per-call
`denyWrite` profile and to the executor's same-door self-test. This keeps the
protection independent of the gateway cwd while leaving Git's `*.sample`
templates writable. Linux continues to rely on its AppArmor policy and
concrete per-call scan; SRT drops write globs on that backend. Git documents
the active hook names, including `fsmonitor-watchmanv2`, the default
`$GIT_DIR/hooks` location, and the configurable `core.hooksPath`.
[Git hooks manual](https://git-scm.com/docs/githooks)

The shared profile is rendered by Linux CI and can be loaded against a native
host's bwrap binary. Docker's `security_opt apparmor=...` applies one profile to
the whole container and replaces `docker-default`; the existing experimental
Compose override is not this per-bwrap policy. The Docker shell path therefore
has no accepted hook-protection result and must fail closed until a container
policy preserves its default restrictions and passes the same runtime and
mutation checks. [Docker AppArmor documentation](https://docs.docker.com/engine/security/apparmor/)

## Evidence in the candidate

- `core/sandbox/executor.test.ts` exercises ordinary writes, nested `git init`
  and `git add`, a hook created in that same call, and the existing top-level
  hook path using the real sandbox binary.
- `core/sandbox/executor.ts` adds a real `SandboxManager` self-test leg. It
  repeats the positive controls, prints the effective AppArmor label, then
  attempts every active hook name with no concrete hook path in `denyWrite`.
  Any allowed write yields `git_hooks_unprotected`; `ensureInit()` refuses the
  caller's command.
- `core/sandbox/executor.selftest.test.ts` fault-injects a missing hook deny
  and asserts the typed failure prevents a caller command from running.
- `agent/runtime-wiring.test.ts` drives the registered `shell_run_write`
  through `buildRuntime` and `runTurn`, then inspects the resulting ordinary
  files, Git index, and absent nested `pre-commit`, `fsmonitor-watchmanv2`, and
  top-level hook files. It also checks the tool result for the typed
  containment failure so a rule-removal mutation fails for the exact reason.
- Both Linux CI profiles render the shared template. `verifica` then removes
  only the explicit hook rules, reloads AppArmor, and reruns the same
  production-runtime test. The mutation step requires the failure output to
  contain `git_hooks_unprotected`; an unrelated failure does not count.

### macOS production-path correction, 2026-10-09

The failing owner-host check and the repair were reproduced against the same
base build. The isolated slice changes only `core/sandbox/executor.ts`; it does
not change the shell read scope, policy, approval semantics, or Linux AppArmor
rules.

- Installed `muffin doctor --json`, outside Codex's nested sandbox, reported
  `sandbox: warn`, reason `git_hooks_unprotected`, with direct
  `applypatch-msg` creation allowed. The live Gateway stayed running and was
  not restarted or modified.
- Running the candidate source's `doctor` on the same host reported
  `sandbox: ok`, `seatbelt: a real containment ran and held`. This executes the
  candidate's actual `SandboxExecutor.verify()` path; it does not claim the
  installed Gateway has been updated.
- The candidate self-test runs `git init` with a synthetic
  `pre-commit.sample`, confirms that template is present, then attempts every
  active hook leaf plus hardlink, rename, and pre-existing hooks-symlink
  controls. `git add` and ordinary writes remain positive controls.
- On the host, `agent/runtime-wiring.test.ts`,
  `core/sandbox/executor.selftest.test.ts`, and
  `core/sandbox/executor.test.ts` passed: 70 passed, 2 platform-specific tests
  skipped. The production runtime-wiring turn ran the registered shell write
  tool through real Seatbelt with a scripted provider. This is not evidence of
  real-model selection.
- `npm run typecheck` and `git diff --check` passed. No owner files or install
  data were changed; the temporary dependency symlink used by this worktree was
  removed after verification.

Host evidence source pin: the 2026-10-09 production-cwd positive run and matching deny-removal mutation were executed against the implementation content in commit `87ff4c7b8e865821e5bcb7fd068c7828527f41b5`. This corrective candidate retains the identical `core/sandbox/executor.ts` source; the follow-up changes the evidence note and commit metadata only. Hosted checks and independent review still need to validate the resulting exact head.

## Limits and reversal conditions

Amendment 2026-10-08 (2): removing `audit deny capability` alone changed
nothing — the rerun failed identically, because enforce mode denies
capabilities that no rule allows. The child profile now carries
`allow capability` like its parent: stacked children keep the rights bwrap
had, and the hook denies in the parent profile still apply to the stack.
Capability stripping for shell children remains a separate real-host
follow-up, not part of #862. The exact-head Linux run must confirm the
denied writes and the rule-removal mutation on this amended head before the
bounded claim is accepted.

This closes direct active hook filenames under a real `.git/hooks` directory.
Git's `core.hooksPath`, a Git directory placed elsewhere, and symlink-based
path redirection (#865) are outside this claim. Path redirection is not the
`.gitattributes` driver activation tracked by #657. A future Git hook name
must be added to the AppArmor list and the real-binary test before it is
treated as protected.

The choice is falsified if ordinary writes or `git add` fail, a default
`.sample` hook cannot be created, any direct active hook path is written, or
deleting the AppArmor rule leaves the production-path test green.
Hosted Linux Actions must prove the candidate on its exact head. The local
macOS host now provides real Seatbelt evidence for this candidate, but this
does not replace Linux CI, review on the exact candidate, or acceptance after
integration and installation. The owner installation remains on build
`31f1f6064e72` until a reviewed update is promoted.
