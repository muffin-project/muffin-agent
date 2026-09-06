import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SandboxExecutor } from './executor.js';
import { probeSandbox } from './probe.js';

/**
 * **Il falsificatore del punto 4 di ADR-0074, eseguito.**
 *
 * L'ADR dice: *«un comando in `sys.shell` (sola lettura) scrive fuori dallo
 * scratch o apre un socket — prova nel container di ci:local (`bwrap`):
 * `touch $WORKSPACE/x` e `curl` devono fallire dentro `sys.shell` e riuscire
 * solo in `sys.shell.write` dopo l'`ask`»*. Questo file è quella prova, e non
 * un'asserzione sugli argomenti che `@anthropic-ai/sandbox-runtime` costruisce:
 * i flag di bwrap e il profilo seatbelt sono suoi, cambiano fra versioni, e
 * una suite che li leggesse resterebbe verde il giorno in cui smettono di
 * fare effetto. Qui gira un comando vero e si guarda cosa è successo.
 *
 * `core/sandbox/executor.test.ts` prova che il sandbox *contiene*; questo file
 * prova che le **due corsie contengono cose diverse**, che è la claim nuova.
 * Vive accanto a quello e ne riusa il cancello, per la stessa ragione con cui
 * quello è una suite sola per due meccanismi: una garanzia che solo una
 * piattaforma asserisce è una garanzia che deriva.
 *
 * **Le mutazioni che lo devono far cadere**, tutte e tre in codice nostro:
 *
 *  1. `networkOff()` in `core/sandbox/executor.ts` che non restituisce più il
 *     blocco `network` (o `allowedDomains` che sparisce): srt smette di
 *     mettere `--unshare-net` su Linux e di togliere `(allow network*)` dal
 *     profilo seatbelt su macOS, e «la rete è spenta» diventa rossa.
 *  2. `runReadOnly` che passa il workspace in `writeScope` invece di `[]`:
 *     «la scrittura fuori dallo scratch fallisce» diventa rossa.
 *  3. `makeShellTool` che chiama `run` invece di `runReadOnly` — quella cade in
 *     `agent/tools/shell.test.ts`, che è dove sta il cablaggio.
 */
const host = platform();

/** Stesso cancello di `executor.test.ts`, e per le stesse ragioni: vedi lì. */
const gate: { run: boolean; why: string } = (() => {
  if (host === 'darwin') return { run: true, why: 'macOS: seatbelt is part of the OS' };
  if (host === 'linux') {
    const p = probeSandbox();
    if (p.available) return { run: true, why: `linux: ${p.mechanism} contained a real probe` };
    return { run: false, why: `linux: sandbox unavailable — ${p.reason}: ${p.detail}` };
  }
  return { run: false, why: `no OS-level sandbox on ${host}` };
})();

const containmentRequired = process.env['MUFFIN_REQUIRE_SANDBOX'] === '1';

describe('il confine fra le due corsie dichiara se è stato provato', () => {
  it('o la prova è girata, o lo skip è dichiarato — e dove era richiesta, uno skip è un guasto', () => {
    if (gate.run) {
      expect(gate.why).not.toBe('');
      return;
    }
    if (containmentRequired) {
      throw new Error(
        `MUFFIN_REQUIRE_SANDBOX=1 e nessun contenimento reale è girato su questo host — ${gate.why}.`,
      );
    }
    console.warn(`[sandbox] confine sola-lettura NON provato — ${gate.why}`);
    expect(gate.why).not.toBe('');
  });
});

