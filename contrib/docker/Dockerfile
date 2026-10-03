# syntax=docker/dockerfile:1.7
#
# Experimental container image for the Muffin gateway (contrib/docker/README.md).
# Built from the last commit of this checkout by contrib/docker/build.sh.
#
# What the image has to provide, and why:
#   - upstream bubblewrap >= 0.12.0, built from the release tarball with a pinned
#     sha256: the shell tools exist only when bwrap carries the CVE-2026-87766
#     setup-time fix (core/sandbox/bubblewrap-version.ts), and the Debian package
#     is older. Same recipe as scripts/install-ci-bubblewrap.sh.
#   - socat and ripgrep: the rest of the Linux sandbox runtime.
#   - whisper-cli, ffmpeg and ggml-base.bin: local voice-note transcription.
#   - python3 (from the base image) and uv: stdio MCP servers run in here.
# The process runs as `node` (uid 1000): the sandbox probe refuses root.

ARG NODE_IMAGE=node:22-bookworm

FROM ${NODE_IMAGE} AS bwrap
ARG BWRAP_VERSION=0.13.0
ARG BWRAP_SHA256=4734237473c0e5d695e4e9034a34e43b2dbf5164655bd13fa59ae376b2b7a765
RUN apt-get update \
 && apt-get install -y --no-install-recommends libcap-dev meson ninja-build pkg-config xz-utils \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /tmp/bwrap.tar.xz \
      "https://github.com/containers/bubblewrap/releases/download/v${BWRAP_VERSION}/bubblewrap-${BWRAP_VERSION}.tar.xz" \
 && echo "${BWRAP_SHA256}  /tmp/bwrap.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/bwrap.tar.xz -C /tmp \
 && meson setup /tmp/bwrap-build "/tmp/bubblewrap-${BWRAP_VERSION}" --prefix=/usr/local --buildtype=release \
 && ninja -C /tmp/bwrap-build \
 && DESTDIR=/out ninja -C /tmp/bwrap-build install \
 && test "$(/out/usr/local/bin/bwrap --version)" = "bubblewrap ${BWRAP_VERSION}"

FROM ${NODE_IMAGE} AS whisper
ARG WHISPER_REF=v1.8.7
ARG WHISPER_MODEL=base
RUN apt-get update \
 && apt-get install -y --no-install-recommends cmake \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "${WHISPER_REF}" https://github.com/ggml-org/whisper.cpp /src \
 && cmake -S /src -B /src/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
      -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF \
 && cmake --build /src/build --target whisper-cli -j"$(nproc)" \
 && install -D -m 0755 /src/build/bin/whisper-cli /out/usr/local/bin/whisper-cli \
 && mkdir -p /out/opt/whisper/models \
 && curl -fsSL -o "/out/opt/whisper/models/ggml-${WHISPER_MODEL}.bin" \
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL}.bin"

FROM ${NODE_IMAGE} AS build
# Only the last commit of the checkout enters the image. build.sh streams
# `git archive` of it plus the raw commit object as the build context, so the
# repository's .git, untracked files (a key file, a .env) and uncommitted edits
# never reach the builder. This stage rebuilds that exact commit (same SHA, one
# shallow commit, no remote, no reflog), which is what lets `muffin doctor` name
# the build and compare the installed defaults, and it refuses to build when the
# files are not exactly the commit's tree.
# The commit object is copied first and alone: a context without it (the
# checkout itself, given to a plain `docker build`) stops here.
COPY .muffin-build-commit /tmp/commit
COPY . /opt/muffin
WORKDIR /opt/muffin
RUN rm .muffin-build-commit \
 && tree=$(sed -n '1s/^tree //p' /tmp/commit) \
 && git init -q \
 && git add -A -f \
 && got=$(git write-tree) \
 && { [ "$got" = "$tree" ] \
      || { echo "the build context is not the commit (tree $got, expected $tree): build with contrib/docker/build.sh" >&2; exit 1; }; } \
 && sha=$(git hash-object -t commit -w /tmp/commit) \
 && git update-ref --no-deref HEAD "$sha" \
 && { ! sed '/^$/q' /tmp/commit | grep -q '^parent ' || echo "$sha" > .git/shallow; } \
 && rm -rf /tmp/commit .git/logs \
 && test -z "$(git status --porcelain)"
# `npm ci` runs `prepare`, which compiles dist/; dev dependencies are dropped
# afterwards because the runtime never loads them.
RUN npm ci \
 && test -f dist/cli/main.js \
 && npm prune --omit=dev

FROM ${NODE_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends socat ripgrep ffmpeg tini libcap2 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=bwrap /out/ /
COPY --from=whisper /out/ /
COPY --from=ghcr.io/astral-sh/uv:0.12.19 /uv /uvx /usr/local/bin/
# The code stays root-owned: the agent process must not be able to rewrite its
# own runtime. safe.directory lets `muffin doctor` read the commit as `node`.
COPY --from=build /opt/muffin /opt/muffin
RUN chmod 0755 /opt/muffin/dist/cli/main.js \
 && ln -s /opt/muffin/dist/cli/main.js /usr/local/bin/muffin \
 && git config --system --add safe.directory /opt/muffin \
 && install -d -m 0755 /muffin \
 && install -d -o node -g node -m 0700 /muffin/home /muffin/config /muffin/workspace
COPY --from=build --chmod=0755 /opt/muffin/contrib/docker/entrypoint.sh /usr/local/bin/muffin-entrypoint

# Data lives under /muffin, one volume per directory: the home (config, sealed
# rot/, database, memory), the persistent secrets and the workspace.
# MUFFIN_CONTAINER marks this image as the experimental gateway container:
# `muffin update` inside it refuses with the host-side procedure instead of
# attempting an in-place update that cannot work here (#765). Baked into the
# image rather than detected, and steering only a help message, never authority.
ENV MUFFIN_HOME=/muffin/home \
    XDG_CONFIG_HOME=/muffin/config \
    MUFFIN_WORKSPACE=/muffin/workspace \
    MUFFIN_CONTAINER=1
USER node
WORKDIR /muffin
LABEL org.opencontainers.image.title="muffin-gateway" \
      org.opencontainers.image.description="Experimental container image for the Muffin gateway"
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/muffin-entrypoint"]
