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
 * Vale identico per le riesportazioni: `export { x } from`, `export * from` e
 * `export * as ns from` verso un bordo sono importazioni di valore travestite,
 * e il controllo le vede. Un `export type … from` resta permesso, come
 * `import type`.
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

/** Importazioni e riesportazioni di valore verso i bordi, una per riga `spec`. */
function valueImportsToEdges(source: string): string[] {
  // Via i type-only: `import type …;` e `export type …;` non esistono a runtime.
  const noTypes = source
    .replace(/^\s*import\s+type\s+[\s\S]*?;(?=\s*(?:\n|$))/gm, '')
    .replace(/^\s*export\s+type\s+[\s\S]*?;(?=\s*(?:\n|$))/gm, '');
  const hits: string[] = [];
  const collect = (spec: string): void => {
    if (!/(^|\/)agent\/|(^|\/)connectors\/|(^|\/)cli\//.test(spec)) return;
    // Normalizza `../../agent/x.js` → `agent/x.js` per l'eccezione.
    if (ALLOWED_VALUE_IMPORTS.has(spec.replace(/^(\.\.\/|\.\/)+/, ''))) return;
    hits.push(spec);
  };
  const staticRe = /import\s*(?:[\s\S]*?\bfrom\s*)?['"]([^'"]+)['"]/g;
  const dynamicRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  // Riesportazioni di valore. `export type … from` è già tolto sopra; una
  // lista di soli `type` (`export { type A } from`, che non esiste a runtime)
  // si salta; tutto il resto — anche misto tipo/valore — è un import di valore
  // e va visto: nel dubbio, fallire.
  const reexportRe = /export\s+(?:\*|\*\s+as\s+[\w$]+|\{([^}]*)\})\s+from\s*['"]([^'"]+)['"]/g;
  for (const re of [staticRe, dynamicRe]) {
    for (const match of noTypes.matchAll(re)) collect(match[1] ?? '');
  }
  for (const match of noTypes.matchAll(reexportRe)) {
    const named = match[1];
    if (named !== undefined && onlyTypes(named)) continue;
    collect(match[2] ?? '');
  }
  return hits;
}

/** Vero per `type A`, `type A as B`, separati da virgole: una lista senza valori. */
function onlyTypes(named: string): boolean {
  return named.split(',').every((entry) => /^\s*type\s+[\w$]+\s*(?:as\s+[\w$]+)?\s*$/.test(entry));
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
