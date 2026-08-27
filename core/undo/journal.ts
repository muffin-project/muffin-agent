import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Il registro di undo: la copia presa **prima** che qualcosa cambi.
 *
 * `decide` emette `draft` per ogni capability `medium` + `undoable` — oggi
 * `fs.write` — e fino a qui il loop lo rifiutava, perché questo registro non
 * esisteva: «il registro di undo non esiste ancora». Il verdetto era emesso dal
 * kernel e implementato da nessuno, quindi `fs_write` veniva offerto al modello
 * e non scriveva mai. Sono le righe D2, D3 e D11 di M5-BIS, tenute ferme dalla
 * stessa mancanza.
 *
 * **Forma decisa dall'owner il 16/08** (M5-BIS §1, «via B»): copia del file
 * prima della mutazione in `~/.muffin/undo/<turno>/`, e un undo che riallinea
 * il filesystem **e** il turno. Non una tabella: costa una migrazione in meno
 * su un database che accumula già dati veri, e una directory si guarda con
 * `ls` il giorno in cui qualcosa va storto.
 *
 * Il principio che decide ogni dettaglio qui sotto: **un checkpoint che non si
 * può prendere è un effetto che non deve avvenire.** Non è pessimismo, è
 * l'unica lettura che rende `draft` diverso da `allow`: chi ha dichiarato la
 * capability `undoable` ha promesso che si torna indietro, ed eseguire senza la
 * copia trasforma quella promessa in una frase.
 */

/** Cosa c'era prima. `copy: null` significa: il file non esisteva. */
export type Snapshot = {
  callId: string;
  capability: string;
  /** Il percorso assoluto che l'effetto sta per toccare. */
  path: string;
  /** Il nome della copia dentro la directory del turno, o `null` se non c'era niente da copiare. */
  copy: string | null;
  takenAt: string;
};

export type UndoEntry = { turnId: string; snapshots: Snapshot[] };

const MANIFEST = 'manifest.json';

/**
 * Un nome di file dal `callId`, senza fidarsi del `callId`.
 *
 * Gli id delle tool call arrivano dal provider — `toolu_…` per Anthropic,
 * `call_…` per OpenAI — quindi sono byte che sceglie qualcun altro. Un
 * `../../rot/policy.json` lì dentro scriverebbe la copia fuori dalla directory
 * del turno, che è esattamente ciò che un registro di sicurezza non può
 * permettersi. Sopravvive solo `[A-Za-z0-9_-]`; il resto diventa `_`.
 */
export function copyNameFor(callId: string, index: number): string {
  const pulito = callId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return `${String(index).padStart(3, '0')}-${pulito === '' ? 'call' : pulito}`;
}

export class UndoJournal {
  constructor(private readonly root: string) {}

