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

export type UndoEntry = {
  turnId: string;
  snapshots: Snapshot[];
  /**
   * In che ordine questo turno è comparso nel registro: 1, 2, 3…
   *
   * Esiste per una sola ragione, ed è misurata. `turns()` ordinava per `mtime`
   * del manifest, e su Linux i due manifest di due turni consecutivi hanno lo
   * **stesso** mtime in 10 giri su 12 (overlayfs ha granularità di un
   * millisecondo; APFS è più fine, per questo su macOS non si vedeva). A parità
   * `Array.prototype.sort` conserva l'ordine di `readdirSync`, che è alfabetico:
   * `--last` sceglieva `t1` invece di `t2`, cioè **il turno più vecchio**, e
   * disfaceva quello sbagliato in silenzio.
   *
   * `takenAt` da solo non basta come rimedio: è ISO al millisecondo, quindi ha
   * lo stesso pareggio. Questo è un intero che non dipende da nessun orologio.
   *
   * Assegnato una volta sola, alla nascita della directory del turno, come
   * `1 + il massimo già su disco`. Un manifest vecchio non ce l'ha e vale `0`:
   * fra due manifest vecchi non aggiunge nulla, e non fa peggio di prima.
   */
  seq?: number;
};

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
  /**
   * `now` è un seam di prova, e serve a provare proprio il caso che il
   * filesystem produceva per conto suo: due turni con l'istante identico.
   * Prima quel caso si otteneva per fortuna — ed è per fortuna che il test
   * passava su una piattaforma e falliva sull'altra.
   */
  constructor(
    private readonly root: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

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
      takenAt: this.now().toISOString(),
    };
    // Il numero d'ordine si assegna alla nascita e non si tocca più: un turno
    // che scrive dieci volte resta dov'era in coda, e `takenAt` è ciò che dice
    // quando è stato attivo l'ultima volta.
    const seq = esistente?.seq ?? this.prossimoSeq();
    this.write(turnId, { turnId, seq, snapshots: [...(esistente?.snapshots ?? []), snapshot] });
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
   */
  restore(turnId: string): { restored: string[]; problems: string[] } | null {
    const entry = this.read(turnId);
    if (entry === null) return null;
    const restored: string[] = [];
    const problems: string[] = [];

    for (const s of [...entry.snapshots].reverse()) {
      try {
        if (s.copy === null) {
          // Non c'era niente prima: tornare indietro vuol dire togliere.
          if (existsSync(s.path)) rmSync(s.path);
          restored.push(`${s.path} — rimosso (non esisteva prima del turno)`);
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
      } catch (error) {
        // Un percorso che fallisce non ferma gli altri: un undo parziale e
        // dichiarato è meglio di uno che si arrende al primo ostacolo e lascia
        // il resto del turno applicato senza dirlo.
        problems.push(`${s.path} — ${(error as Error).message}`);
      }
    }
    return { restored, problems };
  }

  /**
   * Il numero d'ordine per un turno che nasce adesso: uno più del massimo che
   * c'è già.
   *
   * Legge i manifest invece di tenere un contatore da qualche parte, che è
   * coerente con la forma decisa dall'owner — una directory, non una tabella —
   * e costa una lettura per turno, contro le `n` che `turns()` fa comunque a
   * ogni `muffin undo`.
   */
  private prossimoSeq(): number {
    return this.registri().reduce((max, r) => Math.max(max, r.entry.seq ?? 0), 0) + 1;
  }

  /** Ogni turno del registro con il suo manifest, senza ordine. */
  private registri(): { name: string; entry: UndoEntry }[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(this.root, e.name, MANIFEST)))
      .flatMap((e) => {
        const entry = this.read(e.name);
        return entry === null ? [] : [{ name: e.name, entry }];
      });
  }

  /**
   * I turni che hanno qualcosa da disfare, dal più recente.
   *
   * Ordinati per **quello che il registro ha scritto**, mai per un attributo
   * del filesystem. `mtime` era la chiave di prima e sbagliava due volte: ha
   * una granularità che cambia da piattaforma a piattaforma (vedi `seq`), e
   * mente comunque, perché un `rsync`, un ripristino da backup o un `cp` senza
   * `-p` lo riscrivono senza che sia successo niente.
   *
   * «Più recente» vuol dire l'ultima copia presa, non il turno nato per ultimo:
   * un turno vecchio che scrive adesso è la cosa che si è appena mossa.
   */
  turns(): string[] {
    return this.registri()
      .map((r) => ({ name: r.name, at: r.entry.snapshots.at(-1)?.takenAt ?? '', seq: r.entry.seq ?? 0 }))
      .sort((a, b) => (a.at === b.at ? b.seq - a.seq : a.at < b.at ? 1 : -1))
      .map((r) => r.name);
  }

  /**
   * Il turno da disfare con `--last`, **o il rifiuto di indovinare**.
   *
   * `turns()[0]` non basta come risposta a questa domanda: un ordinamento
   * totale restituisce sempre un primo, anche quando i due in testa sono
   * indistinguibili. Succede solo se due processi hanno creato un turno nello
   * stesso istante e con lo stesso numero d'ordine — raro, e comunque non una
   * cosa da risolvere con una monetina: disfare il turno sbagliato è
   * distruttivo e silenzioso, ed è esattamente ciò da cui `undo` esiste per
   * proteggere.
   */
  ultimo(): { turnId: string } | { ambigui: string[] } | null {
    const ordinati = this.registri().map((r) => ({
      name: r.name,
      at: r.entry.snapshots.at(-1)?.takenAt ?? '',
      seq: r.entry.seq ?? 0,
    }));
    if (ordinati.length === 0) return null;
    ordinati.sort((a, b) => (a.at === b.at ? b.seq - a.seq : a.at < b.at ? 1 : -1));
    const primo = ordinati[0]!;
    const pari = ordinati.filter((r) => r.at === primo.at && r.seq === primo.seq);
    if (pari.length > 1) return { ambigui: pari.map((r) => r.name).sort() };
    return { turnId: primo.name };
  }

  /** Butta via il journal di un turno — dopo un undo riuscito, o per pulizia. */
  forget(turnId: string): void {
    rmSync(this.dir(turnId), { recursive: true, force: true });
  }
}
