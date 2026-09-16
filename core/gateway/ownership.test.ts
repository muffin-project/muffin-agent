import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { type ControlServer, serveControlSocket } from './control-socket.js';
import { GatewayLock } from './lock.js';
import { resolveExecutionOwner } from './ownership.js';

/**
 * #533 — per una Home esiste in ogni momento un solo soggetto autorizzato a
 * produrre execution ed effects. Questo file prova la domanda, non il
 * meccanismo: socket vivo → gateway; claim senza socket → stand-down (mai un
 * secondo runtime); né l'uno né l'altro → locale esplicito.
 */

const aperti: ControlServer[] = [];
afterEach(async () => {
  while (aperti.length > 0) await aperti.pop()!.close();
});

const home = (): string => mkdtempSync(join(tmpdir(), 'muffin-owner-'));
const db = (): DatabaseCtor.Database => new DatabaseCtor(':memory:');

describe('resolveExecutionOwner', () => {
  it('senza socket e senza claim: owner locale esplicito', async () => {
    expect(await resolveExecutionOwner(home(), db())).toEqual({ kind: 'local' });
  });

  it('socket che parla protocollo 2: il gateway è l owner', async () => {
    const h = home();
    aperti.push(
      await serveControlSocket(h, (verb) =>
        verb === 'identify'
          ? { protocol: 2, pid: 4242, home: h, codeSha: null, startedAt: 'x' }
          : null,
      ),
    );
    expect(await resolveExecutionOwner(h, db())).toEqual({
      kind: 'gateway',
      pid: 4242,
      protocol: 2,
    });
  });

  it('claim viva senza socket: conflitto fail closed, mai un secondo runtime', async () => {
    const h = home();
    const database = db();
    // Un pid vivo davvero: `readGateway` giudica con `pidAlive` reale, e un
    // pid morto deve leggere come assente anche qui.
    new GatewayLock(database).claim(new Date(), 'in attesa', process.pid);
    const owner = await resolveExecutionOwner(h, database);
    expect(owner.kind).toBe('conflict');
    if (owner.kind === 'conflict') {
      expect(owner.reason).toContain(String(process.pid));
      expect(owner.remedy).not.toBe('');
    }
  });

  it('gateway di una versione senza esecuzione delegata: conflitto con rimedio restart', async () => {
    const h = home();
    aperti.push(
      await serveControlSocket(h, (verb) =>
        verb === 'identify'
          ? { protocol: 1, pid: 4242, home: h, codeSha: null, startedAt: 'x' }
          : null,
      ),
    );
    const owner = await resolveExecutionOwner(h, db());
    expect(owner.kind).toBe('conflict');
    if (owner.kind === 'conflict') expect(owner.remedy).toContain('restart');
  });
});
