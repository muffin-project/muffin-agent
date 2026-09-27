import DatabaseCtor from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SWEEP_MIN_AGE_MS,
  holderLiveness,
  incarnationDir,
  incarnationOf,
  mintHolderId,
  probeIncarnation,
} from './incarnation.js';

/**
 * `core/lock/incarnation.ts` on its own: the token format, the probe's three
 * answers, the sweep, and what a process leaves behind on a clean exit and on
 * a SIGKILL. What the incarnation changes for a real claim is proved in
 * `durable.test.ts` ("a holder is judged by its process") and, on the real
 * binary, in acceptance A1 and B5.
 */

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const newHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), 'muffin-incarnation-unit-'));
  homes.push(home);
  return home;
};

/** A database file in a fresh home, open, as a store would hold it. */
const fileDb = (): { db: DatabaseCtor.Database; home: string } => {
  const home = newHome();
  return { db: new DatabaseCtor(join(home, 'muffin.db')), home };
};

/** An incarnation file nobody holds: what a SIGKILLed holder leaves. */
const deadIncarnation = (dir: string, ageMs = 0): string => {
  mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const file = join(dir, `${id}.db`);
  const db = new DatabaseCtor(file);
  db.exec(`CREATE TABLE incarnation (pid INTEGER NOT NULL, started_at TEXT NOT NULL)`);
  db.close();
  if (ageMs > 0) {
    const then = new Date(Date.now() - ageMs);
    utimesSync(file, then, then);
  }
  return id;
};

describe('the token format', () => {
  it('reads the incarnation out of `<incarnation>.<uuid>`', () => {
    const inc = randomUUID();
    expect(incarnationOf(`${inc}.${randomUUID()}`)).toBe(inc);
  });

  it('a token without one (every token minted before ADR-0092) has none', () => {
    expect(incarnationOf(randomUUID())).toBeNull();
    expect(incarnationOf(null)).toBeNull();
    expect(incarnationOf(undefined)).toBeNull();
  });

  it('nothing but a UUID can become a file name', () => {
    // The first half is joined into a path. A token shaped like a path must
    // never be read as an incarnation, whatever wrote it into the row.
    expect(incarnationOf(`../../etc/passwd.${randomUUID()}`)).toBeNull();
    expect(incarnationOf(`${randomUUID()}/x.${randomUUID()}`)).toBeNull();
    expect(incarnationOf(`${randomUUID().toUpperCase()}.${randomUUID()}`)).toBeNull();
    expect(incarnationOf(`${randomUUID()}.${randomUUID()}.extra`)).toBeNull();
  });
});

