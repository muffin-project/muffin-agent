import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { tightenPrivateFile } from '../config/private-fs.js';

/**
 * Il socket di controllo — la superficie di coordinamento **posseduta dal
 * gateway**.
 *
 * Preso da Hermes, che ha già fatto questa migrazione e ne ha scritto il perché
 * nel docstring del suo `gateway/control_socket.py` (letto il 27/08/2026,
 * riportato in `docs/evidence/gateway-e-client-2026-08-27.md`). La
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
 * **v1 era sola osservazione, e la disciplina era deliberata.** Due verbi,
 * `identify` e `status`, che non cambiavano niente. **v2 aggiunge
 * l'esecuzione**: `run` (un turno del terminale eseguito dal gateway, in
 * streaming sulla stessa connessione) e `query` (l'esito di un'execution per
 * id). La liveness resta dove v1 l'ha messa — `identify` più il claim — e
 * `run` non la reinventa.
 *
 * **Mai una porta TCP.** Gli ACL del filesystem *sono* il confine di
 * autenticazione — lo stesso modello di fiducia del database che affianca, e
 * dello stesso `~/.muffin` che già contiene i segreti. Una porta, anche su
 * loopback, sarebbe una superficie nuova che questo file non ha bisogno di
 * aprire per fare il suo lavoro.
 */

/**
 * Il contratto è versionato: un client che legge un numero che non conosce lo dice, invece di indovinare.
 *
 * 2 = v1 (identify/status/superfici, una riga dentro e una fuori) più `run`
 * (connessione persistente, NDJSON in entrambe le direzioni — vedi
 * `core/gateway/forward.ts`) e `query` (una riga dentro e una fuori). Un
 * client che vuole `run` e legge `protocol: 1` sa che deve chiedere il
 * riavvio del gateway invece di eseguire in locale e sdoppiare il runtime.
 */
export const CONTROL_PROTOCOL = 2;

export type Identify = {
  protocol: number;
  pid: number;
  home: string;
  /** Il commit da cui gira **questo processo**, non quello del checkout. */
  codeSha: string | null;
  startedAt: string;
};

type ControlAnswer = { ok: true; verb: string; data: unknown } | { ok: false; error: string };

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
  const uid = process.getuid?.();
  const directory = join(tmpdir(), `m-${uid ?? 'unknown'}-${hash}`);
  const path = join(directory, 's');
  if (Buffer.byteLength(path) > SUN_PATH_SAFE) {
    throw new Error('la home e la directory temporanea superano il limite del socket Unix');
  }
  return {
    path,
    pointer: join(home, 'gateway.sock.path'),
  };
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

/**
 * I token che il chiamante conia sul protocollo (`run`: `id` e `sessionId`)
 * diventano un id di riga, un canale di risposta e un percorso di transcript
 * (`SessionStore.open` unisce `sessions/<sessionId>.jsonl`). Solo l'alfabeto
 * che il runtime usa davvero — niente `/`, niente `..` che esca, niente byte
 * di framing: una prima riga con altri byte non è un run.
 */
const CONTROL_TOKEN_RE = /^[A-Za-z0-9._:#-]{1,128}$/;

export function isSafeControlToken(value: unknown): value is string {
  return typeof value === 'string' && CONTROL_TOKEN_RE.test(value);
}

/**
 * La superficie del canale che il sandbox deve negare in lettura (#638).
 *
 * Il figlio contenuto gira con lo stesso uid dell'host, quindi gli ACL del
 * filesystem (`0600`) non separano niente: l'unica separazione è il deny del
 * sandbox. Chi costruisce i guard del sandbox (oggi `mandatoryGuards`,
 * `core/rot/guards.ts`) nega queste voci; il test in `control-socket.test.ts`
 * inchioda l'elenco al socket servito davvero.
 */
export function controlSocketGuardPaths(home: string): string[] {
  const { path, pointer } = socketPathFor(home);
  return pointer === null ? [path] : [path, pointer, dirname(path)];
}

/**
 * The long-home socket lives under shared temp storage. Establish its parent
 * before binding so a different UID can neither pre-create a usable path nor
 * reach the socket during the bind-to-chmod window.
 */
function ensurePrivateSocketDirectory(directory: string): void {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error('fallback sicuro del socket Unix non disponibile senza uid POSIX');
  }

  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  let st = lstatSync(directory, { throwIfNoEntry: false });
  if (st === undefined || !st.isDirectory() || st.isSymbolicLink() || st.uid !== uid) {
    throw new Error('directory privata del socket non appartiene al processo');
  }
  if ((st.mode & 0o777) !== 0o700) chmodSync(directory, 0o700);

  st = lstatSync(directory, { throwIfNoEntry: false });
  if (
    st === undefined ||
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    st.uid !== uid ||
    (st.mode & 0o777) !== 0o700
  ) {
    throw new Error('directory privata del socket non ha owner e permessi verificati');
  }
}

