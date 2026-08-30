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
    // Cinque secondi — il default — non sono una scadenza, sono una gara con
    // la CPU. Sotto `gate:local` questa suite gira 213 file in parallelo e
    // impiega ~1160s di tempo-test in ~235s di orologio: un test che apre uno
    // SQLite vero e fa girare le migrazioni non ci mette cinque secondi di
    // lavoro, ci mette cinque secondi di *attesa*. Tre corse consecutive dello
    // stesso SHA hanno prodotto tre rossi diversi, sempre per scadenza e mai
    // per un'asserzione — cioè il rumore esatto che rende un gate inutile,
    // perché un rosso che cambia file a ogni corsa non si distingue da un
    // difetto vero. Venti secondi non nascondono un test che si impianta
    // davvero — lo dice comunque, quattro volte più tardi — e chi ha bisogno di
    // una scadenza più stretta la passa come terzo argomento di `it`, dove è
    // visibile accanto alla ragione.
    testTimeout: 20_000,
  },
});
