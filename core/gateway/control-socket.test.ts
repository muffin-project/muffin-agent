import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  askGateway,
  CONTROL_PROTOCOL,
  type ControlServer,
  controlSocketGuardPaths,
  isSafeControlToken,
  resolveSocketPath,
  serveControlSocket,
  socketPathFor,
} from './control-socket.js';

const aperti: ControlServer[] = [];
afterEach(async () => {
  while (aperti.length > 0) await aperti.pop()!.close();
});

async function servi(home: string, answer: (verb: string) => unknown): Promise<ControlServer> {
  const s = await serveControlSocket(home, answer);
  aperti.push(s);
  return s;
}

const home = (): string => mkdtempSync(join(tmpdir(), 'muffin-sock-'));

const identify = (pid = process.pid): unknown => ({
  protocol: CONTROL_PROTOCOL,
  pid,
  home: '/x',
  codeSha: null,
  startedAt: '2026-08-27T00:00:00.000Z',
});

describe('socket di controllo — i due verbi di v1', () => {
  it('risponde a `identify` con il contratto versionato', async () => {
    const h = home();
    await servi(h, (verb) => (verb === 'identify' ? identify() : null));
    const r = (await askGateway(h, 'identify')) as { protocol: number; pid: number };
    expect(r.protocol).toBe(CONTROL_PROTOCOL);
    expect(r.pid).toBe(process.pid);
  });

  it('risponde a `status` con quello che il gateway gli fa dire', async () => {
    const h = home();
    await servi(h, (verb) => (verb === 'status' ? { stato: 'in attesa', turni: 0 } : null));
    expect(await askGateway(h, 'status')).toEqual({ stato: 'in attesa', turni: 0 });
  });

  /**
   * «Nessuna risposta» non è «gateway morto», e finché la liveness non passa di
   * qui (v2) chi legge non deve poterlo confondere: su un gateway avviato prima
   * di questa versione il socket semplicemente non c'è, ed è la condizione
   * normale, non un guasto.
   */
  it('senza socket risponde null, che non vuol dire morto', async () => {
    expect(await askGateway(home(), 'identify')).toBeNull();
  });

  it('un verbo che il gateway non conosce non fa cadere niente', async () => {
    const h = home();
    await servi(h, (verb) => (verb === 'identify' ? identify() : null));
    expect(await askGateway(h, 'status')).toBeNull();
  });
});

describe('una richiesta per connessione', () => {
  it('due domande di fila si rispondono entrambe, su due connessioni', async () => {
    const h = home();
    let n = 0;
    await servi(h, () => {
      n += 1;
      return { n };
    });
    expect(await askGateway(h, 'identify')).toEqual({ n: 1 });
    expect(await askGateway(h, 'identify')).toEqual({ n: 2 });
  });

  it("un client che muore a meta' non porta giu' il server", async () => {
    const h = home();
    await servi(h, () => identify());
    const { connect } = await import('node:net');
    await new Promise<void>((res) => {
      const s = connect(resolveSocketPath(h), () => {
        s.write('{"verb":"iden'); // riga mai terminata
        s.destroy();
        res();
      });
    });
    // Il server e' ancora li'.
    expect(await askGateway(h, 'identify')).not.toBeNull();
  });
});

/**
 * `sun_path` sta in ~104 byte su macOS/BSD. Una home dentro un percorso
 * profondo lo supera, e senza il puntatore il bind fallirebbe con un errno che
 * non spiega niente. Hermes risolve allo stesso modo e per lo stesso motivo.
 */
