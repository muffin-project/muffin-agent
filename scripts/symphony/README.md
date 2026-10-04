# Optional Symphony / OpenCode pilot

Symphony owns issue polling, claims, concurrency, retry and workspace lifecycle.
The repository/program orchestrator owns canonical work, READY, priority,
acceptance and integration. This package only adapts the pinned app-server
subset to `opencode run --format json --pure`. It is not a Codex implementation,
an ACP bridge, a scheduler or a product runtime dependency.

The generic implementation is distributed from this directory. Centria installs
the same source at a pinned commit; only `WORKFLOW.md`, `symphony.json` and its
canonical reserved-path predicate differ. Removing the pilot does not affect
normal repository development.

## Dependencies and install

- Python 3.11+, Git, GitHub CLI and Docker on one trusted operator host.
- Official Symphony v0.0.3, source pin
  `be10a1b79df723d6d7612b5651c8522704dafb2e`.
- OpenCode 1.18.33 is installed by the worker Dockerfile.
- A dedicated GitHub fine-grained credential restricted to the selected repo:
  Issues read, Contents write, Pull requests write, Actions read. No bypass,
  administration, deployment or organization permissions. The credential is
  host-side only. These permissions are needed to clone and publish branches;
  the worker receives a constrained MCP bridge rather than the credential.
- A dedicated OpenCode `auth.json` containing only the coding model credential,
  provided outside Git. Use the already configured provider/model; do not copy
  a production credential bundle or the user's complete HOME/config/MCP plugins.

Install the official executable from its release with the published checksum,
or build the exact source with the official instructions:

```bash
gh release download v0.0.3 --repo openai/symphony \
  --pattern symphony-v0.0.3-macos_arm64 \
  --pattern symphony-v0.0.3-macos_arm64.sha256 --dir /absolute/path/symphony-bin
cd /absolute/path/symphony-bin
shasum -a 256 -c symphony-v0.0.3-macos_arm64.sha256
chmod +x symphony-v0.0.3-macos_arm64
```

Use the matching official Linux/Intel asset on those platforms. In the start
command, pass this executable as `--symphony`. The wrapper supplies Symphony's
required evaluation acknowledgement; the worker isolation remains Docker.

```bash
git clone https://github.com/openai/symphony.git /absolute/path/symphony
git -C /absolute/path/symphony checkout be10a1b79df723d6d7612b5651c8522704dafb2e
cd /absolute/path/symphony/elixir
mise trust
mise install
mise exec -- mix setup
mise exec -- mix build
```

The executable is `/absolute/path/symphony/elixir/bin/symphony`. A release binary
does not require a separate Elixir/Erlang installation. The official reference
describes itself as evaluation software; this bounded pilot does not certify it
as a general production service. Dashboard binds only to `127.0.0.1`.

From the Muffin checkout:

```bash
python3 scripts/symphony/ops.py build --config symphony.json --runtime /absolute/path/pilot-runtime
export SYMPHONY_OPENCODE_MODEL='your-configured-provider/your-configured-model'
export SYMPHONY_GIT_AUTHOR_NAME='your-approved-DCO-name'
export SYMPHONY_GIT_AUTHOR_EMAIL='your-approved-DCO-email'
# Set GITHUB_TOKEN through your host secret mechanism; never commit/echo it.
python3 scripts/symphony/ops.py start --config symphony.json \
  --runtime /absolute/path/pilot-runtime \
  --symphony /absolute/path/symphony/elixir/bin/symphony \
  --auth /absolute/path/scoped-opencode-auth.json
```

Keep `symphony.json`/`WORKFLOW.md` from the selected repository together. To start
Centria, use the installed shared `ops.py` with Centria's `--config` (see its
runbook), not Muffin's configuration. The service wrapper sets
`SYMPHONY_LAUNCHER`; Symphony's exact command is
`python3 "$SYMPHONY_LAUNCHER"`. The launcher runs the trusted broker on the host; that broker starts a Docker-isolated
`opencode run --format json --pure --model <configured-model> -- <bounded-brief>`
with stdin closed. Codex sandbox fields do not sandbox OpenCode; Docker does.

## Explicit eligibility and bounded brief

The program orchestrator checks dependencies, collisions and policy, then adds
`agent:symphony` to one canonical ordinary issue. This is an executor opt-in,
not a new definition of program READY. No blanket dispatch of open issues.
If missing, create the label with
`gh label create 'agent:symphony' --repo <owner/repo> --description 'Explicit bounded Symphony worker opt-in'`.

The canonical issue must contain exactly one block:

````markdown
```symphony-work
{"canonical_issue":123,"owner":"authorized-login","risk":"ordinary","acceptance":"Observable acceptance for this issue","current_failure":"Current measured failure or missing capability","write_set":["docs/guide.md"]}
```
````

Paths are exact files, including files to add; no globs, hidden paths or parent
traversal. This conservative pilot excludes reserved/high-risk/blocked issues
even with `founder-approved`. Centria executes its existing reserved predicate;
Muffin's thin config excludes product/architecture/authority surfaces from pilot
dispatch. These pilot exclusions do not redefine either repository's merge
policy. Project fields and A/B/C planning remain program-orchestrator concerns.