/** Tighten and verify the socket after bind; the private parent closes the race. */
function hardenControlSocket(path: string): void {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  let st = lstatSync(path, { throwIfNoEntry: false });
  if (st === undefined || !st.isSocket() || st.uid !== uid) {
    throw new Error('il socket di controllo non appartiene al processo');
  }
  chmodSync(path, 0o600);
  st = lstatSync(path, { throwIfNoEntry: false });
  if (st === undefined || !st.isSocket() || st.uid !== uid || (st.mode & 0o777) !== 0o600) {
    throw new Error('permessi owner-only del socket di controllo non verificati');
  }
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
  answer: (verb: string, body: Record<string, unknown>) => unknown,
  opts: {
    /**
     * Chi esegue un `run`, e tiene la connessione aperta.
     *
     * Assente = nessun `run` servito: la prima riga con `verb: 'run'` riceve
     * un errore e la connessione si chiude, come un verbo sconosciuto. Il
     * gateway passa l'host di `core/gateway/forward.ts`; chi non ha un
     * runtime da offrire (i test di v1) non passa niente e il comportamento
     * resta quello di prima, una riga dentro e una fuori.
     */
    onStream?: (sock: Socket, first: Record<string, unknown>) => void;
  } = {},
): Promise<ControlServer> {
  const { path, pointer } = socketPathFor(home);
  const socketDirectory = pointer === null ? null : dirname(path);
  if (socketDirectory !== null) ensurePrivateSocketDirectory(socketDirectory);

  if (existsSync(path)) {
    const vivo = await ask(path, { verb: 'identify' }, 500).then(
      (r) => r.ok,
      () => false,
    );
    if (vivo) throw new Error(`gateway.sock è già servito da un altro processo (${path})`);
    rmSync(path, { force: true });
  }

  const server: Server = createServer((sock) => {
    // Un contratto per connessione: una riga JSON dentro, una fuori, e si
    // chiude — tranne `run`, che tiene la connessione aperta e la consegna a
    // `onStream`. Niente sessioni oltre quella, niente stato — è la forma che
    // rende un client sbagliato incapace di tenere il gateway occupato.
    let buf = '';
    let handedOver = false;
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      if (handedOver) return;
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) {
        // Una riga che non arriva mai è un client rotto o ostile: si tronca
        // invece di far crescere un buffer per sempre. (`run` alza il tetto
        // una volta consegnato — vedi `forward.ts` — non qui, dove una prima
        // riga è sempre piccola.)
        if (buf.length > 65536) sock.destroy();
        return;
      }
      let richiesta: Record<string, unknown>;
      try {
        richiesta = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
      } catch (error) {
        sock.end(
          `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
        );
        return;
      }
      const verb = typeof richiesta.verb === 'string' ? richiesta.verb : '';
      if (verb === 'run' && opts.onStream) {
        handedOver = true;
        // Il resto della connessione non passa più di qui.
        sock.removeAllListeners('data');
        opts.onStream(sock, richiesta);
        return;
      }
      let risposta: ControlAnswer;
      try {
        risposta = { ok: true, verb, data: answer(verb, richiesta) };
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
    server.listen({ path, readableAll: false, writableAll: false }, res);
  });
  try {
    hardenControlSocket(path);
    if (pointer !== null) {
      writeFileSync(pointer, `${path}\n`, { encoding: 'utf8', mode: 0o600 });
      tightenPrivateFile(pointer);
    }
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(path, { force: true });
    if (pointer !== null) rmSync(pointer, { force: true });
    throw error;
  }

  return {
    path,
    close: async () => {
      await new Promise<void>((res) => server.close(() => res()));
      // Rimosso alla chiusura pulita, che è metà del contratto: il file che
      // resta è il caso che `serveControlSocket` sopra deve saper riconoscere,
      // e lasciarlo in giro di proposito renderebbe quel ramo la norma.
      rmSync(path, { force: true });
      if (pointer !== null) rmSync(pointer, { force: true });
      if (socketDirectory !== null) {
        try {
          rmdirSync(socketDirectory);
        } catch {
          /* Keep a non-empty private directory for safe stale-socket recovery. */
        }
      }
    },
  };
}

/** Il timeout esiste perché un socket che accetta e non risponde è indistinguibile da uno vivo, senza. */
const ASK_TIMEOUT_MS = 1_000;

async function ask(
  path: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<ControlAnswer> {
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
    sock.on('connect', () => sock.write(`${JSON.stringify(payload)}\n`));
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
 * Una domanda sola, una risposta sola — il corpo dei verbi che non tengono
 * la connessione aperta (`identify`, `status`, `superfici`, `query`).
 *
 * Restituisce `null` quando non c'è nessuno da chiedere — socket assente,
 * rifiutato, muto. **`null` non significa «gateway morto»**: significa
 * «questo canale non ha risposto», che su un gateway avviato prima della v2
 * è la risposta normale.
 */
export async function askRaw(
  home: string,
  payload: Record<string, unknown>,
  timeoutMs = ASK_TIMEOUT_MS,
): Promise<unknown | null> {
  const path = resolveSocketPath(home);
  if (!existsSync(path)) return null;
  try {
    const r = await ask(path, payload, timeoutMs);
    return r.ok ? r.data : null;
  } catch {
    return null;
  }
}

/**
 * Chiede al gateway di questa home.
 *
 * Restituisce `null` quando non c'è nessuno da chiedere — socket assente,
 * rifiutato, muto. **`null` non significa «gateway morto»**, e chi lo legge non
 * deve trattarlo così: significa «questo canale non ha risposto», che su un
 * gateway avviato prima di questa versione è la risposta normale.
 */
export async function askGateway(
  home: string,
  verb: 'identify' | 'status' | 'superfici',
): Promise<unknown | null> {
  return askRaw(home, { verb });
}
