# Root-launched VPS install: evidence and decision

**Date:** 2026-09-24
**Observed source:** `dev` candidate `db2bb7ac28d1c21f6113e18667361f7f4fa4364a`
**Profile:** CRITICAL — this changes who can read Muffin state and whether downloaded build scripts execute with host-root authority.
**Scope:** issue #654, the fresh-Ubuntu root-login path in the #464 dogfood vertical; not the broader #507 onboarding flow.

## Falsifiable failure

On the current installer path, running `install.sh` as root keeps `$HOME`, the checkout, Node, `npm install`, `muffin init`, and the user unit under root. A root-launched installation therefore builds third-party npm lifecycle scripts as root and supervises the gateway as root. This is not the target outcome: Muffin code and its model tools must run under a dedicated unprivileged identity.

## Production path observed

- `bootstrap.sh` stages `install.sh` and restores the controlling terminal. It does not change identity.
- `install.sh` defaults code and Node to `$HOME/.local/share/muffin`; it clones/builds in-process, writes a launcher under `$HOME/.local/bin`, initializes `$HOME/.muffin`, then invokes `muffin gateway install --write --start`.
- `cli/gateway.ts` writes a user unit and runs `systemctl --user` plus `loginctl enable-linger` for the caller identity. `core/gateway/supervisor.ts`'s doctor checks the user manager, failed state, and linger.
- `cli/update.ts` discovers symlink launchers in the user bindir and atomically flips those symlinks to install a release. A root wrapper must still enter through the service user's launcher for update/rollback to work.
- `evals/install/ubuntu.sh` currently requires Linux, assumes a non-root user with a throwaway `HOME`, and deliberately lacks a live user systemd manager. It cannot prove a root-to-service-user install, logout survival, or reboot survival.

## Options

| Candidate | Evidence for | Counter-evidence / cost | Decision |
|---|---|---|---|
| A. Root provisions a locked `muffin` account, enables its linger, then delegates all build/setup/CLI work to that account. A root-owned operator shim always runs Muffin as that account. | Smallest production-path change: current user unit, doctor, updates, release symlink and status checks remain the mechanism. Ubuntu `useradd` creates a locked account when no password is set; `--create-home` makes home creation explicit. systemd logind documents linger as the way to start/retain a user manager without an interactive login. | Requires explicit ownership/collision handling for an existing `muffin` account; needs an operator shim that does not grant every local user access to one tenant's data; relies on `loginctl`/user-manager behavior on supported Ubuntu. | **Selected for this slice**: it preserves the current supervisor contract and matches the root-login install journey in #654. Never adopt an unmarked existing account automatically. |
| B. Root provisions `muffin` and writes a system unit with `User=muffin`. | systemd's official `systemd.exec` contract explicitly supports `User=` for system services; no lingering user manager is needed. The service identity boundary is clear in the unit. | Current `muffin gateway install/status`, doctor, update/restart, and uninstall paths are built around `systemctl --user`. Supporting system units would broaden this slice across every supervisor lifecycle operation and needs its own failure matrix. | Strong future alternative if A fails on real Ubuntu or dogfood shows the user-manager model is operationally brittle. |
| C. Refuse root and require an already-unprivileged installer account. | Avoids a new privilege transition. | Contradicts the observed root-login VPS journey and issue #654's target. | Rejected for this vertical. |
| D. Continue the current root execution path. | No installer change. | npm lifecycle scripts, runtime tools, state, and gateway inherit host-root authority. | Rejected as unsafe. |

## Security and lifecycle constraints

