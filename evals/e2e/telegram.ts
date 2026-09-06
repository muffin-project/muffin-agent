import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, muffinHome, readSecret } from '../../core/config/config.js';
import { TELEGRAM_MAX } from '../../connectors/telegram/render.js';
import { type Installazione, risolviCredenziali } from './credenziali.js';

/**
 * La corsia end-to-end **reale** su Telegram — modello vero, Bot API vera,
 * un umano al telefono. DAY-1 B11, B13, B2 e D12 si chiudono qui, non sul
 * finto (`docs/evidence/dogfood-superfici-2026-09-03.md` §5.4).
 *
 * Perché esiste: B11 e B13 erano READY sull'harness finto e l'owner, usando
 * Muffin, li ha trovati rotti. Il finto provider risponde in un colpo solo e
 * il finto Bot API non ha rate limit: «si vede bene» non era mai stato nel
 * perimetro. Qui il perimetro è la cosa vera, e la misura è **il filo**: un
 * proxy locale registra ogni chiamata che il gateway fa alla Bot API e ogni
 * update che riceve, e le asserzioni si fanno su quella registrazione — non
 * su una sensazione, e non su una risposta sintetica.
 *
 * Cosa serve, tutto dall'ambiente e mai stampato:
 *
 *   LLM_API_KEY (o OPENROUTER_API_KEY)   la chiave del modello
 *   MUFFIN_E2E_TELEGRAM_TOKEN            il token di un bot **di prova**
 *                                        (BotFather; non quello installato,
 *                                        che sta già facendo getUpdates)
 *   MUFFIN_E2E_OWNER_ID                  la tua user id Telegram
 *
 *   npx tsx evals/e2e/telegram.ts
 *   npx tsx evals/e2e/telegram.ts --model qwen/qwen3.6-27b --keep
 *
 * Il passo umano è dichiarato: lo script dice cosa mandare al bot, aspetta
 * che il filo mostri il risultato, e dice ✓ o ✗ con il perché. Il ritmo lo
 * dai tu; il verdetto lo dà il filo.
 */

const { values } = parseArgs({
  options: {
    model: { type: 'string' },
    'base-url': { type: 'string' },
    keep: { type: 'boolean' },
    home: { type: 'string' },
    'step-timeout-s': { type: 'string' },
  },
});

const installato = ((): Installazione => {
  const assente = { apiKey: '', ownerId: 0, tokenDedicato: '', tokenInstallato: '', gatewayVivo: false };
  try {
    const home = muffinHome();
    const cfg = loadConfig(home);
    const leggi = (ref: string | undefined): string => {
      if (ref === undefined || ref === '') return '';
      try {
        return readSecret(ref, home);
      } catch {
        return '';
      }
    };
    return {
      apiKey: leggi(cfg.provider.apiKeyRef),
      ownerId: cfg.surfaces.telegram?.ownerUserId ?? 0,
      tokenDedicato: leggi('secret://e2e_telegram_token'),
      tokenInstallato: leggi('secret://telegram_token'),
      gatewayVivo: existsSync(join(home, 'gateway.sock')),
    };
  } catch {
    return assente;
  }
})();

const avvio = risolviCredenziali(
  {
    apiKey: process.env['LLM_API_KEY'] ?? process.env['OPENROUTER_API_KEY'],
    token: process.env['MUFFIN_E2E_TELEGRAM_TOKEN'],
    ownerId: process.env['MUFFIN_E2E_OWNER_ID'],
  },
  installato,
);
if (!avvio.ok) {
  process.stderr.write(avvio.motivi.length === 1 ? '' : `mancano ${avvio.motivi.length} cose:\n`);
  for (const r of avvio.motivi) process.stderr.write(`  - ${r}\n`);
  process.exit(78);
}
const { apiKey, token, ownerId } = avvio.credenziali;

const MODEL = values.model ?? 'anthropic/claude-sonnet-5';
const BASE_URL = values['base-url'] ?? 'https://openrouter.ai/api/v1';
const STEP_TIMEOUT_MS = Number(values['step-timeout-s'] ?? '180') * 1000;
const ROOT = values.home ?? mkdtempSync(join(tmpdir(), 'muffin-e2e-'));
const HOME = join(ROOT, 'home');
const WORKSPACE = join(ROOT, 'workspace');
const WIRE = join(ROOT, 'wire.jsonl');
const CLI = join(import.meta.dirname, '..', '..', 'cli', 'main.ts');
mkdirSync(HOME, { recursive: true });
mkdirSync(WORKSPACE, { recursive: true });

