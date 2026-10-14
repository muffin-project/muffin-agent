# Shell read allowlist probe (2026-10-08)

This record reopens ADR-0091's technical assumption that the pinned sandbox
runtime cannot build a read scope. It does not reverse the approval decision
or claim that the installed Home uses this source.

## Observed Muffin path and failure

The production path is `agent/runtime.ts` → `makeShellTool` /
`makeShellWriteTool` → `SandboxExecutor.runReadOnly` / `run` →
`SandboxManager.wrapWithSandboxArgv`. The runtime passes the workspace as a
write scope, but the sandbox starts with a read-only bind of `/` and only a
finite sensitive-path deny list. `core/sandbox/executor.test.ts` records the
outside-workspace read as an expected success. Thus a read-only shell can
return any readable host file to the model; the owner-install approval gate
does not confine that data flow.

The observed candidate dependency is `@anthropic-ai/sandbox-runtime@0.0.71`.
Its [tagged README](https://github.com/anthropics/sandbox-runtime/blob/v0.0.71/README.md)
documents `denyRead` plus `allowRead`, including a workspace-only recipe.
Its [tagged implementation](https://github.com/anthropics/sandbox-runtime/blob/v0.0.71/src/sandbox/sandbox-manager.ts)
uses per-call `allowRead` on macOS/Linux; Windows only accepts read grants at
session initialization. Muffin can provide the scope in the session config,
which is also the portable shape. A per-call override must repeat the root
deny because SRT replaces a filesystem field when a caller supplies it.

## Local probes

All probes used synthetic files under `/private/tmp`, disabled network
egress, and removed their scratch afterwards. They ran on macOS Seatbelt
through the pinned package:

- Allowing one directory while denying its parent let the command read a
  marker inside the allowed directory and refused a sibling marker.
- With a literal nested deny, the same profile refused a synthetic `.env`
  inside the allowed workspace, a symlink from that workspace to a sibling,
  and the sibling file itself.
- A root-deny profile re-allowing the checkout, its dependency tree, scratch,
  Node, and OS/toolchain roots ran `npm run typecheck` successfully. A read of
  `/private/etc/hosts` still failed.

The first real executor attempt did not reach the scoped-read canary: Apple's
`/usr/bin/git` shim called `xcode-select` for a selection link Seatbelt could
not read. Under the same existing `/Library/Developer` grant, the actual Git
binary at `/Library/Developer/CommandLineTools/usr/bin/git` completed the
nested-repository probe. The candidate uses that binary only when it would be
the first `git` in `PATH`; it does not add a read root. It also gives sandboxed
Git an inert global config and disables system config, since host Git config is
outside the new read scope. The self-test and production turn then passed with
plain `git` commands. An attempted `DEVELOPER_DIR`-derived read grant was
rejected by automatic review because an environment-controlled path could
reopen arbitrary data; no such grant is retained.

## Candidate production-path verification

At candidate HEAD `31f1f6064e727102ecfcf12fffa0cce609901768`, on macOS Seatbelt:

- `npm run typecheck` and `git diff --check`: passed.
- `core/sandbox/executor.selftest.test.ts`: 12 passed, 1 skipped.
- `core/sandbox/executor.test.ts`: 20 passed, 1 platform-gated skip. The live
  executor read an authorized file and refused a sibling, an outside symlink,
  and an explicit `.env` deny; write-scope and nested Git-hook controls passed.
- `core/sandbox/confine-sola-lettura.test.ts`: 12 passed, including the
  read-only/write-lane split, scratch, and no-egress controls.
- `agent/runtime-wiring.test.ts` filtered to the registered read-shell turn
  and Git-hook write turn: 2 passed, 38 unrelated cases skipped. These use a
  scripted provider, so they prove runtime registration and tool execution,
  not real-model discovery or selection.
- `evals/system/sandbox-overhead.ts --n 20`: Seatbelt median 63.9 ms per
  contained `true`, plain spawn median 7.0 ms, measured delta about 56.9 ms per
  command. This is a current-host measurement, not a before/after comparison.

The initial failing production attempt and the later passing attempt are both
part of the evidence: the candidate must not report the shell available when
its Git positive control fails. The current installed Home was not changed or
tested with this candidate. Linux CI and Windows remain unverified.

These probes and the passing candidate executor/runtime tests establish the
policy on this Mac candidate only. They do not establish Linux or Windows
behavior. The proposal changes a filesystem-read security boundary and remains
unratified; the installed Home still has the previous behavior.

## Decision required before integration

The owner must ratify the read boundary: deny reads from the filesystem root,
then grant the workspace, executor scratch, and configured system/tool roots.
The recommendation is to accept it after Linux CI exercises the same positive
and negative canaries; the Mac result shows the pinned SRT can enforce it and
the existing executor can retain Git functionality without opening another
filesystem root. Until then, this remains an uninstalled candidate.

## Decision table

| Candidate | Evidence for it | Counter-evidence / cost | Disposition |
|---|---|---|---|
| A. Keep the finite deny list and ask every shell call | Already wired; whole-host output is correctly treated as sensitive | A caller can still read personal files outside the finite list; repeated approval is not a containment boundary | Reject as the final filesystem policy |
| B. Use SRT's existing root deny plus explicit read roots | Exact pinned API supports it; macOS Seatbelt and candidate production-path tests held workspace, sibling, secret, and symlink controls | System/toolchain roots need a maintained list; Linux and Windows require live CI; the read boundary still requires owner ratification | Proposed, not integrated |
| C. Replace SRT or parse shell text to find paths | Could impose a different filesystem model | Adds a new runtime or a bypassable parser despite a working OS-level primitive already pinned | Reject |

The allowlist is built from the trusted runtime workspace, its disposable
scratch, the Node installation that is running Muffin, executable directories
already present in the process `PATH` (excluding the filesystem root and the
user-home root), and a short OS-specific set needed to launch programs. The
model cannot add paths. Secret denies are preserved and repeated in each
invocation. Writes remain scratch-only in `sys.shell` and workspace-scoped in
`sys.shell.write`; direct egress remains off.

The gate stays on `sys.shell`. Filesystem scope removes arbitrary file reads,
but the command still consumes host resources and has OS-specific process
visibility; this change alone does not justify changing its risk or approval
semantics.

## Falsifier

Through the real `SandboxExecutor` and runtime-registered shell tool, a command
must read an authorized workspace file, fail to read an outside canary, fail
to read a guarded secret inside the workspace, and fail to follow a symlink
out of the workspace. Existing write-scope, nested-Git-hook and no-egress
checks must continue to pass. The test must go red if the root deny or trusted
read scope is removed. Linux CI must execute these tests rather than skip them
before cross-platform installation claims change.
