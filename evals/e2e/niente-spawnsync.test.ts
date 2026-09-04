import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Un file che ospita un server nel proprio processo non puo' usare
 * `spawnSync`.
 *
 * Il 04/09/2026 questo ha reso il banco e2e di Telegram **impossibile da
 * superare**, e in un modo che nessun test unitario poteva incontrare.
 * `evals/e2e/telegram.ts` fa girare il proxy che registra il filo dentro il
 * proprio processo, e lanciava la CLI con `spawnSync`: l'event loop restava
 * fermo finche' il figlio non usciva, quindi quando
 * `muffin surface enable --api-base http://127.0.0.1:<porta>` chiedeva
 * `getMe` al proxy, il proxy non poteva rispondere — non era occupato, non
 * girava proprio. Il figlio aspettava i 65 secondi del suo timeout e moriva
 * con `Telegram 0: TimeoutError`, e il filo restava vuoto.
 *
 * La diagnosi era fuorviante per costruzione: «filo vuoto» sembra «la
 * richiesta non e' arrivata», mentre era «la risposta non e' mai partita».
 *
 * Il controllo e' sulla forma del file e non sul comportamento, di proposito:
 * il comportamento richiede un banco vero che costa soldi e un telefono, ed e'
 * esattamente il banco che questo difetto impediva di far girare. Una regola
 * strutturale la si puo' invece far fallire in mezzo secondo.
 */

const QUI = dirname(fileURLToPath(import.meta.url));
const RADICE = join(QUI, '..', '..');

/**
 * Il codice senza i commenti.
 *
 * Serve perche' il commento che spiega **questo** difetto nomina `spawnSync`
 * per esteso — e un controllo che legge anche la prosa punirebbe chi documenta
 * la trappola, che e' l'incentivo esattamente al contrario.
 */
function senzaCommenti(testo: string): string {
  return testo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Ogni `.ts` sotto queste cartelle. `node_modules` e i generati restano fuori. */
function file(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) file(full, out);
    else if (e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('chi ospita un server non blocca il proprio event loop', () => {
  const ospitanti = file(join(RADICE, 'evals'))
    .map((f) => ({ path: relative(RADICE, f), testo: senzaCommenti(readFileSync(f, 'utf8')) }))
    .filter((f) => /createServer\s*\(/.test(f.testo));

  it('almeno un file ospita un server: se questo elenco si svuota il controllo non prova piu\' niente', () => {
    expect(ospitanti.length).toBeGreaterThan(0);
  });

  it.each(ospitanti.map((f) => [f.path, f.testo] as const))('%s non usa spawnSync', (_path, testo) => {
    expect(/\bspawnSync\b/.test(testo)).toBe(false);
  });
});
