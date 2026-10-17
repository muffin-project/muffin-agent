import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CORE = dirname(fileURLToPath(import.meta.url));

/**
 * Direzione delle dipendenze del nucleo.
 *
 * `core/` possiede la semantica che rende l'agente continuo uno e sicuro;
 * le capacità stanno ai bordi (`agent/`, `connectors/`, `cli/`). Un modulo
 * del nucleo che importa *comportamento* da un bordo — I/O, rete, memoize,
 * caricatori — rovescia la stratificazione: il nucleo non si può più ragionare
 * né testare senza il bordo, e la futura estrazione di Worker/Node si trascina
 * dietro il mondo.
 *
 * Regola: nessun file di produzione sotto `core/` importa valori da
 * `agent/`, `connectors/` o `cli/`. I contratti di tipo (`import type`) sono
 * cancellati a compile-time e restano permessi; così pure i contratti
 * condivisi del provider in `agent/providers/types.js` (tipi, tassonomia
 * degli errori, dimensionamenti come `REASONING_HEADROOM`), che il nucleo
 * usa per dimensionare le proprie chiamate interne senza eseguire codice del
 * bordo. Il comportamento si inietta per dipendenza (`VistaDeps.carica`,
 * `VoceDeps.misuraAudio`, …), mai per importazione.
 *
 * Se questo test diventa rosso, la correzione è iniettare, non allargare
 * l'eccezione.
 */

const ALLOWED_VALUE_IMPORTS = new Set([
  // Contratti condivisi del provider: tipi + costanti di dimensionamento.
  // Vedi sopra per perché questa è l'unica eccezione.
  'agent/providers/types.js',
]);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (entry.endsWith('.ts')) yield path;
  }
}

/** Importazioni di valore verso i bordi, una per riga `file: spec`. */
function valueImportsToEdges(source: string): string[] {
  // Via i type-only: `import type …;` e `export type …;` non esistono a runtime.
  const noTypes = source
    .replace(/^\s*import\s+type\s+[\s\S]*?;(?=\s*(?:\n|$))/gm, '')
    .replace(/^\s*export\s+type\s+[\s\S]*?;(?=\s*(?:\n|$))/gm, '');
  const hits: string[] = [];
  const staticRe = /import\s*(?:[\s\S]*?\bfrom\s*)?['"]([^'"]+)['"]/g;
  const dynamicRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [staticRe, dynamicRe]) {
    for (const match of noTypes.matchAll(re)) {
      const spec = match[1] ?? '';
      const toEdge = /(^|\/)agent\/|(^|\/)connectors\/|(^|\/)cli\//.test(spec);
      if (!toEdge) continue;
      // Normalizza `../../agent/x.js` → `agent/x.js`.
      const normalized = spec.replace(/^(\.\.\/|\.\/)+/, '');
      if (ALLOWED_VALUE_IMPORTS.has(normalized)) continue;
      hits.push(spec);
    }
  }
  return hits;
}

describe('core layering', () => {
  it('no production module under core/ value-imports agent/, connectors/ or cli/', () => {
    const violations: string[] = [];
    let scanned = 0;
    for (const path of walk(CORE)) {
      if (path.endsWith('.test.ts')) continue;
      scanned += 1;
      const source = readFileSync(path, 'utf8');
      for (const spec of valueImportsToEdges(source)) {
        violations.push(`${path} → ${spec}`);
      }
    }
    expect(scanned).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
