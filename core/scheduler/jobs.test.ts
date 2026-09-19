import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JobStore, JobError, nextFire } from './jobs.js';

const BRIEF = { cron: '0 8 * * *', timezone: 'Europe/Rome', goal: 'brief della giornata', channel: 'cli' };

function memStore(now: Date): { store: JobStore; db: DatabaseCtor.Database } {
  const db = new DatabaseCtor(':memory:');
  return { store: new JobStore(db, () => now), db };
}

describe('nextFire', () => {
  it('computes the next 08:00 in the given timezone', () => {
    // 2026-06-15 06:00 UTC = 08:00 Rome (CEST, UTC+2) — the next fire is the
    // same day, 08:00 Rome.
    const after = new Date('2026-06-15T05:00:00Z'); // 07:00 Rome, before 08:00
    const fire = nextFire('0 8 * * *', 'Europe/Rome', after);
    expect(fire.toISOString()).toBe('2026-06-15T06:00:00.000Z'); // 08:00 CEST
  });

  it('holds wall-clock time across a spring-forward DST change', () => {
    // Italy springs forward 2026-03-29 (02:00 → 03:00). A 08:00 job must still
    // fire at 08:00 local on the 29th — 06:00 UTC (CEST) not 07:00.
    const after = new Date('2026-03-28T12:00:00Z');
    const fire = nextFire('0 8 * * *', 'Europe/Rome', after);
    // 08:00 on the 29th is after the transition → CEST (UTC+2) → 06:00 UTC.
    expect(fire.toISOString()).toBe('2026-03-29T06:00:00.000Z');
  });

  it('rejects an invalid timezone before it can misfire forever', () => {
    expect(() => nextFire('0 8 * * *', 'Not/AZone', new Date())).toThrow(JobError);
  });

  it('rejects a malformed cron expression', () => {
    expect(() => nextFire('not a cron', 'Europe/Rome', new Date())).toThrow(JobError);
  });
});

