import { openDb } from '../core/db/open.js';
import { paths } from '../core/config/config.js';
import { MemoryStore } from '../core/memory/store.js';
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
 *
 * D11, l'altra metà: rimettere i file com'erano non basta se la cronologia
 * del turno e la memoria continuano a dire «ho scritto». Dopo un restore
 * **completo** (mai uno parziale — vedi sotto) questo file marca anche
 * `turn_tool_calls.undone_at` e gli episodi `role: 'agent'` di quel turno,
 * sulla stessa connessione (`muffin.db`) che `agent/loop.ts` legge per
 * riassemblare il contesto del giro dopo.
 */

/** L'unico tenant che questo comando conosce: `muffin undo` gira sulla macchina dell'owner. */
const TENANT = 'host';

const USAGE = `uso:
  muffin undo                    i turni che si possono disfare, dal più recente
  muffin undo <turno> --yes      rimette i file com'erano prima di quel turno
  muffin undo --last --yes       lo stesso, sul turno più recente
  muffin undo --dimentica <turno> --yes
                                 butta via le copie di quel turno`;

/** Il turno sotto cui finisce lo stato *attuale* prima che l'undo lo sovrascriva. */
export function undoOfId(turnId: string): string {
  // Il journal tronca a 64 caratteri, e un id di turno è un uuid (36): il
  // prefisso ci sta. Il taglio qui è per non dipendere da quel fatto.
  return `annulla-${turnId.slice(0, 48)}`;
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

  let bersaglio = turno;
  if (argv.includes('--last')) {
    const ultimo = journal.ultimo();
    if (ultimo !== null && 'ambigui' in ultimo) {
      // Non si tira a sorte su un'operazione distruttiva. Succede solo se due
      // turni hanno l'ultima copia nello stesso istante **e** lo stesso numero
      // d'ordine, cioè se due processi li hanno creati insieme; l'owner ha i
      // due nomi e sceglie lui.
      process.stderr.write(
        `due turni hanno l'ultima copia nello stesso istante, non so quale sia «l'ultimo»:
` +
          ultimo.ambigui.map((t) => `    muffin undo ${t} --yes
`).join('') +
          `
scegli tu: disfare quello sbagliato non si disfà.
`,
      );
      return 1;
    }
    bersaglio = ultimo === null ? undefined : ultimo.turnId;
  }

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

  if (esito.problems.length === 0) {
    // Turno disfatto: le sue copie sono peso morto, e il ritorno indietro
    // dell'undo vive sotto `annulla-…`, che resta.
    journal.forget(bersaglio);
    marcaDisfatto(home, bersaglio, entry.snapshots.map((s) => s.callId));
    process.stdout.write(`\ndisfatto ${bersaglio}. per tornare com'era: muffin undo ${rete} --yes\n`);
    return 0;
  }
  process.stdout.write(
    `\n${bersaglio} disfatto solo in parte — le copie restano, riprova dopo aver risolto.\n`,
  );
  return 1;
}

/**
 * D11: dopo un restore **completo**, riallinea la cronologia del turno e la
 * memoria — mai su un restore parziale, perché una marcatura totale su un
 * disfacimento parziale sarebbe la stessa bugia che questa slice ripara,
 * solo spostata di un livello (vedi B3 in `docs/status/day1/critical-path.md`).
 *
 * `callIds` sono esattamente quelli che `entry.snapshots` porta per questo
 * turno — mai «ogni chiamata del turno», che marcherebbe come disfatte anche
 * letture che l'undo non ha mai toccato.
 *
 * Non fa fallire il comando: il filesystem è già tornato com'era quando
 * questa funzione gira, e un errore qui (database assente, disco pieno) è un
 * fatto in meno nella cronologia, non un restore fallito. Dichiarato su
 * stderr, mai inghiottito in silenzio.
 */
function marcaDisfatto(home: string, turnId: string, callIds: readonly string[]): void {
  let db: ReturnType<typeof openDb> | undefined;
  try {
    db = openDb(paths(home).db);
    const now = new Date().toISOString();
    new TurnStore(db).markUndone(turnId, callIds);
    new MemoryStore(db).markEpisodesUndone(TENANT, turnId, now);
  } catch (error) {
    process.stderr.write(
      `! i file sono tornati com'erano, ma non sono riuscito ad aggiornare cronologia/memoria ` +
        `(${error instanceof Error ? error.message : String(error)}). Il modello potrebbe ancora leggere «ho scritto».\n`,
    );
  } finally {
    db?.close();
  }
}
