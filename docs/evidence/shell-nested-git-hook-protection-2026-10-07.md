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

On Ubuntu, the shared bwrap profile uses AppArmor `default_allow`, retains
`userns`, and explicitly denies write/link access to the active hook names
documented by Git. AppArmor documents that `default_allow` honors explicit
deny rules, while `unconfined` generally does not; its AARE syntax supports
recursive `**` paths and brace alternatives. The finite names leave `*.sample`
template files writable. The deny is attached to the exact bwrap executable;
if that profile is absent or attached elsewhere, the runtime check fails
closed. [Ubuntu AppArmor profile syntax](https://manpages.ubuntu.com/manpages/noble/man5/apparmor.d.5.html)

macOS keeps the pinned sandbox-runtime Seatbelt hook-path deny. The positive
control uses an empty Git template there because Seatbelt also denies Git's
default `.sample` hook files; Linux uses the normal template. Git documents
the active hook names, the default `$GIT_DIR/hooks` location, and the
configurable `core.hooksPath`. [Git hooks manual](https://git-scm.com/docs/githooks)

## Evidence in the candidate

- `core/sandbox/executor.test.ts` exercises ordinary writes, nested `git init`
  and `git add`, a hook created in that same call, and the existing top-level
  hook path using the real sandbox binary.
- `core/sandbox/executor.ts` adds a real `SandboxManager` self-test leg. It
  repeats the positive controls, then attempts `nested/.git/hooks/pre-commit`
  with no concrete hook path in `denyWrite`. An allowed write yields
  `git_hooks_unprotected`; `ensureInit()` refuses the caller's command.
- `core/sandbox/executor.selftest.test.ts` fault-injects a missing hook deny
  and asserts the typed failure prevents a caller command from running.
- `agent/runtime-wiring.test.ts` drives the registered `shell_run_write`
  through `buildRuntime` and `runTurn`, then inspects the resulting ordinary
  files, Git index, and absent nested/top-level hook files. It also checks the
  tool result for the typed containment failure so a rule-removal mutation
  fails for the exact reason.
- Both Linux CI profiles render the shared template. `verifica` then removes
  only the explicit hook rules, reloads AppArmor, and reruns the same
  production-runtime test. The mutation step requires the failure output to
  contain `git_hooks_unprotected`; an unrelated failure does not count.

## Limits and reversal conditions

This closes direct active hook filenames under `.git/hooks`. It does not claim
coverage for `core.hooksPath`, a Git directory placed elsewhere, or path
redirection; those remain in #657. A future Git hook name must be added to the
AppArmor list and the real-binary test before it is treated as protected.

The choice is falsified if ordinary writes or `git add` fail, the hook path is
written, or deleting the AppArmor rule leaves the production-path test green.
Hosted Linux Actions must prove the candidate on its exact head. The local
Codex host cannot run the real macOS sandbox, so that host is not evidence for
Seatbelt acceptance; the real-binary tests remain enabled on any supported
macOS runner.