describe('JobStore', () => {
  it('add validates and persists with a computed first fire', () => {
    const { store } = memStore(new Date('2026-06-15T05:00:00Z'));
    const job = store.add(BRIEF);
    expect(job.nextFireAt.toISOString()).toBe('2026-06-15T06:00:00.000Z');
    expect(job.active).toBe(true);
    expect(store.list().map((j) => j.id)).toEqual([job.id]);
  });

  it('a bad spec throws and writes nothing', () => {
    const { store } = memStore(new Date('2026-06-15T05:00:00Z'));
    expect(() => store.add({ ...BRIEF, timezone: 'Nope' })).toThrow(JobError);
    expect(store.list()).toEqual([]);
  });

  it('apre un database scritto prima che `kind` esistesse — il caso di ogni upgrade reale', () => {
    // La tabella nella forma pre-#106, costruita a mano: `CREATE TABLE IF NOT
    // EXISTS` è un no-op su una tabella che c'è già, quindi senza la rete
    // difensiva nel costruttore il `prepare` dell'INSERT esplodeva con «table
    // jobs has no column named kind» — non per i job script nuovi: per
    // QUALUNQUE `muffin jobs list` dopo l'aggiornamento, perché `cli/jobs.ts`
    // apre il database direttamente, senza passare da `migrate()`. Riprodotto
    // dal judge del giro 2 esattamente così.
    const db = new DatabaseCtor(':memory:');
    db.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        cron TEXT NOT NULL,
        timezone TEXT NOT NULL,
        goal TEXT NOT NULL,
        channel TEXT NOT NULL,
        created_at TEXT NOT NULL,
        next_fire_at TEXT NOT NULL,
        last_run_at TEXT,
        active INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO jobs (id, cron, timezone, goal, channel, created_at, next_fire_at, last_run_at, active)
      VALUES ('vecchio', '0 8 * * *', 'Europe/Rome', 'brief della giornata', 'cli',
              '2026-06-01T00:00:00.000Z', '2026-06-15T06:00:00.000Z', NULL, 1);
    `);

    const store = new JobStore(db, () => new Date('2026-06-15T05:00:00Z'));
    // Il job di prima dell'upgrade è ancora lì, e legge come goal — il default
    // che la migrazione dichiara.
    const seen = store.list();
    expect(seen.map((j) => j.id)).toEqual(['vecchio']);
    expect(seen[0]!.kind).toBe('goal');
    // E il database aggiornato accetta anche il vocabolario nuovo.
    const script = store.add({ cron: '0 9 * * *', timezone: 'Europe/Rome', channel: 'cli', kind: 'script', script: 'echo ciao' });
    expect(store.get(script.id)?.kind).toBe('script');
  });

  it('survives a restart — a fresh store on the same file sees the job', () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-jobs-'));
    const file = join(home, 'jobs.db');
    const now = new Date('2026-06-15T05:00:00Z');

    const first = new DatabaseCtor(file);
    const id = new JobStore(first, () => now).add(BRIEF).id;
    first.close();

    // A new process would open a new connection and a new JobStore.
    const second = new DatabaseCtor(file);
    const reopened = new JobStore(second, () => now);
    const seen = reopened.list();
    second.close();
    expect(seen.map((j) => j.id)).toEqual([id]);
    expect(seen[0]!.goal).toBe('brief della giornata');
  });

  it('due returns only jobs whose fire time has arrived', () => {
    const now = new Date('2026-06-15T05:00:00Z');
    const { store } = memStore(now);
    const job = store.add(BRIEF); // fires 06:00Z
    expect(store.due(new Date('2026-06-15T05:59:00Z'))).toEqual([]); // not yet
    expect(store.due(new Date('2026-06-15T06:00:00Z')).map((j) => j.id)).toEqual([job.id]);
  });

  it('markRan schedules the next fire from now, not replaying missed slots', () => {
    // The process was down for two days; when it runs the catch-up, the job
    // should fire once and resume tomorrow — not queue two more runs.
    let now = new Date('2026-06-15T05:00:00Z');
    const db = new DatabaseCtor(':memory:');
    const store = new JobStore(db, () => now);
    const job = store.add(BRIEF); // next 06:00Z on the 15th

    now = new Date('2026-06-17T09:00:00Z'); // two days later, well past two fires
    const ran = store.markRan(job.id);
    expect(ran).not.toBeNull();
    // Next fire is the 18th at 08:00 Rome (06:00Z), one slot ahead of NOW — not
    // the 16th or 17th it slept through.
    expect(ran!.nextFireAt.toISOString()).toBe('2026-06-18T06:00:00.000Z');
    expect(ran!.lastRunAt!.toISOString()).toBe('2026-06-17T09:00:00.000Z');
  });

  it('disable is a soft-delete: it stops firing but the row remains', () => {
    const now = new Date('2026-06-15T05:00:00Z');
    const db = new DatabaseCtor(':memory:');
    const store = new JobStore(db, () => now);
    const job = store.add(BRIEF);

    expect(store.disable(job.id)).toBe(true);
    expect(store.list()).toEqual([]); // no longer active
    expect(store.disable(job.id)).toBe(false); // already disabled
    // The row is still there (§I-8) — get() reaches it regardless of active.
    expect(store.get(job.id)?.active).toBe(false);
    const count = db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number };
    expect(count.n).toBe(1);
  });
});

/**
 * Il tetto per-job (DAY-1 E1, ADR-0035 emendamento №2).
 *
 * Questa metà è la colonna: che esista, che sopravviva a un riavvio, che non
 * arrivi mai per sbaglio su una riga scritta prima di lei, e che un valore
 * assurdo venga rifiutato **prima** della scrittura invece di entrare come
 * NULL — cioè come «nessun tetto», che è l'opposto di quello che l'owner
 * aveva chiesto. Chi lo fa rispettare è `agent/scheduler-run.ts`, e lo prova
 * il suo test.
 */
describe('JobStore — il tetto per-job', () => {
  const NOW = new Date('2026-06-15T05:00:00Z');

  it('un job senza --per-job-usd non ha tetto, e nessuno gliene inventa uno', () => {
    const { store, db } = memStore(NOW);
    try {
      expect(store.add(BRIEF).perJobUsd).toBeNull();
      expect(store.list()[0]?.perJobUsd).toBeNull();
    } finally {
      db.close();
    }
  });

  it('il tetto sopravvive alla scrittura e torna dal database, non dalla memoria', () => {
    const { store, db } = memStore(NOW);
    try {
      const job = store.add({ ...BRIEF, perJobUsd: 0.5 });
      // Riletto da una seconda istanza sulla stessa connessione: è la riga che
      // risponde, non l'oggetto che `add` ha appena costruito.
      expect(new JobStore(db, () => NOW).get(job.id)?.perJobUsd).toBe(0.5);
    } finally {
      db.close();
    }
  });

  it('rifiuta un tetto che non è un numero di dollari, e non scrive niente', () => {
    const { store, db } = memStore(NOW);
    try {
      expect(() => store.add({ ...BRIEF, perJobUsd: Number.NaN })).toThrow(JobError);
      expect(() => store.add({ ...BRIEF, perJobUsd: -1 })).toThrow(JobError);
      // Il punto: un NaN scritto in SQLite diventa NULL, cioè «nessun tetto».
      // Se una di quelle due fosse passata, il job esisterebbe senza limite.
      expect(store.list()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('zero è un tetto valido e significa quello che dice', () => {
    const { store, db } = memStore(NOW);
    try {
      expect(store.add({ ...BRIEF, perJobUsd: 0 }).perJobUsd).toBe(0);
    } finally {
      db.close();
    }
  });

  it('setPerJobUsd cambia e toglie il tetto senza toccare l\'id del job', () => {
    const { store, db } = memStore(NOW);
    try {
      const job = store.add({ ...BRIEF, perJobUsd: 0.5 });
      expect(store.setPerJobUsd(job.id, 2)).toBe(true);
      expect(store.get(job.id)?.perJobUsd).toBe(2);
      expect(store.setPerJobUsd(job.id, null)).toBe(true);
      expect(store.get(job.id)?.perJobUsd).toBeNull();
      // L'id è la cosa a cui punta ogni occorrenza già registrata in
      // `job_fires`: cambiare il tetto non deve costare la storia del job.
      expect(store.get(job.id)?.id).toBe(job.id);
      expect(store.setPerJobUsd('non-esiste', 1)).toBe(false);
      expect(() => store.setPerJobUsd(job.id, -3)).toThrow(JobError);
    } finally {
      db.close();
    }
  });

  /**
   * La prova di migrazione che il resto della slice poggia su un'assunzione.
   *
   * `CREATE TABLE IF NOT EXISTS` è un no-op su una tabella che esiste già:
   * senza `ensureColumn` il primo `muffin jobs list` dopo l'aggiornamento
   * morirebbe con «table jobs has no column named per_job_usd» su
   * un'installazione che funzionava un minuto prima — ed è già successo una
   * volta, per `kind` (judge #106 giro 2). Qui la tabella viene creata a mano
   * **con lo schema vecchio**, con dentro una riga vecchia, e la prova è che
   * lo store apre, la riga vecchia si legge come «senza tetto» e una riga
   * nuova col tetto si scrive e si rilegge.
   */
  it('apre un database creato con lo SCHEMA vecchio, senza per_job_usd', () => {
    const db = new DatabaseCtor(':memory:');
    try {
      db.exec(`
        CREATE TABLE jobs (
          id           TEXT PRIMARY KEY,
          cron         TEXT NOT NULL,
          timezone     TEXT NOT NULL,
          goal         TEXT NOT NULL,
          channel      TEXT NOT NULL,
          kind         TEXT NOT NULL DEFAULT 'goal',
          created_at   TEXT NOT NULL,
          next_fire_at TEXT NOT NULL,
          last_run_at  TEXT,
          active       INTEGER NOT NULL DEFAULT 1
        );
      `);
      db.prepare(
        `INSERT INTO jobs (id, cron, timezone, goal, channel, kind, created_at, next_fire_at, active)
         VALUES ('vecchio', '0 8 * * *', 'Europe/Rome', 'brief di prima', 'cli', 'goal', ?, ?, 1)`,
      ).run(NOW.toISOString(), new Date('2026-06-16T06:00:00Z').toISOString());
      const colonne = () => (db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>).map((c) => c.name);
      expect(colonne()).not.toContain('per_job_usd');

      // Il costruttore è ciò che apre — e ciò che prepara gli statement.
      const store = new JobStore(db, () => NOW);
      expect(colonne()).toContain('per_job_usd');

      // La riga vecchia si legge, e legge «nessun tetto»: la migrazione non
      // ha spento niente che l'owner non abbia toccato.
      expect(store.get('vecchio')?.perJobUsd).toBeNull();
      expect(store.get('vecchio')?.goal).toBe('brief di prima');

      // E una riga nuova col tetto si scrive e si rilegge sulla stessa tabella.
      const nuovo = store.add({ ...BRIEF, perJobUsd: 1.25 });
      expect(store.get(nuovo.id)?.perJobUsd).toBe(1.25);
      expect(store.list().length).toBe(2);
    } finally {
      db.close();
    }
  });
});

describe('JobStore — provenance corrotta legge default noti, mai stringhe vuote', () => {
  /**
   * S3 (delta review): `toJob` è il decoder canonico della riga. Una stringa
   * vuota scritta a mano (`origin_tenant = ''`) non è un tenant e non deve
   * arrivare al fire come indirizzo vuoto: ricade sui default legacy
   * (host/cli/owner), la stessa direzione fail-closed della migrazione 7.
   * Per `channel` nessun default canonico esiste nel decoder (è un indirizzo
   * di consegna, non provenance): resta follow-up, non reinterpretazione.
   */
  it("origin_* vuoti tornano host/cli/owner, tier assurdo torna 0", () => {
    const db = new DatabaseCtor(':memory:');
    try {
      const store = new JobStore(db, () => new Date('2026-06-15T05:00:00Z'));
      const job = store.add({ cron: '0 8 * * *', timezone: 'Europe/Rome', channel: 'cli', goal: 'brief' });
      db.prepare(`UPDATE jobs SET origin_tenant = '', origin_surface = '', origin_principal = '', origin_turn = '', tier = 9 WHERE id = ?`).run(job.id);
      const riletto = store.get(job.id);
      expect(riletto?.origin).toEqual({ tenant: 'host', surface: 'cli', principal: 'owner', turnId: null });
      expect(riletto?.tier).toBe(0);
    } finally {
      db.close();
    }
  });
});
