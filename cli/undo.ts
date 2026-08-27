import DatabaseCtor from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { paths } from '../core/config/config.js';
import { attribuisciEpisodi } from '../core/memory/store.js';
import { TurnStore } from '../core/turns/store.js';
import { UndoJournal } from '../core/undo/journal.js';

/**
 * `muffin undo` — la metà che legge il registro di undo.
 *
 * Senza questa il journal sarebbe un writer senza reader: si salva una copia e
 * non c'è modo di riportarla indietro. È il difetto di firma di questo repo —
 * `draft` esisteva nel kernel e nessuno lo implementava — e ripeterlo nel
 * commit che lo ripara sarebbe la cosa peggiore che questa slice possa fare.
 * Per questo D2 e D3 atterrano insieme.
 */

const USAGE = `uso:
  muffin undo                    i turni che si possono disfare, dal più recente
  muffin undo <turno> --yes      rimette i file com'erano prima di quel turno
  muffin undo --last --yes       lo stesso, sul turno più recente
  muffin undo --dimentica <turno> --yes
                                 butta via le copie di quel turno`;

/** Il prefisso che distingue una rete di undo da un turno vero. */
const RETE = 'annulla-';

/** Il turno sotto cui finisce lo stato *attuale* prima che l'undo lo sovrascriva. */
export function undoOfId(turnId: string): string {
  // Il journal tronca a 64 caratteri, e un id di turno è un uuid (36): il
  // prefisso ci sta. Il taglio qui è per non dipendere da quel fatto.
  return `${RETE}${turnId.slice(0, 48)}`;
}

/**
 * Cosa sta chiedendo davvero un bersaglio: quale turno, e in che verso.
 *
 * `undoOfId` è invertibile, e questa è l'inversione. Serve perché il comando
 * **pubblicizza** il percorso inverso — ogni undo riuscito finisce con «per
 * tornare com'era: muffin undo annulla-… --yes» — e quel percorso rimette i
 * file allo stato *dopo* il turno: se la marcatura non torna indietro con
 * loro, il contesto del giro seguente dice «i file sono tornati com'erano
 * prima» con il file pieno del contenuto nuovo.
 *
 * Si contano i prefissi invece di guardarne uno solo perché il comando li
 * annida davvero: disfare una rete produce `annulla-annulla-…`, e quello è di
 * nuovo un undo del turno vero. **Pari annulla, dispari rifà** — la parità è
 * la stessa cosa che il journal sta facendo ai file, letta sull'id.
 *
 * `turno` è ciò che resta tolti i prefissi, e può essere **troncato**:
 * `undoOfId` taglia a 48 caratteri, quindi dal terzo annidamento in poi la
 * coda dell'id si perde. Chi risolve lo cerca prima esatto e poi per prefisso
 * — e se il prefisso è ambiguo non sceglie, perché sbagliare turno qui vuol
 * dire marcare la cronologia di qualcun altro.
 */
export function dietroLaRete(bersaglio: string): { turno: string; verso: 'annulla' | 'rifai' } {
  let turno = bersaglio;
  let n = 0;
  while (turno.startsWith(RETE)) {
    turno = turno.slice(RETE.length);
    n++;
  }
  return { turno, verso: n % 2 === 0 ? 'annulla' : 'rifai' };
}

