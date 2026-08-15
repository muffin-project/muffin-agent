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
    // Il caso pericoloso: il file c'è, la riga c'è, ma il codice si è spostato e
    // ora quella riga dice un'altra cosa. Il numero da solo non difende niente;
    // il testo sì.
    //
    // Si controllano le coordinate REGISTRATE nell'ancora, non il numero scritto
    // nella mappa: `ancore.mjs` insegue il codice che si sposta e aggiorna la
    // riga tenendo il testo, quindi è lì che vive la verità. Confrontare col
    // numero scritto in prosa farebbe fallire ogni refactor innocuo — e un test
    // che grida a ogni refactor viene disattivato entro la settimana.
    const drifted: string[] = [];
    for (const [ref, atteso] of Object.entries(anchors)) {
      const righe = readFileSync(join(MAPPA, '..', '..', '..', atteso.path), 'utf8').split('\n');
      const trovato = righe[atteso.line - 1]?.trim();
      if (trovato === undefined) drifted.push(`${ref} — ${atteso.path} non ha una riga ${atteso.line}`);
      else if (trovato !== atteso.testo) {
        drifted.push(`${ref} → ${atteso.path}:${atteso.line}\n    atteso:  ${atteso.testo}\n    trovato: ${trovato}`);
      }
    }
    expect(drifted).toEqual([]);
  });

  it('ogni riferimento risolve ancora allo stesso file', () => {
    // Il numero di riga scritto in prosa può invecchiare senza danno; il file
    // no. Un `mcp.ts:102` che comincia a risolversi in un altro `mcp.ts` è la
    // mappa che parla di un pezzo di sistema mentre ne indica un altro.
    const sorgenti = references() as Map<string, Set<string>>;
    const spostati: string[] = [];
    for (const [ref, atteso] of Object.entries(anchors)) {
      const r = resolveRef(ref, [...(sorgenti.get(ref) ?? [])]) as { ok: boolean; path?: string };
      if (!r.ok) spostati.push(`${ref} — non risolve più`);
      else if (r.path !== atteso.path) spostati.push(`${ref} — ora è ${r.path}, non ${atteso.path}`);
    }
    expect(spostati).toEqual([]);
  });

  it('registra un ancoraggio per ogni riferimento citato — nessuna casella senza prova', () => {
    // Una voce della mappa senza ancora è una voce che non abbiamo il diritto di
    // disegnare: sarebbe di nuovo un diagramma a memoria.
    const refs = [...(references() as Map<string, Set<string>>).keys()].sort();
    expect(Object.keys(anchors).sort()).toEqual(refs);
  });
});
