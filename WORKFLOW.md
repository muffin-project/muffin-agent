---
tracker:
  kind: github
  provider:
    repo: muffin-project/muffin-agent
    token: $GITHUB_TOKEN
  required_labels: ["agent:symphony"]
  active_states: [open]
  terminal_states: [closed]
polling:
  interval_ms: 30000
workspace:
  root: $SYMPHONY_WORKSPACE_ROOT
hooks:
  after_create: |
    GIT_TERMINAL_PROMPT=0 git -c credential.helper='!gh auth git-credential' clone --branch dev --single-branch https://github.com/muffin-project/muffin-agent.git .
  before_run: |
    python3 "$SYMPHONY_PREPARE"
agent:
  max_concurrent_agents: 1
  max_turns: 1
codex:
  command: python3 "$SYMPHONY_LAUNCHER"
  approval_policy: never
  thread_sandbox: danger-full-access
  turn_sandbox_policy:
    type: dangerFullAccess
server:
  host: 127.0.0.1
---
Canonical issue: {{ issue.id }}