export function cmdUndo(argv: string[], home = paths().home): number {
  const journal = new UndoJournal(paths(home).undo);
  const turno = argv.find((a) => !a.startsWith('--'));

  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  if (argv.includes('--dimentica')) {
    if (turno === undefined) {
      process.stderr.write(`${USAGE}\n`);
      return 2;
    }
    const entry = journal.read(turno);
    if (entry === null) {
      process.stderr.write(`nessun turno "${turno}" nel registro di undo.\n`);
      return 1;
    }
    if (!argv.includes('--yes')) {
      // Lo stesso cancello del restore, e per una ragione più forte: il restore
      // sovrascrive dei file che si possono ancora recuperare da qui, mentre
      // questo butta **l'unica** copia. Era l'unica azione distruttiva del file
      // senza conferma — trovata dal judge, non da me.
      process.stdout.write(
        `dimenticare ${turno} butta le copie di:\n` +
          [...new Set(entry.snapshots.map((s) => s.path))].map((f) => `    ${f}\n`).join('') +
          `\ndopo, quel turno non si può più disfare. aggiungi --yes per procedere.\n`,
      );
      return 1;
    }
    journal.forget(turno);
    process.stdout.write(`dimenticato: ${turno}\n`);
    return 0;
  }

  const bersaglio = argv.includes('--last') ? journal.turns()[0] : turno;

  if (bersaglio === undefined) {
    // Nessun bersaglio: è la lista, non un errore d'uso. Un `muffin undo` a
    // vuoto è la domanda «cosa posso disfare?», e va risposta.
    const turni = journal.turns();
    if (turni.length === 0) {
      process.stdout.write(`niente da disfare.\n`);
      return 0;
    }
    for (const t of turni) {
      const entry = journal.read(t);
      const n = entry?.snapshots.length ?? 0;
      const quando = entry?.snapshots[0]?.takenAt ?? '';
      const files = [...new Set(entry?.snapshots.map((s) => s.path) ?? [])];
      process.stdout.write(
        `${t}  ${n} ${n === 1 ? 'modifica' : 'modifiche'}  ${quando}\n` +
          files.map((f) => `    ${f}\n`).join(''),
      );
    }
    process.stdout.write(`\nper disfare: muffin undo <turno> --yes\n`);
    return 0;
  }

  const entry = journal.read(bersaglio);
  if (entry === null) {
    process.stderr.write(`nessun turno "${bersaglio}" nel registro di undo.\n`);
    return 1;
  }

  if (!argv.includes('--yes')) {
    // Stessa forma di `muffin restore <file> --yes`, e per la stessa ragione:
    // l'undo sovrascrive lo stato attuale, che può contenere lavoro fatto dopo
    // quel turno. Senza --yes si stampa cosa succederebbe.
    process.stdout.write(
      `disfare ${bersaglio} rimetterebbe:\n` +
        [...entry.snapshots]
          .reverse()
          .map((s) => `    ${s.path} — ${s.copy === null ? 'rimosso (non esisteva)' : 'ripristinato'}\n`)
          .join('') +
        `\nlo stato attuale di quei file viene messo da parte come "${undoOfId(bersaglio)}".\n` +
        `aggiungi --yes per procedere.\n`,
    );
    return 1;
  }

  // Prima di sovrascrivere, metti da parte quello che c'è adesso — è ciò che
  // fa `muffin restore` col database, ed è ciò che rende reversibile l'undo
  // stesso. Un percorso una volta sola: due scritture nello stesso turno hanno
  // due copie, ma lo stato *attuale* è uno.
  const rete = undoOfId(bersaglio);
  const visti = new Set<string>();
  for (const s of entry.snapshots) {
    if (visti.has(s.path)) continue;
    visti.add(s.path);
    try {
      journal.take(rete, { callId: s.callId, capability: 'sys.undo', path: s.path });
    } catch (error) {
      // Qui ci si ferma, al contrario del loop: là rifiutare costa una
      // scrittura di file, qui costerebbe il lavoro fatto dopo quel turno.
      process.stderr.write(
        `non ho potuto mettere da parte ${s.path} (${error instanceof Error ? error.message : String(error)}).\n` +
          `Niente è stato toccato: senza rete non disfo, perché l'undo sovrascrive.\n`,
      );
      return 1;
    }
  }

  const esito = journal.restore(bersaglio);
  if (esito === null) {
    process.stderr.write(`nessun turno "${bersaglio}" nel registro di undo.\n`);
    return 1;
  }
  for (const r of esito.restored) process.stdout.write(`  ${r}\n`);
  for (const p of esito.problems) process.stderr.write(`  ! ${p}\n`);

  // La seconda metà di D11, e la sola ragione per cui questo comando apre il
  // database: un undo che rimette il filesystem e lascia il turno dire «ho
  // scritto nuovo.txt» fa divergere in silenzio l'idea che il modello ha del
  // mondo e il mondo, e il consumatore di quella divergenza è il giro dopo.
  //
  // **Dopo** il restore, mai prima. Le due direzioni di fallimento non sono
  // simmetriche: segnare per primo e poi non riuscire a ripristinare direbbe
  // «annullato» di un effetto ancora sul disco, cioè inventerebbe la
  // riconciliazione; ripristinare per primo e non riuscire a segnare lascia il
  // difetto che c'era, ma **dichiarato** — e sotto si dichiara.
  const ric = riconcilia(home, bersaglio, esito.undone.map((s) => s.callId));
  const riallineati = ric.chiamate;

  if (ric.verso === 'rifai') {
    // Il verso opposto ha una frase opposta, non la stessa con un numero
    // diverso: qui i file sono tornati **in avanti**, e la cosa che il turno
    // seguente deve smettere di leggere è «sono stati disfatti».
    if (riallineati > 0) {
      process.stdout.write(
        `\n${riallineati} ${riallineati === 1 ? 'chiamata non è più segnata' : 'chiamate non sono più segnate'} come annullata` +
          `${riallineati === 1 ? '' : 'e'} nel record del turno: la cronologia non dice più che quei file sono tornati indietro.\n`,
      );
    } else if (esito.undone.length > 0) {
      process.stdout.write(
        `\nnessuna riga rimessa in avanti nel record del turno: i file sono tornati com'erano dopo il turno, ` +
          `la cronologia no. Se ci parli sopra, ricordagli che quel turno **non** è più disfatto.\n`,
      );
    }
  } else if (riallineati > 0) {
    // «quei file», non «i file del turno»: su un ripristino parziale una parte
    // è ancora sul disco, e la frase larga direbbe di quella parte esattamente
    // la bugia che questo comando esiste per togliere. La riga che segue nomina
    // quante sono rimaste, invece di lasciarlo dedurre dai `!` più sopra.
    process.stdout.write(
      `\n${riallineati} ${riallineati === 1 ? 'chiamata segnata come annullata' : 'chiamate segnate come annullate'} nel record del turno: ` +
        `la cronologia non dice più che quei file sono stati scritti.\n` +
        (esito.problems.length === 0
          ? ''
          : `${esito.problems.length} ${esito.problems.length === 1 ? 'percorso non è tornato' : 'percorsi non sono tornati'} indietro e ` +
            `${esito.problems.length === 1 ? 'resta' : 'restano'} come ${esito.problems.length === 1 ? 'era' : 'erano'} dopo il turno.\n`),
    );
  } else if (esito.undone.length > 0) {
    // Dichiarato, non taciuto. Un turno che non è nel database — un journal
    // preso a mano, una home senza `muffin.db` — non è un errore dell'undo, ma
    // chi lo ha chiesto deve sapere che il disco è tornato indietro e la
    // cronologia no, invece di scoprirlo dal comportamento del giro dopo.
    process.stdout.write(
      `\nnessuna riga del turno segnata come annullata: il filesystem è tornato indietro, ` +
        `la cronologia di quel turno no. Se ci parli sopra, ricordagli che ${bersaglio} è stato disfatto.\n`,
    );
  }

  // La terza copia dell'affermazione, dichiarata quando non si è potuta
  // riallineare. Stessa forma del paragrafo qui sopra e per la stessa ragione:
  // un ricordo che il recall ripesca senza la marca arriva al modello come un
  // fatto, e chi ha chiesto l'undo deve saperlo adesso invece di scoprirlo dal
  // comportamento del giro dopo.
  if (ric.ricordiNonAttribuiti > 0) {
    process.stdout.write(
      `\n${ric.ricordiNonAttribuiti} ${ric.ricordiNonAttribuiti === 1 ? 'ricordo' : 'ricordi'} di questa sessione ${ric.ricordiNonAttribuiti === 1 ? 'non porta' : 'non portano'} nessun turno ` +
        `e non ho attribuito ${ric.ricordiNonAttribuiti === 1 ? 'quello' : 'quelli'} di ${bersaglio}: un altro turno della stessa sessione ha scritto ` +
        `nella stessa finestra, e sceglierne uno vorrebbe dire segnare come annullato un turno che nessuno ha disfatto. ` +
        `La memoria può ancora ripescare quelle frasi senza dire che sono state rimesse indietro.\n`,
    );
  }

  if (esito.problems.length === 0) {
    // Turno disfatto: le sue copie sono peso morto, e il ritorno indietro
    // dell'undo vive sotto `annulla-…`, che resta.
    journal.forget(bersaglio);
    process.stdout.write(`\ndisfatto ${bersaglio}. per tornare com'era: muffin undo ${rete} --yes\n`);
    return 0;
  }
  process.stdout.write(
    `\n${bersaglio} disfatto solo in parte — le copie restano, riprova dopo aver risolto.\n`,
  );
  return 1;
}

