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
import uuid


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

def read_upstream(path):
    if not path.exists(): return None
    value = json.loads(path.read_text())
    if not isinstance(value.get("pid"), int) or value["pid"] < 2 or not isinstance(value.get("marker"), str) or len(value["marker"]) != 32:
        raise ValueError("invalid service process identity")
    return value


def upstream_live(state):
    if not state: return False
    try:
        if os.getpgid(state["pid"]) != state["pid"]: return False
        command = subprocess.run(["ps", "-ww", "-p", str(state["pid"]), "-o", "command="],
                                 capture_output=True, text=True, check=False).stdout
        return state["marker"] in command
    except ProcessLookupError:
        return False


def stop_upstream(state):
    # Never signal a stale PID unless the unique launch identity still matches.
    if not upstream_live(state): return
    try:
        os.killpg(state["pid"], signal.SIGTERM)
    except ProcessLookupError:
        return
    for _ in range(25):
        if not upstream_live(state): return
        time.sleep(.2)
    if upstream_live(state):
        try:
            os.killpg(state["pid"], signal.SIGKILL)
        except ProcessLookupError:
            pass


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
    upstream_file = registry / (service + ".upstream.json")
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
        upstream = read_upstream(upstream_file)
        running = live or upstream_live(upstream)
        print(json.dumps({"service": service, "pid": pid, "running": running,
                          "dashboard": f"http://127.0.0.1:{config['port']}/api/v1/state"}))
        if args.action == "stop":
            if live:
                # A stale PID must never signal an unrelated host process.
                stopfile.write_text(str(pid))
            stop_upstream(upstream)
            stop_containers(service)
            if not live: upstream_file.unlink(missing_ok=True); pidfile.unlink(missing_ok=True)
        return
    if not args.symphony or not args.auth or not all(os.environ.get(k) for k in ("GITHUB_TOKEN", "SYMPHONY_GIT_AUTHOR_NAME", "SYMPHONY_GIT_AUTHOR_EMAIL", "SYMPHONY_OPENCODE_MODEL")):
        parser.error("start requires --symphony, --auth, host-only GITHUB_TOKEN, model and DCO identity")
    with open_lock(lockfile) as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if upstream_live(read_upstream(upstream_file)):
            raise ValueError("prior scheduler still active after wrapper exit; run stop before restart")
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
        marker = uuid.uuid4().hex
        command = [str(args.symphony.resolve(strict=True)), str(workflow),
                   "--i-understand-that-this-will-be-running-without-the-usual-guardrails",
                   "--logs-root", str(runtime / "logs" / service / marker), "--port", str(config["port"])]
        gate_read, gate_write = os.pipe()
        proc = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "_exec", str(gate_read), *command],
                                env=env, pass_fds=(gate_read,), start_new_session=True)
        os.close(gate_read)
        try:
            # Record process identity before allowing scheduler execution. If
            # the wrapper dies in this window, pipe EOF prevents execution.
            pending = upstream_file.with_suffix(".pending")
            pending.write_text(json.dumps({"pid": proc.pid, "marker": marker}))
            os.replace(pending, upstream_file)
            os.write(gate_write, b"1")
        finally:
            os.close(gate_write)
        def stop(_signum, _frame):
            stop_upstream(read_upstream(upstream_file))
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        try:
            while proc.poll() is None:
                if stopfile.exists() and stopfile.read_text() == str(os.getpid()):
                    stop_upstream(read_upstream(upstream_file))
                    stopfile.unlink(missing_ok=True)
                time.sleep(.2)
        finally:
            stop_upstream(read_upstream(upstream_file))
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            stop_containers(service)
            pidfile.unlink(missing_ok=True)
            upstream_file.unlink(missing_ok=True)


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "_exec":
        gate = int(sys.argv[2])
        ready = os.read(gate, 1)
        os.close(gate)
        if ready != b"1": sys.exit(78)
        # Keep a trusted process-group leader with the launch marker even
        # when the release executable wraps/forks its Erlang runtime.
        result = subprocess.run(sys.argv[3:], env=os.environ)
        sys.exit(result.returncode)
    else:
        main()
