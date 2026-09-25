# Linux AF_UNIX runtime gate — 2026-09-25

## Decision

On base `e8bfd19f33ce8a85840f971ffbc4bfc17928092a`, issue #638 remains open
after PR #650 merged the gateway-socket fix. `core/sandbox/executor.ts`
configures the pinned `@anthropic-ai/sandbox-runtime` 0.0.71 with
`allowAllUnixSockets: true` on Linux. That skips SRT's AF_UNIX seccomp filter;
the gateway socket deny does not cover every other visible local service.

**Claim:** while the Linux config permits all AF_UNIX sockets, Muffin exposes no
shell lane or scheduled-script executor through `buildRuntime`; macOS Seatbelt
keeps its existing shell availability, and `doctor` reports the Linux reason.

## Alternatives

| Option | Evidence and consequence |
| --- | --- |
| Deny only the gateway socket | PR #650 closes that exact re-entry path, but leaves other visible service sockets reachable. It cannot establish the broader Linux shell boundary. |
| Use SRT's path allowlist | The [current SRT README](https://github.com/anthropics/sandbox-runtime) says Linux ignores `allowUnixSockets` paths because seccomp cannot filter by path. |
| Remove `allowAllUnixSockets` and keep execution enabled | The [upstream #428](https://github.com/anthropics/sandbox-runtime/issues/428) and [#429](https://github.com/anthropics/sandbox-runtime/issues/429) record Ubuntu failures applying the filter; #429 remains open. A successful Bubblewrap probe alone does not prove SRT applied this filter. |
| Keep execution disabled until filtering is verified | Chosen. This removes Linux shell and unattended script execution, preserves macOS Seatbelt, and uses the existing shared fail-closed gate. |

## Verification contract

- A green Bubblewrap probe and patched version fixture still produce no
  `shell_run`, `shell_run_write`, or runtime executor.
- `doctor` warns with the AF_UNIX reason on that same fixture.
- A Seatbelt fixture keeps both shell lanes.
- Falsifier: any production runtime path exposes shell or scheduled scripts
  while `LINUX_ALLOW_ALL_UNIX_SOCKETS` is true, or doctor reports that boundary
  as usable.

Re-enable Linux execution only after the actual SRT invocation proves its
AF_UNIX filter is installed and blocks the relevant local IPC path; changing
the flag alone is not proof. CPU, memory, process-count, and descriptor quotas
remain separate work.
