import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runInit } from '../../cli/init.js';
import { paths } from './config.js';
import { SessionStore } from '../session/store.js';
import { JsonlExporter } from '../tracing/tracer.js';
import { UndoJournal } from '../undo/journal.js';
import { openDb } from '../db/open.js';
import { snapshotTo } from '../db/migrate.js';
import { saveMcpRegistry } from '../mcp/registry.js';
import { ensurePrivateDir, isSelfOwned, tightenHome, tightenPrivateDb, tightenPrivateFile } from './private-fs.js';

let tmpRoots: string[] = [];
let savedUmask: number | undefined;

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'muffin-private-'));
  tmpRoots.push(d);
  return d;
}

afterEach(() => {
  if (savedUmask !== undefined) {
    process.umask(savedUmask);
    savedUmask = undefined;
  }
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
  tmpRoots = [];
});

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe('private-by-construction under a permissive umask', () => {
  it('fresh init is private even with umask 022', () => {
    savedUmask = process.umask(0o022);
    const home = join(tmp(), 'home');
    runInit({ home });
    const p = paths(home);
    expect(mode(p.home)).toBe(0o700);
    expect(mode(p.rot)).toBe(0o700);
    expect(mode(p.vault)).toBe(0o700);
    expect(mode(p.traces)).toBe(0o700);
    expect(mode(p.sessions)).toBe(0o700);
    expect(mode(p.secrets)).toBe(0o700);
    expect(mode(p.undo)).toBe(0o700);
    expect(mode(p.config)).toBe(0o600);
    expect(mode(p.db)).toBe(0o600);
    expect(mode(p.defaultsManifest)).toBe(0o600);
    // Shipped copies live in the private home too.
    expect(mode(p.persona)).toBe(0o600);
    expect(mode(p.voice)).toBe(0o600);
  });

  it('session, trace, undo, db and mcp writers create private files under umask 022', () => {
    savedUmask = process.umask(0o022);
    const home = join(tmp(), 'home');
    mkdirSync(home, { recursive: true });
    ensurePrivateDir(home);

    const sessions = new SessionStore(home);
    const ref = sessions.open('owner');
    sessions.append(ref, {
      role: 'user',
      content: 'ciao',
      surface: 'cli',
      createdAt: new Date().toISOString(),
    });
    expect(mode(ref.file)).toBe(0o600);

    const exporter = new JsonlExporter(home);
    exporter.export({
      name: 'muffin.turn',
      traceId: 't',
      spanId: 's',
      parentSpanId: null,
      startTimeUnixNano: Date.now() * 1e6,
      endTimeUnixNano: Date.now() * 1e6,
      status: 'ok',
      attributes: {},
      semconvVersion: '1.42.0',
    });
    const traces = paths(home).traces;
    for (const f of [ref.file, ...readdirList(traces)]) {
      expect(mode(f)).toBe(0o600);
    }

    const journal = new UndoJournal(paths(home).undo);
    journal.take('t1', { callId: 'c1', capability: 'fs.write', path: ref.file });
    expect(mode(join(paths(home).undo, 't1', 'manifest.json'))).toBe(0o600);

    const db = openDb(paths(home).db);
    db.exec(`CREATE TABLE IF NOT EXISTS t (x TEXT)`);
    db.prepare(`INSERT INTO t (x) VALUES (?)`).run('y');
    // Force a WAL sidecar to exist, then tighten what SQLite created.
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    tightenPrivateDb(paths(home).db);
    expect(mode(paths(home).db)).toBe(0o600);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const sidecar = `${paths(home).db}${suffix}`;
      if (existsSync(sidecar)) expect(mode(sidecar)).toBe(0o600);
    }

    // VACUUM INTO snapshots (backups, pre-migrate copies) are private too.
    const db2 = openDb(paths(home).db);
    try {
      const snap = join(home, 'backups', 'snap.db');
      mkdirSync(join(home, 'backups'), { recursive: true });
      snapshotTo(db2, snap);
      expect(mode(snap)).toBe(0o600);
    } finally {
      db2.close();
    }

    saveMcpRegistry({ schemaVersion: 1, servers: {} }, home);
    expect(mode(join(home, 'mcp.json'))).toBe(0o600);
  });
});

function readdirList(dir: string): string[] {
  return readdirSync(dir).map((e) => join(dir, e));
}

