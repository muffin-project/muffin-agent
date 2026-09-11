# Self-hosted CI plan — 2026-09-11

## Why this exists

GitHub-hosted Actions for the private repository are currently blocked before job steps begin, while the owner has a Mac capable of hosting an isolated runner. `scripts/ci-local.ts` remains a useful fallback because it derives `run:` steps from the workflow YAML instead of duplicating them, but it is still an emulator: it recreates GitHub Actions inside Docker, has special handling for AppArmor, and cannot be the canonical CI path when a real runner is available.

## Direction

Use GitHub Actions with a repository-scoped **self-hosted Linux ARM64 runner inside an isolated Linux VM on the owner's Mac**.

Do **not** register the owner's normal macOS environment directly as the primary runner:

- Muffin's current CI intentionally exercises Linux-only behavior (`bwrap`, AppArmor, systemd).
- A direct self-hosted runner executes workflow code with persistent access to the host; the owner's normal Mac contains unrelated credentials and state.
- The VM must not mount the owner's home directory, forward the owner's SSH agent, or inherit unrelated credentials.

The VM is CI infrastructure, not a development checkout.

## Target runner contract

- repository-level runner, only for `GiustoPiedimonte/muffin-agent`;
- Ubuntu 24.04+ ARM64;
- default labels `self-hosted`, `linux`, `ARM64` plus custom label `muffin-ci`;
- Node 22 is still installed through the workflow's `actions/setup-node` step rather than assumed from the VM image;
- Docker available because the repository's separate local/install acceptance gates may require it;
- AppArmor, bubblewrap, socat, ripgrep and systemd available through the full Linux VM, not a Docker imitation;
- no owner secrets copied into the VM;
- workflows retain minimal `GITHUB_TOKEN` permissions (`contents: read` unless a job proves it needs more).

Expected routing shape:

```yaml
runs-on: [self-hosted, linux, ARM64, muffin-ci]
```

The workflow YAML remains the canonical CI definition. `scripts/ci-local.ts` and `npm run gate:local` become fallback/local diagnostic paths, not the required merge gate.

## Migration sequence

1. Create the isolated Linux VM on the owner's Mac.
2. Register one repository-scoped GitHub Actions runner with custom label `muffin-ci`.
3. Prove it with a disposable smoke workflow/job that reports OS/arch and performs no repository mutation.
4. Change the current Linux workflows from `ubuntu-latest` to the self-hosted runner labels without rewriting their steps.
5. Run the real PR workflows on an existing integration PR and compare results to the current local targeted tests.
6. Only after the real runner is proven, demote `ci:local` from declared replacement to fallback and update stale comments/docs.
7. Keep architecture differences explicit: this runner is Linux ARM64 while the current production VPS may be x64. Add a separate x64/release proof only where a failure class actually depends on architecture.

## Security boundary

Self-hosted runners are persistent machines. Treat workflow code and dependencies as code execution inside the VM. The VM should contain nothing whose compromise would expose the owner's normal workstation. Repository-level scope and minimal workflow permissions limit blast radius but do not replace isolation.

## Current integration work

PR #502 remains unmerged until the real/self-hosted gate is available or the owner explicitly accepts the existing local gate as temporary evidence. The targeted suite already passed locally (typecheck plus 150/150 relevant tests); GitHub-hosted jobs currently fail before any step starts, so their red status is infrastructure, not a code verdict.
