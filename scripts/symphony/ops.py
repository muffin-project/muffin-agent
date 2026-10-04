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
import stat


def stop_containers(service):
    ids = subprocess.check_output(["docker", "ps", "-q", "--filter", "label=symphony.service=" + service], text=True).split()
    if ids:
        subprocess.run(["docker", "stop", "--time", "5", *ids], check=True, stdout=subprocess.DEVNULL)


SERVICE_REGISTRY_PARENT = Path("/tmp")


def service_root():
    root = SERVICE_REGISTRY_PARENT / ("symphony-services-" + str(os.getuid()))
    root.mkdir(mode=0o700, exist_ok=True)
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError("untrusted host service registry")
    return root


def open_lock(path):
    return os.fdopen(os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), "w")

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
    registry = service_root()
    lockfile = registry / (service + ".lock")
    pidfile = registry / (service + ".pid")
    stopfile = registry / (service + ".stop")
    if args.action == "build":
        subprocess.run(["docker", "build", "-t", image, str(adapter)], check=True)
        return
    if args.action in ("status", "stop"):
        pid = int(pidfile.read_text()) if pidfile.exists() else None
        live = True
        with open_lock(lockfile) as status_lock:
            try:
                fcntl.flock(status_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                live = False
            except BlockingIOError:
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
    with open_lock(lockfile) as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        pidfile.write_text(str(os.getpid()))
        stopfile.unlink(missing_ok=True)
        stop_containers(service)  # reap leftovers from a crashed prior instance
        env = os.environ.copy()
        env.update(SYMPHONY_ADAPTER_HOME=str(adapter), SYMPHONY_REPO_CONFIG=str(config_path),
                   SYMPHONY_OPENCODE_AUTH=str(args.auth.resolve(strict=True)), SYMPHONY_SERVICE=service,
                   SYMPHONY_IMAGE=image, SYMPHONY_WORKSPACE_ROOT=str(runtime / "workspaces" / service),
                   SYMPHONY_LAUNCHER=str(adapter / "launcher.py"), SYMPHONY_PREPARE=str(adapter / "prepare.py"),
                   SYMPHONY_LOCK_ROOT=str(registry / "issues"), SYMPHONY_MIRROR_ROOT=str(runtime / "mirrors"), SYMPHONY_SOURCE_BUNDLE=str(runtime / "bundles" / (service + ".bundle")))
        workflow = config_path.parent / config["workflow"]
        proc = subprocess.Popen([str(args.symphony.resolve(strict=True)), str(workflow),
                                 "--i-understand-that-this-will-be-running-without-the-usual-guardrails",
                                 "--logs-root", str(runtime / "logs" / service), "--port", str(config["port"])], env=env)
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
