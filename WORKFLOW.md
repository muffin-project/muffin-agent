---
tracker:
  kind: github
  provider:
    repo: muffin-project/muffin-agent
    token: $GITHUB_TOKEN
  required_labels:
    - agent:symphony
  active_states:
    - open
  terminal_states:
    - closed
polling:
  interval_ms: 30000
workspace:
  root: ~/symphony-workspaces/muffin-agent
hooks:
  after_create: |
    git clone --branch dev --single-branch ssh://github.com/muffin-project/muffin-agent.git .
agent:
  max_concurrent_agents: 1
  max_turns: 20
codex:
  command: codex app-server
  approval_policy:
    granular:
      sandbox_approval: false
      rules: false
      mcp_elicitations: false
      request_permissions: false
      skill_approval: false
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
    networkAccess: true
---

You own the GitHub issue `{{ issue.identifier }}` until it is genuinely ready
for human review or a real external blocker prevents progress.

Title: {{ issue.title }}

{% if issue.description %}
Issue body:
{{ issue.description }}
{% endif %}

{% if attempt %}
This is attempt {{ attempt }}. Resume from the existing workspace state. Do not
repeat completed investigation or verification unless the candidate changed or
new evidence invalidates it.
{% endif %}

Operating contract:

1. Read `AGENTS.md` first. Repository source, GitHub state, CI, and the
   relevant local canonical docs outrank this prompt.
2. Work only on this issue's bounded claim. Before writing, use the provided
   `github_api` tool to inspect the issue and open PRs that could overlap the
   same behavior or files. If another human/agent already owns overlapping
   work, do not create a competing implementation; record the collision and
   request operator input.
3. Base new work on current `origin/dev`. Reuse an existing branch/PR for this
   issue when one exists; otherwise create a short-lived `slice/...` branch.
   Never push directly to `dev` or `main`.
4. Implement the smallest solution that satisfies the issue acceptance. Decide
   routine reversible implementation details yourself. Do not stop for ordinary
   test failures, CI failures, rebases, review fixes, or implementation choices.
5. Commit coherent checkpoints and push the owned branch. The Symphony host must
   provide Git push authentication; if it does not, this is a true external
   blocker.
6. Create or update a PR targeting `dev`. The tracker credential reads issues
   and writes PRs; use `github_api` for PR metadata and comments. It cannot
   write or close issues. Never merge the PR.
7. Read the GitHub Actions/check state for the exact current PR head. Repair
   failures attributable to the change and continue until the current candidate
   satisfies the repository's required gates. Do not treat a worker summary or
   a green nearby SHA as evidence for the current candidate.
8. When the PR is review-ready, post one compact PR comment containing the
   current head SHA, acceptance evidence, and any explicitly unverified residue.
   Then request operator input for human review. Do not continue polishing,
   refactoring, or starting another issue.
9. Stop earlier only for a genuine external blocker: missing required
   credentials/permissions/tooling, a destructive or irreversible operation
   needing owner authority, or a product/security/privacy decision that the
   repository does not already resolve. State the exact blocker and evidence.

The `agent:symphony` label is dispatch authority, not completion. Do not remove
it or close the issue yourself during this pilot; the maintainer removes the
label after reviewing the handoff. Do not auto-merge.