describe.runIf(gate.run)(`le due corsie contengono cose diverse (${gate.why})`, () => {
  const base = mkdtempSync(join(tmpdir(), 'muffin-corsie-'));
  const workspace = join(base, 'workspace');
  const secrets = join(base, 'secrets');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(secrets, { recursive: true });
  writeFileSync(join(secrets, 'llm_api_key'), 'sk-live-do-not-read');

  const executor = new SandboxExecutor({ denyWrite: [secrets], denyRead: [secrets] });

  /**
   * Una porta TCP **viva** sul loopback dell'host, e non una porta chiusa.
   *
   * Con `127.0.0.1:9` (discard, quasi sempre chiusa) il test sarebbe verde
   * anche a rete completamente aperta: la connessione fallirebbe per
   * ECONNREFUSED, cioè per una ragione che non ha niente a che vedere col
   * sandbox. Serve un bersaglio che l'host raggiunge davvero — il controllo
   * positivo qui sotto lo verifica prima di ogni asserzione — così un
   * fallimento da dentro il sandbox può essere letto come contenimento e non
   * come «non c'era niente da raggiungere».
   */
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    // Un server **HTTP**, non un TCP grezzo: le due strade verso l'esterno sono
    // due, e vanno provate tutte e due. Il TCP grezzo prova il namespace di
    // rete; una GET prova il proxy di srt, che è l'unico canale che resta
    // aperto dentro il namespace isolato — e che `networkOff()` chiude con
    // `allowedDomains: []` più `deniedDomains: ['*']`.
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('PONG\n');
    });
    // Il probe TCP chiude di netto appena la connessione è stabilita: la
    // scrittura del server muore con ECONNRESET, che è la risposta giusta alla
    // domanda «esiste una strada», non un guasto da far salire.
    server.on('clientError', () => {});
    server.on('connection', (socket) => socket.on('error', () => {}));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('nessuna porta assegnata');
    port = address.port;
  });

  afterAll(async () => {
    await executor.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** Il controllo positivo: dall'host, quella porta risponde. */
  const raggiungibileDallHost = (): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = connect({ host: '127.0.0.1', port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
      socket.setTimeout(3_000, () => {
        socket.destroy();
        resolve(false);
      });
    });

  /**
   * `bash -c` e `/dev/tcp`, non `curl`: `curl` onora `HTTP_PROXY`, che srt
   * imposta dentro il sandbox, quindi un suo fallimento proverebbe che il
   * proxy rifiuta e non che il namespace di rete è isolato. `/dev/tcp` è una
   * connessione TCP grezza che nessuna variabile d'ambiente devia — è la
   * domanda «esiste una strada verso quella porta», che è quella che conta.
   */
  const bussa = (p: number) => `bash -c 'exec 3<>/dev/tcp/127.0.0.1/${p} && echo RAGGIUNTA'`;

  describe('sola lettura (sys.shell)', () => {
    it('una scrittura nel workspace fallisce, e il file non compare', async () => {
      const bersaglio = join(workspace, 'x');
      const r = await executor.runReadOnly({ command: `touch '${bersaglio}'`, cwd: workspace });
      expect(r.code).not.toBe(0);
      expect(existsSync(bersaglio)).toBe(false);
    });

    it('una scrittura relativa nella cwd fallisce anche lei', async () => {
      const r = await executor.runReadOnly({
        command: 'echo pwned > relativo.txt',
        cwd: workspace,
      });
      expect(r.code).not.toBe(0);
      expect(existsSync(join(workspace, 'relativo.txt'))).toBe(false);
    });

    it('lo scratch di sessione resta scrivibile — il confine è lo scope, non «tutto negato»', async () => {
      // Senza questa riga i due rossi qui sopra sarebbero indistinguibili da un
      // sandbox che rifiuta ogni scrittura, e `cmd1 > f && cmd2 < f` — la
      // ragione per cui lo scratch esiste — smetterebbe di funzionare senza
      // che niente lo dica.
      const r = await executor.runReadOnly({
        command: 'echo ok > "$TMPDIR/nota" && cat "$TMPDIR/nota"',
        cwd: workspace,
      });
      expect(r.stderr + r.stdout).toContain('ok');
      expect(r.code).toBe(0);
    });

    it("la rete è spenta: una porta che l'host raggiunge non è raggiungibile da dentro", async () => {
      expect(
        await raggiungibileDallHost(),
        "il controllo positivo è caduto: la porta non risponde nemmeno dall'host",
      ).toBe(true);
      const r = await executor.runReadOnly({ command: bussa(port), cwd: workspace });
      expect(r.stdout).not.toContain('RAGGIUNTA');
      expect(r.code).not.toBe(0);
      // E la porta è ancora viva dopo: il fallimento non era il server morto.
      expect(await raggiungibileDallHost()).toBe(true);
    });

    it("il proxy di egress rifiuta anche una GET — l'altra strada fuori, non solo il socket grezzo", async () => {
      // La strada che il namespace isolato lascia aperta di proposito: srt
      // monta un listener nel sandbox e ci mette `HTTP_PROXY` addosso, così
      // una configurazione con domini permessi potrebbe farci passare qualcosa.
      // `networkOff()` non ne permette nessuno, e nega tutto in modo esplicito.
      //
      // **È questa la riga che cade sulla mutazione stretta**, e non quella sul
      // socket grezzo: `allowedDomains: ['*']` (o la sparizione di
      // `deniedDomains: ['*']` con un dominio permesso) è un'edit legale e
      // silenziosa dentro `networkOff()`, mentre togliere l'intero blocco
      // `network` non lo è — `SandboxRuntimeConfig.network` è obbligatorio e
      // srt deriva `--unshare-net` dalla sua sola presenza, quindi quella metà
      // del confine non si perde con una svista (misurato: forzata con un cast,
      // srt muore nell'init e l'esecutore fallisce chiuso).
      expect(await raggiungibileDallHost()).toBe(true);
      const r = await executor.runReadOnly({
        command: `curl -sS --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/`,
        cwd: workspace,
      });
      expect(r.stdout).not.toContain('200');
      expect(r.code).not.toBe(0);
    });

    it('leggere riesce: `ls` e `env` sono esattamente i comandi per cui questa corsia esiste', async () => {
      writeFileSync(join(workspace, 'visibile.txt'), 'ciao\n');
      const ls = await executor.runReadOnly({ command: 'ls', cwd: workspace });
      expect(ls.code).toBe(0);
      expect(ls.stdout).toContain('visibile.txt');

      const env = await executor.runReadOnly({ command: 'env', cwd: workspace });
      expect(env.code).toBe(0);
      expect(env.stdout).toContain('PATH=');
    });

    it('i segreti restano illeggibili anche di qua: le guardie non sono un privilegio della corsia che scrive', async () => {
      const r = await executor.runReadOnly({
        command: `cat '${join(secrets, 'llm_api_key')}'`,
        cwd: workspace,
      });
      expect(r.stdout).not.toContain('sk-live-do-not-read');
      expect(r.code).not.toBe(0);
    });
  });

  describe('scrittura (sys.shell.write)', () => {
    it('lo stesso `touch` riesce, con lo stesso esecutore e lo stesso comando', async () => {
      // La differenza fra i due blocchi è una parola: `runReadOnly` contro
      // `run`. Se non lo fosse, il rosso del primo non proverebbe niente sul
      // confine — proverebbe che due comandi diversi si comportano diversamente.
      const bersaglio = join(workspace, 'x');
      const r = await executor.run({
        command: `touch '${bersaglio}'`,
        cwd: workspace,
        writeScope: [workspace],
      });
      expect(r.code).toBe(0);
      expect(existsSync(bersaglio)).toBe(true);
    });

    it('la rete resta spenta anche di qua — questa corsia chiede, non esce', async () => {
      // ADR-0074 §4 descrive `sys.shell.write` come «scrive nel workspace **o**
      // parla in rete». Metà è vera oggi e metà no, e la differenza è scritta
      // qui invece che lasciata al lettore: aprire la rete a questa corsia
      // vorrebbe dire scavalcare l'allowlist di egress della RoT (ADR-0066) da
      // una porta che non la consulta, e non è questa fetta a poterlo fare.
      // `docs/SECURITY.md` §9 lo dichiara; questa riga lo tiene vero.
      const r = await executor.run({
        command: bussa(port),
        cwd: workspace,
        writeScope: [workspace],
      });
      expect(r.stdout).not.toContain('RAGGIUNTA');
      expect(r.code).not.toBe(0);
    });
  });
});