/** Cosa la riconciliazione ha davvero cambiato, in entrambe le direzioni. */
type Riconciliazione = {
  /** `annulla` marca le chiamate, `rifai` toglie la marca. */
  verso: 'annulla' | 'rifai';
  /** Righe di `turn_tool_calls` che hanno davvero cambiato stato. */
  chiamate: number;
  /** Episodi di memoria agganciati al turno adesso, che prima non lo portavano. */
  ricordi: number;
  /** Episodi candidati che si è **scelto** di non attribuire, e che vanno dichiarati. */
  ricordiNonAttribuiti: number;
};

/**
 * Riallinea il record del turno con quello che l'undo ha appena fatto ai file —
 * **nei due versi**, e su **tutte e tre** le copie dell'affermazione.
 *
 * Restituisce quante righe ha davvero cambiato, mai quante ci ha provato: il
 * chiamante deve poter dire «cronologia riallineata» solo quando lo è. Zero è
 * un esito legittimo — un `muffin undo` ripetuto trova le righe già segnate, e
 * un journal preso a mano il cui turno non è mai stato un turno vero non ha
 * righe in `turn_tool_calls`.
 *
 * ## Il verso
 *
 * Prima, `annulla-…` cadeva qui come un turno qualunque, non trovava righe e
 * usciva 0. Ma `annulla-…` non è un turno che non esiste: è il turno vero
 * letto al contrario, e il comando lo raccomanda una riga dopo ogni undo
 * riuscito. `dietroLaRete` dice quale turno e in che verso; il resto è
 * simmetrico, `markUndone` da un lato e `markRedone` dall'altro.
 *
 * ## La terza copia
 *
 * Marcare `turn_tool_calls` riallinea la cronologia di sessione e — via
 * `episodes.turn_id` — la memoria. Ma quella colonna è arrivata nullable e
 * senza backfill, quindi sulle righe di ieri non c'è, `annullaRicordi` esce
 * sull'item e il blocco `MEMORIA` di una sessione nuova consegna la frase nuda.
 * `attribuisciEpisodi` ricostruisce la giunzione dalla finestra del turno prima
 * di marcare — e si rifiuta di indovinare se un altro turno della stessa
 * sessione ha scritto dentro la stessa finestra, perché attribuire male qui
 * vuol dire marcare come annullato l'episodio di un turno che nessuno ha
 * disfatto. Quello che non attribuisce lo **dichiara**, come si dichiara già il
 * database assente.
 *
 * Non lancia. Il filesystem è già tornato indietro quando questa gira: farla
 * fallire il comando trasformerebbe un undo riuscito-a-metà in un undo che
 * *sembra* non essere avvenuto, che è la lettura peggiore delle due.
 */
