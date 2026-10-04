#!/usr/bin/env python3
"""Foreground service wrapper. Symphony alone owns work scheduling/state."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def stop_containers(service):
    ids = subprocess.check_output(["docker", "ps", "-q", "--filter", "label=symphony.service=" + service], text=True).split()
    if ids:
        subprocess.run(["docker", "stop", "--time", "5", *ids], check=True, stdout=subprocess.DEVNULL)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("build", "start", "stop", "status"))
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--symphony", type=Path)
    parser.add_argument("--auth", type=Path)
    parser.add_argument("--runtime", required=True, type=Path)
    args = parser.parse_args()
    config_path = args.config.resolve(strict=True)
    config = json.loads(config_path.read_text())
    adapter = Path(__file__).resolve().parent
    service = "symphony-" + config["repo"].replace("/", "-")
    image = "symphony-opencode:1.18.33-pilot"
    runtime = args.runtime.resolve()
    runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
    pidfile = runtime / (service + ".pid")
    stopfile = runtime / (service + ".stop")
    if args.action == "build":
        subprocess.run(["docker", "build", "-t", image, str(adapter)], check=True)
        return
    if args.action in ("status", "stop"):
        pid = int(pidfile.read_text()) if pidfile.exists() else None
        live = False
        if pid:
            try:
                os.kill(pid, 0)
                live = True
            except ProcessLookupError:
                pass
        print(json.dumps({"service": service, "pid": pid, "running": live,
                          "dashboard": f"http://127.0.0.1:{config['port']}/api/v1/state"}))
        if args.action == "stop":
            if live:
                # A stale PID must never signal an unrelated host process.
                stopfile.write_text(str(pid))
            stop_containers(service)
        return
    if not args.symphony or not args.auth or not all(os.environ.get(k) for k in ("GITHUB_TOKEN", "SYMPHONY_GIT_AUTHOR_NAME", "SYMPHONY_GIT_AUTHOR_EMAIL", "SYMPHONY_OPENCODE_MODEL")):
        parser.error("start requires --symphony, --auth, host-only GITHUB_TOKEN, model and DCO identity")
    with open(runtime / (service + ".lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        env = os.environ.copy()
        env.update(SYMPHONY_ADAPTER_HOME=str(adapter), SYMPHONY_REPO_CONFIG=str(config_path),
                   SYMPHONY_OPENCODE_AUTH=str(args.auth.resolve(strict=True)), SYMPHONY_SERVICE=service,
                   SYMPHONY_IMAGE=image, SYMPHONY_WORKSPACE_ROOT=str(runtime / "workspaces" / service),
                   SYMPHONY_LAUNCHER=str(adapter / "launcher.py"), SYMPHONY_PREPARE=str(adapter / "prepare.py"),
                   SYMPHONY_LOCK_ROOT=str(runtime / "locks"), SYMPHONY_MIRROR_ROOT=str(runtime / "mirrors"), SYMPHONY_SOURCE_BUNDLE=str(runtime / "bundles" / (service + ".bundle")))
        workflow = config_path.parent / config["workflow"]
        proc = subprocess.Popen([str(args.symphony.resolve(strict=True)), str(workflow),
                                 "--i-understand-that-this-will-be-running-without-the-usual-guardrails",
                                 "--logs-root", str(runtime / "logs" / service), "--port", str(config["port"])], env=env)
        pidfile.write_text(str(os.getpid()))
        stopfile.unlink(missing_ok=True)
        def stop(_signum, _frame):
            proc.terminate()
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        try:
            while proc.poll() is None:
                if stopfile.exists() and stopfile.read_text() == str(os.getpid()):
                    proc.terminate()
                    stopfile.unlink(missing_ok=True)
                time.sleep(.2)
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            stop_containers(service)
            pidfile.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