1. Root may install required OS packages, create/validate the dedicated account, set locked-login and private-home permissions, enable/disable linger, and install/remove a root-owned shim. It must not run `npm`, build scripts, `muffin init`, or the gateway as root.
2. The `muffin` account must be non-login, receive a private home, and not be silently reused if it pre-exists without Muffin's root-owned install marker. Existing root/user data is never copied, overwritten, or deleted implicitly.
3. The global shim must be a root-owned regular file, require effective UID 0, and execute the per-user launcher with a clean, allowlisted environment. The supported operator invocation is `sudo muffin ...`; a world-executable shim must not let an arbitrary local user inspect or control the tenant's agent.
4. API-key contents remain on stdin or in a private file. Root delegation may pass a file path but must not put its contents in argv, environment, logs, or a world-readable temporary directory.
5. Repeated install must validate the managed account and repair the same install. Uninstall stops/disables the user unit and removes only the managed shim/launcher; it preserves the service account and data unless the owner explicitly invokes Muffin's data-removal command.
6. A service-owned launcher symlink must remain visible to the existing update/rollback and unit planner. The global shim must not be a symlink into the checkout: `cli/update.ts` discovers and atomically flips every owned launcher symlink in known bindirs, which would include `/usr/local/bin/muffin` and then fail for the non-root service UID. The shim calls the service-owned launcher, which remains the only update-managed link.

## Sources and limits

- Ubuntu Noble `useradd(8)`: a new account has a locked password when no password is supplied; `--create-home` explicitly creates the home; `--system` does not create a home unless paired with `--create-home`. <https://manpages.ubuntu.com/manpages/noble/man8/useradd.8.html>
- systemd `org.freedesktop.login1(5)`: `SetUserLinger` controls lingering and names the authorization boundary. <https://github.com/systemd/systemd/blob/main/man/org.freedesktop.login1.xml>
- systemd polkit policy distinguishes self-linger from managing another user's linger. <https://github.com/systemd/systemd/blob/main/src/login/org.freedesktop.login1.policy>
- systemd `systemd.exec(5)`: system services default to root unless `User=` selects another Unix identity; this is the main evidence for candidate B. <https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml>
- util-linux `runuser(1)`: root-only identity switching, explicit target command, login environment handling, optional pty, and its shared-terminal warning. <https://man7.org/linux/man-pages/man1/runuser.1.html>
- GNU `env(1)`: `-i` starts the delegated process with an empty environment. <https://www.man7.org/linux/man-pages/man1/env.1.html>

These sources establish the OS mechanisms, not Muffin's end-to-end behavior. The critical falsifier is a disposable Ubuntu 24.04 guest: root invocation → build/init and gateway process UID are `muffin` → `doctor` green for supervision → process remains after logout and returns after reboot → a non-sudo local user cannot read or control the service home. A macOS shell test or the existing no-user-bus container eval cannot close this claim.

**Local OS probe (2026-09-24):** `docker run --rm ubuntu:24.04 ... useradd --user-group --create-home --home-dir /var/lib/muffin --shell /usr/sbin/nologin muffin` returned UID/GID 1001, `passwd -S` state `L`, and home mode `0750`. This confirms the account primitives on the target distribution and falsifies the assumption that `useradd` alone produces a `0700` home. We must tighten it explicitly. This container had no systemd manager and proves no linger, logout, reboot, or Muffin behavior.

**Root-account component (2026-09-24, uncommitted worktree):** `evals/install/root-account-state.sh` passed in a disposable `ubuntu:24.04` container. It observed refusal of an unmanaged existing account without creating a home or marker; verified a new account is password-locked, `nologin`, sole-member of its private group, and owns a `0700` home; verified the external root marker is `root:root 0600`; then verified reruns accept unchanged state but refuse unexpected supplementary groups and a changed home mode without repairing them. The end-to-end root eval below now covers the canonical bootstrap and command collision boundary too.

## Decision

**Proposed claim:** A fresh Ubuntu VPS can start installation from the provider's root login while every Muffin build/runtime process and its private state belong to a dedicated non-login account, and the existing update/doctor/supervisor contract remains intact.

**Owner decision (2026-09-24):** choose A: provision a locked `muffin` account and reuse its systemd user manager with linger. This preserves the existing gateway, doctor and update paths. B remains a future alternative if the real Ubuntu VM check shows this manager lifecycle is unreliable.

## Peer review and implementation gate

The first implementation draft was not applied: automatic review rejected a patch that combined account creation, package installation, `/usr/local` writes and root-to-user delegation. A separate remote-helper approach was also rejected as too coupled. The owner later explicitly authorized narrower patches and disposable-container tests. The rejected remote-helper approach remains absent; the current root handoff stays inline in `install.sh`. A review also exposed a real root-path hazard: creating or `chown`ing service-owned paths on every reinstall could let the service account substitute symlinks before root touched them. The installer now creates the initial tree before service code runs, then validates its ownership, mode and symlink shape on later runs instead of repairing it as root.

