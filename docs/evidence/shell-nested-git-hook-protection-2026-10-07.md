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

macOS keeps the pinned sandbox-runtime Seatbelt hook-path deny. The positive
control uses an empty Git template there because Seatbelt also denies Git's
default `.sample` hook files; Linux uses the normal template. Git documents
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
Codex host cannot run the real macOS sandbox, so that host is not evidence for
Seatbelt acceptance; the real-binary tests remain enabled on any supported
macOS runner.
