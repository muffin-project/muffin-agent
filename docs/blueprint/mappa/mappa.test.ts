import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — script .mjs senza dichiarazioni, volutamente eseguibile a mano
import { mapFiles, references, resolveRef } from './ancore.mjs';

/**
 * La mappa dell'architettura, tenuta onesta.
 *
 * `docs/blueprint/mappa/*.json` è la sorgente dell'artefatto visivo: descrive il
 * flusso di un messaggio, i tool, il kernel dei permessi, la memoria e le
 * superfici. È una **vista derivata**, cioè la forma di documentazione che
 * invecchia peggio — descrive ciò che cambia di più e sbaglia con autorevolezza.
 *
 * Questi test sono il meccanismo al posto del promemoria (ORCHESTRATION §14):
 * ogni `file:riga` citato dalla mappa deve esistere e deve puntare ancora allo
 * stesso testo. Quando il codice si sposta, fallisce **la suite** — non
 * l'artefatto in silenzio, tre settimane dopo, davanti a chi lo legge per capire.
 */

type Ancora = { path: string; line: number; testo: string };

const MAPPA = dirname(fileURLToPath(import.meta.url));
const anchors = JSON.parse(readFileSync(join(MAPPA, 'ancore.json'), 'utf8')) as Record<string, Ancora>;

describe('la mappa dell architettura', () => {
  it('esiste ed è JSON valido, tutti i file', () => {
    const files = mapFiles() as string[];
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(() => JSON.parse(readFileSync(f, 'utf8'))).not.toThrow();
  });

  it('cita solo codice che esiste', () => {
    // Il caso banale e il più probabile: un file rinominato, o una riga oltre la
    // fine del file dopo una cancellazione.
    const missing: string[] = [];
    for (const [ref, sezioni] of references() as Map<string, Set<string>>) {
      const r = resolveRef(ref, [...sezioni]) as { ok: boolean; reason?: string };
      if (!r.ok) missing.push(`${ref} — ${r.reason}`);
    }
    expect(missing).toEqual([]);
  });

  it('ogni ancora punta ancora al testo che aveva quando è stata scritta', () => {
    // Il caso pericoloso: il file c'è, la riga c'è, ma il codice si è spostato di
    // otto righe e ora l'ancora indica un'altra cosa. Il numero da solo non
    // difende niente; il testo sì.
    const sorgenti = references() as Map<string, Set<string>>;
    const drifted: string[] = [];
    for (const [ref, atteso] of Object.entries(anchors)) {
      const r = resolveRef(ref, [...(sorgenti.get(ref) ?? [])]) as { ok: boolean; path?: string; text?: string };
      if (!r.ok) drifted.push(`${ref} — sparito`);
      else if (r.path !== atteso.path) drifted.push(`${ref} — ora risolve a ${r.path}, non a ${atteso.path}`);
      else if (r.text !== atteso.testo) {
        drifted.push(`${ref}\n    atteso:  ${atteso.testo}\n    trovato: ${r.text}`);
      }
    }
    expect(drifted).toEqual([]);
  });

  it('registra un ancoraggio per ogni riferimento citato — nessuna casella senza prova', () => {
    // Una voce della mappa senza ancora è una voce che non abbiamo il diritto di
    // disegnare: sarebbe di nuovo un diagramma a memoria.
    const refs = [...(references() as Map<string, Set<string>>).keys()].sort();
    expect(Object.keys(anchors).sort()).toEqual(refs);
  });
});
