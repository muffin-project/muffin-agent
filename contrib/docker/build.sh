#!/bin/sh
# Builds the gateway image from the last commit of this checkout, and from
# nothing else (contrib/docker/README.md).
#
# The build context is `git archive HEAD` plus the raw commit object, streamed
# to `docker build` on stdin. The repository's .git (history, reflog, config,
# objects) never reaches the builder, and neither do untracked files (a key
# file, a .env) or uncommitted edits. The Dockerfile rebuilds that exact commit,
# same SHA, from the archived files and refuses to build if they are not exactly
# its tree. Works from a regular clone and from a linked worktree.
#
#   contrib/docker/build.sh [docker build options]
#
# The tag is $MUFFIN_IMAGE, default muffin-gateway:local, the image compose.yaml
# runs. Extra options go to `docker build`, for example --build-arg NODE_IMAGE=...
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
sha=$(git -C "$repo" rev-parse HEAD)

if [ -n "$(git -C "$repo" status --porcelain)" ]; then
  echo "build.sh: uncommitted changes and untracked files are NOT in the image; it is built from $sha" >&2
fi

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
git -C "$repo" cat-file commit "$sha" > "$scratch/.muffin-build-commit"

git -C "$repo" archive --format=tar --add-file="$scratch/.muffin-build-commit" "$sha" |
  docker build -f contrib/docker/Dockerfile \
    -t "${MUFFIN_IMAGE:-muffin-gateway:local}" \
    --label "org.opencontainers.image.revision=$sha" \
    "$@" -
