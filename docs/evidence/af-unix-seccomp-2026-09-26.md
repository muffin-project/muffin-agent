# Linux AF_UNIX seccomp filter — requested and verified (2026-09-26)

> Evidence record for the change that stopped treating "srt's seccomp stage can
> fail on Ubuntu" as "the filter can never work there". It answers the owner's
> question of 2026-09-25: *why can't we verify this in CI?*

## The question, and the wrong shortcut

`networkOff()` used to set `network.allowAllUnixSockets: true` on Linux because
upstream `anthropics/sandbox-runtime#428`/`#429` break the seccomp stage on
Ubuntu 24.04: the stock `bwrap-userns-restrict` AppArmor profile denies
`CAP_SYS_ADMIN` to bwrap's children, and `apply-seccomp` — which runs as
bwrap's child — aborts. The kernel of the shortcut was read as "the filter
cannot work here", so Muffin disabled it *always*, on every Linux host, and
accepted an unfiltered AF_UNIX surface everywhere.

The failure is not silent in either direction:

- with the filter requested, `apply-seccomp` either installs it or aborts — and
  when it aborts, every contained command fails, which the existing deny/allow
  self-test already reports as a broken containment;
- the one silent path is a missing `apply-seccomp` binary: srt logs a warning
  and continues **unfiltered**. That is a behavior, so it can be measured.

## What changed

1. `networkOff()` requests the filter (`allowAllUnixSockets: false`, srt's own
   default, stated explicitly) instead of disabling it.
2. `SandboxExecutor`'s self-test gained a third leg, through the same door as a
   real command: this process listens on a Unix socket in its scratch, an
   unsandboxed control leg must connect (proving the command works), and the
   contained leg must **not** connect. A contained connect that succeeds is
   `unix_filter_absent` — the missing-binary case — and the boundary is
   unavailable. An `apply-seccomp` abort (`setgroups`/`CAP_SYS_ADMIN`) is
   `contain_failed`, never a held filter; an unrecognised refusal is not
   evidence either.

## Measured on the production-side runner (2026-09-25/26)

CI `verifica` run [36198123804](https://github.com/muffin-project/muffin-agent/actions/runs/36198123804)
on `ubuntu-latest`, with upstream bubblewrap 0.13.0 installed by
`scripts/install-ci-bubblewrap.sh`:

- `core/sandbox/executor.test.ts` — **17/17 passed**, including the new
  behavioral AF_UNIX test: a contained `node` client was refused, with the
  kernel's `EPERM`.
- `core/sandbox/canale-controllo-irraggiungibile.test.ts` observed
  `NEGATO:EPERM` where it previously saw `EACCES`/`ENOENT` from the deny-read
  list: the refusal moved one layer down, from "the socket file is hidden" to
  "the socket cannot be created at all". This is the filter working.
- The 7 failures in that run were all in test files that mock `SandboxManager`
  and therefore never ran bwrap; their fixtures now model the seccomp refusal
  (`EPERM`), which is what the real manager produces on Linux.

Conclusion: on the runner that stands in for the production VPS, the filter is
applied and blocks `socket(AF_UNIX, …)`. Shell stays available there **with**
the filter rather than without it.

## Where this leaves the fail-closed gate

On a host where `apply-seccomp` cannot obtain its capability, the whole sandbox
refuses to run and `verify()` says so: no shell lane, no scheduled scripts,
`doctor` names the reason. That is the same posture the constant gate proposed,
but applied only where the measurement says it is needed, and with the shell
preserved where the filter holds. The owner's own machine is the other
production target: the boot self-test runs there too and decides.

## Limits

- This does not prove GitHub Support's history rewrite removed every personal
  datum (that is #464's separate gate).
- It does not add CPU, memory, process-count or file-descriptor quotas.
- The filter blocks `socket(AF_UNIX, …)`; it is not a general "no local IPC"
  claim — inherited descriptors, for example, are outside it.
