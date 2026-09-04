/**
 * I posti che Muffin installa nella casa di chi lo usa.
 *
 * Non è una lista di file preziosi: è la lista dei posti dove **questo
 * programma** scrive quando è installato per davvero. Un test che ne tocca uno
 * ha smesso di girare nella sua home temporanea, e l'unico modo di accorgersene
 * finora era guardare — cosa che si fa dopo aver già rotto qualcosa.
 *
 * È successo due volte. La prima un test scrisse un LaunchAgent vero in
 * `~/Library` e il file sopravvisse alla run, perché la pulizia stava dopo
 * un'asserzione che falliva. La seconda, il 27/08/2026, un
 * `muffin-gateway.service` comparve nella `~/.config` vera con
 * `WorkingDirectory` su una directory temporanea già cancellata: la difesa
 * copriva il planner puro e non il chiamante che leggeva `homedir()` da sé.
 *
 * Entrambe le volte il codice si è riparato nel punto giusto. Questo file è
 * l'altra cosa, quella che non dipende dal ricordarsene: un posto solo da cui
 * ogni fuga passa.
 *
 * ## Il falso positivo, misurato il 04/09/2026
 *
 * La guardia ha fatto uscire rossa una suite **tutta verde**: `Test Files 1
 * passed`, e poi `~/.muffin — è stato riscritto durante la suite`. Nessun test
 * era uscito da niente. A scrivere era l'**installazione viva dell'owner**, che
 * girava mentre la suite girava: un backup alle 02:21 e alle 02:24, e
 * `gateway.sock` ricreato alle 02:25. Le due copie di `config.json` e
 * `defaults-manifest.json` prima e dopo erano identiche byte per byte.
 *
 * È esattamente la dinamica che il commento su `watchedPaths` qui sotto
 * prevedeva per sé — *«il primo falso positivo … lo farebbe spegnere entro la
 * settimana»* — e una guardia spenta riporta indietro le due fughe vere per cui
 * esiste. Quindi non si indebolisce: si rende capace di distinguere **chi** ha
 * scritto.
 *
 * ## Due misure che hanno deciso la forma
 *
 * **1. La mtime di una directory non vede una riscrittura interna.** Misurato:
 * riscrivere un file dentro una directory lascia la mtime del contenitore
 * immutata; farci comparire una voce nuova la muove. Quindi il marchio su
 * `~/.muffin` non ha **mai** asserito «nessuno ha riscritto niente qui dentro»:
 * asserisce «l'insieme delle voci non è cambiato», e il messaggio che diceva
 * *«è stato riscritto»* era sbagliato prima ancora di questo lavoro.
 *
 * **2. Non esiste un insieme di file «che solo un test scriverebbe».** La prima
 * idea era sorvegliare la configurazione installata e ignorare i file di
 * runtime. La casa viva dell'owner l'ha falsificata in un `ls`: `config.json`
 * riscritto alle 02:24 e `defaults-manifest.json` alle 02:21, da `muffin
 * update`. Un'installazione che fa le sue cose normali tocca praticamente tutto.
 *
 * ## Quindi: la comparsa pesa più della riscrittura
 *
 * Le due fughe vere erano **entrambe** «un file che non c'era, adesso c'è» — il
 * plist e l'unit — e nessun gateway vivo fa comparire quei due percorsi. Quella
 * classe resta fatale sempre, senza eccezioni e senza domande.
 *
 * L'unica indulgenza è dove la prova non regge: le voci che compaiono e
 * spariscono nella radice di una casa **con un gateway che risponde**, e solo
 * per i nomi che un gateway in esecuzione possiede davvero. Un test che scrive
 * `~/.muffin/pippo.txt` resta fatale anche mentre l'owner sta usando Muffin.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type HomeMark = {
  path: string;
  stamp: string;
  /** Le voci, se il percorso è una directory. `undefined` per file e assenti. */
  entries?: readonly string[];
};

/**
 * I percorsi sorvegliati, dato un HOME.
 *
 * Assoluti e nominati uno per uno: un glob su `~` sarebbe una promessa più
 * larga di quella che questo file può mantenere, e il primo falso positivo
 * (un editor che tocca una preferenza mentre gira la suite) lo farebbe
 * spegnere entro la settimana.
 */
