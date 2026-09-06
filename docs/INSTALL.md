# Installing Muffin

> **One command.** On a fresh Linux box with nothing on it but a user account
> and `sudo`, this is the whole installation:
>
> ```bash
> curl -fsSL https://raw.githubusercontent.com/GiustoPiedimonte/muffin-agent/main/install.sh | sh
> ```
>
> Then, on a terminal, `install.sh` asks for your model API key and offers to
> turn the agent into a supervised service. When it is done you have a `muffin`
> command, a `~/.muffin` home, and a gateway running under systemd.

The mechanics live in `install.sh` itself, which is the authority for what
actually happens; this page says what the command is for, what it will do to
your machine, and how to undo it.

## What it does, in order

| Step | What ends up where |
|---|---|
| OS packages | `git`, `curl`, `xz-utils` if missing; `bubblewrap`, `socat`, `ripgrep` for the sandbox (via `sudo apt-get`, best effort) |
| Node 22 | `~/.local/share/muffin/node` — the official tarball, only if the machine has no Node ≥ 22 already |
| Source | `~/.local/share/muffin/src` — a real git checkout, cloned from the channel you asked for |
| Build | `npm ci` in that checkout, producing `dist/` |
| Command | `~/.local/bin/muffin` → a symlink into that build |
| Setup | `muffin init` — creates `~/.muffin`, stores your key `0600`, seals the root of trust |
| Supervisor | `muffin gateway install --write --start` — writes the user unit, loads it, enables linger |

Nothing is installed outside your home directory, and `sudo` is used **only**
for the OS packages in the first row. If passwordless `sudo` is not available
the script prints the one `apt-get` line to run and carries on.

## Why a git checkout and not a package

Because `muffin update` needs one. An update never modifies the tree a live
gateway is running from: it checks the new commit out as a `git worktree` under
`.releases/<sha>`, builds and smoke-tests *that* directory, takes a backup, and
only then swings the launcher symlink over. A rollback is the inverse flip.
Both are one command:

```bash
muffin update                 # to the promoted line (main)
muffin update --channel dev   # to the line where work lands first
muffin update --rollback      # back to the previous release
```

`muffin update` always tells you how far ahead the other channel is, so
"nothing new" and "plenty, nobody promoted it" never print the same line.

## Why Node comes from a tarball

Ubuntu 24.04 ships Node 18 and the runtime needs 22. Neither `nvm` nor `fnm`
would do: both are shell-profile machinery whose value is *switching* versions
interactively, and a systemd unit does not source a shell profile — it needs
one absolute interpreter directory that still exists next month. So the
installer puts the official build at `~/.local/share/muffin/node` and the
generated unit names that directory in its `Environment=PATH`.

If your machine already has Node ≥ 22, that one is used and nothing is
downloaded.

## Why the code is not under `~/.muffin`

`~/.muffin` is the **data** home — config, keys, memory, the root of trust —
and `muffin uninstall` deletes it whole. Putting the checkout or the Node
runtime in there would mean a command whose stated job is "remove my data"
also removes the program and the interpreter its own service unit points at.
So code lives under `~/.local/share/muffin` and data under `~/.muffin`. See
[`MUFFIN-HOME.md`](MUFFIN-HOME.md) for what the data home contains.

## Your API key never travels through argv or the environment

`muffin init` reads the key from **stdin** and refuses both `--api-key <value>`
and `MUFFIN_API_KEY` by name: a value in `argv` is in your shell history and in
every `ps` on the box, and one in the environment is readable from `/proc` and
inherited by every child process. On a terminal `install.sh` lets `init` ask
you, hidden. Scripted, point it at a file:

```bash
MUFFIN_API_KEY_FILE=/run/secrets/muffin-key sh install.sh
```

That is a *path* in the environment, not a secret. See ADR-0048.

## Overrides

| Variable | Default | What it changes |
|---|---|---|
| `MUFFIN_PREFIX` | `~/.local/share/muffin` | where the checkout and Node live |
| `MUFFIN_BINDIR` | `~/.local/bin` | where the launcher symlink goes |
| `MUFFIN_CMD` | `muffin` | the command name (see below) |
| `MUFFIN_REPO` | the GitHub URL | where to clone from |
| `MUFFIN_CHANNEL` | `main` | which branch to install |
| `MUFFIN_API_KEY_FILE` | — | unattended setup: the file holding the key |
| `MUFFIN_NO_APT` | — | `1` never calls `apt-get` |
| `MUFFIN_NO_GATEWAY` | — | `1` installs the command but not the service |

Exit codes: `0` done · `1` something failed · `3` installed and working, but the
gateway could not be activated on this machine (no user systemd instance —
a container, or a shell that never logged in). `3` and not `1` so a script can
tell "nothing works" from "everything works except the part this machine cannot
do".

### The name collision

Linux Mint ships `/usr/bin/muffin`: the Cinnamon window manager. The installer
checks whether the `muffin` already on your `PATH` resolves to *this* build; if
it does not, it installs as `muffin-agent` rather than shadowing your desktop.
`MUFFIN_CMD=muffin` takes the name anyway. See ADR-0012.

## From a clone instead

Running the script from a checkout skips the clone and builds that tree:

```bash
git clone https://github.com/GiustoPiedimonte/muffin-agent.git
cd muffin-agent
./install.sh
```

The remaining steps are identical.

## Removing it

```bash
muffin uninstall          # ~/.muffin: config, keys, memory
./install.sh --uninstall  # the launcher symlink
rm -rf ~/.local/share/muffin   # the checkout and the bundled Node
```

A key stored with `--persist` lives outside `~/.muffin` on purpose and survives
`muffin uninstall`; the command says where it is so you can delete it too.

## How this page stays true

Every claim above is exercised on a real Ubuntu machine by
`evals/install/ubuntu.sh`, which the `install` workflow runs on any change to
the installer or to the commands it calls. It starts from a `ubuntu:24.04`
container with the `PATH` stripped of every Node, a throwaway `HOME` and a
local git origin pinned to the commit under test, then asserts that
`install.sh` finishes on its own, that `muffin doctor` reports no red lines,
that the generated unit is accepted by `systemd-analyze verify` and produces a
live gateway, and that `muffin update` and `muffin update --rollback` move the
launcher and move it back.

It also declares what a container cannot prove: there is no user systemd
instance inside one, so `systemctl --user is-active` is only asserted when a
real one is reachable. Everywhere else the unit is proved by systemd's parser
plus a foreground run of its own `ExecStart`.
