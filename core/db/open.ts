import DatabaseCtor from 'better-sqlite3';
import { tightenPrivateDb } from '../config/private-fs.js';

/**
 * Open the Muffin database the way every process in this installation must
 * open it.
 *
 * Two pragmas, and neither is a preference:
 *
 * - **`journal_mode = WAL`** is a property of the *file*, not of the
 *   connection — SQLite persists it in the header — so a second opener does
 *   not strictly need to ask for it. Asking anyway is what makes the mode
 *   true for whoever opens the file *first*, and after `muffin restore` or a
 *   fresh copy that first opener is not always `agent/runtime.ts`.
 * - **`busy_timeout = 5000`** is per connection and persists nowhere. A
 *   connection that omits it gets `SQLITE_BUSY` the instant another writer
 *   holds the lock, instead of waiting for it. That is the whole difference
 *   between two processes taking turns and one of them failing.
 *
 * The second pragma is why this function exists. `connectSurfaces` opens its
 * own connections from three entrypoints — `cli/gateway.ts`, `cli/repl.ts`
 * and `cli/observe.ts` — and the judge of PR #90 found them opening the
 * database bare: `muffin repl` started while the gateway is already running
 * is not an exotic race, it is the ordinary shape of a day of use. The
 * failure was bounded (the delivery fence means a loser refuses rather than
 * double-sends) but it was a refusal where waiting five seconds would have
 * succeeded.
 *
 * Anything that needs schema migrations calls `migrate()` after this;
 * opening a database is not the same act as bringing it up to date.
 */
export function openDb(file: string): DatabaseCtor.Database {
  const db = new DatabaseCtor(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  // SQLite creates the main file and its `-wal`/`-shm` siblings under the
  // process umask (typically 0644 under 022). The database holds
  // conversations, memory and Telegram inbox data, so tighten what exists
  // now; later sidecars are tightened again at the next boot migration.
  tightenPrivateDb(file);
  return db;
}
