import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { install } from '../harness.js';
import { HEADLESS_TURN_TIMEOUT_SECONDS, headlessTestTimeoutMs } from '../turn-budget.js';

/**
 * `fs_edit` sul binario vero — non un `Provider` iniettato.
 *
 * `agent/runtime-wiring.test.ts` prova la stessa cucitura in-process (kernel
 * `draft`, snapshot, modifica chirurgica). Ciò che solo questa prova è che
 * l'intera pila — parsing degli argv di `cli/main.ts`, `buildRuntime`,
 * l'esposizione del tool al modello, il kernel, l'handler — tiene insieme
 * attraverso un confine di processo reale, contro un provider (finto ma via
 * socket) che sceneggia la chiamata. Come `lane-concurrency.accept.ts`, è un
 * `it()` plain: nessun difetto di prodotto qui ha una riga di manifest.
 */
describe('acceptance · fs_edit chirurgico', () => {
  it(
    'una chiamata scriptata a fs_edit cambia un blocco solo, senza riscrivere il file',
    async () => {
      const inst = await install({
        main: [
          { tool: { name: 'fs_edit', args: { path: 'bersaglio.txt', oldText: 'BETA', newText: 'beta' } } },
          { text: 'sistemato' },
        ],
      });
      try {
        writeFileSync(join(inst.workspace, 'bersaglio.txt'), 'alfa\nBETA\nomega\n');
        const run = await inst.muffin([
          'run',
          '--timeout',
          String(HEADLESS_TURN_TIMEOUT_SECONDS),
          'sistema la riga in maiuscolo in bersaglio.txt',
        ]);
        if (run.code !== 0) throw new Error(`exit ${run.code} invece di 0:\n${run.err}`);
        if (!run.out.includes('sistemato')) throw new Error(`risposta assente:\n${run.out}`);

        // Chirurgico davvero: il resto del file è intatto.
        const dopo = readFileSync(join(inst.workspace, 'bersaglio.txt'), 'utf8');
        if (dopo !== 'alfa\nbeta\nomega\n') {
          throw new Error(`il file non porta la modifica chirurgica: ${JSON.stringify(dopo)}`);
        }

        // Offerto al modello sul wire, non contrabbandato: la lista tool che
        // la chiamata ha visto contiene sia il nuovo attrezzo che la lettura
        // a finestre da cui doveva partire.
        const call = inst.provider.main()[0];
        if (!call) throw new Error('il modello non è mai stato chiamato');
        for (const atteso of ['fs_edit', 'fs_read']) {
          if (!call.tools.includes(atteso)) {
            throw new Error(`${atteso} non era nella lista tool offerta: ${call.tools.join(', ')}`);
          }
        }
      } finally {
        await inst.cleanup();
      }
    },
    headlessTestTimeoutMs(1),
  );
});