// ---------------------------------------------------------------------------
// Il filo: ogni chiamata del gateway alla Bot API, e ogni update ricevuto.
// ---------------------------------------------------------------------------

type Chiamata = {
  n: number;
  at: string;
  method: string;
  payload: Record<string, unknown>;
  status: number;
  /** `message_id` di un messaggio creato, quando c'è. */
  messageId?: number;
  /** Per `getUpdates`: gli update tornati, ridotti a ciò che serve. */
  updates?: { updateId: number; messageId?: number; fromId?: number; text?: string; callback?: string }[];
};

const filo: Chiamata[] = [];
let contatore = 0;

/** Il token non finisce mai nel file né a schermo: l'URL registrato è solo il metodo. */
const senzaToken = (s: string): string => s.split(token).join('<token>');

function registra(c: Chiamata): void {
  filo.push(c);
  appendFileSync(WIRE, `${JSON.stringify(c)}\n`);
}

function leggi(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function avviaProxy(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    void (async () => {
      const raw = await leggi(req);
      const url = `https://api.telegram.org${req.url ?? ''}`;
      const method = (req.url ?? '').split('/').pop() ?? '';
      const contentType = String(req.headers['content-type'] ?? 'application/json');
      let payload: Record<string, unknown> = {};
      if (contentType.startsWith('application/json') && raw.length > 0) {
        try {
          payload = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        } catch {
          payload = {};
        }
      } else if (raw.length > 0) {
        payload = { _multipart: raw.length };
      }
      let status = 0;
      let bodyText = '';
      try {
        const upstream = await fetch(url, {
          method: req.method ?? 'POST',
          headers: { 'content-type': contentType },
          ...(raw.length > 0 ? { body: new Uint8Array(raw) } : {}),
        });
        status = upstream.status;
        bodyText = await upstream.text();
      } catch (error) {
        status = 502;
        bodyText = JSON.stringify({ ok: false, description: senzaToken(error instanceof Error ? error.message : String(error)) });
      }
      const entry: Chiamata = { n: ++contatore, at: new Date().toISOString(), method, payload, status };
      try {
        const parsed = JSON.parse(bodyText) as { ok?: boolean; result?: unknown };
        if (method === 'getUpdates' && Array.isArray(parsed.result)) {
          entry.updates = (parsed.result as Array<Record<string, unknown>>).map((u) => {
            const m = (u['message'] ?? {}) as Record<string, unknown>;
            const cq = (u['callback_query'] ?? {}) as Record<string, unknown>;
            const from = (m['from'] ?? cq['from'] ?? {}) as Record<string, unknown>;
            return {
              updateId: Number(u['update_id']),
              ...(typeof m['message_id'] === 'number' ? { messageId: m['message_id'] } : {}),
              ...(typeof from['id'] === 'number' ? { fromId: from['id'] } : {}),
              ...(typeof m['text'] === 'string' ? { text: m['text'] } : {}),
              ...(typeof cq['data'] === 'string' ? { callback: cq['data'] } : {}),
            };
          });
        } else if (parsed.result && typeof parsed.result === 'object' && 'message_id' in (parsed.result as object)) {
          entry.messageId = Number((parsed.result as { message_id: number }).message_id);
        }
      } catch {
        // una risposta non JSON si registra com'è: lo status basta
      }
      registra(entry);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(bodyText);
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${String(port)}` });
    });
  });
}

// ---------------------------------------------------------------------------
// Il binario vero, come lo usa l'owner.
// ---------------------------------------------------------------------------

/**
 * Asincrona, e la ragione non e' lo stile: era `spawnSync`, e con `spawnSync`
 * questo banco non poteva funzionare.
 *
 * Il proxy che registra il filo vive **in questo stesso processo**. `spawnSync`
 * blocca l'event loop finche' il figlio non esce, quindi mentre
 * `muffin surface enable --api-base http://127.0.0.1:<porta>` chiedeva
 * `getMe` al proxy, il proxy non poteva rispondere: nessuno stava girando.
 * Il figlio aspettava i 65 secondi di `REQUEST_TIMEOUT_MS` e moriva con
 * `Telegram 0: TimeoutError`, e il filo restava **vuoto** — perche' nessuna
 * chiamata era mai stata servita, non perche' nessuna fosse mai arrivata.
 *
 * Misurato il 04/09/2026 sulla macchina dell'owner, e riprodotto in isolamento:
 * un server locale piu' uno `spawnSync` che gli parla da' `TimeoutError` dopo
 * esattamente la scadenza del figlio.
 *
 * Il guasto e' entrato quando `surface enable` ha cominciato a validare il
 * token contro il server vero (`cli/surface.ts`, `api.getMe()`): prima di
 * allora nessun comando di setup parlava al proxy, e il blocco non si vedeva.
 * Non e' una svista di stile: e' una dipendenza fra due meccanismi che nessun
 * test unitario poteva incontrare, perche' vive solo quando il banco gira
 * intero.
 */
function muffin(args: string[], stdin?: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', CLI, ...args], {
      env: { ...process.env, MUFFIN_HOME: HOME, NO_COLOR: '1' },
      cwd: WORKSPACE,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      err += c.toString('utf8');
    });
    // Segreti da stdin, mai da argv (direttiva owner 2026-08-18).
    if (stdin !== undefined) child.stdin?.write(stdin);
    child.stdin?.end();
    child.on('error', () => resolve({ code: -1, out, err }));
    child.on('close', (code) => resolve({ code: code ?? -1, out, err }));
  });
}

