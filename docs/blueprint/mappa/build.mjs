#!/usr/bin/env node
/**
 * Genera `mappa.html` inlinando i dati estratti dal repo dentro il template.
 *
 * L'artefatto visivo non si disegna a mano (`README.md`, qui accanto): i dati stanno
 * in `docs/blueprint/mappa/*.json` con un'ancora `file:riga` per ogni voce, e
 * questo script li cuce dentro la pagina. Ridisegnare la mappa dopo un cambio
 * di codice è quindi rieseguire due comandi, non ricordarsi di una cosa.
 *
 *   node docs/blueprint/mappa/ancore.mjs   # riverifica le ancore
 *   node docs/blueprint/mappa/build.mjs    # rigenera la pagina
 *
 * Inlining e non fetch: la pagina pubblicata gira sotto una CSP che blocca ogni
 * richiesta di rete, e da `file://` un fetch fallirebbe comunque.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAPPA = dirname(fileURLToPath(import.meta.url));
const SEZIONI = ['loop', 'tools', 'policy', 'memory', 'surfaces'];

/**
 * `</script>` dentro una stringa JSON chiuderebbe il tag che la contiene: è la
 * via classica per rompere una pagina che inlina dati, e qui i dati contengono
 * codice vero.
 */
const safe = (json) => JSON.stringify(json).replace(/</g, '\\u003c');

const dati = {};
for (const s of SEZIONI) {
  try {
    dati[s] = JSON.parse(readFileSync(join(MAPPA, `data-${s}.json`), 'utf8'));
  } catch (e) {
    console.error(`data-${s}.json non leggibile: ${e.message}`);
    process.exit(1);
  }
}
dati.ancore = JSON.parse(readFileSync(join(MAPPA, 'ancore.json'), 'utf8'));
dati.generato = process.env.MUFFIN_MAPPA_DATA ?? new Date().toISOString().slice(0, 10);

const template = readFileSync(join(MAPPA, 'template.html'), 'utf8');
const out = template.replace('/*__DATI__*/', `window.MAPPA = ${safe(dati)};`);
if (out === template) {
  console.error('segnaposto /*__DATI__*/ non trovato nel template');
  process.exit(1);
}

writeFileSync(join(MAPPA, 'mappa.html'), out);
const kb = (out.length / 1024).toFixed(0);
console.log(`mappa.html: ${kb} KB · ${Object.keys(dati.ancore).length} ancore`);
