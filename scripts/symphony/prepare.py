#!/usr/bin/env python3
"""Refresh a trusted host mirror, never execute Git in a worker-owned clone."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


def prepare(env):
    config = json.loads(Path(env["SYMPHONY_REPO_CONFIG"]).read_text())
    repo, base = config["repo"], config["base"]
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo) or not re.fullmatch(r"[A-Za-z0-9_-]+", base):
        raise ValueError("invalid repo/base")
    mirror = Path(env["SYMPHONY_MIRROR_ROOT"]).resolve() / (repo.replace("/", "-") + ".git")
    bundle = Path(env["SYMPHONY_SOURCE_BUNDLE"]).resolve()
    mirror.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    bundle.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    safe_env = env.copy()
    safe_env.update(GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1", GIT_TERMINAL_PROMPT="0")
    def git(*args):
        subprocess.run(["git", "-c", "core.hooksPath=/dev/null", *args], env=safe_env, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=mirror.parent)
    if not mirror.exists():
        git("init", "--bare", str(mirror))
    git("-C", str(mirror), "-c", "credential.helper=!gh auth git-credential", "fetch", "--no-tags", "--",
        "https://github.com/" + repo + ".git", f"+refs/heads/{base}:refs/heads/{base}")
    fd, temp = tempfile.mkstemp(prefix="base-", suffix=".bundle", dir=bundle.parent)
    os.close(fd)
    try:
        git("-C", str(mirror), "bundle", "create", temp, "refs/heads/" + base)
        os.chmod(temp, 0o644)
        os.replace(temp, bundle)
    finally:
        Path(temp).unlink(missing_ok=True)


if __name__ == "__main__":
    prepare(os.environ)