  private dir(turnId: string): string {
    // Stesso trattamento del `callId`, e per la stessa ragione: il turnId è
    // nostro, ma questa funzione non ha modo di saperlo e non deve dipenderci.
    return join(this.root, turnId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64));
  }

  private manifestPath(turnId: string): string {
    return join(this.dir(turnId), MANIFEST);
  }

  read(turnId: string): UndoEntry | null {
    const p = this.manifestPath(turnId);
    if (!existsSync(p)) return null;
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as UndoEntry;
      return Array.isArray(parsed.snapshots) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Prende la copia e la registra. **Lancia se non ci riesce**, e il chiamante
   * deve leggere il lancio come «non eseguire»: è l'intero punto.
   */
  take(turnId: string, call: { callId: string; capability: string; path: string }): Snapshot {
    const dir = this.dir(turnId);
    mkdirSync(dir, { recursive: true });
    const esistente = this.read(turnId);
    const indice = esistente?.snapshots.length ?? 0;

    let copy: string | null = null;
    if (existsSync(call.path)) {
      if (!statSync(call.path).isFile()) {
        // Esiste e non è un file regolare — una directory, un socket, un
        // device. `copy: null` qui vorrebbe dire «non c'era niente», e un undo
        // successivo proverebbe a **rimuoverlo**. Non è fotografabile, quindi
        // per la regola di questo file non è nemmeno eseguibile: chi chiama
        // legge il lancio come «non eseguire». Trovato dal judge della slice.
        throw new Error(`${call.path} esiste e non è un file regolare: non posso fotografarlo`);
      }
      copy = copyNameFor(call.callId, indice);
      copyFileSync(call.path, join(dir, copy));
    }

    const snapshot: Snapshot = {
      callId: call.callId,
      capability: call.capability,
      path: call.path,
      copy,
      takenAt: new Date().toISOString(),
    };
    this.write(turnId, { turnId, snapshots: [...(esistente?.snapshots ?? []), snapshot] });
    return snapshot;
  }

  /**
   * Il manifest, scritto con un rename atomico.
   *
   * Un manifest troncato a metà è peggio di nessun manifest: dice che una copia
   * esiste e non dice dove, quindi l'undo si ferma proprio sul turno che
   * qualcuno vuole disfare. File temporaneo e poi `renameSync`, che è atomico
   * dentro lo stesso filesystem — e qui lo è per costruzione, perché i due file
   * stanno nella stessa directory.
   */
  private write(turnId: string, entry: UndoEntry): void {
    const finale = this.manifestPath(turnId);
    const tmp = `${finale}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
    renameSync(tmp, finale);
  }

  /**
   * Rimette le cose com'erano, dall'ultima mutazione alla prima.
   *
   * L'ordine inverso non è un dettaglio: due scritture sullo stesso file nello
   * stesso turno hanno due copie, e riapplicarle in avanti lascerebbe la
   * penultima. L'ultima applicata è la prima da disfare.
   *
   * Restituisce cosa ha fatto riga per riga: un undo che dice solo «fatto» non
   * è verificabile da chi lo ha chiesto.
   *
   * `undone` è la stessa lista in forma leggibile da una macchina, e non è un
   * duplicato di comodo: chi deve riallineare il **turno** (D11) ha bisogno dei
   * `callId` esatti che sono tornati indietro, e prende una prosa italiana solo
   * se qualcuno la ri-parsifica. Un ripristino parziale segna solo la sua
   * parte, che è l'unica versione onesta di un undo a metà.
   */
  restore(turnId: string): { restored: string[]; problems: string[]; undone: Snapshot[] } | null {
    const entry = this.read(turnId);
    if (entry === null) return null;
    const restored: string[] = [];
    const problems: string[] = [];
    const undone: Snapshot[] = [];

    for (const s of [...entry.snapshots].reverse()) {
      try {
        if (s.copy === null) {
          // Non c'era niente prima: tornare indietro vuol dire togliere.
          if (existsSync(s.path)) rmSync(s.path);
          restored.push(`${s.path} — rimosso (non esisteva prima del turno)`);
          undone.push(s);
          continue;
        }
        const copia = join(this.dir(turnId), s.copy);
        if (!existsSync(copia)) {
          problems.push(`${s.path} — la copia ${s.copy} non c'è più`);
          continue;
        }
        mkdirSync(dirname(s.path), { recursive: true });
        copyFileSync(copia, s.path);
        restored.push(`${s.path} — ripristinato`);
        undone.push(s);
      } catch (error) {
        // Un percorso che fallisce non ferma gli altri: un undo parziale e
        // dichiarato è meglio di uno che si arrende al primo ostacolo e lascia
        // il resto del turno applicato senza dirlo.
        problems.push(`${s.path} — ${(error as Error).message}`);
      }
    }
    return { restored, problems, undone };
  }

  /** I turni che hanno qualcosa da disfare, dal più recente. */
  turns(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(this.root, e.name, MANIFEST)))
      .map((e) => ({ name: e.name, at: statSync(join(this.root, e.name, MANIFEST)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
      .map((e) => e.name);
  }

  /** Butta via il journal di un turno — dopo un undo riuscito, o per pulizia. */
  forget(turnId: string): void {
    rmSync(this.dir(turnId), { recursive: true, force: true });
  }
}