describe('sun_path e il file puntatore', () => {
  it('una home corta usa il socket dentro la home, senza puntatore', () => {
    const p = socketPathFor('/tmp/x');
    expect(p.path).toBe('/tmp/x/gateway.sock');
    expect(p.pointer).toBeNull();
  });

  it('una home lunga sposta il socket in temp e lascia un puntatore accanto', () => {
    const lunga = `/tmp/${'a'.repeat(60)}/${'b'.repeat(60)}`;
    const p = socketPathFor(lunga);
    expect(p.path.startsWith(realpathSync(tmpdir()))).toBe(true);
    expect(p.path).not.toContain('a'.repeat(60));
    expect(p.pointer).toBe(join(lunga, 'gateway.sock.path'));
  });

  it('due home diverse non atterrano sullo stesso file in temp', () => {
    const a = socketPathFor(`/tmp/${'a'.repeat(120)}`).path;
    const b = socketPathFor(`/tmp/${'b'.repeat(120)}`).path;
    expect(a).not.toBe(b);
  });

  it('e il client segue il puntatore senza sapere che esiste un caso speciale', async () => {
    const base = mkdtempSync(join(tmpdir(), 'muffin-lungo-'));
    const lunga = join(base, 'x'.repeat(60), 'y'.repeat(60));
    mkdirSync(lunga, { recursive: true });
    const s = await servi(lunga, () => identify());
    expect(existsSync(join(lunga, 'gateway.sock.path'))).toBe(true);
    expect(readFileSync(join(lunga, 'gateway.sock.path'), 'utf8').trim()).toBe(s.path);
    expect(statSync(s.path).isSocket()).toBe(true);
    expect(statSync(s.path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(s.path)).mode & 0o777).toBe(0o700);
    expect(resolveSocketPath(lunga)).toBe(s.path);
    expect(controlSocketGuardPaths(lunga)).toContain(s.path);
    expect(controlSocketGuardPaths(lunga)).toContain(dirname(s.path));
    expect(controlSocketGuardPaths(lunga)).toContain(join(lunga, 'gateway.sock.path'));
    expect(await askGateway(lunga, 'identify')).not.toBeNull();
  });

  it.skipIf(process.getuid === undefined)('rifiuta un TMPDIR scrivibile senza sticky prima del bind', async () => {
    const base = mkdtempSync(join('/tmp', 'm-'));
    const tmpUnsafe = join(base, 'unsafe-tmp');
    const homeLunga = `/tmp/${'h'.repeat(60)}/${'x'.repeat(60)}`;
    mkdirSync(tmpUnsafe);
    chmodSync(tmpUnsafe, 0o777);
    const precedente = process.env.TMPDIR;
    process.env.TMPDIR = tmpUnsafe;

    try {
      const socket = socketPathFor(homeLunga).path;
      await expect(serveControlSocket(homeLunga, () => identify())).rejects.toThrow(/directory temporanea/);
      expect(existsSync(dirname(socket))).toBe(false);
    } finally {
      if (precedente === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = precedente;
      rmSync(base, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'darwin')('rifiuta un TMPDIR con ACL che concede scrittura ad altri UID prima del bind', async () => {
    const base = mkdtempSync(join('/tmp', 'm-'));
    const tmpAcl = join(base, 'acl-tmp');
    const homeLunga = `/tmp/${'h'.repeat(60)}/${'x'.repeat(60)}`;
    mkdirSync(tmpAcl);
    execFileSync('/bin/chmod', ['+a', 'everyone allow add_file,delete_child', tmpAcl]);
    const precedente = process.env.TMPDIR;
    process.env.TMPDIR = tmpAcl;

    try {
      const socket = socketPathFor(homeLunga).path;
      await expect(serveControlSocket(homeLunga, () => identify())).rejects.toThrow(/ACL/);
      expect(existsSync(dirname(socket))).toBe(false);
    } finally {
      if (precedente === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = precedente;
      rmSync(base, { recursive: true, force: true });
    }
  });
});

/**
 * `listen` su un path esistente fallisce con `EADDRINUSE` senza distinguere «un
 * altro gateway vivo» da «l'ultimo e' stato ucciso e il file e' rimasto». La
 * differenza si misura provando a parlarci, non si assume.
 */
describe('un socket rimasto da un processo morto', () => {
  it('non blocca l avvio: se non risponde era un cadavere', async () => {
    const h = home();
    // Un file al posto del socket: esiste, e non parla.
    writeFileSync(join(h, 'gateway.sock'), '', 'utf8');
    const s = await servi(h, () => identify());
    expect(await askGateway(h, 'identify')).not.toBeNull();
    expect(s.path).toBe(join(h, 'gateway.sock'));
  });

  /**
   * Se invece risponde, il file e' di qualcun altro: non lo si tocca. La
   * contesa fra due gateway e' gia' decisa dal claim nel database, e deciderla
   * una seconda volta qui vorrebbe dire poter essere in disaccordo.
   */
  it('ma un socket che risponde non viene rimosso, e il secondo avvio si rifiuta', async () => {
    const h = home();
    await servi(h, () => identify(111));
    await expect(serveControlSocket(h, () => identify(222))).rejects.toThrow(/altro processo/);
    const r = (await askGateway(h, 'identify')) as { pid: number };
    expect(r.pid).toBe(111);
  });
});

describe('chiusura pulita', () => {
  it('toglie il socket, cosi il file che resta e sempre e solo quello di un morto', async () => {
    const h = home();
    const s = await serveControlSocket(h, () => identify());
    expect(existsSync(s.path)).toBe(true);
    await s.close();
    expect(existsSync(s.path)).toBe(false);
    expect(await askGateway(h, 'identify')).toBeNull();
  });
});

describe('il canale dichiara la sua superficie negata (#638)', () => {
  /**
   * Il socket di controllo e il suo puntatore devono stare nella superficie
   * che il sandbox nega in lettura: un figlio contenuto gira con lo stesso
   * uid, quindi `chmod 0600` non chiude niente e solo il deny del sandbox
   * separa l'host dal contenuto.
   */
  it('controlSocketGuardPaths copre il socket servito e il puntatore', async () => {
    const h = home();
    const s = await servi(h, () => identify());
    const percorsi = controlSocketGuardPaths(h);
    expect(percorsi).toContain(s.path);
    expect(percorsi).toContain(resolveSocketPath(h));
    const { pointer } = socketPathFor(h);
    if (pointer !== null) expect(percorsi).toContain(pointer);
  });

  it('isSafeControlToken accetta gli id del runtime e rifiuta i percorsi', () => {
    for (const ok of [
      'owner',
      's',
      'sess-1',
      'telegram:-100950#2',
      'job-ab12cd34-ef5678',
      'a'.repeat(128),
    ]) {
      expect(isSafeControlToken(ok), ok).toBe(true);
    }
    for (const ko of [
      '../../evil',
      '/assoluto',
      'a/b',
      '',
      'con spazio',
      'x'.repeat(129),
      42,
      null,
    ]) {
      expect(isSafeControlToken(ko), String(ko)).toBe(false);
    }
  });
});
