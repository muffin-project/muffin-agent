#!/usr/bin/env python3
"""Only mount this workspace, immutable adapter/config and model auth."""
import json
import os
from pathlib import Path
import subprocess
import sys


def command(env, cwd, broker_dir, prompt):
    required = ("SYMPHONY_ADAPTER_HOME", "SYMPHONY_REPO_CONFIG", "SYMPHONY_OPENCODE_AUTH", "SYMPHONY_SERVICE", "SYMPHONY_IMAGE", "SYMPHONY_SOURCE_BUNDLE")
    if any(not env.get(k) for k in required):
        raise ValueError("missing isolated worker settings")
    adapter, config, auth = [Path(env[k]).resolve(strict=True) for k in required[:3]]
    if not adapter.is_dir() or not config.is_file() or not auth.is_file():
        raise ValueError("invalid isolated worker mounts")
    settings = json.loads(config.read_text())
    # Docker cannot map an existing linked-worktree .git pointing outside the
    # workspace. Symphony must use its after_create standalone clone hook.
    if not (Path(cwd) / ".git").is_dir():
        raise ValueError("standalone issue clone required")
    import hashlib
    suffix = hashlib.sha256(str(Path(cwd).resolve()).encode()).hexdigest()[:16]
    args = ["docker", "run", "--rm", "-i", "--init", "--name", env["SYMPHONY_SERVICE"] + "-" + suffix,
            "--add-host", "host.docker.internal:host-gateway",
            "--label", "symphony.service=" + env["SYMPHONY_SERVICE"], "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", "--read-only", "--pids-limit", "128", "--memory", "4g",
            "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777", "--user", str(os.getuid()) + ":" + str(os.getgid()),
            "--mount", f"type=bind,src={cwd},dst={cwd}", "--workdir", str(cwd),
            "--mount", f"type=bind,src={adapter},dst=/adapter,readonly",
            "--mount", f"type=bind,src={config},dst=/adapter-config.json,readonly",
            "--mount", f"type=bind,src={auth},dst=/model-auth.json,readonly",
            "--mount", f"type=bind,src={Path(env['SYMPHONY_SOURCE_BUNDLE']).resolve(strict=True)},dst=/source.bundle,readonly",
            "--env", "HOME=/tmp/worker-home", "--env", "XDG_DATA_HOME=/tmp/worker-data",
            "--env", "XDG_CONFIG_HOME=/tmp/worker-config", "--env", "XDG_CACHE_HOME=/tmp/worker-cache",
            "--env", "GIT_CONFIG_GLOBAL=/dev/null", "--env", "GIT_CONFIG_NOSYSTEM=1",
            "--env", "GIT_TERMINAL_PROMPT=0", "--env", "OPENCODE_DISABLE_PROJECT_CONFIG=true",
            "--mount", f"type=bind,src={broker_dir},dst=/broker,readonly",
            "--env", "OPENCODE_CONFIG=/broker/opencode.json",
            "--env", "OPENCODE_DISABLE_AUTOUPDATE=true",
            "--env", "GIT_AUTHOR_NAME=" + env.get("SYMPHONY_GIT_AUTHOR_NAME", ""),
            "--env", "GIT_COMMITTER_NAME=" + env.get("SYMPHONY_GIT_AUTHOR_NAME", ""),
            "--env", "GIT_AUTHOR_EMAIL=" + env.get("SYMPHONY_GIT_AUTHOR_EMAIL", ""),
            "--env", "GIT_COMMITTER_EMAIL=" + env.get("SYMPHONY_GIT_AUTHOR_EMAIL", ""),
            "--entrypoint", "sh", env["SYMPHONY_IMAGE"], "-c",
            "set -e; git fetch /source.bundle refs/heads/" + settings["base"] + ":refs/remotes/origin/" + settings["base"] + "; "
            "mkdir -p /tmp/worker-data/opencode /tmp/worker-home; "
            "cp /model-auth.json /tmp/worker-data/opencode/auth.json; "
            'exec opencode run --format json --pure --model "$1" -- "$2"',
            "worker", env["SYMPHONY_OPENCODE_MODEL"], prompt]
    # No tracker token, SSH agent, Docker socket, user HOME or repo credentials.
    return args


if __name__ == "__main__":
    # The trusted broker runs on the host; arbitrary worker code stays in Docker.
    from bridge import Bridge
    Bridge(json.loads(Path(os.environ["SYMPHONY_REPO_CONFIG"]).read_text())).run()
