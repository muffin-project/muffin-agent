import { createServer, connect, type Server } from 'node:net';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/**
 * Il socket di controllo — la superficie di coordinamento **posseduta dal
 * gateway**.
 *
 * Preso da Hermes, che ha già fatto questa migrazione e ne ha scritto il perché
 * nel docstring del suo `gateway/control_socket.py` (letto il 27/08/2026,
 * riportato in `docs/blueprint/research/gateway-e-client-2026-08-27.md`). La
 * frase che conta descrive **noi**, non loro:
 *
 * > every other process on the machine … currently discovers gateway
 * > identity/state by scanning the process table … or by reading
 * > `gateway_state.json` (which can outlive its writer) … A connectable socket
 * > with a well-formed `identify` answer IS liveness — no PID-reuse heuristics.
 *
 * `readGateway` (`./lock.ts`) legge una riga `gateway_lock` con dentro un pid e
 * chiama `pidAlive`. Un record che può sopravvivere a chi l'ha scritto, più
 * un'euristica sul riuso dei pid. È esattamente quella frase.
 *
 * **v1 è sola osservazione, e la disciplina è deliberata.** Due verbi,
 * `identify` e `status`, che non cambiano niente; `readGateway` non è ancora
 * toccato. Ribaltare la liveness sul socket è un passo separato e piccolo, e
 * separarlo è quello che rende questa slice rivedibile: se il canale ha un
 * difetto, lo si scopre senza che nessuna decisione dipenda ancora da lui.
 *
 * **Mai una porta TCP.** Gli ACL del filesystem *sono* il confine di
 * autenticazione — lo stesso modello di fiducia del database che affianca, e
 * dello stesso `~/.muffin` che già contiene i segreti. Una porta, anche su
 * loopback, sarebbe una superficie nuova che questo file non ha bisogno di
 * aprire per fare il suo lavoro.
 */

/** Il contratto è versionato: un client che legge un numero che non conosce lo dice, invece di indovinare. */
export const CONTROL_PROTOCOL = 1;

export type Identify = {
  protocol: number;
  pid: number;
  home: string;
  /** Il commit da cui gira **questo processo**, non quello del checkout. */
  codeSha: string | null;
  startedAt: string;
};

export type ControlAnswer = { ok: true; verb: string; data: unknown } | { ok: false; error: string };

/**
 * Dove vive il socket, e il rimedio a un limite del sistema operativo che
 * altrimenti si scopre solo su una home lunga.
 *
 * `sun_path` sta in ~104 byte su macOS/BSD (108 su Linux): una home dentro un
 * `mkdtempSync` — cioè ogni test — ci arriva vicino da sola, e una home reale
 * dentro un percorso profondo la supera. Hermes risolve allo stesso modo e per
 * lo stesso motivo: quando il percorso non ci sta, il socket si bind in temp e
 * un **file puntatore** accanto alla home registra dov'è finito davvero. I
 * client seguono il puntatore senza sapere che esiste un caso speciale.
 *
 * Il nome in temp porta un hash della home, non un contatore: due installazioni
 * diverse sulla stessa macchina non devono poter atterrare sullo stesso file.
 */
const SUN_PATH_SAFE = 92;

export function socketPathFor(home: string): { path: string; pointer: string | null } {
  const diretto = join(home, 'gateway.sock');
  if (Buffer.byteLength(diretto) <= SUN_PATH_SAFE) return { path: diretto, pointer: null };
  const hash = createHash('sha256').update(home).digest('hex').slice(0, 12);
  return { path: join(tmpdir(), `muffin-gw-${hash}.sock`), pointer: join(home, 'gateway.sock.path') };
}

/** Dove il client deve bussare: il puntatore vince, perché è scritto da chi ha davvero fatto il bind. */
export function resolveSocketPath(home: string): string {
  const pointer = join(home, 'gateway.sock.path');
  if (existsSync(pointer)) {
    const scritto = readFileSync(pointer, 'utf8').trim();
    if (scritto !== '') return scritto;
  }
  return socketPathFor(home).path;
}

export type ControlServer = { path: string; close: () => Promise<void> };

