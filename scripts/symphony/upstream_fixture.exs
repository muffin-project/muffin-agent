defmodule SymphonyElixir.OpenCodeBridgeFixtureTest do
  use SymphonyElixir.TestSupport

  test "official Symphony workspace and app-server drive the OpenCode bridge for both repos" do
    for {repo, base} <- [{"muffin-project/muffin-agent", "dev"}, {"centrialabs/centria", "main"}] do
      root = Path.join(System.tmp_dir!(), "bridge-#{System.unique_integer([:positive])}")
      File.mkdir_p!(root)
      fake = Path.join(root, "fake-opencode")
      File.write!(fake, """
      #!/usr/bin/env python3
      import json, os, sys
      from pathlib import Path
      Path('received.json').write_text(json.dumps({'argv':sys.argv,'token':os.getenv('GITHUB_TOKEN')}))
      print(json.dumps({'type':'step_finish','part':{'reason':'stop'}}),flush=True)
      """)
      File.chmod!(fake, 0o755)
      adapter = System.fetch_env!("SYMPHONY_FIXTURE_ADAPTER")
      config = Path.join(root, "config.json")
      File.write!(config, Jason.encode!(%{repo: repo, base: base, ready_label: "agent:symphony", denied_paths: ["infra"],
        opencode_bin: fake, author_name: "Fixture", author_email: "fixture@example.invalid"}))
      write_workflow_file!(Workflow.workflow_file_path(), tracker_kind: "memory", workspace_root: root,
        tracker_required_labels: ["agent:symphony"], max_concurrent_agents: 1,
        codex_approval_policy: "never", codex_command: "env SYMPHONY_REPO_CONFIG=#{config} python3 #{adapter}/launcher.py",
        hook_after_create: "git init -q", codex_read_timeout_ms: 5000)
      issue = %Issue{id: "1", identifier: "GH-1", title: "Fixture", state: "In Progress", labels: ["agent:symphony"], dispatchable: true}
      state = %Orchestrator.State{max_concurrent_agents: 1}
      refute Orchestrator.should_dispatch_issue_for_test(%{issue | labels: []}, state)
      assert Orchestrator.should_dispatch_issue_for_test(issue, state)
      assert {:ok, workspace} = Workspace.create_for_issue(issue)
      File.write!(Path.join(workspace, "checkpoint"), "preserved")
      assert {:ok, ^workspace} = Workspace.create_for_issue(issue)
      assert File.read!(Path.join(workspace, "checkpoint")) == "preserved"
      raw = %{number: 1, state: "open", title: "Fixture", assignees: [], labels: [%{name: "agent:symphony"}],
        body: "```symphony-work\n" <> Jason.encode!(%{canonical_issue: 1, owner: "fixture", risk: "ordinary",
          write_set: ["guide.md"], acceptance: "bounded acceptance", current_failure: "bounded failure"}) <> "\n```"}
      executor = fn "github_api", args ->
        body = if String.ends_with?(args["path"], "/issues/1"), do: raw, else: []
        %{"success" => true, "output" => Jason.encode!(%{status: 200, body: body})}
      end
      result = AppServer.run(workspace, "Canonical issue: 1", issue, tool_executor: executor)
      assert match?({:error, {:turn_input_required, _}}, result)
      received = Jason.decode!(File.read!(Path.join(workspace, "received.json")))
      assert Enum.slice(received["argv"], 1, 4) == ["run", "--format", "json", "--pure"]
      assert String.contains?(List.last(received["argv"]), repo)
      assert String.contains?(List.last(received["argv"]), "bounded acceptance")
      File.rm_rf!(root)
    end
  end
end
