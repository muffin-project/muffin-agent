#!/usr/bin/env bash
set -euo pipefail
adapter_dir="$(cd "$(dirname "$0")" && pwd)"
fixture_root="$(mktemp -d)"
trap 'rm -rf "$fixture_root"' EXIT
git clone -q https://github.com/openai/symphony.git "$fixture_root/symphony"
git -C "$fixture_root/symphony" checkout -q be10a1b79df723d6d7612b5651c8522704dafb2e
cp "$adapter_dir/upstream_fixture.exs" "$fixture_root/symphony/elixir/test/symphony_elixir/opencode_bridge_test.exs"
docker run --rm --init \
  --mount "type=bind,src=$fixture_root/symphony,dst=/symphony" \
  --mount "type=bind,src=$adapter_dir,dst=/adapter,readonly" \
  --env SYMPHONY_FIXTURE_ADAPTER=/adapter --workdir /symphony/elixir \
  elixir:1.19.5-otp-28 sh -c \
  'mix local.hex --force && mix local.rebar --force && mix deps.get && mix test test/symphony_elixir/opencode_bridge_test.exs test/symphony_elixir/core_test.exs test/symphony_elixir/github_adapter_test.exs test/symphony_elixir/workspace_and_config_test.exs'