function riconcilia(home: string, bersaglio: string, callIds: readonly string[]): Riconciliazione {
  const { turno: chiave, verso } = dietroLaRete(bersaglio);
  const vuoto: Riconciliazione = { verso, chiamate: 0, ricordi: 0, ricordiNonAttribuiti: 0 };
  if (callIds.length === 0) return vuoto;
  const file = paths(home).db;
  if (!existsSync(file)) return vuoto;
  let db: DatabaseCtor.Database | undefined;
  try {
    db = new DatabaseCtor(file);
    const turnId = risolviTurno(db, chiave);
    if (turnId === null) return vuoto;
    const turns = new TurnStore(db);

    let chiamate = 0;
    for (const callId of callIds) {
      if (verso === 'annulla' ? turns.markUndone(turnId, callId) : turns.markRedone(turnId, callId))
        chiamate++;
    }

    // Solo nel verso `annulla`: un `rifai` arriva sempre dopo un `annulla`
    // dello stesso turno, che ha già attaccato ciò che c'era da attaccare, e
    // togliere la marca alle chiamate toglie la marca alla memoria da sé.
    if (verso === 'rifai') return { verso, chiamate, ricordi: 0, ricordiNonAttribuiti: 0 };
    const record = turns.get(turnId);
    if (record === null) return { verso, chiamate, ricordi: 0, ricordiNonAttribuiti: 0 };
    const { attribuiti, nonAttribuiti } = attribuisciEpisodi(
      db,
      {
        turnId,
        tenantId: record.tenant,
        connector: record.surface,
        threadKey: record.sessionId,
        from: record.createdAt,
        to: record.updatedAt,
      },
      sovrapposti(db, turnId, record.sessionId, record.createdAt, record.updatedAt),
    );
    return { verso, chiamate, ricordi: attribuiti, ricordiNonAttribuiti: nonAttribuiti };
  } catch {
    return vuoto;
  } finally {
    db?.close();
  }
}

