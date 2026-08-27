import { defineConfig } from 'vitest/config';

/**
 * The acceptance suite, on its own clock.
 *
 * Kept out of `vitest.config.ts` on purpose (PRACTICES.md's CI-budget concern,
 * and `.github/workflows/ci.yml`'s own accounting of why every minute is
 * counted): each scenario here spawns one or more real `node` processes
 * running the actual CLI, which costs real wall-clock time that a unit test
 * never does. `npm test` must stay fast; `npm run test:acceptance` is the
 * separate, slower command this file exists to name.
 *
 * `fileParallelism: false` — one acceptance file at a time. Scenarios spawn
 * real child processes and open real sqlite connections against their own
 * temp directories, so they do not collide with each other the way a shared
 * in-memory fixture would; the constraint here is different: several
 * concurrent `node --import tsx` boots is exactly the kind of load that made
 * the dead delegation's timeouts hard to tell apart from the real deadlock
 * this suite's harness fix now avoids. Sequential is slower and legible,
 * which matters more for a suite whose whole job is to be trusted.
 */
export default defineConfig({
  test: {
    // Una run che scrive nella home dell owner fallisce, invece di lasciare
    // il file lì. Vedi `core/config/home-guard.ts` per le due volte in cui è
    // successo davvero.
    globalSetup: ['./vitest.home-guard.ts'],
    include: ['evals/acceptance/**/*.accept.ts'],
    exclude: ['**/node_modules/**', '**/.claude/worktrees/**'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
