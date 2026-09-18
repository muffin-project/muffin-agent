# Installing Muffin

> **One command.** On a fresh Linux or macOS machine with a user account and
> the normal command-line tools needed to fetch this script, this is the public
> installation path:
>
> ```bash
> curl -fsSL https://raw.githubusercontent.com/muffin-project/muffin-agent/main/bootstrap.sh | sh
> ```
>
> `bootstrap.sh` is intentionally tiny: it stages the canonical `install.sh`
> first and gives that installer the terminal back on stdin. That distinction
> matters because a shell reading `curl | sh` has a pipe on stdin; without the
> shim, the setup cannot safely ask for a hidden model credential or consent and
> the supposedly one-command path stops at “run `muffin init`”. The bootstrap
> never reads a secret itself.
>
> When the installer is done you have a `muffin` command, a `~/.muffin` home,
> and, where the local supervisor supports it, a gateway running in the
> background.

The mechanics live in `install.sh` itself, which is the authority for what
actually happens; `bootstrap.sh` owns only the pipe-to-controlling-TTY handoff.
This page says what the command is for, what it will do to your machine, and how
to undo it.

## What it does, in order

| Step | What ends up where |
|---|---|
| Bootstrap | stages the canonical installer and restores the controlling TTY when one exists |
| OS packages | `git`, `curl`, `xz-utils` if missing; Linux sandbox dependencies when needed |
| Node 22 | `~/.local/share/muffin/node` — the official tarball, only if the machine has no Node ≥ 22 already |
| Source | `~/.local/share/muffin/src` — a real git checkout, cloned from the channel you asked for |
| Build | `npm ci` in that checkout, producing `dist/` |
| Command | `~/.local/bin/muffin` → a symlink into that build |
| Setup | `muffin init` — creates `~/.muffin`, stores your key `0600`, seals the root of trust |
| Supervisor | `muffin gateway install --write --start` — writes the system unit (`User=` = you), loads it on the system bus, no linger step exists |

Nothing is installed outside your home directory except optional OS packages.
If passwordless `sudo` is not available on Linux the installer prints the one
package-manager line it cannot perform and continues where it safely can.

## Why a bootstrap shim exists

The canonical installer needs to distinguish an interactive terminal from a
headless/scripted run. That is how `muffin init` knows whether it may ask a
masked question or must remain non-interactive.

The literal public shape `curl ... | sh` changes only fd 0: the shell still has a
controlling terminal, but stdin is now the downloaded script. Calling
`install.sh` directly through that pipe therefore made the documented happy path
non-interactive. `bootstrap.sh` fixes the transport rather than teaching every
setup prompt a second input mechanism:

```text
curl | sh bootstrap.sh
        ↓ stages install.sh
        ↓ /dev/tty exists? yes → install.sh stdin = controlling terminal
        ↓ no controlling tty   → keep the normal headless path
```

The property is exercised by `evals/install/pipe-tty.sh` with the same shape: a
shell whose stdin is a pipe while `/dev/tty` is still a real PTY. A fake
canonical installer must observe `stdin` as a TTY or the eval fails.

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
interactively, and a systemd unit does not source a shell profile — it needs one
absolute interpreter directory that still exists next month. So the installer
puts the official build at `~/.local/share/muffin/node` and the generated unit
names that directory in its `Environment=PATH`.

Your own shells need it too: the `muffin` command is a symlink whose shebang
resolves `node` through `PATH`. So the installer also appends one marked
`export PATH=…` line — the launcher directory plus that Node directory — to
`~/.profile` (and to `~/.bash_profile` or `~/.zprofile` where those are the
files your login shell reads). New login shells find `muffin`; the shell you ran
the installer in needs `. ~/.profile` first. Measured on a fresh VPS on
2026-09-08, where the previous «add it yourself» hint had left `muffin` failing
with `/usr/bin/env: 'node': No such file or directory`.

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
inherited by every child process. On a terminal the bootstrap restores the
controlling terminal to `install.sh`, which lets `init` ask you with a masked
prompt. Scripted/headless, point the canonical installer at a file:

```bash
MUFFIN_API_KEY_FILE=/run/secrets/muffin-key sh install.sh
```

That is a *path* in the environment, not a secret. See ADR-0048.