export function watchedPaths(homeDir: string, configHome?: string): string[] {
  return [
    join(homeDir, '.muffin'),
    join(homeDir, 'Library', 'LaunchAgents', 'ai.muffin.gateway.plist'),
    join(configHome ?? join(homeDir, '.config'), 'systemd', 'user', 'muffin-gateway.service'),
    join(configHome ?? join(homeDir, '.config'), 'muffin'),
  ];
}

/**
 * Le voci che un gateway **in esecuzione** crea e toglie nella radice della sua
 * casa, ricavate dal codice che le scrive e non da un `ls` fortunato
 * (`grep "join(home, '…')"` su `core cli agent connectors`).
 *
 * Sono tutte e sole cose che esistono *perché un processo è vivo*: il socket di
 * controllo e il suo puntatore, i due file su cui il supervisore redirige, la
 * sentinella di stop, e i due compagni di SQLite che nascono all'apertura e
 * spariscono a una chiusura pulita. Nessuna di queste è configurazione, nessuna
 * sopravvive al processo per portarsi dietro uno stato, e nessuna è un posto in
 * cui un test che sia sfuggito avrebbe una ragione di scrivere.
 *
 * Aggiungere un nome qui allarga ciò che la guardia perdona: si fa con la stessa
 * misura, mai per far passare una run.
 */
export const VOCI_DEL_GATEWAY: readonly string[] = [
  'gateway.sock',
  'gateway.sock.path',
  'gateway.err',
  'gateway.out',
  'gateway.stopped',
  'muffin.db-wal',
  'muffin.db-shm',
];

/**
 * Lo stato di un percorso, in una forma confrontabile.
 *
 * `assente` è un valore come gli altri, non un errore: la comparsa di un file
 * che non c'era è esattamente il caso che ha morso due volte, e trattarla come
 * "niente da confrontare" la renderebbe invisibile.
 *
 * Per una directory si registrano anche le **voci**, ordinate. Costa una
 * `readdir` non ricorsiva per percorso sorvegliato e compra la sola cosa che il
 * messaggio vecchio non sapeva dire: *quale* voce è comparsa.
 */
export function markHome(homeDir: string, configHome?: string): HomeMark[] {
  return watchedPaths(homeDir, configHome).map((path) => {
    try {
      const s = statSync(path);
      // mtimeMs e size: un file riscritto con lo stesso contenuto non è un
      // problema di questa guardia, ma non costa niente segnalarlo, e la
      // dimensione prende il caso in cui la mtime ha la granularità di un
      // secondo e la scrittura è avvenuta dentro lo stesso.
      const stamp = `${s.mtimeMs}:${s.size}`;
      if (!s.isDirectory()) return { path, stamp };
      try {
        return { path, stamp, entries: readdirSync(path).sort() };
      } catch {
        // Illeggibile ma esistente: si perde il dettaglio, non il confronto.
        return { path, stamp };
      }
    } catch {
      return { path, stamp: 'assente' };
    }
  });
}

export type Drift =
  /** Non c'era e adesso c'è. Le due fughe vere erano tutte e due questa. */
  | { path: string; kind: 'apparso' }
  /** C'era e non c'è più. */
  | { path: string; kind: 'sparito' }
  /** Stesso percorso, marchio diverso, e non è una directory. */
  | { path: string; kind: 'riscritto' }
  /** Directory: l'insieme delle voci è cambiato, e queste sono. */
  | { path: string; kind: 'voci'; aggiunte: readonly string[]; tolte: readonly string[] };

