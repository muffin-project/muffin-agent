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
| `Dockerfile` | gateway image built from the **last commit** of this checkout: Node 22, upstream bubblewrap, socat, ripgrep, whisper.cpp + ffmpeg, uv |
| `Dockerfile.dockerignore` | the build context is `.git` only, so untracked files (a key, a `.env`) and uncommitted edits never reach the image |
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
| updates | `muffin update` / `--rollback` | rebuild the image from a newer checkout; `muffin update` does not apply |
| shell tools | on when the host sandbox works | **off by default**; on only with the sandbox override and a host that allows it |
| data | `~/.muffin` and `~/.config/muffin/secrets` | named volumes `home` (`/muffin/home`) and `config` (`/muffin/config`) |
| workspace | `~/muffin-workspace` | named volume `workspace` (`/muffin/workspace`) |

## Requirements

- Docker Engine with Docker Compose v2 on Linux (the sandbox is Linux bubblewrap).
- A regular `git clone` of this repository (not a linked worktree: the build
  needs `.git` to be a directory). The image contains the last commit of the
  checked-out branch; commit local changes before building them.
- A model provider: a key (OpenRouter, Anthropic) or an OpenAI-compatible
  endpoint such as a local Ollama.
- About 2 GB of disk for the image; more for local models.

## Quick start

From `contrib/docker/`:

```sh
docker compose build
docker compose run --rm -it gateway muffin init     # key asked with a masked prompt
docker compose up -d
docker compose logs -f gateway                       # shows `muffin doctor`, then the gateway
```

`muffin init` in a container can offer to install a systemd unit: answer no,
there is no systemd in the container.

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
the file **outside the checkout**, mode 0600:

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

| Posture | Command | Effect on the container |
|---|---|---|
| default | `docker compose up -d` | Docker's default seccomp and AppArmor. On the engines measured, the default seccomp profile refuses user namespaces, so the shell tools are off; an engine whose defaults allow them would contain here, and `doctor` would say so |
| sandbox | `docker compose -f compose.yaml -f compose.sandbox.yaml up -d` | `seccomp=unconfined` (user namespaces) and `systempaths=unconfined` (unmasked `/proc`); no capability, no device |
| sandbox + AppArmor | add `-f compose.apparmor.yaml` after loading `apparmor/muffin-userns` on the host | the container runs under `muffin-userns` instead of Docker's default AppArmor profile: `flags=(unconfined)` plus the `userns` grant, so Docker's default AppArmor confinement is removed as well |

Measured results (details in the evidence file):

| Host | default | sandbox | sandbox + AppArmor |
|---|---|---|---|
| Linux without AppArmor (WSL2 kernel 6.18) | shell off | contained | n/a (option ignored) |
| Ubuntu 24.04 with `apparmor_restrict_unprivileged_userns=1` | not yet verified | not yet verified (with `apparmor=unconfined` instead: `userns_denied`) | not yet verified |

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

- **Update**: `git pull`, then `docker compose build && docker compose up -d`.
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

| Symptom in `docker compose logs gateway` | Cause | Remedy |
|---|---|---|
| `not configured yet` | no `muffin init` yet | `docker compose exec -it gateway muffin init` |
| `bwrap: No permissions to create new namespace` | default seccomp profile | sandbox override |
| `userns_denied ... RTM_NEWADDR` | AppArmor user-namespace restriction | load the profile, add `compose.apparmor.yaml` |
| `Can't mount proc on /proc` | Docker masks `/proc` | make sure `compose.sandbox.yaml` is applied (`systempaths=unconfined`) |
| container does not start after adding `compose.apparmor.yaml` | profile not loaded on an AppArmor host | load it, or drop that override |
| `bubblewrap ... predates ... 0.12.0` | wrong image | rebuild from this Dockerfile |
| build: `.git is not a directory (linked worktree?)` | building from a `git worktree` | build from a regular clone |
| a local change is missing from the image | the image is built from the last commit | commit it, then rebuild |