On Linux the installer then moves the key to encrypted systemd credentials
in the same session (`muffin secret migrate --yes` when sudo is available):
the durable form is a host-key-encrypted blob under
`/etc/credstore.encrypted/`, materialised by PID 1 into
`$CREDENTIALS_DIRECTORY` at service activation — never a file in the home,
never argv/env. Same stdin discipline throughout; `doctor` reports the
backend, and a missing/unavailable store fails closed with a remedy instead
of silently falling back to files.

The Alpha onboarding plan adds a lower-friction recommended path — OpenRouter
OAuth PKCE — without weakening this invariant. Until that slice lands, the
masked-stdin key path remains the supported credential path.

## Native first; Docker is not a second installer yet

The supported personal Home path is native: it is the only path exercised by
the Ubuntu acceptance, including the generated system service, update/rollback
and the actual launcher. A Docker/Compose Home would still need an explicit
answer for persistent owner data, a supervisor and updates; adding an unproved
second path would duplicate those boundaries while not replacing Muffin's
separate tool-execution sandbox. Do not infer that a container makes model tool
execution contained, and do not use privileged containers, broad host mounts or
the Docker socket as a shortcut.

For a VPS, Docker remains a candidate only when a composed path can prove a
smaller owner journey end-to-end than this native one. That evidence does not
exist at this commit, so no official Docker path is advertised.

## Overrides

The bootstrap itself accepts only one transport override, primarily for tests or
mirrors:

| Variable | Default | What it changes |
|---|---|---|
| `MUFFIN_INSTALL_URL` | raw `main/install.sh` | canonical installer staged by `bootstrap.sh` |

The canonical installer keeps the existing operational overrides:

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

Exit codes from `install.sh`: `0` done · `1` something failed · `3` installed
and working, but the gateway could not be activated on this machine (usually
the privileged steps need root — a container, or a shell without sudo).
`3` and not `1` so a script can tell "nothing works" from "everything works
except the part this machine cannot do". `bootstrap.sh` preserves that exit code.

### The name collision

Linux Mint ships `/usr/bin/muffin`: the Cinnamon window manager. The installer
checks whether the `muffin` already on your `PATH` resolves to *this* build; if
it does not, it installs as `muffin-agent` rather than shadowing your desktop.
`MUFFIN_CMD=muffin` takes the name anyway. See ADR-0012.

## From a clone instead

Running the canonical installer from a checkout skips the clone and builds that
tree:

```bash
git clone https://github.com/muffin-project/muffin-agent.git
cd muffin-agent
./install.sh
```

The remaining steps are identical. The bootstrap is unnecessary in this shape
because `./install.sh` already owns the terminal directly.

## Removing it

```bash
muffin uninstall          # ~/.muffin: config, keys, memory
./install.sh --uninstall  # the launcher symlink
rm -rf ~/.local/share/muffin   # the checkout and the bundled Node
```

New values entered through an owner-facing capability setup are stored in the
persistent secret location; the old `--persist` spelling remains a compatibility
no-op. `muffin uninstall` names a persistent key it leaves behind so it is never
surprising.

## How this page stays true

Two install evals own two different claims:

- `evals/install/pipe-tty.sh` proves the public transport shape: the bootstrap
  itself is read from a pipe while the staged canonical installer sees the real
  controlling terminal on stdin;
- `evals/install/ubuntu.sh` starts from an Ubuntu 24.04 machine with `PATH`
  stripped of every Node, a throwaway `HOME` and a local git origin pinned to
  the commit under test, then asserts that `install.sh` finishes on its own
  (including migrating the key to encrypted systemd credentials when sudo is
  available, leaving no file secret store behind), that `muffin doctor`
  reports no red lines, that the generated system unit is accepted by
  `systemd-analyze verify` and produces a live gateway, and that
  `muffin update` and `muffin update --rollback` move the launcher and move it
  back.

The Ubuntu eval also declares what a container cannot prove: there is no PID 1
systemd inside one, so the service is proved by systemd's parser plus a
foreground run of its own `ExecStart` (with an emulated
`$CREDENTIALS_DIRECTORY`, exactly what PID 1 would hand over), never by
`systemctl is-active`. Reboot, linger-free survival and host-key decryption
belong to the VPS acceptance harness on a disposable VM, not to this container.