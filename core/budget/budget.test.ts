import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { BudgetEngine } from './budget.js';

function engine(now: () => Date) {
  return new BudgetEngine(
    new DatabaseCtor(':memory:'),
    { monthlyUsd: 10, perTenantDailyUsd: 2 },
    now,
  );
}

const spend = (tenant: string, usd: number) => ({
  tenant,
  capability: 'chat',
  model: 'test',
  inputTokens: 100,
  outputTokens: 10,
  usd,
});

describe('budget', () => {
  it('adds up the month and trips the global cap', () => {
    const b = engine(() => new Date('2026-08-04T10:00:00Z'));
    b.record(spend('host', 4));
    b.record(spend('host', 5));
    expect(b.exhausted()).toBe(false);
    b.record(spend('host', 1.5));
    expect(b.exhausted()).toBe(true);
  });

  it('keeps a noisy group from eating the whole month', () => {
    // The failure mode this exists for: a group echo loop. The tenant cap trips
    // long before the monthly one, and the owner's own tenant is untouched.
    const b = engine(() => new Date('2026-08-04T10:00:00Z'));
    b.record(spend('group:telegram:42', 2.5));
    expect(b.tenantExhausted('group:telegram:42')).toBe(true);
    expect(b.tenantExhausted('host')).toBe(false);
    expect(b.exhausted()).toBe(false);
  });

  it('never applies the daily cap to the owner, however much the owner spends', () => {
    // The test above passes for a weak reason: `host` had spent nothing. This
    // is the strong one. Two dollars is roughly fifteen frontier turns, so a
    // cap written to stop a group echo loop would, applied to `host`, stop the
    // owner by mid-morning — and the exit criterion for DAY-1 is days of
    // ordinary use. The owner's ceiling is the monthly cap and nothing else.
    const b = engine(() => new Date('2026-08-04T10:00:00Z'));
    b.record(spend('host', 9));
    expect(b.tenantTodayUsd('host')).toBe(9);
    expect(b.tenantExhausted('host')).toBe(false);
    expect(b.exhausted()).toBe(false);
  });

  it('resets the tenant cap the next day and keeps the monthly one', () => {
    let now = new Date('2026-08-04T10:00:00Z');
    const b = engine(() => now);
    b.record(spend('group:telegram:42', 2.5));
    now = new Date('2026-08-05T10:00:00Z');
    expect(b.tenantExhausted('group:telegram:42')).toBe(false);
    expect(b.monthToDateUsd()).toBe(2.5);
  });

  it('starts a fresh month', () => {
    let now = new Date('2026-08-31T23:00:00Z');
    const b = engine(() => now);
    b.record(spend('host', 10));
    expect(b.exhausted()).toBe(true);
    now = new Date('2026-09-01T01:00:00Z');
    expect(b.exhausted()).toBe(false);
  });

  it('announces the crossing once, not on every turn', () => {
    const b = engine(() => new Date('2026-08-04T10:00:00Z'));
    b.record(spend('host', 10));
    expect(b.status().justCrossed).toBe('monthly');
    expect(b.status().justCrossed).toBeNull();
  });
});

/**
 * Il contatore del tetto per-job (DAY-1 E1).
 *
 * Il tetto vive sulla riga del job (`core/scheduler/jobs.ts`); qui vive il
 * numero che lo consuma. Le due metà si incontrano in
 * `agent/scheduler-run.ts`, ed è quel file a provare che il modello non viene
 * chiamato — queste prove riguardano solo se il conto è giusto.
 */
describe('BudgetEngine — il conto per-job', () => {
  const GIUGNO = new Date('2026-06-15T10:00:00Z');
  const LUGLIO = new Date('2026-07-01T10:00:00Z');

  it('somma solo le righe di QUEL job, e solo quelle di questo mese', () => {
    let ora = GIUGNO;
    const b = engine(() => ora);
    b.record({ ...spend('host', 1), jobId: 'job-a' });
    b.record({ ...spend('host', 2), jobId: 'job-b' });
    b.record({ ...spend('host', 4), jobId: 'job-a' });
    // Una spesa interattiva: nessun job, e non deve finire nel conto di
    // nessuno. È la ragione per cui la colonna è nullable e non un sentinella.
    b.record(spend('host', 8));

    expect(b.jobMonthUsd('job-a')).toBe(5);
    expect(b.jobMonthUsd('job-b')).toBe(2);
    expect(b.jobMonthUsd('job-mai-visto')).toBe(0);
    // Il tetto globale continua a vedere tutto, job o non job.
    expect(b.monthToDateUsd()).toBe(15);

    // Il mese cambia: il conto per-job riparte, come quello mensile. Un tetto
    // a vita spegnerebbe per sempre un job quotidiano per una sola giornata
    // storta — una decisione diversa, e peggiore.
    ora = LUGLIO;
    expect(b.jobMonthUsd('job-a')).toBe(0);
  });

  it('jobExhausted: nessun tetto non è mai esaurito; il tetto raggiunto sì', () => {
    const b = engine(() => GIUGNO);
    b.record({ ...spend('host', 0.5), jobId: 'job-a' });

    expect(b.jobExhausted('job-a', null)).toBe(false); // l'owner non ne ha messo uno
    expect(b.jobExhausted('job-a', 1)).toBe(false);
    expect(b.jobExhausted('job-a', 0.5)).toBe(true); // >=, non >
    expect(b.jobExhausted('job-a', 0.25)).toBe(true);
    // Un tetto a zero è un job in pausa, e lo è già prima di spendere niente.
    expect(b.jobExhausted('job-mai-visto', 0)).toBe(true);
  });

  /**
   * La prova di migrazione per l'altra metà dello schema.
   *
   * `spend` la scrive **ogni chiamata al modello**, non solo i job: se
   * `ensureColumn` sparisse, il primo boot dopo l'aggiornamento su un database
   * dell'owner morirebbe nel costruttore — e non per i job, per tutto.
   */
  it('apre una tabella spend creata senza job_id, e le righe vecchie non appartengono a nessun job', () => {
    const db = new DatabaseCtor(':memory:');
    try {
      db.exec(`
        CREATE TABLE spend (
          id            INTEGER PRIMARY KEY,
          tenant        TEXT NOT NULL,
          capability    TEXT NOT NULL,
          model         TEXT NOT NULL,
          input_tokens  INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          usd           REAL NOT NULL,
          day           TEXT NOT NULL,
          month         TEXT NOT NULL,
          created_at    TEXT NOT NULL
        );
      `);
      db.prepare(
        `INSERT INTO spend (tenant, capability, model, input_tokens, output_tokens, usd, day, month, created_at)
         VALUES ('host', 'llm.chat', 'test', 1, 1, 3, '2026-06-15', '2026-06', '2026-06-15T09:00:00.000Z')`,
      ).run();
      expect((db.prepare(`PRAGMA table_info(spend)`).all() as Array<{ name: string }>).map((c) => c.name)).not.toContain(
        'job_id',
      );

      const b = new BudgetEngine(db, { monthlyUsd: 10, perTenantDailyUsd: 2 }, () => GIUGNO);
      // La spesa vecchia c'è ancora — non è stata riscritta né persa.
      expect(b.monthToDateUsd()).toBe(3);
      // E non è attribuita a nessun job: nessuna riga già scritta sa a quale
      // job apparteneva, e inventarlo dopo sarebbe peggio che non saperlo.
      expect(b.jobMonthUsd('job-a')).toBe(0);

      b.record({ ...spend('host', 1), jobId: 'job-a' });
      expect(b.jobMonthUsd('job-a')).toBe(1);
    } finally {
      db.close();
    }
  });
});
