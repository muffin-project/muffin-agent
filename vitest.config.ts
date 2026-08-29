import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { escludiPerVitest } from './vitest.ignored.js';

const QUI = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    // Una run che scrive nella home dell owner fallisce, invece di lasciare
    // il file lì. Vedi `core/config/home-guard.ts` per le due volte in cui è
    // successo davvero.
    globalSetup: ['./vitest.home-guard.ts'],
    // La lista non è più scritta a mano: la deriva da ciò che Git ignora, e il
    // perché — 945 file raccolti dove ce n'erano 201 — sta in
    // `vitest.ignored.ts` insieme alla misura che l'ha motivata.
    //
    // Copriva `.claude/worktrees/` e `.gate-linux/` e non copriva `.releases/`
    // (402 file) né `.codex/worktrees/` (342): entrambi invisibili a
    // `git status`, entrambi letti da vitest. Una lista di nomi arriva sempre
    // dopo l'albero che non conosceva ancora.
    exclude: escludiPerVitest(QUI),
  },
});
