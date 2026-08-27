import { paths } from '../core/config/config.js';
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
  muffin undo --dimentica <turno>  butta via le copie di quel turno`;

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
    if (journal.read(turno) === null) {
      process.stderr.write(`nessun turno "${turno}" nel registro di undo.\n`);
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