type Passo = { nome: string; ok: boolean; dettaglio: string };
const passi: Passo[] = [];
/**
 * A quale messaggio risponde questa scrittura.
 *
 * Due campi, e leggerne uno solo e' costato una corsa: `reply_to_message_id`
 * e' il campo storico, `reply_parameters.message_id` quello attuale (Bot API
 * 7.0). Muffin manda il secondo — correttamente — e il banco cercava il
 * primo, quindi confrontava `NaN` e dichiarava rotto un prodotto che
 * funzionava. Si leggono entrambi: il banco deve reggere la Bot API che c'e',
 * non quella che ricordava.
 */
function rispondeA(c: Chiamata): number | undefined {
  const diretto = c.payload['reply_to_message_id'];
  if (typeof diretto === 'number') return diretto;
  const params = c.payload['reply_parameters'];
  if (params !== null && typeof params === 'object' && 'message_id' in params) {
    const id = (params as { message_id: unknown }).message_id;
    if (typeof id === 'number') return id;
  }
  return undefined;
}

function esito(nome: string, ok: boolean, dettaglio: string): void {
  passi.push({ nome, ok, dettaglio });
  process.stderr.write(`${ok ? '✓' : '✗'} ${nome}\n    ${dettaglio}\n`);
}

const inviati = (): Chiamata[] => filo.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText');
const testo = (c: Chiamata): string => String(c.payload['text'] ?? '');
const dopo = (n: number): Chiamata[] => filo.filter((c) => c.n > n);
/** Gli update dell'owner arrivati dopo il punto `n`, con il numero della chiamata `getUpdates` che li ha portati. */
const messaggiOwner = (n: number): { n: number; messageId: number; text: string }[] =>
  dopo(n).flatMap((c) =>
    (c.updates ?? [])
      .filter((u) => u.fromId === ownerId && u.text !== undefined && u.messageId !== undefined)
      .map((u) => ({ n: c.n, messageId: u.messageId!, text: u.text! })),
  );

