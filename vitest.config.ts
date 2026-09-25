import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { escludiPerVitest } from './vitest.ignored.js';

const QUI = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    // Fail the run if a test writes under the operator's real home.
    globalSetup: ['./vitest.home-guard.ts'],
    // Exclude Git-ignored generated trees, including nested worktrees/releases.
    exclude: escludiPerVitest(QUI),
    // SQLite-backed tests can exceed Vitest's five-second default on busy
    // runners. Individual tests can still set a narrower timeout explicitly.
    testTimeout: 20_000,
  },
});
