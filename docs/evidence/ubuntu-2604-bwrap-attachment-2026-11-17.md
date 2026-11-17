# Ubuntu 26.04 bubblewrap attachment, 2026-11-17

`ubuntu-latest` on this date is image `ubuntu-26.04` (`actions/runner-images`
`ubuntu26/20261111.196`), with `apparmor 5.0.2-0ubuntu1~26.04.1` and
`kernel.apparmor_restrict_unprivileged_userns=1`.

## What the runner did

`verifica` on `origin/dev` `2a245311` (workflow dispatch run
[44146250102](https://github.com/muffin-project/muffin-agent/actions/runs/44146250102))
loaded `scripts/install/bwrap.apparmor` onto `/usr/bin/bwrap` and the parser
exited 0. The probe then returned:

```text
available: false
reason: userns_denied
detail: bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
```

The same probe and the same 14 test failures happened on the dependency-floor
head `dad9e6d3` (run 44142376722). That head does not change the profile or
the install path. The suite also failed `systemd-analyze verify` because the
image warns that `CPUAccounting=` was removed from three host units
(`xfs_scrub_all.service`, `system-xfs_scrub.slice`, `walinuxagent.service`),
not from Muffin's unit.

## Why the profile load is not enough

Ubuntu 26.04's `apparmor` package ships `bwrap-userns-restrict` attached to
`/usr/bin/bwrap`. A second profile on that path is a conflicting attachment.
AppArmor then confines `bwrap` with `unprivileged_userns`, which denies
`net_admin`. Launchpad
[#2169201](https://bugs.launchpad.net/ubuntu/+source/apparmor/+bug/2169201)
records that sequence, on the same apparmor package version, ending in the
same `RTM_NEWADDR` line. Removing the extra attachment made bubblewrap work
again. Lowering `kernel.apparmor_restrict_unprivileged_userns` is not the
remedy: it would open the restriction for every unconfined process.

The installer already refuses to attach `muffin-bwrap` to `/usr/bin/bwrap`.
It renders the profile for the realpath of the Muffin-owned binary. CI was
the exception: `install-ci-bubblewrap.sh` installed the pinned 0.13.0 build
at prefix `/`, which on this image is `/usr/bin/bwrap`, and the workflow
substituted that path into the profile.

## What changed

CI installs that build at `/usr/local/bin/bwrap` and loads the profile on
that binary's realpath. The loader exits if the realpath is `/usr/bin/bwrap`
or `/bin/bwrap`. The lookup does not use sudo's `secure_path`: the probe
execs `bwrap` from the job PATH, where `/usr/local/bin` comes first.

The unit test and the owner-journey check (`e2e-giro-owner`) keep a
`systemd-analyze` diagnostic when it names the unit under test, and drop
diagnostics that name another absolute path. The journey still fails when
verify exits non-zero.
