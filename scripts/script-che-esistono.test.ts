import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Ogni file nominato da uno script di `package.json` deve esistere.
 *
 * Il 04/09/2026 questo è costato all'owner il Muffin installato. La mappa
 * generata è stata rimossa, ma `prepare` continuava a chiamare
 * `docs/derived/architecture-map/setup-merge-driver.mjs` — cancellato nello
 * stesso commit. Nessun test ha cambiato colore, perché `prepare` non gira
 * durante la suite: gira su `npm ci`, cioè **solo su un albero pulito** —
 * un clone nuovo, o la release che `muffin update` costruisce.
 *
 * Quindi il guasto è arrivato dove non c'era nessuno a guardare: la macchina
 * dell'owner, al momento dell'aggiornamento, con il binario già scollegato.
 * La suite era verde e il prodotto non si installava.
 *
 * Il controllo è deliberatamente stupido: prende dagli script ogni parola che
 * *sembra* un percorso di file del repo e chiede che esista. Non prova a
 * capire la shell — un test che interpreta la shell è un secondo bug in
 * attesa. Falsi negativi possibili, falsi positivi no: se dice che manca un
 * file, quel file manca davvero.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Estensioni che nominano un file eseguibile o sorgente dentro il repo. */
const ESTENSIONI = /\.(mjs|cjs|js|ts|sh|json)$/;

/** Sembra un percorso del repo: ha una barra, non è un flag, non è un URL. */
function paionoPercorsi(comando: string): string[] {
  return comando
    .split(/[\s'"`;|&()]+/)
    .filter((t) => t.includes('/') && ESTENSIONI.test(t))
    .filter((t) => !t.startsWith('-') && !t.includes('://') && !t.startsWith('node_modules/'))
    // `dist/` e' output, non ingresso: chiederne l'esistenza proverebbe se
    // qualcuno ha compilato di recente, non se lo script e' scritto bene.
    // Un glob non e' un percorso: la shell lo espande, e un `*` che non
    // corrisponde a niente e' un problema diverso da un file mancante.
    .filter((t) => !t.startsWith('dist/') && !t.includes('*'))
    .map((t) => t.replace(/^\.\//, ''));
}

describe('gli script di package.json', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const scripts = Object.entries(pkg.scripts ?? {});

  it('esistono', () => {
    expect(scripts.length).toBeGreaterThan(0);
  });

  it.each(scripts)('«%s» nomina solo file che esistono', (_nome, comando) => {
    const mancanti = paionoPercorsi(comando).filter((p) => !existsSync(join(ROOT, p)));
    expect(mancanti).toEqual([]);
  });
});
