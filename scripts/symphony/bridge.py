#!/usr/bin/env python3
"""Bounded Symphony app-server -> OpenCode run adapter. Python stdlib only.

Not a Codex server or sandbox: isolation belongs to the Docker launcher.
Only the pinned Symphony handshake/turn/dynamic-tool subset is supported.
"""
import concurrent.futures
import base64
import fcntl
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hmac
import subprocess
import sys
import tempfile
import threading
import uuid


def write_json(stream, value):
    stream.write(json.dumps(value, separators=(",", ":")) + "\n")
    stream.flush()


class RetryableBaseChange(ValueError):
    pass


def brief_from_issue(issue, config):
    labels = {x["name"].strip().lower() for x in issue.get("labels", [])}
    if issue.get("state") != "open" or "pull_request" in issue or config["ready_label"] not in labels:
        raise ValueError("issue is not explicitly READY")
    if labels & {"reserved", "high-risk", "founder-required", "blocked"}:
        raise ValueError("reserved/high-risk/blocked issue excluded from this pilot")
    blocks = re.findall(r"```symphony-work\s*\n(.*?)\n```", issue.get("body") or "", re.S)
    if len(blocks) != 1:
        raise ValueError("exactly one symphony-work brief required")
    brief = json.loads(blocks[0])
    for key in ("owner", "acceptance", "current_failure"):
        if not isinstance(brief.get(key), str) or not brief[key].strip():
            raise ValueError("missing bounded brief field: " + key)
    if brief.get("risk") != "ordinary" or brief.get("canonical_issue") != issue["number"]:
        raise ValueError("canonical ordinary issue required; founder-approved is not a dispatch bypass")
    paths = brief.get("write_set")
    if not isinstance(paths, list) or not paths or len(paths) > 30:
        raise ValueError("1..30 exact write paths required")
    for path in paths:
        if (not isinstance(path, str) or not path or path != str(PurePosixPath(path))
                or PurePosixPath(path).is_absolute() or ".." in PurePosixPath(path).parts
                or any(c in path for c in "\n\r\x00*?[")
                or any(p.startswith(".") for p in PurePosixPath(path).parts)
                or any(path == p or path.startswith(p.rstrip("/") + "/") for p in config["denied_paths"])):
            raise ValueError("unsafe or reserved write path")
    return brief


def github_allowed(arguments, config, pr_numbers):
    """No labels, issue writes, reviews, merge, credentials, Git refs or cross-repo calls."""
    method, path = arguments.get("method"), arguments.get("path", "")
    if "review-attestation" in json.dumps(arguments.get("body", {})):
        return False
    root = "/repos/" + config["repo"]
    if not isinstance(path, str) or any(c in path for c in "?%\\\n\r\x00") or ".." in path:
        return False
    if not path.startswith(root + "/"):
        return False
    relative = path[len(root):]
    if method == "GET":
        return bool(re.fullmatch(r"/(issues|pulls|commits|actions/runs)(/[A-Za-z0-9_/-]+)?", relative))
    if method == "POST" and relative == "/pulls":
        body = arguments.get("body") or {}
        return (body.get("base") == config["base"] and
                body.get("head") == config.get("branch") and isinstance(body.get("draft"), bool))
    for n in pr_numbers:
        if method == "POST" and relative == f"/issues/{n}/comments":
            return set(arguments.get("body") or {}) == {"body"}
        if method == "PATCH" and relative == f"/pulls/{n}":
            return set(arguments.get("body") or {}) <= {"title", "body"}
    return False