/**
 * Apre il socket e risponde ai verbi.
 *
 * **Un socket rimasto da un processo morto non blocca l'avvio.** `listen` su un
 * path esistente fallisce con `EADDRINUSE` senza distinguere «c'è un altro
 * gateway vivo» da «l'ultimo è stato ucciso e il file è rimasto». La differenza
 * si misura, non si assume: si prova a **parlarci**. Se risponde, il file è di
 * qualcun altro e questo processo non lo tocca — la contesa fra due gateway è
 * già decisa dal claim nel database, e non va decisa una seconda volta qui, in
 * disaccordo. Se non risponde, era un cadavere e si rimuove.
 */
export async function serveControlSocket(
  home: string,
  answer: (verb: string) => unknown,
): Promise<ControlServer> {
  const { path, pointer } = socketPathFor(home);

  if (existsSync(path)) {
    const vivo = await ask(path, 'identify', 500).then(
      (r) => r.ok,
      () => false,
    );
    if (vivo) throw new Error(`gateway.sock è già servito da un altro processo (${path})`);
    rmSync(path, { force: true });
  }

  const server: Server = createServer((sock) => {
    // Un contratto per connessione: una riga JSON dentro, una fuori, e si
    // chiude. Niente sessioni, niente stato — è la forma che rende un client
    // sbagliato incapace di tenere il gateway occupato.
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) {
        // Una riga che non arriva mai è un client rotto o ostile: si tronca
        // invece di far crescere un buffer per sempre.
        if (buf.length > 4096) sock.destroy();
        return;
      }
      let risposta: ControlAnswer;
      try {
        const richiesta = JSON.parse(buf.slice(0, nl)) as { verb?: unknown };
        const verb = typeof richiesta.verb === 'string' ? richiesta.verb : '';
        risposta = { ok: true, verb, data: answer(verb) };
      } catch (error) {
        risposta = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      sock.end(`${JSON.stringify(risposta)}\n`);
    });
    // Un client che muore a metà non deve poter far cadere il gateway.
    sock.on('error', () => sock.destroy());
  });
  server.on('error', () => {
    /* un errore sul listener non e' una ragione per far cadere il gateway */
  });

  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(path, res);
  });
  if (pointer !== null) writeFileSync(pointer, `${path}\n`, 'utf8');

  return {
    path,
    close: async () => {
      await new Promise<void>((res) => server.close(() => res()));
      // Rimosso alla chiusura pulita, che è metà del contratto: il file che
      // resta è il caso che `serveControlSocket` sopra deve saper riconoscere,
      // e lasciarlo in giro di proposito renderebbe quel ramo la norma.
      rmSync(path, { force: true });
      if (pointer !== null) rmSync(pointer, { force: true });
    },
  };
}

/** Il timeout esiste perché un socket che accetta e non risponde è indistinguibile da uno vivo, senza. */
const ASK_TIMEOUT_MS = 1_000;

async function ask(path: string, verb: string, timeoutMs: number): Promise<ControlAnswer> {
  return new Promise<ControlAnswer>((res, rej) => {
    const sock = connect(path);
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      rej(new Error(`nessuna risposta dal socket entro ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    const fine = (fn: () => void): void => {
      clearTimeout(timer);
      sock.destroy();
      fn();
    };
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${JSON.stringify({ verb })}\n`));
    sock.on('data', (chunk: string) => {
      buf += chunk;
      if (!buf.includes('\n')) return;
      try {
        const r = JSON.parse(buf.slice(0, buf.indexOf('\n'))) as ControlAnswer;
        fine(() => res(r));
      } catch (error) {
        fine(() => rej(error instanceof Error ? error : new Error(String(error))));
      }
    });
    sock.on('error', (e) => fine(() => rej(e)));
    sock.on('close', () => {
      if (buf === '') fine(() => rej(new Error('il socket ha chiuso senza rispondere')));
    });
  });
}

/**
 * Chiede al gateway di questa home.
 *
 * Restituisce `null` quando non c'è nessuno da chiedere — socket assente,
 * rifiutato, muto. **`null` non significa «gateway morto»**, e chi lo legge non
 * deve trattarlo così finché la liveness non passa di qui (v2): significa
 * «questo canale non ha risposto», che su un gateway avviato prima di questa
 * versione è la risposta normale.
 */
export async function askGateway(home: string, verb: 'identify' | 'status'): Promise<unknown | null> {
  const path = resolveSocketPath(home);
  if (!existsSync(path)) return null;
  try {
    const r = await ask(path, verb, ASK_TIMEOUT_MS);
    return r.ok ? r.data : null;
  } catch {
    return null;
  }
}