describe('where incarnations live', () => {
  it('beside a database file', () => {
    const { db, home } = fileDb();
    try {
      expect(incarnationDir(db)).toBe(join(home, 'incarnations'));
    } finally {
      db.close();
    }
  });

  it('nowhere for an in-memory database: nothing outside this process can hold its rows', () => {
    const db = new DatabaseCtor(':memory:');
    try {
      expect(incarnationDir(db)).toBeNull();
      expect(incarnationOf(mintHolderId(db))).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe('minting', () => {
  it("a token for a file database names this process's incarnation, whose file is locked", () => {
    const { db, home } = fileDb();
    try {
      const first = mintHolderId(db);
      const second = mintHolderId(db);
      const inc = incarnationOf(first);
      expect(inc).not.toBeNull();
      // One incarnation per process and directory, a fresh token per claim.
      expect(incarnationOf(second)).toBe(inc);
      expect(second).not.toBe(first);
      expect(inc !== null && probeIncarnation(join(home, 'incarnations'), inc)).toBe('alive');
    } finally {
      db.close();
    }
  });

  it("a claim in another pid's name carries no incarnation: this process's life says nothing about that pid", () => {
    // Otherwise a row staged for a dead pid would read as alive for as long as
    // the process that wrote it lives (found by cli/observe.test.ts and
    // agent/lane-wiring.test.ts, which stage exactly such rows).
    const { db } = fileDb();
    try {
      expect(incarnationOf(mintHolderId(db, process.pid + 1))).toBeNull();
      expect(incarnationOf(mintHolderId(db, process.pid))).not.toBeNull();
    } finally {
      db.close();
    }
  });
});

describe('the probe', () => {
  it('a missing file is a dead incarnation: a clean exit or a sweep removed it', () => {
    const dir = join(newHome(), 'incarnations');
    mkdirSync(dir);
    expect(probeIncarnation(dir, randomUUID())).toBe('dead');
  });

  it('a file whose lock can be taken is a dead incarnation', () => {
    const dir = join(newHome(), 'incarnations');
    expect(probeIncarnation(dir, deadIncarnation(dir))).toBe('dead');
  });

  it('a file it cannot read is unknown, and liveness falls back to the pid', () => {
    const { db, home } = fileDb();
    try {
      const dir = join(home, 'incarnations');
      mkdirSync(dir);
      const id = randomUUID();
      writeFileSync(join(dir, `${id}.db`), 'not a database, not even close to one');
      expect(probeIncarnation(dir, id)).toBe('unknown');
      const token = `${id}.${randomUUID()}`;
      expect(holderLiveness(db)(process.pid, token)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('a dead incarnation is dead whatever the pid on the row says', () => {
    const { db, home } = fileDb();
    try {
      const token = `${deadIncarnation(join(home, 'incarnations'))}.${randomUUID()}`;
      // process.pid is certainly alive: the pid is not asked at all.
      expect(holderLiveness(db)(process.pid, token)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('a token without an incarnation is judged by its pid, as before ADR-0092', () => {
    const { db } = fileDb();
    try {
      const live = holderLiveness(db);
      expect(live(process.pid, randomUUID())).toBe(true);
      expect(live(process.pid, null)).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('the sweep', () => {
  it('removes old dead files and leaves young ones, which may not be locked yet', () => {
    const { db, home } = fileDb();
    try {
      const dir = join(home, 'incarnations');
      const old = deadIncarnation(dir, SWEEP_MIN_AGE_MS + 5_000);
      const young = deadIncarnation(dir);
      // The first mint in this directory creates this process's incarnation,
      // and sweeps before it does.
      const own = incarnationOf(mintHolderId(db));
      const left = readdirSync(dir);
      expect(left).not.toContain(`${old}.db`);
      expect(left).toContain(`${young}.db`);
      expect(left).toContain(`${own}.db`);
    } finally {
      db.close();
    }
  });
});

describe('what a process leaves behind', () => {
  /** A child that mints on `dbPath`, prints its token, then exits or waits to be killed. */
  const child = async (
    dbPath: string,
    exitCleanly: boolean,
  ): Promise<{ token: string; done: Promise<void>; kill: () => void }> => {
    const code = `
      import DatabaseCtor from 'better-sqlite3';
      import { mintHolderId } from '${join(process.cwd(), 'core/lock/incarnation.ts')}';
      const db = new DatabaseCtor(process.argv[1]);
      process.stdout.write(mintHolderId(db) + '\\n');
      if (${exitCleanly}) process.exit(0);
      setTimeout(() => process.exit(0), 20_000);
    `;
    const proc = spawn('node', ['--import', 'tsx', '--input-type=module', '-e', code, dbPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    proc.stderr.on('data', (d) => (err += String(d)));
    const done = new Promise<void>((r) => proc.on('close', () => r()));
    const token = await new Promise<string>((resolve, reject) => {
      proc.stdout.on('data', (d) => {
        out += String(d);
        if (out.includes('\n')) resolve(out.trim());
      });
      proc.on('close', () => (out.includes('\n') ? resolve(out.trim()) : reject(new Error(err))));
    });
    return { token, done, kill: () => proc.kill('SIGKILL') };
  };

  it('a clean exit removes its own file', async () => {
    const home = newHome();
    const c = await child(join(home, 'muffin.db'), true);
    await c.done;
    const id = incarnationOf(c.token);
    if (id === null) throw new Error(`token senza incarnazione: ${c.token}`);
    expect(existsSync(join(home, 'incarnations', `${id}.db`))).toBe(false);
    expect(probeIncarnation(join(home, 'incarnations'), id)).toBe('dead');
  }, 30_000);

  it('a SIGKILL leaves the file, and the kernel has already released its lock', async () => {
    const home = newHome();
    const c = await child(join(home, 'muffin.db'), false);
    const id = incarnationOf(c.token);
    if (id === null) throw new Error(`token senza incarnazione: ${c.token}`);
    const dir = join(home, 'incarnations');
    expect(probeIncarnation(dir, id)).toBe('alive');
    c.kill();
    await c.done;
    expect(existsSync(join(dir, `${id}.db`))).toBe(true);
    expect(probeIncarnation(dir, id)).toBe('dead');
  }, 30_000);
});
