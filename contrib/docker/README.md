# Muffin in Docker Compose (experimental)

> **Experimental, community path. Not the supported installation.**
> The supported path is native (`docs/user/INSTALL.md`, "Native first; Docker is
> not a second installer yet"), and Muffin itself is pre-alpha. This directory
> exists so that people who run everything in containers can do so without
> weakening Muffin's boundaries by accident. It does not change the project's
> position.

What is here:

| File | Purpose |
|---|---|
| `build.sh` | builds the image from the **last commit** of this checkout and nothing else: the context is `git archive HEAD` plus the commit object, so the repository's `.git`, untracked files (a key, a `.env`) and uncommitted edits never reach the builder |
| `Dockerfile` | the gateway image: Node 22, upstream bubblewrap, socat, ripgrep, whisper.cpp + ffmpeg, uv. It rebuilds the commit (same SHA) from the archived files and refuses a context that is not exactly its tree |
| `Dockerfile.dockerignore` | keeps `.git` out if the checkout itself is passed to `docker build` by mistake; that build stops at its first step |
| `compose.yaml` | the gateway; a one-shot `init` service for unattended setup; Ollama for memory embeddings as the optional `embeddings` profile; an optional model router, commented out |
| `compose.sandbox.yaml` | opt-in override that lets the shell sandbox run inside the container |
| `compose.apparmor.yaml` | opt-in override for hosts where AppArmor restricts user namespaces |
| `apparmor/muffin-userns` | the host AppArmor profile that override refers to |
| `entrypoint.sh` | first-run wait or unattended init, `muffin doctor` in the log, gateway in the foreground |

Measurements and alternatives behind these choices:
`docs/evidence/muffin-in-container-2026-09-26.md`. Automated check:
`evals/install/docker.sh`.

## How it differs from the native install

| | Native | This container path |
|---|---|---|
| supervisor | systemd user unit / launchd | the container restart policy (`unless-stopped`); `doctor` warns that no unit exists, which is expected |
| updates | `muffin update` / `--rollback` | rebuild the image from a newer checkout (transitional — the unified update/rollback contract is #765); `muffin update` inside the container says so instead of failing on git |
| shell tools | on when the host sandbox works | **off by default**; on only with the sandbox override and a host that allows it |
| data | `~/.muffin` and `~/.config/muffin/secrets` | named volumes `home` (`/muffin/home`) and `config` (`/muffin/config`) |
| workspace | `~/muffin-workspace` | named volume `workspace` (`/muffin/workspace`) |

## Requirements

- Docker Engine with Docker Compose v2 on Linux (the sandbox is Linux bubblewrap).
- A `git clone` of this repository (a linked worktree works too). The image
  contains the last commit of the checked-out branch and nothing else:
  uncommitted changes and untracked files are left out (`build.sh` warns about
  the ones `git status` shows, that is all but the ignored ones).
  Commit local changes before building them.
- A model provider: a key (OpenRouter, Anthropic) or an OpenAI-compatible
  endpoint such as a local Ollama.
- About 2 GB of disk for the image; more for local models.

## Quick start

From `contrib/docker/`:

```sh
./build.sh                                           # the image, tagged muffin-gateway:local
docker compose run --rm -it gateway muffin init     # key asked with a masked prompt
docker compose up -d
docker compose logs -f gateway                       # shows `muffin doctor`, then the gateway
```

`muffin init` in a container can offer to install a systemd unit: answer no,
there is no systemd in the container.

The image is never built by `docker compose` (`compose.yaml` has no `build:`
section and `pull_policy: never`): a compose build would send the checkout as it
is. The commit it was built from is in the image's
`org.opencontainers.image.revision` label, and `muffin doctor` names it.
`MUFFIN_IMAGE` sets another tag, and extra options go to `docker build`
(`./build.sh --build-arg NODE_IMAGE=...`).

If you start the stack before `init`, the gateway waits and logs how to
initialise it; it starts by itself once the home is initialised:

```sh
docker compose up -d
docker compose exec -it gateway muffin init
```

Everything else is the normal CLI, run inside the container:

```sh
docker compose exec -it gateway muffin doctor
docker compose exec -it gateway muffin               # interactive chat; approvals are asked here
docker compose exec -it gateway muffin surface enable telegram
```

Surfaces, web search and MCP servers are attached when the gateway starts:
after `muffin surface enable`, `muffin search` or `muffin mcp add`, run
`docker compose restart gateway`. `muffin gateway restart` looks for systemd and
does not apply here.

### Unattended first run

For scripted setups the one-shot `init` service replaces the interactive
`muffin init`. The key comes from a file mounted as a compose secret, fed on
stdin, never from an environment variable or the command line (ADR-0048). Keep
the file **outside the checkout**, where other host users cannot read it:

```sh
MUFFIN_PROVIDER_KEY_FILE=/path/outside/the/checkout/provider.key \
MUFFIN_INIT_PROVIDER=openai-compat \
MUFFIN_INIT_BASE_URL=https://openrouter.ai/api/v1 \
MUFFIN_INIT_MODEL=<model id> \
docker compose --profile unattended-init run --rm init
docker compose up -d
```

| Variable | Example |
|---|---|
| `MUFFIN_PROVIDER_KEY_FILE` | path of the key file |
| `MUFFIN_INIT_PROVIDER` | `openai-compat` or `anthropic` |
| `MUFFIN_INIT_BASE_URL` | `https://openrouter.ai/api/v1`, `http://ollama:11434/v1` |
| `MUFFIN_INIT_MODEL` | the model id |

Compose mounts the file as it is on the host, and outside swarm it ignores the
`uid`, `gid` and `mode` of a secret (measured). The file itself must therefore
be readable by uid 1000, the container user: either owned by that uid with mode
0600, or mode 0644 inside a directory only you can open (mode 0700). Otherwise
`init` stops with `cannot open /run/secrets/muffin_provider_key: Permission
denied`.

The secret is mounted only into the `init` container, which exits when the home
is initialised. The long-running gateway never has it: anything mounted into the
gateway would be readable by its sandboxed shell. Muffin keeps its own copy of
the key in the `config` volume, which the sandbox cannot read.

### Memory embeddings (optional)

```sh
docker compose --profile embeddings up -d
```

starts Ollama and pulls Muffin's default embedding model
(`qwen3-embedding:0.6b`). Without it recall is full-text only and `doctor` says
so. The same Ollama can serve a local chat model: `muffin init` offers it.

### Optional model router

`compose.yaml` contains a commented LiteLLM service. Muffin estimates spend from
the model name (`core/budget/pricing.ts`): a name it does not recognise is priced
at the most expensive known rate against the sealed daily cap. Give local models
an alias containing `ollama` or `llama.cpp`, and paid ones their family name.

## Sandbox postures

The shell tools (`shell_run`, `shell_run_write`) exist only when bubblewrap can
build a real sandbox and is at least 0.12.0 (`core/sandbox/shell-boundary.ts`).
Otherwise they are absent and `muffin doctor` says why: Muffin never runs a
command unsandboxed. Even when present, every shell call asks the owner
(ADR-0091).

In every posture the gateway runs as the non-root `node` user with all
capabilities dropped and `no-new-privileges`; bubblewrap needs neither
(measured).

The container also has ceilings: 512 processes and threads, and 2 GiB of
memory with no extra swap. Everything in it shares them, sandboxed commands
included, since bubblewrap creates no cgroup of its own. They protect the host,
not the gateway:

- forks beyond the ceiling fail for every process in the container, the gateway
  included, until the runaway command ends or reaches its timeout (120 s by
  default, 600 s at most);
- at the memory ceiling the kernel kills the largest process. When the runaway
  command is one process that allocates, that is the command, and the gateway
  keeps running (measured). When the memory is spread over processes each
  smaller than the gateway, or written to one of the sandbox's in-memory
  filesystems (`/dev` with `/dev/shm`, and the empty mounts that hide the secret
  directories), whose pages belong to no process, the largest process is the
  gateway: it is killed and the container restarts (both measured). On restart
  the new gateway probes the dead holder's incarnation — the file lock the
  kernel releases when the process dies — and takes the lock immediately. The
  pid fallback, which could refuse for up to 30 minutes (see Troubleshooting),
  only applies to a lock taken by a build older than #728 (ADR-0094).

Without the memory ceiling the same command is not harmless: each of those
in-memory filesystems can grow to half of the host's memory, so one command can
push the whole host into out-of-memory. Disk and CPU have no ceiling here; a
command is bounded only by its timeout.

Raise the ceilings with `MUFFIN_GATEWAY_PIDS_LIMIT` and
`MUFFIN_GATEWAY_MEM_LIMIT` (for example `3g` for a larger whisper model). To
remove one, delete its line from `compose.yaml`: that trades the host's
protection for nothing on the gateway's side, since a hard kill takes down the
gateway and the turn in flight either way.

`stop_grace_period` is 75 s: on SIGTERM the gateway finishes the turn in flight
for up to 60 s, and Docker's default 10 s would kill it mid-drain.

| Posture | Command | Effect on the container |
|---|---|---|
| default | `docker compose up -d` | Docker's default seccomp and AppArmor. On the engines measured, the default seccomp profile refuses user namespaces, so the shell tools are off; if an engine lets bwrap run, the active-hook self-test must also pass or shell calls are refused |
| sandbox | `docker compose -f compose.yaml -f compose.sandbox.yaml up -d` | `seccomp=unconfined` (user namespaces) and `systempaths=unconfined` (unmasked `/proc`); no capability, no device |
| sandbox + AppArmor | add `-f compose.apparmor.yaml` after loading `apparmor/muffin-userns` on the host | the container runs under `muffin-userns` instead of Docker's default AppArmor profile: `flags=(unconfined)` plus the `userns` grant, so Docker's default AppArmor confinement is removed as well |

Earlier Docker measurements from 2026-09-26, before the nested active-hook
guard (details in the evidence file):

| Host | default | sandbox | sandbox + AppArmor |
|---|---|---|---|
| Linux without AppArmor (WSL2 kernel 6.18) | shell off | contained | n/a (option ignored) |
| Ubuntu 24.04 with `apparmor_restrict_unprivileged_userns=1` (Docker 29.6, Compose 5.1.4) | shell off | shell off: Docker's default AppArmor profile denies the mounts bubblewrap needs (with `apparmor=unconfined` instead: `userns_denied`) | contained |

The current Linux shell guard verifies writes to every active Git hook name at
runtime. The existing `compose.apparmor.yaml` override selects its AppArmor
profile for the whole container and does not apply the native per-bwrap hook
policy. If the runtime probe can create an active hook, shell calls are refused
before the requested command runs. Treat Docker shell execution as
unavailable until a container profile preserves Docker's default restrictions
and passes the same runtime and mutation checks.

`privileged: true` is deliberately **not** offered: it grants every device and
capability to the container, and `docs/user/INSTALL.md` rules it out. Never mount
the Docker socket into this container.

Loading the AppArmor profile (once per host, persists across reboots):

```sh
sudo install -m 0644 apparmor/muffin-userns /etc/apparmor.d/muffin-userns
sudo apparmor_parser -r /etc/apparmor.d/muffin-userns
sudo aa-status | grep muffin-userns
```

## Operating it

- **Update**: `git pull`, then `./build.sh && docker compose up -d`.
  The volumes keep the home; the new image carries the new code.
- **Backup**: `docker compose exec gateway muffin backup` writes into the `home`
  volume, under `backups/`; copy the `home` and `config` volumes for a full copy
  of the installation.
- **Stop the gateway without stopping the container**: `muffin gateway stop`
  inside the container writes `gateway.stopped`; the entrypoint then idles.
  Remove that file and restart the container to resume.
- **Remove everything**: `docker compose down -v` deletes the containers and the
  volumes, keys included.

## Troubleshooting

| Symptom (in `docker compose logs gateway` unless stated) | Cause | Remedy |
|---|---|---|
| `not configured yet` | no `muffin init` yet | `docker compose exec -it gateway muffin init` |
| in a shell command's result: `Cannot fork` (or `Resource temporarily unavailable` from other programs) | the process ceiling of the container | find the runaway command; raise `MUFFIN_GATEWAY_PIDS_LIMIT` only if the load is legitimate |
| in a shell command's result: exit code 137 (`Killed`); or the gateway restarts; `docker events --filter container=<name> --filter event=oom --since 1h` lists the kills (`.State.OOMKilled` is reset when the container restarts) | the memory ceiling of the container | raise `MUFFIN_GATEWAY_MEM_LIMIT` if the load is legitimate, for example a larger whisper model |
| after the gateway stopped uncleanly: `un gateway è già attivo (pid N)`, exit code 75, and the container restarts in a loop | the lock was written by a build older than #728 (ADR-0094), which judged a holder by its pid alone; in a restarted container the new gateway often gets the same id, so the dead holder's lock looked alive | rebuild the image and restart: current builds judge the holder by its incarnation and take the lock at once. Without rebuilding, it recovers once the dead holder's last heartbeat is 30 minutes old |
| the gateway restarts in a loop; `docker compose ps -a` shows exit code 78 | a permanent error: missing config, a rejected key, a Root of Trust that refuses. systemd leaves the gateway down on this code; Docker's restart policy has no per-code exception and keeps retrying | `docker compose stop gateway`, then `docker compose run --rm gateway muffin doctor` and `muffin rot verify` |
| `bwrap: No permissions to create new namespace` | default seccomp profile | sandbox override |
| `userns_denied ... RTM_NEWADDR` | AppArmor user-namespace restriction | load the profile, add `compose.apparmor.yaml` |
| shell call reports `git_hooks_unprotected` | the nested-hook self-test can write an active Git hook | on native Linux, load the shared profile against the exact host bwrap binary; Docker shell execution has no accepted AppArmor policy yet |
| `bwrap: Failed to make / slave: Permission denied` | Docker's default AppArmor profile denies mounts | load the profile, add `compose.apparmor.yaml` |
| `Can't mount proc on /proc` | Docker masks `/proc` | make sure `compose.sandbox.yaml` is applied (`systempaths=unconfined`) |
| container does not start after adding `compose.apparmor.yaml` | profile not loaded on an AppArmor host | load it, or drop that override |
| `bubblewrap ... predates ... 0.12.0` | wrong image | rebuild from this Dockerfile |
| init: `cannot open /run/secrets/muffin_provider_key: Permission denied` | the key file is not readable by uid 1000 (for example created with `sudo`, mode 0600) | own it by uid 1000, or mode 0644 inside a 0700 directory |
| build: `"/.muffin-build-commit": not found` | the checkout was passed to `docker build` or `docker compose build` | build with `./build.sh` |
| build: `the build context is not the commit` | the context was not produced by `build.sh`, or was altered | build with `./build.sh` |
| `docker compose up`: `No such image: muffin-gateway:local` | the image was not built yet | `./build.sh` |
| a local change is missing from the image | the image is built from the last commit | commit it, then rebuild |