async function aspetta(cond: () => boolean, ms = STEP_TIMEOUT_MS): Promise<boolean> {
  const inizio = Date.now();
  while (!cond()) {
    if (Date.now() - inizio > ms) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
  return true;
}

function chiedi(cosa: string): void {
  process.stderr.write(`\n▶ ${cosa}\n`);
}

// ---------------------------------------------------------------------------

process.stderr.write(`corsia reale Telegram · ${MODEL}\nscratch: ${ROOT}\n\n`);
writeFileSync(WIRE, '');
writeFileSync(join(WORKSPACE, 'spesa.txt'), 'pane 2.10\nlatte 1.35\nmele 5.00\n');

const { server: proxy, url: proxyUrl } = await avviaProxy();
let gateway: ReturnType<typeof spawn> | null = null;

try {
  const init = await muffin(['init', '--provider', 'openai-compat', '--base-url', BASE_URL, '--model', MODEL], apiKey);
  if (init.code !== 0) throw new Error(`muffin init: ${init.err.slice(-300)}`);
  const tok = await muffin(['secret', 'set', 'telegram_token'], token);
  if (tok.code !== 0) throw new Error(`secret set: ${senzaToken(tok.err.slice(-300))}`);
  const enable = await muffin(['surface', 'enable', 'telegram', '--api-base', proxyUrl, '--owner', String(ownerId)]);
  if (enable.code !== 0) throw new Error(`surface enable: ${senzaToken(enable.err.slice(-300))}`);

  gateway = spawn('npx', ['tsx', CLI, 'gateway', 'run'], {
    env: { ...process.env, MUFFIN_HOME: HOME, NO_COLOR: '1' },
    cwd: WORKSPACE,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let gwLog = '';
  gateway.stderr?.setEncoding('utf8');
  gateway.stderr?.on('data', (c: string) => (gwLog += senzaToken(c)));
  gateway.stdout?.setEncoding('utf8');
  gateway.stdout?.on('data', (c: string) => (gwLog += senzaToken(c)));
  if (!(await aspetta(() => /telegram: connesso/.test(gwLog), 30_000))) {
    throw new Error(`il gateway non si è connesso a Telegram:\n${gwLog.slice(-600)}`);
  }
  process.stderr.write('gateway connesso al bot di prova, attraverso il proxy.\n');

  // ---- 1. la trascrizione: parole, passi, e niente cancellato ---------------
  {
    const da = contatore;
    chiedi('Manda al bot: «leggi spesa.txt e dimmi quanto ho speso in tutto, poi esegui `echo ciao` e riporta cosa risponde». Quando chiede di approvare il comando, premi Consenti.');
    const arrivato = await aspetta(() => messaggiOwner(da).length >= 1);
    if (!arrivato) esito('trascrizione · messaggio ricevuto', false, 'nessun messaggio dell\'owner sul filo');
    else {
      const finito = await aspetta(() => {
        const t = dopo(da).filter((c) => c.method === 'sendMessage' && c.payload['reply_markup'] === undefined);
        // La risposta finale: un sendMessage senza tastiera che non è una riga di trascrizione.
        return t.some((c) => !/[✓✗⏳⏸]/.test(testo(c)) && /ciao/i.test(testo(c)));
      });
      const c = dopo(da);
      const trascrizioni = c.filter((x) => (x.method === 'sendMessage' || x.method === 'editMessageText') && /✓ leggo un file/.test(testo(x)));
      esito('trascrizione · i passi restano in un messaggio vero', trascrizioni.length > 0, `${String(trascrizioni.length)} scritture con «✓ leggo un file»`);
      esito('trascrizione · niente cancellato', !c.some((x) => x.method === 'deleteMessage'), `${String(c.filter((x) => x.method === 'deleteMessage').length)} deleteMessage`);

      /**
       * B11 in privato, dopo la decisione dell'owner del 06/09/2026:
       * `Surface.negotiate('direct')` dichiara `['draft','edit','off']` con
       * `draftTtlMs` 30 s, quindi il filo deve contenere `sendMessageDraft`,
       * con lo **stesso** `draft_id` per tutto il turno, e senza mai un buco
       * piu' lungo della finestra dichiarata.
       *
       * Perche' qui e non solo nell'unita': l'unita' misura il timer con un
       * orologio finto, e un timer perfetto che nessuno arma non si vede.
       * Solo il filo di un bot vero dice che la Bot API ha davvero ricevuto
       * un rinnovo, e che l'ha ricevuto in tempo. Il rosso che questo passo
       * esiste per catturare e' esattamente il difetto della PR #388 letto al
       * contrario: una bolla mostrata una volta e mai piu' rinnovata.
       */
      const bozze = c.filter((x) => x.method === 'sendMessageDraft');
      const idBozza = new Set(bozze.map((x) => String(x.payload['draft_id'] ?? '')));
      esito(
        'B11 privato · l\'anteprima esiste e ha un solo draft_id per turno',
        bozze.length > 0 && idBozza.size === 1 && !idBozza.has('') && !idBozza.has('0'),
        `${String(bozze.length)} sendMessageDraft, draft_id: ${[...idBozza].join(', ') || 'nessuno'}`,
      );
      const tempi = bozze.map((x) => Date.parse(x.at));
      const buco = tempi.slice(1).reduce((m, t, i) => Math.max(m, t - tempi[i]!), 0);
      esito(
        'B11 privato · rinnovata dentro la finestra dichiarata (30 s)',
        bozze.length > 1 && buco < 30_000,
        bozze.length > 1 ? `buco massimo fra due rinnovi: ${String(buco)}ms` : 'una sola anteprima: nessun rinnovo osservato',
      );

      /**
       * Lo **stato finale** del messaggio della trascrizione, non l'esistenza
       * di una scrittura qualsiasi.
       *
       * I due controlli sopra, da soli, non chiudono B13. «Almeno una scrittura
       * conteneva un passo» resta vero anche se l'ultima `editMessageText` su
       * quel messaggio sostituisce l'elenco dei passi con la sola risposta: e
       * cancellare i passi con una edit invece che con un `deleteMessage` e'
       * esattamente cio' di cui l'owner si e' lamentato il 03/09 — «non voglio
       * perdere gli step che ha fatto». Un banco che guarda solo le scritture
       * intermedie non puo' vedere la differenza fra «i passi restano» e «i
       * passi sono stati sovrascritti», che e' la domanda.
       *
       * Quindi: si prende il `message_id` del messaggio di trascrizione, si
       * guarda l'ULTIMA scrittura che lo tocca, e si pretende che i passi
       * siano ancora li'.
       */
      const nato = c.find((x) => x.method === 'sendMessage' && /✓ leggo un file/.test(testo(x)));
      const idTrascrizione = nato?.messageId;
      let ultima: (typeof c)[number] | undefined;
      if (nato === undefined || idTrascrizione === undefined) {
        esito(
          'trascrizione · i passi ci sono ancora alla fine',
          false,
          'nessun messaggio di trascrizione con un message_id: non posso guardarne lo stato finale',
        );
      } else {
        const suQuelMessaggio = c.filter(
          (x) => x.method === 'editMessageText' && x.payload['message_id'] === idTrascrizione,
        );
        ultima = suQuelMessaggio.at(-1) ?? nato;
        esito(
          'trascrizione · i passi ci sono ancora alla fine, non solo durante',
          /✓ leggo un file/.test(testo(ultima)),
          `${String(suQuelMessaggio.length)} edit sul messaggio #${String(idTrascrizione)}; ultima: ${testo(ultima).slice(0, 120).replace(/\n/g, ' ⏎ ')}`,
        );
      }
      const troppo = inviati().filter((x) => testo(x).length > TELEGRAM_MAX);
      esito('niente tagliato · ogni messaggio entro il limite', troppo.length === 0, `${String(troppo.length)} oltre ${String(TELEGRAM_MAX)} caratteri`);
      const ask = c.find((x) => x.method === 'sendMessage' && x.payload['reply_markup'] !== undefined);
      esito(
        'ASK · comando intero e frase del modello',
        ask !== undefined && /command: echo ciao/.test(testo(ask)) && /<i>.+<\/i>/.test(testo(ask)),
        ask === undefined ? 'nessun ASK con tastiera' : testo(ask).slice(0, 200).replace(/\n/g, ' ⏎ '),
      );
      /**
       * La risposta arriva **nello stesso messaggio** dei passi, non a parte.
       *
       * Fino al 04/09 questo caso pretendeva un `sendMessage` separato dopo
       * l'ultima edit — ed era giusto per il disegno di allora. #388 l'ha
       * cambiato di proposito, per chiudere la lamentela dell'owner «mi sta
       * rispondendo due volte»: c'erano due bolle per turno, la scia dei tool
       * e la consegna durevole, e ora la risposta finale **edita** il
       * messaggio che la scia gia' possiede.
       *
       * Quindi la promessa non e' piu' «due messaggi in ordine» ma «un
       * messaggio solo che alla fine contiene entrambe le cose» — ed e'
       * quella che si misura qui. Il caso e' rimasto rosso una corsa intera
       * su un prodotto corretto: un banco che porta avanti la specifica di
       * ieri accusa il codice di oggi.
       */
      const rispostaNelloStesso = /Totale spesa/i.test(testo(ultima ?? nato ?? { payload: {} } as never));
      esito(
        'risposta · nello stesso messaggio dei passi, dopo di essi (#388)',
        finito && rispostaNelloStesso,
        rispostaNelloStesso ? 'passi e risposta nello stesso messaggio' : 'la risposta non e\' finita nel messaggio della trascrizione',
      );
    }
  }

  // ---- 2. la coda: un secondo messaggio mentre il primo gira ---------------
  {
    const da = contatore;
    chiedi('Manda due messaggi di fila, entro pochi secondi: «raccontami una storia di venti righe» e poi «ciao, ci sei?».');
    const due = await aspetta(() => messaggiOwner(da).length >= 2);
    if (!due) esito('coda · due messaggi ricevuti', false, `${String(messaggiOwner(da).length)} messaggi dell'owner sul filo`);
    else {
      const [primo, secondo] = messaggiOwner(da);
      const conferma = await aspetta(() => dopo(da).some((c) => c.method === 'sendMessage' && /in coda/.test(testo(c))), 60_000);
      const ack = dopo(da).find((c) => c.method === 'sendMessage' && /in coda/.test(testo(c)));
      const rispostaAlPrimo = dopo(da).find((c) => c.method === 'sendMessage' && c.payload['reply_markup'] === undefined && !/in coda|[✓✗⏳⏸]/.test(testo(c)) && testo(c).length > 80);
      esito(
        'coda · confermata subito, prima della prima risposta',
        conferma && ack !== undefined && rispondeA(ack) === secondo!.messageId && (rispostaAlPrimo === undefined || ack.n < rispostaAlPrimo.n),
        ack === undefined ? 'nessuna conferma «in coda» (il secondo messaggio è arrivato a turno finito?)' : `ack #${String(ack.n)} in risposta a ${String(secondo!.messageId)}; prima risposta ${rispostaAlPrimo === undefined ? 'non ancora' : `#${String(rispostaAlPrimo.n)}`}`,
      );
      const entrambe = await aspetta(() => dopo(da).filter((c) => c.method === 'sendMessage' && c.payload['reply_markup'] === undefined && !/in coda|[✓✗⏳⏸]/.test(testo(c))).length >= 2);
      esito('coda · entrambi risposti, nell\'ordine', entrambe, entrambe ? `messaggi ${String(primo!.messageId)} e ${String(secondo!.messageId)} risposti` : 'la seconda risposta non è arrivata');
    }
  }

  // ---- 3. /stop a metà turno ------------------------------------------------
  {
    const da = contatore;
    chiedi('Manda «scrivi un poema di quaranta righe» e subito dopo «/stop».');
    const arrivati = await aspetta(() => messaggiOwner(da).some((m) => m.text === '/stop'));
    if (!arrivati) esito('/stop · ricevuto', false, 'nessun /stop sul filo');
    else {
      const interrotto = await aspetta(() => dopo(da).some((c) => c.method === 'sendMessage' && testo(c) === 'Interrotto.'), 60_000);
      const fermato = dopo(da).some((c) => c.method === 'sendMessage' && /fermato/.test(testo(c)));
      esito('/stop · «fermato» e poi «Interrotto.»', interrotto && fermato, `fermato=${String(fermato)} interrotto=${String(interrotto)}`);
    }
  }
} catch (error) {
  esito('setup', false, senzaToken(error instanceof Error ? error.message : String(error)));
} finally {
  if (gateway !== null) {
    gateway.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 2_000));
    gateway.kill('SIGKILL');
  }
  proxy.close();
}

const rossi = passi.filter((p) => !p.ok);
process.stderr.write(`\n${String(passi.length - rossi.length)}/${String(passi.length)} verdi · filo: ${WIRE}\n`);
if (values.keep !== true && rossi.length === 0) rmSync(ROOT, { recursive: true, force: true });
else process.stderr.write(`scratch tenuto: ${ROOT}\n`);
process.exit(rossi.length === 0 ? 0 : 1);
