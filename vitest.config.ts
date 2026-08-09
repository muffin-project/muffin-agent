import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Agent worktrees live under .claude/worktrees with full checkouts of this
    // repo: without the exclusion every suite runs twice and a stranger's
    // in-progress branch fails or passes as if it were ours.
    //
    // Scoped to worktrees, which is what the reason above actually describes.
    // The pattern used to be `**/.claude/**`, which was wider than its own
    // justification and had a cost: the hooks in `.claude/hooks/` could not be
    // tested at all, so a cap added there shipped with no test and was wrong.
    exclude: ['**/node_modules/**', '**/.claude/worktrees/**'],
  },
});
