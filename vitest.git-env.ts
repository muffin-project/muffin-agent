/**
 * Every test worker starts without the caller's `GIT_*` environment.
 *
 * Git exports `GIT_DIR` (absolute, for a linked worktree) and friends to the
 * hooks it runs. The pre-push hook runs this suite, and dozens of fixtures
 * spawn `git init`, `git config` and `git commit` inside a temp directory
 * with the inherited environment — so with `GIT_DIR` set they operated on
 * the *real* repository instead: `core.bare = true`, `user.name = t`, a
 * moved `main`, junk branches (measured 2026-11-25 on a shared clone).
 *
 * A fixture that wants Git config passes it explicitly in its own `env`;
 * nothing a test asserts depends on where the runner itself was started.
 * Cleared in `setupFiles` (inside each worker, before any test file loads),
 * so every child process a test spawns with the default `process.env`
 * inherits the scrubbed copy.
 */
export function clearGitEnv(env: NodeJS.ProcessEnv): string[] {
  const removed = Object.keys(env).filter((key) => key.startsWith('GIT_'));
  for (const key of removed) delete env[key];
  return removed;
}

clearGitEnv(process.env);
