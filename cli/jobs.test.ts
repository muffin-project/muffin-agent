import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInit } from './init.js';
import { paths } from '../core/config/config.js';
import { JobStore } from '../core/scheduler/jobs.js';
import { cmdJobsAdd, cmdJobsCap, cmdJobsList, cmdJobsRemove } from './jobs.js';

function bootHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'muffin-jobs-cli-'));
  runInit({ home, apiKey: 'sk-not-used' });
  return home;
}

function activeJobs(home: string) {
  const db = new DatabaseCtor(paths(home).db);
  try {
    return new JobStore(db).list();
  } finally {
    db.close();
  }
}

describe('muffin jobs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('add validates and persists; list and remove round-trip through exit codes', () => {
    const home = bootHome();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(cmdJobsList(home)).toBe(0); // empty is fine
    expect(cmdJobsAdd(home, ['--cron', '0 8 * * *', '--tz', 'Europe/Rome', 'brief della giornata'])).toBe(0);

    const jobs = activeJobs(home);
    expect(jobs.length).toBe(1);
    expect(jobs[0]!.goal).toBe('brief della giornata');
    expect(jobs[0]!.timezone).toBe('Europe/Rome');

    // remove by the short prefix that list prints
    const prefix = jobs[0]!.id.slice(0, 8);
    expect(cmdJobsRemove(home, prefix)).toBe(0);
    expect(activeJobs(home)).toEqual([]);
    // removing again finds nothing active
    expect(cmdJobsRemove(home, prefix)).toBe(1);
  });

  it('a malformed cron is rejected with exit 78 and writes nothing', () => {
    const home = bootHome();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(cmdJobsAdd(home, ['--cron', 'not a cron', 'goal'])).toBe(78);
    expect(activeJobs(home)).toEqual([]);
  });

  it('add without a cron or goal shows usage (78)', () => {
    const home = bootHome();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(cmdJobsAdd(home, ['--cron', '0 8 * * *'])).toBe(78); // no goal
    expect(cmdJobsAdd(home, ['just a goal'])).toBe(78); // no cron
    expect(activeJobs(home)).toEqual([]);
  });

  it('defaults the timezone to the neutral fallback sealed in the root of trust', () => {
    const home = bootHome();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // no --tz: falls back to budgets.json quietHours.timezone (neutral UTC default)
    expect(cmdJobsAdd(home, ['--cron', '0 8 * * *', 'brief'])).toBe(0);
    expect(activeJobs(home)[0]!.timezone).toBe('UTC');
  });
});

/**
 * La porta dell'owner sul tetto per-job (DAY-1 E1).
 *
 * Il tetto lo fa rispettare lo scheduler; qui si prova che l'owner possa
 * **metterlo, vederlo e cambiarlo** dal binario, perché un limite che si può
 * solo scrivere nel database a mano non è una capacità del sistema.
 */
describe('muffin jobs — il tetto per-job', () => {
  afterEach(() => vi.restoreAllMocks());

  it('--per-job-usd si scrive sulla riga, e la lista lo mostra insieme allo speso', () => {
    const home = bootHome();
    const detto: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => (detto.push(String(s)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(cmdJobsAdd(home, ['--cron', '0 8 * * *', '--per-job-usd', '0.5', 'brief della giornata'])).toBe(0);
    expect(activeJobs(home)[0]!.perJobUsd).toBe(0.5);

    // Una spesa già attribuita a quel job: la lista deve leggerla dal
    // registro vero, non stampare il solo tetto — «$0.50 al mese» non dice
    // niente finché non si vede che ne ha già spesi 0,40.
    const job = activeJobs(home)[0]!;
    const db = new DatabaseCtor(paths(home).db);
    const now = new Date();
    db.prepare(
      `INSERT INTO spend (tenant, capability, model, input_tokens, output_tokens, usd, day, month, job_id, created_at)
       VALUES ('host', 'llm.chat', 'test', 1, 1, 0.4, ?, ?, ?, ?)`,
    ).run(now.toISOString().slice(0, 10), now.toISOString().slice(0, 7), job.id, now.toISOString());
    db.close();

    detto.length = 0;
    expect(cmdJobsList(home)).toBe(0);
    const lista = detto.join('');
    expect(lista).toContain('tetto $0.5/mese');
    expect(lista).toContain('speso $0.40');
    expect(lista).not.toContain('raggiunto');
  });

  it('un --per-job-usd che non è un numero è un rifiuto (78), non un job senza tetto', () => {
    const home = bootHome();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // Il guasto che questa riga chiude: `Number('molto')` è NaN, NaN scritto
    // in SQLite è NULL, e NULL è «nessun tetto» — l'owner avrebbe chiesto un
    // limite e ottenuto il contrario, in silenzio.
    expect(cmdJobsAdd(home, ['--cron', '0 8 * * *', '--per-job-usd', 'molto', 'brief'])).toBe(78);
    expect(cmdJobsAdd(home, ['--cron', '0 8 * * *', '--per-job-usd', '-1', 'brief'])).toBe(78);
    expect(activeJobs(home)).toEqual([]);
  });

  it('jobs cap cambia e toglie il tetto per prefisso, senza rifare il job', () => {
    const home = bootHome();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(cmdJobsAdd(home, ['--cron', '0 8 * * *', '--per-job-usd', '0.5', 'brief'])).toBe(0);
    const id = activeJobs(home)[0]!.id;

    expect(cmdJobsCap(home, id.slice(0, 8), '2')).toBe(0);
    expect(activeJobs(home)[0]!.perJobUsd).toBe(2);
    expect(activeJobs(home)[0]!.id).toBe(id); // stesso job, non uno nuovo

    expect(cmdJobsCap(home, id.slice(0, 8), 'none')).toBe(0);
    expect(activeJobs(home)[0]!.perJobUsd).toBeNull();

    expect(cmdJobsCap(home, id.slice(0, 8), 'molto')).toBe(78);
    expect(cmdJobsCap(home, 'nessuno', '1')).toBe(1);
  });
});
