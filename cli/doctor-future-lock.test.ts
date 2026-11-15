import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { paths } from '../core/config/config.js';
import { runDoctor } from './doctor.js';
import { runInit } from './init.js';

/**
 * `muffin doctor` has to say a future stamp out loud. The scanner is unit
 * tested on its own; this file is the call `runDoctor` makes, which is the
 * one that disappears without a red test.
 */

const homes: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-doctor-future-'));
  homes.push(dir);
  vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'xdg'));
  runInit({ home: dir, apiKey: 'sk-never-called' });
  return dir;
}

describe('doctor flags a lock stamp that is in the future', () => {
  it('names the holder, how far ahead, the clock step, and the remedy', async () => {
    const dir = home();
    const database = new DatabaseCtor(paths(dir).db);
    const gatewayAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const sendAt = new Date(Date.now() + 60 * 1000).toISOString();
    database.exec(`
      CREATE TABLE IF NOT EXISTS gateway_lock (
        id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER, taken_at TEXT, since TEXT, status TEXT, holder_id TEXT
      );
      CREATE TABLE IF NOT EXISTS send_lock (
        id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER, taken_at TEXT, holder_id TEXT
      );
    `);
    // A pid that is not this process, and not pid 1. `holderLiveness` falls
    // back to the pid when the token has no incarnation, so the remedy is
    // the stale one: unlock, not stop.
    database
      .prepare(
        `INSERT INTO gateway_lock (id, pid, taken_at, since, status, holder_id) VALUES (1, ?, ?, ?, 'serving', NULL)`,
      )
      .run(2_147_000_001, gatewayAt, new Date().toISOString());
    database
      .prepare(`INSERT INTO send_lock (id, pid, taken_at, holder_id) VALUES (1, ?, ?, ?)`)
      .run(process.pid, sendAt, 'send.token');
    database.close();

    const report = await runDoctor(dir, { supervisorProbes: { unitFileExists: () => false } });
    const gateway = report.checks.find((check) => check.name === 'lock gateway');
    const send = report.checks.find((check) => check.name === 'lock invio');

    expect(gateway?.level).toBe('warn');
    expect(gateway?.detail).toContain('pid 2147000001');
    expect(gateway?.detail).toContain('nel futuro');
    expect(gateway?.detail).toContain("passo d'orologio");
    expect(gateway?.remedy).toContain('unlock --confirm');

    expect(send?.level).toBe('warn');
    expect(send?.detail).toContain(`pid ${String(process.pid)}`);
    expect(send?.detail).toContain("passo d'orologio");
    expect(send?.detail).toContain('holder send.token');
    expect(send?.remedy).toContain('ferma il processo');
    expect(send?.remedy).not.toContain('unlock --confirm');
  }, 60_000);
});