/**
 * Da una chiave — un id intero, o il troncamento a 48 che `undoOfId` lascia —
 * al turno vero, o `null` se non è **uno solo**.
 *
 * L'ambiguità non si risolve scegliendo: due turni con lo stesso prefisso di 48
 * caratteri sono un caso che non capita con gli id attuali (32 esadecimali) e
 * che, se capitasse, farebbe marcare la cronologia del turno sbagliato. `LIMIT 2`
 * perché la domanda è «quanti», non «quali».
 */
function risolviTurno(db: DatabaseCtor.Database, chiave: string): string | null {
  const esatto = db.prepare(`SELECT id FROM turns WHERE id = ?`).get(chiave) as
    | { id: string }
    | undefined;
  if (esatto !== undefined) return esatto.id;
  const righe = db
    .prepare(`SELECT id FROM turns WHERE substr(id, 1, ?) = ? LIMIT 2`)
    .all(chiave.length, chiave) as { id: string }[];
  return righe.length === 1 ? righe[0]!.id : null;
}

/**
 * Un altro turno della stessa sessione ha scritto dentro questa finestra?
 *
 * È la condizione che rende la chiave (sessione + finestra) ambigua, ed è
 * l'unica ragione per cui `attribuisciEpisodi` può sbagliare bersaglio. Il
 * confronto è il test di sovrapposizione standard fra due intervalli: l'altro
 * comincia prima che questo finisca e finisce dopo che questo comincia.
 */
function sovrapposti(
  db: DatabaseCtor.Database,
  turnId: string,
  sessionId: string,
  from: string,
  to: string,
): boolean {
  const { n } = db
    .prepare(
      `SELECT count(*) AS n FROM turns
        WHERE session_id = ? AND id != ? AND created_at <= ? AND updated_at >= ?`,
    )
    .get(sessionId, turnId, to, from) as { n: number };
  return n > 0;
}