describe('migration tightens a pre-existing permissive home', () => {
  it('tightenHome repairs 0755/0644 to 0700/0600', () => {
    savedUmask = process.umask(0o022);
    const home = join(tmp(), 'home');
    mkdirSync(join(home, 'sessions'), { recursive: true });
    mkdirSync(join(home, 'traces'), { recursive: true });
    mkdirSync(join(home, 'vault', 'inbox'), { recursive: true });
    writeFileSync(join(home, 'config.json'), '{}\n');
    writeFileSync(join(home, 'sessions', 'a.jsonl'), '{}\n');
    writeFileSync(join(home, 'traces', '2026-01-01.jsonl'), '{}\n');
    // Simulate the old world: everything permissive.
    chmodSync(home, 0o755);
    chmodSync(join(home, 'sessions'), 0o755);
    chmodSync(join(home, 'config.json'), 0o644);

    const report = tightenHome(home);
    expect(report.tightened.length).toBeGreaterThan(0);
    expect(mode(home)).toBe(0o700);
    expect(mode(join(home, 'sessions'))).toBe(0o700);
    expect(mode(join(home, 'config.json'))).toBe(0o600);
    expect(mode(join(home, 'sessions', 'a.jsonl'))).toBe(0o600);
    expect(mode(join(home, 'traces', '2026-01-01.jsonl'))).toBe(0o600);
  });

  it('runInit migrates an existing permissive install', () => {
    savedUmask = process.umask(0o022);
    const home = join(tmp(), 'home');
    // Build a legacy home by hand with wide modes, then re-run init.
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify(fakeConfig(), null, 2));
    chmodSync(home, 0o755);
    chmodSync(join(home, 'config.json'), 0o644);

    runInit({ home });
    expect(mode(home)).toBe(0o700);
    expect(mode(paths(home).config)).toBe(0o600);
    expect(mode(paths(home).db)).toBe(0o600);
  });
});

function fakeConfig(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    provider: { kind: 'anthropic', apiKeyRef: 'secret://provider_api_key' },
    models: { main: 'm', light: 'l' },
    rot: { mode: 'single-user' },
    traces: { retentionDays: 90 },
    surfaces: { default: 'cli', enabled: ['cli'] },
  };
}

describe('hardened / service-user-owned material is never chmodded', () => {
  it('isSelfOwned distinguishes self from foreign uid', () => {
    expect(isSelfOwned('/tmp', () => ({ uid: 1000, mode: 0o755 }), () => 1000)).toBe(true);
    expect(isSelfOwned('/tmp', () => ({ uid: 0, mode: 0o755 }), () => 1000)).toBe(false);
  });

  it('tightenHome skips foreign-owned entries instead of chmodding them', () => {
    const home = join(tmp(), 'home');
    mkdirSync(join(home, 'rot'), { recursive: true });
    writeFileSync(join(home, 'rot', 'policy.json'), '{}\n');
    writeFileSync(join(home, 'config.json'), '{}\n');

    const foreignStat = (path: string): { uid: number; mode: number } => {
      const real = statSync(path);
      // Pretend rot/ belongs to a hardening service user.
      if (path.includes(`${join(home, 'rot')}`)) return { uid: 999999, mode: real.mode };
      return { uid: process.getuid?.() ?? 0, mode: real.mode };
    };
    const me = (): number | undefined => process.getuid?.() ?? 0;
    const beforeRotMode = mode(join(home, 'rot'));
    const report = tightenHome(home, { stat: foreignStat, getuid: me });
    expect(report.skippedForeign.some((p) => p.includes('rot'))).toBe(true);
    // Foreign-owned dir left alone.
    expect(mode(join(home, 'rot'))).toBe(beforeRotMode);
    // Same-user file still tightened.
    expect(mode(join(home, 'config.json'))).toBe(0o600);
  });

  it('tightenPrivateFile and ensurePrivateDir never throw on missing or foreign paths', () => {
    const home = join(tmp(), 'home');
    mkdirSync(home, { recursive: true });
    expect(() => tightenPrivateFile(join(home, 'missing.json'))).not.toThrow();
    const link = join(home, 'link');
    writeFileSync(join(home, 'real.json'), 'x\n');
    symlinkSync(join(home, 'real.json'), link);
    expect(() => tightenPrivateFile(link)).not.toThrow();
    expect(() => ensurePrivateDir(join(home, 'newdir'))).not.toThrow();
    expect(mode(join(home, 'newdir'))).toBe(0o700);
  });
});
