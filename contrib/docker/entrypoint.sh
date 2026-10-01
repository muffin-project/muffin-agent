#!/bin/sh
# Entrypoint of the experimental Muffin gateway container (contrib/docker/README.md).
#
#   (no arguments)     wait for a configured home, print `muffin doctor` to the
#                      log, then run `muffin gateway run` in the foreground: the
#                      container restart policy stands in for the systemd/launchd
#                      unit, which does not exist in a container.
#   init-from-secret   one-shot unattended `muffin init`, used by the `init`
#                      service: the key is read from the compose secret on stdin
#                      and the container exits. The long-running gateway never
#                      has the secret mounted, so its sandboxed shell cannot read it.
#   anything else      run as a command (`docker compose run --rm gateway muffin init`).
set -eu

log() { printf '[muffin-container] %s\n' "$*"; }

if [ "${1:-}" = init-from-secret ]; then
  KEY_FILE=/run/secrets/muffin_provider_key
  [ -f "$KEY_FILE" ] || { log "no secret at $KEY_FILE"; exit 78; }
  if [ -f "$MUFFIN_HOME/config.json" ]; then
    log "home already initialised: nothing to do"
    exit 0
  fi
  : "${MUFFIN_INIT_PROVIDER:?MUFFIN_INIT_PROVIDER is required}"
  set -- --provider "$MUFFIN_INIT_PROVIDER"
  if [ -n "${MUFFIN_INIT_BASE_URL:-}" ]; then set -- "$@" --base-url "$MUFFIN_INIT_BASE_URL"; fi
  if [ -n "${MUFFIN_INIT_MODEL:-}" ]; then set -- "$@" --model "$MUFFIN_INIT_MODEL"; fi
  exec muffin init "$@" < "$KEY_FILE"
fi

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

log "build=$(git -C /opt/muffin rev-parse --short HEAD 2>/dev/null || echo unknown) uid=$(id -u) $(bwrap --version 2>&1)"

# First run: wait until `muffin init` has written and sealed the home.
if [ ! -f "$MUFFIN_HOME/config.json" ] || [ ! -f "$MUFFIN_HOME/.rot-anchor" ]; then
  log "not configured yet. Run: docker compose exec -it gateway muffin init"
  log "the gateway starts by itself as soon as the home is initialised."
  until [ -f "$MUFFIN_HOME/config.json" ] && [ -f "$MUFFIN_HOME/.rot-anchor" ]; do sleep 5; done
  sleep 3
fi

# Voice notes: the default model path is <home>/models/ggml-base.bin. Copied, not
# symlinked: the private-home writers refuse symlinks inside the home.
if [ -f /opt/whisper/models/ggml-base.bin ] && [ ! -e "$MUFFIN_HOME/models/ggml-base.bin" ]; then
  mkdir -p "$MUFFIN_HOME/models"
  chmod 0700 "$MUFFIN_HOME/models"
  cp /opt/whisper/models/ggml-base.bin "$MUFFIN_HOME/models/ggml-base.bin"
  chmod 0600 "$MUFFIN_HOME/models/ggml-base.bin"
fi

log "muffin doctor:"
muffin doctor 2>&1 | sed 's/^/    /' || true

if [ -f "$MUFFIN_HOME/gateway.stopped" ]; then
  log "gateway.stopped is present (muffin gateway stop): not starting."
  log "remove it and restart the container to resume."
  exec sleep infinity
fi

log "starting muffin gateway run"
exec muffin gateway run
