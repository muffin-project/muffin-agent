import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import DatabaseCtor from 'better-sqlite3';
import { formatOrientamentoReport, readOrientamentoReport } from '../core/turns/orientamento-report.js';

/**
 * `muffin orientamento` — la misura ripetibile che
 * `docs/evidence/orizzonte-del-turno-2026-09-03.md` Parte 0 chiede: prima
 * quel numero (51,7%) è stato prodotto interrogando a mano `muffin.db`
 * dell'owner una volta; questo comando fa la stessa lettura, ripetibile.
 *
 * **`--db` è obbligatorio e non c'è un default sulla home.** Il mandato di
 * questa slice vieta di leggere l'installazione dell'owner: chi vuole il
 * numero vero lo passa esplicitamente (`--db ~/.muffin/muffin.db`), chi
 * scrive un test lo passa su una fixture. Aperto in sola lettura
 * (`readonly: true`), quindi anche puntato per errore su un database vivo
 * non scrive nulla.
 */
export const ORIENTAMENTO_USAGE = `usage: muffin orientamento --db <path> [--cap N]
  la quota di chiamate "di orientamento" (fs_list, fs_read, fs_search, sys_inspect)
  su turn_tool_calls di un database esplicito — mai la home di default, sola lettura.
  --db   percorso del file sqlite da leggere (obbligatorio)
  --cap  soglia di chiamate/turno oltre cui un turno conta "al tetto" (default 15)
`;

export function cmdOrientamento(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: { db: { type: 'string' }, cap: { type: 'string' } },
    allowPositionals: false,
  });

  if (!values.db) {
    process.stderr.write(ORIENTAMENTO_USAGE);
    return 78;
  }
  if (!existsSync(values.db)) {
    process.stderr.write(`nessun database in ${values.db}\n`);
    return 78;
  }
  const cap = values.cap !== undefined ? Number(values.cap) : 15;
  if (!Number.isFinite(cap) || cap <= 0) {
    process.stderr.write(`--cap deve essere un numero positivo (ricevuto: ${values.cap})\n`);
    return 78;
  }

  const db = new DatabaseCtor(values.db, { readonly: true, fileMustExist: true });
  try {
    process.stdout.write(`${formatOrientamentoReport(readOrientamentoReport(db, cap))}\n`);
    return 0;
  } finally {
    db.close();
  }
}
