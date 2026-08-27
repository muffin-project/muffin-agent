import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Una run che scrive nella home dell owner fallisce, invece di lasciare
    // il file lì. Vedi `core/config/home-guard.ts` per le due volte in cui è
    // successo davvero.
    globalSetup: ['./vitest.home-guard.ts'],
    // Agent worktrees live under .claude/worktrees with full checkouts of this
    // repo: without the exclusion every suite runs twice and a stranger's
    // in-progress branch fails or passes as if it were ours.
    //
    // Scoped to worktrees, which is what the reason above actually describes.
    // The pattern used to be `**/.claude/**`, which was wider than its own
    // justification and had a cost: the hooks in `.claude/hooks/` could not be
    // tested at all, so a cap added there shipped with no test and was wrong.
    //
    // `evals/acceptance/**/*.accept.ts` never matches vitest's own default
    // include glob (`*.test.ts`/`*.spec.ts`) — the suffix was chosen so this
    // exclude is redundant defence, not the only thing keeping the slow e2e
    // suite off every `npm test`. It is listed anyway: a renamed file that
    // drifted onto `.test.ts` should still be caught here rather than silently
    // joining the fast suite and blowing the CI budget nobody would notice
    // until the bill did. `vitest.acceptance.config.ts` is the separate,
    // slower command (`npm run test:acceptance`) that runs these on purpose.
    exclude: ['**/node_modules/**', '**/.claude/worktrees/**', 'evals/acceptance/**/*.accept.ts'],
  },
});
