import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Il numero di un ADR è una risorsa condivisa senza lock.
 *
 * Tre slice in volo lo stesso giorno hanno rivendicato **ADR-0042** — il record
 * del turno, i documenti, il taint in ingresso — e nessuna delle tre poteva
 * accorgersene: ognuna era partita da un `dev` che non conteneva ancora le
 * altre. Non è disattenzione, è la forma del lavoro: con più worktree in
 * parallelo la collisione è la regola, non l'incidente.
 *
 * Il costo di non accorgersene è specifico. Un ADR non è un file, è **una
 * citazione**: `09-contratti-m0-m1.md` dice «questa riga è normativa
 * (ADR-0042)», e se due documenti diversi rispondono a quel numero la riga
 * normativa smette di indicare qualcosa. Il difetto non si vede leggendo il
 * codice — si vede mesi dopo, seguendo un riferimento che porta altrove.
 *
 * Questo test è il lock che il filesystem non dà: chi arriva secondo lo scopre
 * al merge, quando costa una rinumerazione, invece che alla prima citazione
 * ambigua.
 */

const ADR = dirname(fileURLToPath(import.meta.url));
const BLUEPRINT = join(ADR, '..');

const file = readdirSync(ADR).filter((f) => /^\d{4}-.*\.md$/.test(f));

describe('gli ADR', () => {
  it('non condividono un numero', () => {
    const per = new Map<string, string[]>();
    for (const f of file) {
      const n = f.slice(0, 4);
      per.set(n, [...(per.get(n) ?? []), f]);
    }
    const doppi = [...per.entries()]
      .filter(([, f]) => f.length > 1)
      .map(([n, f]) => `${n}: ${f.join(' e ')}`);
    expect(doppi).toEqual([]);
  });

  it('portano nel titolo il numero che hanno nel nome', () => {
    // Una rinumerazione fatta col solo `git mv` lascia il titolo vecchio, e da
    // lì in poi il documento cita se stesso col numero di un altro.
    const storti: string[] = [];
    for (const f of file) {
      const prima = readFileSync(join(ADR, f), 'utf8').split('\n')[0] ?? '';
      const m = /ADR-(\d{4})/.exec(prima);
      if (!m) storti.push(`${f} — la prima riga non dichiara un numero`);
      else if (m[1] !== f.slice(0, 4)) storti.push(`${f} — il titolo dice ADR-${m[1]}`);
    }
    expect(storti).toEqual([]);
  });

  it('esistono, quando il blueprint li cita', () => {
    // Il verso opposto: un riferimento a un ADR mai scritto. Costa quanto il
    // doppione, e si trova nello stesso momento — mai.
    const numeri = new Set(file.map((f) => f.slice(0, 4)));
    const citati = new Map<string, string>();
    const visita = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'adr' || e.name.startsWith('.')) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) visita(p);
        else if (e.name.endsWith('.md') || e.name.endsWith('.json')) {
          for (const m of readFileSync(p, 'utf8').matchAll(/ADR-(\d{4})/g)) {
            if (!citati.has(m[1]!)) citati.set(m[1]!, `${e.name}`);
          }
        }
      }
    };
    visita(BLUEPRINT);
    const fantasmi = [...citati.entries()]
      .filter(([n]) => !numeri.has(n))
      .map(([n, dove]) => `ADR-${n}, citato da ${dove}, non esiste`);
    expect(fantasmi).toEqual([]);
  });
});