**Read-only peer review (2026-09-24):** the reviewer confirmed the current user-manager path is the smaller fit for #654 and raised these attack surfaces. I checked each against the source before recording it:

- A world-executable root dispatcher must reject non-root callers. Otherwise any local account could run CLI operations against the one Muffin tenant. The documented path will be `sudo muffin ...`.
- `bootstrap.sh` stages the installer in a `mktemp` directory with mode `0700`. That file cannot be executed by `muffin`; root must copy the installer to a root-owned, traversable staging directory while keeping the file non-writable to the service account. The bootstrap's `/dev/tty` redirection must remain attached through the identity switch.
- `MUFFIN_API_KEY_FILE` may point somewhere root-only. If set, root must create a private, service-readable temporary copy, never pass the value in argv or environment, and remove it on both success and failure.
- The supervisor activation list calls `systemctl --user` before its explicit linger command. Root bootstrap must enable linger before delegating install/start, and the real user manager still needs VM verification.
- `cli/update.ts` treats symlinks into the checkout as update-managed launcher links. A global symlink under `/usr/local/bin` would be included and then be unwritable to the service account. The global command therefore stays a regular root-owned shim, while the per-user launcher remains the update-managed symlink.
- The existing user `--uninstall` path only removes launchers that point at the current build. Root `--uninstall` now has a separate ordered service-stop check and removes the verified dispatcher, launcher and program while preserving the service account and data.

The review also confirmed the no-chown-on-rerun rule is load-bearing. An unmarked pre-existing service account or home must fail without mutation; a managed home with unexpected owner, mode, or symlink shape must fail closed rather than be repaired as root.

## Current implementation and evidence

`root-account-state.sh`, `root-boundary.sh` and `root-handoff.sh` all passed together in a disposable Ubuntu 24.04 container after the local image was given the bootstrap prerequisites (`ca-certificates`, `curl`, `git`, `passwd`, `util-linux`, `xz-utils`). The handoff eval uses a local Git fixture and fake Node/npm, `loginctl` and `systemctl` commands; it verifies the real bootstrap and installer create the account, run build/setup/gateway commands as `muffin`, preserve key stdin and file-mode rules, keep the shim unavailable to an ordinary user, accept a managed reinstall, and preserve data/account during root uninstall. It also injects a manager-query failure and a still-active gateway after the unit file is missing; both attempts must leave the program, shim, unit file and linger intact. This tests the wiring and fail-closed decisions, not a real build or a live systemd service.

The existing personal-install acceptance, `evals/install/ubuntu.sh`, also passed on a temporary copy of the current worktree in Ubuntu 24.04. It downloaded and checksum-verified Node 22, built the real application, initialized a throwaway Home, reported 0 red checks in `muffin doctor`, had systemd validate the generated unit, ran that unit's actual `ExecStart` in the foreground, then completed update, rollback and the existing-Home reinstall case. It returned installer exit 3 because the container had no user systemd bus; the eval expects that result and verifies the documented no-bus behavior. Its seven doctor warnings include environment-dependent setup/sandbox/supervisor states and are not evidence of a fully configured VPS.

The adversarial peer review found that a failed `systemctl is-active` query could be mistaken for an inactive service. The installer now accepts only explicit `inactive` or `failed` states (and `unknown` only when the unit file is absent), and the handoff eval exercises both a query error and a missing-unit-but-active service. A second review confirmed these checks close the reported removal gaps.

## Live Lima VM evidence (2026-09-24)

The test guest ran locally on the Mac with Lima: Ubuntu 24.04.4 LTS, ARM64,
2 CPUs, 4 GiB RAM, 16 GiB disk, instance `muffin-root-acceptance`. The source
was a disposable local Git remote inside the guest, not GitHub. A fake,
deliberately invalid provider key was used; no real credential or Telegram
token entered the VM.

