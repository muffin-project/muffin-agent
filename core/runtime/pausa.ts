import type Database from 'better-sqlite3';

/**
 * La pausa: un fatto durevole, letto da chiunque stia per far partire lavoro.
 *
 * ADR-0054 §4: `/pause` ferma il runtime — nessun job parte, nessun turno in
 * coda inizia — e `/resume` riparte. **Persistita**, perché un riavvio del
 * gateway non deve dimenticare che l'owner aveva detto di fermarsi: una pausa
 * in memoria che sparisce con il processo è una pausa che vale finché il
 * `launchd` non decide altrimenti.
 *
 * Una riga in una tabella chiave/valore piccola e sua (`runtime_state`), non
 * `config.json`: la config è ciò che l'owner *configura*, e questo è uno
 * stato che cambia da un comando e che ogni processo sullo stesso database
 * deve vedere nello stesso momento — il REPL e il gateway condividono il
 * `muffin.db`, quindi `/pause` dal telefono ferma anche i job del terminale.
 *
 * Letta a ogni tick con una `SELECT` su chiave primaria: microsecondi, e la
 * sola alternativa — una cache — è il modo in cui due processi finiscono a
 * pensarla diversamente.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runtime_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const CHIAVE = 'paused';

export class Pausa {
  constructor(private readonly db: Database.Database) {
    db.exec(SCHEMA);
  }

  /** Vero mentre l'owner ha detto di fermarsi. */
  attiva(): boolean {
    const row = this.db.prepare(`SELECT value FROM runtime_state WHERE key = ?`).get(CHIAVE) as
      | { value: string }
      | undefined;
    return row?.value === '1';
  }

  /** Da quando, o `null` se non è in pausa. */
  da(): string | null {
    const row = this.db.prepare(`SELECT value, updated_at FROM runtime_state WHERE key = ?`).get(CHIAVE) as
      | { value: string; updated_at: string }
      | undefined;
    return row?.value === '1' ? row.updated_at : null;
  }

  metti(at: string = new Date().toISOString()): void {
    this.db
      .prepare(
        `INSERT INTO runtime_state (key, value, updated_at) VALUES (?, '1', ?)
         ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at`,
      )
      .run(CHIAVE, at);
  }

  togli(at: string = new Date().toISOString()): void {
    this.db
      .prepare(
        `INSERT INTO runtime_state (key, value, updated_at) VALUES (?, '0', ?)
         ON CONFLICT(key) DO UPDATE SET value = '0', updated_at = excluded.updated_at`,
      )
      .run(CHIAVE, at);
  }
}
