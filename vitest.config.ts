import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Agent worktrees live under .claude/worktrees with full checkouts of this
    // repo: without the exclusion every suite runs twice and a stranger's
    // in-progress branch fails or passes as if it were ours.
    exclude: ['**/node_modules/**', '**/.claude/**'],
  },
});