- The canonical root bootstrap installed Node 22.23.3 with its published
  checksum, built the application with real npm, ran setup as the locked
  `muffin` account, and started the actual user-systemd gateway. The observed
  process was `node ... muffin gateway run` with UID 1000, GID 1001; the guest's
  `loginctl` showed `Linger=yes`.
- After closing the install session, a separate check showed no login sessions
  for `muffin` while the gateway remained active. After a full Lima stop/start,
  systemd started the gateway again as `muffin` (new PID 838).
- A separate commit was published only to the guest's local test remote. The
  real updater created a release worktree, ran `npm ci`, built it, smoke-tested
  `--help`, switched the service-owned launcher and restarted the gateway. The
  rollback command returned the launcher to the previous checkout and restarted
  the gateway. This verifies the mechanism against a synthetic local history,
  not an upstream release or GitHub branch.
- The real root uninstall stopped and disabled the unit, removed the program
  and global command, and disabled linger. Follow-up checks found no Muffin
  process or program tree; the `muffin` account remained locked with
  `/usr/sbin/nologin`, and `/var/lib/muffin/.muffin/config.json` remained owned
  by that account with mode `0600`.
- After manually installing Ubuntu's `apparmor-profiles` package profile
  `bwrap-userns-restrict` and loading it in this disposable guest, `muffin
  doctor` reported a real Bubblewrap containment and enabled `shell_run`. The
  installer currently does not install or load that profile. Before this manual
  step, Ubuntu 24.04's AppArmor user-namespace restriction prevented Bubblewrap
  from creating its network namespace. The persistent host policy change is
  waiting for the owner's explicit decision; this experiment is not a product
  install result.
- `muffin doctor` after reboot confirmed the gateway, linger and sandbox, but
  exited 1 because it also reported single-user root-of-trust mode, an empty
  vector index and no consolidation history. `muffin doctor --online` with the
  fake provider key received HTTP 401, as expected; this is not provider
  acceptance.

The live VM closes the systemd process-identity, logout, reboot, update,
rollback and uninstall lifecycle checks for the root handoff. It does not close
provider onboarding, Telegram DM/group smoke, AppArmor installation policy, or
the unauthenticated public `curl` path while the repository is private. Keep
issue #654 open until those remaining acceptance items are addressed.

Official behavior references: [systemd `loginctl`](https://www.freedesktop.org/software/systemd/man/252/loginctl.html) documents that linger starts a user manager at boot and keeps it after logout; [systemd `systemctl`](https://cgit.freedesktop.org/systemd/systemd/tree/man/systemctl.xml?id=9749cd77bc6121a304a7f1eb0f03f26e620dc9da) documents `is-active` as both a state query and a nonzero result when no unit is active. Ubuntu documents the AppArmor restriction on unprivileged user namespaces in [Ubuntu Security Features](https://wiki.ubuntu.com/Security/Features). These OS mechanisms were checked in the disposable guest; they do not establish provider or Telegram acceptance.

## Remaining security decisions

1. **What code may root trust?** `bootstrap.sh` downloads `install.sh` from the
   mutable GitHub `main` branch over HTTPS, then runs it as root. This still
   makes the repository's current branch the root-of-trust for a new server.
   The owner has been asked whether release verification must be in place before
   publication or whether explicit trust in GitHub HTTPS is the intended
   boundary. No pinning, signature, or attestation check has been added.
2. **How should Ubuntu enable Bubblewrap?** On this guest, Ubuntu 24.04's
   AppArmor user-namespace restriction stopped Bubblewrap until the distribution
   profile was manually loaded. Automatically loading that system-wide profile
   changes the policy for all `/usr/bin/bwrap` invocations and persists after
   uninstall. That installation choice is awaiting owner approval; the global
   AppArmor sysctl was not disabled.
3. **Runtime dependency baseline:** the exact base commit still resolves
   `@xmldom/xmldom 0.9.11`, which is affected by
   [GHSA-6gmq-8vp8-gcm6](https://github.com/xmldom/xmldom/security/advisories/GHSA-6gmq-8vp8-gcm6).
   Draft PR #678 updates it to `0.9.12` and reports a zero-vulnerability audit
   on its own head. This branch does not include that change; verify the
   integrated lockfile and audit before publishing.