/** Cosa è cambiato fra due marchi — vuoto quando la casa è intatta. */
export function homeDrift(before: readonly HomeMark[], after: readonly HomeMark[]): Drift[] {
  const prima = new Map(before.map((m) => [m.path, m]));
  const out: Drift[] = [];
  for (const m of after) {
    const era = prima.get(m.path);
    if (era === undefined) continue;
    if (era.stamp === 'assente' && m.stamp !== 'assente') {
      out.push({ path: m.path, kind: 'apparso' });
      continue;
    }
    if (era.stamp !== 'assente' && m.stamp === 'assente') {
      out.push({ path: m.path, kind: 'sparito' });
      continue;
    }
    if (era.stamp === m.stamp && !vociCambiate(era, m)) continue;
    if (m.entries !== undefined && era.entries !== undefined) {
      const prime = new Set(era.entries);
      const dopo = new Set(m.entries);
      const aggiunte = m.entries.filter((e) => !prime.has(e));
      const tolte = era.entries.filter((e) => !dopo.has(e));
      // La mtime della directory si è mossa ma l'insieme è identico: su APFS
      // succede per un rename in-place. Non c'è niente da nominare, e una riga
      // che non sa dire cosa è cambiato è la riga che spegne la guardia.
      if (aggiunte.length === 0 && tolte.length === 0) continue;
      out.push({ path: m.path, kind: 'voci', aggiunte, tolte });
      continue;
    }
    if (era.stamp !== m.stamp) out.push({ path: m.path, kind: 'riscritto' });
  }
  return out;
}

function vociCambiate(a: HomeMark, b: HomeMark): boolean {
  if (a.entries === undefined || b.entries === undefined) return false;
  return a.entries.length !== b.entries.length || a.entries.some((e, i) => e !== b.entries![i]);
}

/** Chi risponde sul socket di controllo di quella casa, se qualcuno risponde. */
export type Installazione = { pid: number; home: string } | null;

export type Giudizio = {
  /** Fanno uscire la suite non-zero. */
  fatali: Drift[];
  /** Attribuite all'installazione viva: si stampano, non fanno fallire. */
  spiegate: Drift[];
};

/**
 * Chi ha scritto, per quanto la prova permette di dirlo.
 *
 * La regola in una riga: **si perdona solo ciò che un processo vivo possiede,
 * solo nella casa di quel processo, e solo mentre quel processo risponde.**
 *
 * - `apparso` e `sparito` non si perdonano mai, su nessun percorso. Sono la
 *   classe delle due fughe vere, e un gateway vivo non fa comparire né sparire
 *   la propria casa, né un plist, né una unit.
 * - `riscritto` non si perdona mai: nessuno dei percorsi che possono produrlo è
 *   un file che un gateway in esecuzione riscrive.
 * - `voci` si perdona **solo** nella radice della casa dell'installazione che
 *   ha risposto, e **solo** se ogni nome comparso o sparito è in
 *   `VOCI_DEL_GATEWAY`. Una voce sconosciuta rende fatale l'intera riga, anche
 *   se le altre erano innocue: un test che scrive `pippo.txt` accanto a
 *   `gateway.sock` non passa per compagnia.
 *
 * `viva === null` significa «nessuno ha risposto», che il socket di controllo
 * dichiara **non** equivalente a «nessuno è vivo». Si fallisce chiusi: nessuna
 * indulgenza. In CI, dove nessun gateway gira, questo è l'unico ramo e la
 * guardia si comporta esattamente come prima.
 */
export function giudica(drift: readonly Drift[], viva: Installazione): Giudizio {
  const fatali: Drift[] = [];
  const spiegate: Drift[] = [];
  for (const d of drift) {
    if (viva !== null && d.kind === 'voci' && d.path === viva.home && soloDelGateway(d)) {
      spiegate.push(d);
    } else {
      fatali.push(d);
    }
  }
  return { fatali, spiegate };
}

function soloDelGateway(d: Drift & { kind: 'voci' }): boolean {
  const noto = (e: string): boolean => VOCI_DEL_GATEWAY.includes(e);
  return d.aggiunte.every(noto) && d.tolte.every(noto);
}

/** La riga da stampare per una deriva, con il dettaglio che il messaggio vecchio non aveva. */
export function raccontaDrift(d: Drift): string {
  switch (d.kind) {
    case 'apparso':
      return `${d.path} — non c'era prima della suite, adesso c'è`;
    case 'sparito':
      return `${d.path} — c'era prima della suite, adesso non c'è più`;
    case 'riscritto':
      return `${d.path} — è stato riscritto durante la suite`;
    case 'voci': {
      const pezzi: string[] = [];
      if (d.aggiunte.length > 0) pezzi.push(`comparse: ${d.aggiunte.join(', ')}`);
      if (d.tolte.length > 0) pezzi.push(`sparite: ${d.tolte.join(', ')}`);
      return `${d.path} — l'insieme delle voci è cambiato (${pezzi.join(' · ')})`;
    }
  }
}