## Publication and gates

OpenCode can commit locally and call MCP `publish_branch`. The adapter checks
READY again, unchanged canonical brief, the current integration base, a clean
committed candidate, exact write-set, regular files and DCO. It publishes only
`slice/symphony-<issue>` with non-forced ref updates and returns the **remote**
candidate SHA; when base advances, validated publication preserves the old
branch head and current base as merge parents without forced updates. API commits may differ from local commits. Workers read CI using
that remote SHA, repair the same PR and finish with
`symphony-handoff:<remote-sha>` in a PR comment. A matching GitHub marker blocks
restart dispatch. This marker is a worker handoff, never a review attestation.

The worker can read repo issues/PRs/commits/runs and create/update its own PR and
comments. It cannot merge, issue-write/close/label, review, emit review attestations,
change protected refs, access other repos or see GitHub credentials. No Git push
credential is mounted. Existing required CI, independent review, exact-head
attestation and founder gates are unchanged. A reviewer/program orchestrator
integrates under repository policy; Symphony never performs integration.

One foreground instance per repo on the same host, concurrency 1 each (maximum
2 across these two configured instances). A per-user host registry in the system temporary directory locks the repository identity,
independent of the chosen runtime directory. It rejects a second instance;
an external issue lock rejects a second logical writer. This is not a multi-host
distributed lease. A process failure is retried by Symphony in the same clone.
An attempt is capped at one hour; successful process exit requests operator
handoff and does not assert acceptance or merge readiness.

## Status, stop and disable

```bash
python3 scripts/symphony/ops.py status --config symphony.json --runtime /absolute/path/pilot-runtime
python3 scripts/symphony/ops.py stop --config symphony.json --runtime /absolute/path/pilot-runtime
```

Muffin dashboard/state: `http://127.0.0.1:4318/` and `/api/v1/state`.
Centria uses port 4319. Ctrl-C also stops the foreground service and its labeled
containers. Remove READY before handoff or disabling/restarting. Removing READY
stops the active worker at reconciliation and prevents retries; closing an issue
also triggers Symphony's terminal workspace cleanup. Unpublished local work must
be published or saved before closing an issue: terminal cleanup can delete it.

To disable, remove `agent:symphony` from opted-in issues, stop both services,
verify `docker ps --filter label=symphony.service=<service-name>` is empty and
save any remaining issue clones before deleting the runtime directory. Workspaces
are standalone clones, not linked repository worktrees. Revoke pilot credentials
through their normal issuer. No system service/autostart or VPS change is installed. Host registry lock files
contain no credentials and can be removed after both services are stopped.

## Verification

```bash
python3 -m unittest discover -s scripts/symphony -p 'test_*.py' -v
SYMPHONY_TEST_DOCKER=1 python3 -m unittest discover -s scripts/symphony -p 'test_*.py' -v
bash scripts/symphony/verify-upstream.sh
```

The real OpenCode test uses a localhost model fixture, not an external model.
The upstream fixture uses official Symphony's workspace/app-server code and a
deterministic worker; upstream lifecycle tests cover opt-out, close, claims/retry
and workspace reuse. This is protocol/lifecycle evidence, not real-issue CI-repair
or model-quality acceptance. No orchestration glue is subtracted by this pilot.

The host refresh hook uses a separate trusted bare mirror and creates a base
bundle. The mirror is never mounted in the worker. The bundle is mounted read
only; Git in the issue checkout runs inside the container. Retry therefore
never executes host Git against worker-controlled checkout configuration.

The trusted host broker loads repository policy from the config checkout, never
from the worker clone. All candidate Git commands execute through `docker exec`
in the active worker container. Only a scoped, ephemeral authenticated MCP HTTP
endpoint is reachable by the child; the broker's process/stdout, host HOME,
tracker token and Docker socket are absent from the worker namespace. Docker's
host gateway is required (Docker Desktop or Linux host-gateway support). The
endpoint binds an ephemeral host port; keep this pilot on a trusted local host,
not exposed as a remote service. The capability expires when the attempt ends.

For a custom provider, optionally set `SYMPHONY_OPENCODE_PROVIDER_CONFIG` to an
external JSON file containing only the selected provider definition (the value
of OpenCode's `provider` field); keep authentication in the dedicated auth file.
No full user/project configuration or MCP plugin bundle is imported.
Publication requires the current integration base to be an ancestor of the
local candidate; refreshed refs alone do not make a stale branch publishable.

If the foreground wrapper is interrupted abruptly, status recognizes the owned
scheduler group by a unique launch marker. A second start fails closed until
`ops.py stop` stops that group and its worker containers; then start normally.
The scheduler cannot execute before its identity has been recorded. Status/stop
never signal an unrelated process using a stale PID alone. POSIX `ps` is a host
dependency; macOS and the supported Linux host provide it.
