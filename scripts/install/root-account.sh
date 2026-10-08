#!/usr/bin/env sh
# Source-checkout compatibility entry point. The implementation is embedded in
# install.sh because bootstrap stages only that one canonical file.
set -eu
# shellcheck disable=SC1007 # An empty CDPATH keeps cd quiet and deterministic.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd)
exec sh "$SCRIPT_DIR/../../install.sh" --muffin-root-account "$@"