class Bridge:
    def __init__(self, config, input_stream=sys.stdin, output_stream=sys.stdout):
        self.config, self.input, self.output = config, input_stream, output_stream
        for field, env in (("author_name", "SYMPHONY_GIT_AUTHOR_NAME"), ("author_email", "SYMPHONY_GIT_AUTHOR_EMAIL"), ("model", "SYMPHONY_OPENCODE_MODEL")):
            if env in os.environ:
                self.config[field] = os.environ[env]
        self.pending, self.output_lock = {}, threading.Lock()
        self.thread_id, self.turn_id = "opencode-" + uuid.uuid4().hex, None
        self.worker, self.lock_file, self.temp, self.server = None, None, None, None
        self.closed = threading.Event()
        self.pr_numbers = set()
        self.brief = None
        self.publish_lock = threading.Lock()
        self.worker_timer = None
        self.container = None
        self.isolated = bool(os.environ.get("SYMPHONY_SERVICE"))
        self.cleanup_lock = threading.RLock()

    def git_command(self, *args):
        if self.isolated:
            if not self.container:
                raise ValueError("worker container not active")
            return ["docker", "exec", self.container, "git", *args]
        return ["git", *args]  # credential-free fixture only

    def git(self, *args):
        return subprocess.check_output(self.git_command(*args))

    def publish(self):
        """Publish only validated files, through the host-side credential.

        API branch commits are the remote candidate: return that SHA, not the
        local commit SHA. No raw Git mutation API is exposed to the worker.
        """
        root = "/repos/" + self.config["repo"]
        issue = self.rpc({"method": "GET", "path": root + "/issues/" + str(self.brief["canonical_issue"])})
        if brief_from_issue(issue, self.config) != self.brief:
            raise ValueError("issue authority changed before publication")
        base = "origin/" + self.config["base"]
        if self.git("branch", "--show-current").decode().strip() != self.config["branch"]:
            raise ValueError("candidate must be on the owned issue branch")
        paths = [p.decode() for p in self.git("diff", "--no-renames", "--name-only", "-z", base + "...HEAD").split(b"\0") if p]
        if not paths or not set(paths) <= set(self.brief["write_set"]):
            raise ValueError("candidate outside exact write-set or empty")
        if self.git("status", "--porcelain").strip():
            raise ValueError("commit candidate before publication")
        base_sha = self.git("rev-parse", base).decode().strip()
        if subprocess.run(self.git_command("merge-base", "--is-ancestor", base, "HEAD"), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
            raise ValueError("rebase the owned branch onto current integration base before publication")
        live_base = self.rpc({"method": "GET", "path": root + "/branches/" + self.config["base"]})
        if live_base["commit"]["sha"] != base_sha:
            raise RetryableBaseChange("integration base advanced; retry with refreshed host bundle")
        base_commit = self.rpc({"method": "GET", "path": root + "/git/commits/" + base_sha})
        existing = self.rpc({"method": "GET", "path": root + "/git/matching-refs/heads/" + self.config["branch"]})
        existing = [r for r in existing if r["ref"] == "refs/heads/" + self.config["branch"]]
        parent = existing[0]["object"]["sha"] if existing else base_sha
        current = self.rpc({"method": "GET", "path": root + "/git/commits/" + parent})
        reconciled = True
        if existing:
            comparison = self.rpc({"method": "GET", "path": root + "/compare/" + base_sha + "..." + parent})
            if comparison.get("status") not in ("ahead", "identical", "behind", "diverged") or len(comparison.get("files", [])) >= 300:
                raise ValueError("published branch comparison invalid or truncated")
            reconciled = comparison["status"] in ("ahead", "identical")
            for file in comparison.get("files", []):
                if file["filename"] not in self.brief["write_set"] or file.get("previous_filename", file["filename"]) not in self.brief["write_set"]:
                    raise ValueError("published branch changed outside owned write-set")
        entries = []
        for path in paths:
            entry = self.git("ls-tree", "HEAD", "--", path).decode().strip()
            if not entry:
                entries.append({"path": path, "mode": "100644", "type": "blob", "sha": None})
                continue
            mode, kind, _sha = entry.split("\t")[0].split()
            if mode not in ("100644", "100755") or kind != "blob":
                raise ValueError("symlinks/submodules excluded")
            content = base64.b64encode(self.git("show", "HEAD:" + path)).decode()
            blob = self.rpc({"method": "POST", "path": root + "/git/blobs", "body": {"content": content, "encoding": "base64"}})
            entries.append({"path": path, "mode": mode, "type": "blob", "sha": blob["sha"]})
        tree = self.rpc({"method": "POST", "path": root + "/git/trees", "body": {
            "base_tree": base_commit["tree"]["sha"], "tree": entries}})
        if tree["sha"] == current["tree"]["sha"] and reconciled:
            return {"branch": self.config["branch"], "head_sha": parent}
        message = self.git("show", "-s", "--format=%B", "HEAD").decode().strip()
        name, email = self.config["author_name"], self.config["author_email"]
        if f"Signed-off-by: {name} <{email}>" not in message:
            raise ValueError("approved DCO identity required")
        commit = self.rpc({"method": "POST", "path": root + "/git/commits", "body": {
            "message": message, "tree": tree["sha"], "parents": [parent] if reconciled else [parent, base_sha], "author": {"name": name, "email": email}}})
        if existing:
            args = {"method": "PATCH", "path": root + "/git/refs/heads/" + self.config["branch"],
                    "body": {"sha": commit["sha"], "force": False}}
        else:
            args = {"method": "POST", "path": root + "/git/refs",
                    "body": {"ref": "refs/heads/" + self.config["branch"], "sha": commit["sha"]}}
        self.rpc(args)
        return {"branch": self.config["branch"], "head_sha": commit["sha"]}

    def emit(self, value):
        with self.output_lock:
            write_json(self.output, value)

    def notify(self, method, params=None):
        self.emit({"method": method, "params": params or {}})

    def rpc(self, arguments):
        request_id = "github-" + uuid.uuid4().hex
        future = concurrent.futures.Future()
        self.pending[request_id] = future
        self.emit({"id": request_id, "method": "item/tool/call", "params": {
            "threadId": self.thread_id, "turnId": self.turn_id,
            "callId": request_id, "tool": "github_api", "arguments": arguments}})
        try:
            result = future.result(timeout=45)
            if not result.get("success"):
                raise ValueError("GitHub host tool rejected request")
            payload = json.loads(result["output"])
            if not 200 <= payload.get("status", 0) < 300:
                raise ValueError("GitHub response was not successful")
            return payload["body"]
        finally:
            self.pending.pop(request_id, None)

    def blocked(self, reason):
        # Symphony recognizes this as operator_input_required and does not retry
        # while alive. The program orchestrator removes READY before restart.
        self.emit({"id": "handoff-" + uuid.uuid4().hex, "method": "item/tool/requestUserInput",
                   "params": {"threadId": self.thread_id, "turnId": self.turn_id,
                              "questions": [{"id": "handoff", "header": "Operator",
                                             "question": reason, "isOther": True, "options": []}]}})

    def mcp_request(self, request):
        method, params = request.get("method"), request.get("params", {})
        if "id" not in request:
            return None
        try:
            if method == "initialize":
                result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                          "serverInfo": {"name": "symphony-github", "version": "1"}}
            elif method == "tools/list":
                result = {"tools": [{"name": "publish_branch", "description": "Publish committed exact write-set; returns remote candidate SHA. No raw Git credentials.",
                                      "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}},
                                     {"name": "github_api", "description": "Scoped host-side GitHub API; no merge or issue writes.",
                                      "inputSchema": {"type": "object", "properties": {
                                          "method": {"type": "string"}, "path": {"type": "string"},
                                          "params": {"type": "object"}, "body": {"type": "object"}},
                                          "required": ["method", "path"]}}]}
            elif method == "tools/call" and params.get("name") == "publish_branch":
                with self.publish_lock:
                    published = self.publish()
                result = {"content": [{"type": "text", "text": json.dumps(published)}]}
            elif method == "tools/call" and params.get("name") == "github_api":
                args = params.get("arguments", {})
                if not github_allowed(args, self.config, self.pr_numbers):
                    raise ValueError("GitHub request outside worker authority")
                body = self.rpc(args)
                if args.get("method") == "POST" and args.get("path", "").endswith("/pulls"):
                    self.pr_numbers.add(body["number"])
                result = {"content": [{"type": "text", "text": json.dumps(body)}]}
            else:
                raise ValueError("unsupported MCP method")
            return {"jsonrpc": "2.0", "id": request["id"], "result": result}
        except RetryableBaseChange:
            self.notify("turn/failed", {"turnId": self.turn_id, "error": "integration base advanced; refresh and retry"})
            threading.Thread(target=self.cleanup_worker, daemon=True).start()
            return {"jsonrpc": "2.0", "id": request.get("id"), "error": {"code": -32000, "message": "Base advanced"}}
        except Exception:
            return {"jsonrpc": "2.0", "id": request.get("id"), "error": {"code": -32000, "message": "Scoped host request failed"}}

    def start_mcp(self):
        bridge, token = self, uuid.uuid4().hex + uuid.uuid4().hex
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_GET(self):
                self.send_response(405); self.end_headers()
            def do_POST(self):
                if self.path != "/mcp" or not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
                    self.send_response(403); self.end_headers(); return
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if not 0 < length < 65536: raise ValueError("size")
                    response = bridge.mcp_request(json.loads(self.rfile.read(length)))
                    payload = json.dumps(response).encode() if response else b""
                    self.send_response(200 if response else 202)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(payload))); self.end_headers()
                    self.wfile.write(payload)
                except (ValueError, OSError):
                    self.send_response(400); self.end_headers()
        self.server = ThreadingHTTPServer(("0.0.0.0" if self.isolated else "127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        host = "host.docker.internal" if self.isolated else "127.0.0.1"
        return {"type": "remote", "url": f"http://{host}:{self.server.server_port}/mcp", "headers": {"Authorization": "Bearer " + token}}

    def run_worker(self, params):
        try:
            prompt = "\n".join(x.get("text", "") for x in params.get("input", []) if x.get("type") == "text")
            match = re.fullmatch(r"Canonical issue: ([1-9][0-9]*)\s*", prompt)
            if not match:
                raise ValueError("invalid issue envelope")
            number = int(match[1])
            root = "/repos/" + self.config["repo"]
            issue = self.rpc({"method": "GET", "path": f"{root}/issues/{number}"})
            brief = brief_from_issue(issue, self.config)
            self.brief = brief
            self.config["branch"] = f"slice/symphony-{number}"
            prs = self.rpc({"method": "GET", "path": root + "/pulls",
                            "params": {"state": "open", "per_page": 100}})
            # Fail closed on truncation; selection/collision ownership stays with
            # the program orchestrator, not an inferred scheduler plan.
            if len(prs) >= 100:
                raise ValueError("open PR page may be truncated")
            relevant = [p for p in prs if p["head"]["ref"] == self.config["branch"] or
                        re.search(r"#" + str(number) + r"\b", p.get("body") or "")]
            if any(p["head"].get("repo", {}).get("full_name") != self.config["repo"] for p in relevant):
                raise ValueError("another repository/fork owns this PR")
            self.pr_numbers.update(p["number"] for p in relevant)
            if any(p["head"]["ref"] != self.config["branch"] for p in relevant):
                raise ValueError("another PR already owns this issue")
            if issue.get("assignees") and {a["login"] for a in issue["assignees"]} != {brief["owner"]}:
                raise ValueError("issue claimed by a different owner")
            # A worker repairs its own existing PR; a persistent handoff marker
            # prevents restart from relaunching accepted work.
            for pr in relevant:
                comments = self.rpc({"method": "GET", "path": root + f"/issues/{pr['number']}/comments", "params": {"per_page": 100}})
                if len(comments) >= 100 or any(f"symphony-handoff:{pr['head']['sha']}" in (c.get("body") or "") for c in comments):
                    raise ValueError("review handoff or truncated comments; program orchestrator must remove READY")
            if self.config.get("reserved_classifier"):
                # A repo-owned command reads its canonical reserved predicate.
                classifier = self.config["reserved_classifier"]
                if self.isolated:
                    classifier = [classifier[0], str(Path(os.environ["SYMPHONY_REPO_CONFIG"]).parent / classifier[1])]
                result = subprocess.run(classifier, input=json.dumps(brief["write_set"]),
                                        text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True)
                if json.loads(result.stdout):
                    raise ValueError("canonical reserved predicate rejected write-set")
            # EOF cleanup must either prevent launch or observe every resource.
            with self.cleanup_lock:
                if self.closed.is_set(): return
                if self.isolated:
                    import hashlib
                    key = hashlib.sha256((self.config["repo"] + "#" + str(number)).encode()).hexdigest()[:16]
                    lock_root = Path(os.environ["SYMPHONY_LOCK_ROOT"])
                    lock_root.mkdir(parents=True, exist_ok=True, mode=0o700)
                    self.lock_file = open(lock_root / (key + ".lock"), "a")
                    fcntl.flock(self.lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.temp = tempfile.TemporaryDirectory(prefix="symphony-opencode-")
                mcp = self.start_mcp()
                config = {"$schema": "https://opencode.ai/config.json", "autoupdate": False,
                          "mcp": {"symphony": mcp},
                          "permission": {"*": "allow", "external_directory": "deny", "question": "deny"}}
                if self.isolated and os.environ.get("SYMPHONY_OPENCODE_PROVIDER_CONFIG"):
                    config["provider"] = json.loads(Path(os.environ["SYMPHONY_OPENCODE_PROVIDER_CONFIG"]).read_text())
                configfile = Path(self.temp.name) / "opencode.json"
                configfile.write_text(json.dumps(config))
                text = (f"Repository: {self.config['repo']}\nCanonical issue: #{number} {issue['title']}\n"
                        f"Integration base: origin/{self.config['base']}\nOwned branch: {self.config['branch']}\n"
                        + json.dumps(brief, indent=2) + "\n\nRead AGENTS.md and relevant local contracts. "
                        "Work only in write_set; preserve other writers. Create or reuse the owned branch, and reconcile it onto the current integration base before coding/publishing. Reuse this branch/PR on retry. "
                        "Repair implementation/tests/exact-head CI until review-ready. Commit with the configured "
                        "DCO identity, then use symphony publish_branch; use its returned REMOTE head SHA for CI. "
                        "Create the PR when integration-grade (draft=false) using "
                        "the symphony github_api MCP tool, and post evidence on that PR. "
                        "Never merge, label, close issues, deploy or modify reserved/product authority. "
                        "If credentials or founder authority are missing, report that blocker. "
                        "After required exact-head CI succeeds, post a PR comment containing "
                        "symphony-handoff:<remote SHA> and evidence. This is not a review attestation. "
                        "Finish with a concise SHA/evidence/handoff; do not start other work.")
                env = {k: v for k, v in os.environ.items() if k not in {
                    "GITHUB_TOKEN", "GH_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_ENTERPRISE_TOKEN"}}
                env["OPENCODE_CONFIG"] = str(configfile)
                env["OPENCODE_DISABLE_AUTOUPDATE"] = "true"
                for k, v in {"GIT_AUTHOR_NAME": self.config["author_name"], "GIT_COMMITTER_NAME": self.config["author_name"],
                             "GIT_AUTHOR_EMAIL": self.config["author_email"], "GIT_COMMITTER_EMAIL": self.config["author_email"]}.items():
                    env[k] = v
                command = [self.config.get("opencode_bin", "opencode"), "run", "--format", "json", "--pure"]
                if self.config.get("model"):
                    command += ["--model", self.config["model"]]
                command += ["--", text]
                if self.isolated:
                    from launcher import command as docker_command
                    command = docker_command(os.environ, str(Path.cwd()), self.temp.name, text, number)
                    self.container = command[command.index("--name") + 1]
                self.worker = subprocess.Popen(command, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                               stderr=subprocess.DEVNULL, text=True, start_new_session=True)
                self.worker_timer = threading.Timer(self.config.get("worker_timeout_seconds", 3600), self.cleanup_worker)
                self.worker_timer.daemon = True
                self.worker_timer.start()
            finished, failed = False, False
            for line in self.worker.stdout:
                try:
                    event = json.loads(line)
                except ValueError:
                    failed = True
                    continue
                # Never forward raw provider/tool output, prompt, arguments or secrets.
                kind = event.get("type")
                failed |= kind == "error"
                finished |= kind == "step_finish" and event.get("part", {}).get("reason") == "stop"
                self.notify("item/started", {"threadId": self.thread_id, "turnId": self.turn_id,
                                             "item": {"type": "opencodeProgress", "event": kind}})
            code = self.worker.wait()
            if code != 0 or failed or not finished:
                self.notify("turn/failed", {"turnId": self.turn_id, "error": "OpenCode failed or lacked a final stop event"})
            else:
                self.blocked("OpenCode attempt finished. Inspect branch/PR evidence; remove READY at handoff. "
                             "No merge or completion is inferred from process exit.")
        except (ValueError, OSError, KeyError, TimeoutError, subprocess.CalledProcessError):
            self.blocked("Dispatch preflight failed: inspect canonical brief, claim, write-set, GitHub access and existing PR.")
        finally:
            self.cleanup_worker()

    def cleanup_worker(self):
        with self.cleanup_lock:
            if self.worker_timer:
                self.worker_timer.cancel()
            if self.container:
                subprocess.run(["docker", "stop", "--time", "3", self.container],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                self.container = None
            if self.worker:
                try:
                    os.killpg(self.worker.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    self.worker.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(self.worker.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    self.worker.wait()
            if self.server:
                self.server.shutdown()
                self.server.server_close()
                self.server = None
            if self.temp:
                self.temp.cleanup()
                self.temp = None
            if self.lock_file:
                self.lock_file.close()
                self.lock_file = None

    def run(self):
        try:
            for line in self.input:
                message = json.loads(line)
                request_id, method = message.get("id"), message.get("method")
                if method is None:
                    future = self.pending.get(request_id)
                    if future and not future.done():
                        future.set_result(message.get("result", {}))
                    continue
                if method == "initialized":
                    continue
                if method == "initialize":
                    result = {"userAgent": "symphony-opencode/1"}
                elif method == "thread/start":
                    params = message.get("params", {})
                    if Path(params.get("cwd", "")).resolve() != Path.cwd().resolve():
                        raise ValueError("cwd mismatch")
                    result = {"thread": {"id": self.thread_id}}
                elif method == "turn/start" and self.turn_id is None:
                    self.turn_id = uuid.uuid4().hex
                    self.emit({"id": request_id, "result": {"turn": {"id": self.turn_id}}})
                    threading.Thread(target=self.run_worker, args=(message["params"],), daemon=True).start()
                    continue
                else:
                    self.emit({"id": request_id, "error": {"code": -32601, "message": "Unsupported adapter method"}})
                    continue
                self.emit({"id": request_id, "result": result})
        finally:
            self.closed.set()
            for future in list(self.pending.values()):
                if not future.done():
                    future.set_exception(ValueError("Symphony stream closed"))
            self.cleanup_worker()


if __name__ == "__main__":
    Bridge(json.loads(Path(sys.argv[1]).read_text())).run()
