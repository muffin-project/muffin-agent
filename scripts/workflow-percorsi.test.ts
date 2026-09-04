import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Ogni percorso che un passo di workflow dà a `vitest run` deve esistere.
 *
 * Il gemello di `script-che-esistono.test.ts`, per l'altra metà del guasto
 * dello stesso giorno. La mappa generata è stata rimossa il 04/09/2026, ma
 * `collegamenti.yml` continuava a eseguire
 * `npx vitest run docs/derived/architecture-map`. Quel percorso non esiste
 * più, vitest esce **1** su «nessun test trovato», e il job era rosso su
 * ogni PR — trovato solo tre PR dopo, e per caso, perché nel frattempo la CI
 * di GitHub era ferma per fatturazione e nessuno guardava quel colore.
 *
 * È la forma di guasto peggiore fra quelle a costo zero: non un test che
 * fallisce dicendo cosa c'è che non va, ma un gate che fallisce **senza
 * un'asserzione dentro**, cioè un rosso che non insegna niente e che si
 * impara a ignorare.
 *
 * Perché solo `vitest run` e non ogni parola del `run:`: un `run:` è shell,
 * e un test che interpreta la shell è un secondo bug in attesa.
 *
 * E perché «trova almeno un test» e non «il percorso esiste»: un argomento
 * posizionale di vitest non è un percorso, è un **filtro** confrontato come
 * sottostringa contro i file di test. `docs/collegamenti` non è una
 * directory e non lo è mai stato — corrisponde a `docs/collegamenti.test.ts`
 * — quindi chiedere che esista boccerebbe un passo che funziona. Ciò che
 * fallisce davvero è il filtro che non pesca niente, ed è esattamente questo
 * che si asserisce.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = join(ROOT, '.github', 'workflows');

/**
 * I filtri che questo comando passa a `vitest run`.
 *
 * Deliberatamente stupido, come il gemello: niente parser di shell, niente
 * YAML da interpretare oltre la riga. Falsi negativi possibili, falsi
 * positivi no — se dice che un filtro non pesca niente, non pesca niente.
 */
export function filtriDatiAVitest(comando: string): string[] {
  const trovati: string[] = [];
  // `vitest run` può comparire più volte nello stesso `run:` multilinea.
  // `^\s*[^#\n]*?` esclude le righe di commento: un YAML spiega i suoi passi
  // a parole, e la parola «vitest» dentro una spiegazione non è un comando.
  const re = /^[^#\n]*?vitest\s+run\s+([^\n]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(comando)) !== null) {
    for (const token of m[1]!.split(/[\s'"`;|&]+/)) {
      if (token === '') continue;
      // Un flag chiude gli argomenti posizionali di questo comando.
      if (token.startsWith('-')) break;
      // `$VAR` e i glob non sono percorsi: il primo lo decide la CI, il
      // secondo lo espande la shell, e un `*` che non corrisponde a niente
      // è un problema diverso da un file mancante.
      if (token.includes('$') || token.includes('*')) continue;
      trovati.push(token.replace(/^\.\//, ''));
    }
  }
  return trovati;
}

/** I file di test versionati, cioè l'insieme contro cui vitest confronta un filtro. */
const TEST_VERSIONATI = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.(test|spec|accept)\.[cm]?[jt]sx?$/.test(f));

/** Quanti test versionati pesca questo filtro — la domanda che vitest si fa. */
function pescati(filtro: string): number {
  return TEST_VERSIONATI.filter((f) => f.includes(filtro)).length;
}

const filtri: [string, string][] = readdirSync(WORKFLOWS)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .flatMap((file) => {
    const testo = readFileSync(join(WORKFLOWS, file), 'utf8');
    return filtriDatiAVitest(testo).map((p): [string, string] => [file, p]);
  });

describe('i filtri che i workflow danno a vitest', () => {
  it('ce ne sono — se questa lista si svuotasse, il resto del file non proverebbe più niente', () => {
    expect(filtri.length).toBeGreaterThan(0);
    expect(TEST_VERSIONATI.length).toBeGreaterThan(100);
  });

  it.each(filtri)('%s: «%s» pesca almeno un test', (_file, filtro) => {
    expect(pescati(filtro)).toBeGreaterThan(0);
  });

  it('un filtro che non pesca niente viene visto', () => {
    // Il caso reale, dentro il test: `docs/derived/architecture-map` è stato
    // cancellato e la riga di YAML è rimasta. Vitest esce 1 e il job diventa
    // rosso senza un'asserzione dentro — un rosso che non insegna niente.
    expect(filtriDatiAVitest('npx vitest run docs/derived/architecture-map --reporter=dot')).toEqual([
      'docs/derived/architecture-map',
    ]);
    expect(pescati('docs/derived/architecture-map')).toBe(0);
    // E la riga di commento accanto, che nomina vitest a parole, non è un comando.
    expect(filtriDatiAVitest('      # girava con npx vitest run docs/qualcosa')).toEqual([]);
  });
});
