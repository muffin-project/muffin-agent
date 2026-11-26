import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { negoziazioneTelegram } from '../../connectors/telegram/negoziazione.js';
import { TELEGRAM_MAX } from '../../connectors/telegram/render.js';
import { normalizeInboundRich, richPlain } from '../../connectors/telegram/rich.js';
import { loadConfig, muffinHome, paths, readSecret } from '../../core/config/config.js';
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
 * Credenziali dall'ambiente o dall'installazione locale (vedi README.md):
 *
 *   LLM_API_KEY (o OPENROUTER_API_KEY)   la chiave del modello
 *   MUFFIN_E2E_TELEGRAM_TOKEN            il token di un bot **di prova**
 *                                        (BotFather; non quello installato,
 *                                        che sta già facendo getUpdates)
 *   MUFFIN_E2E_OWNER_ID                  la tua user id Telegram
 *
 *   npx tsx evals/e2e/telegram.ts
 *   npx tsx evals/e2e/telegram.ts --group --keep
 *
 * Il passo umano è dichiarato: lo script dice cosa mandare al bot, aspetta
 * che il filo mostri il risultato, e dice ✓ o ✗ con il perché. Per l'ASK
 * legge anche lo stato durevole nella Home di prova; la decisione resta umana.
 */

const { values } = parseArgs({
  options: {
    model: { type: 'string' },
    'base-url': { type: 'string' },
    keep: { type: 'boolean' },
    group: { type: 'boolean' },
    home: { type: 'string' },
    'step-timeout-s': { type: 'string' },
  },
});

const installato = ((): Installazione => {
  const assente = {
    apiKey: '',
    ownerId: 0,
    tokenDedicato: '',
    tokenInstallato: '',
    gatewayVivo: false,
  };
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
const ROOT =
  values.home === undefined ? mkdtempSync(join(tmpdir(), 'muffin-e2e-')) : resolve(values.home);
const HOME = join(ROOT, 'home');
const WORKSPACE = join(ROOT, 'workspace');
const WIRE = join(ROOT, 'wire.jsonl');
const CLI = join(import.meta.dirname, '..', '..', 'cli', 'main.ts');
const nodeArgs = ['--import', import.meta.resolve('tsx'), CLI];
if (values.home !== undefined) mkdirSync(ROOT); // Refuse to reuse state or erase an existing root.
mkdirSync(HOME);
mkdirSync(WORKSPACE);
const runEnv = { ...process.env, MUFFIN_HOME: HOME, MUFFIN_WORKSPACE: WORKSPACE, NO_COLOR: '1' };

// ---------------------------------------------------------------------------
// Il filo: ogni chiamata del gateway alla Bot API, e ogni update ricevuto.
// ---------------------------------------------------------------------------

type WireUpdate = {
  updateId: number;
  chatId?: number;
  threadId?: number;
  messageId?: number;
  fromId?: number;
  text?: string;
  callback?: string;
  callbackId?: string;
  stoppedDraftId?: number;
};

type Chiamata = {
  n: number;
  at: string;
  method: string;
  payload: Record<string, unknown>;
  status: number;
  /** `message_id` di un messaggio creato, quando c'è. */
  messageId?: number;
  /** Per `getUpdates`: gli update tornati, ridotti a ciò che serve. */
  updates?: WireUpdate[];
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
        bodyText = JSON.stringify({
          ok: false,
          description: senzaToken(error instanceof Error ? error.message : String(error)),
        });
      }
      const entry: Chiamata = {
        n: ++contatore,
        at: new Date().toISOString(),
        method,
        payload,
        status,
      };
      try {
        const parsed = JSON.parse(bodyText) as { ok?: boolean; result?: unknown };
        if (method === 'getUpdates' && Array.isArray(parsed.result)) {
          entry.updates = (parsed.result as Array<Record<string, unknown>>).map((u) => {
            const m = (u['message'] ?? {}) as Record<string, unknown>;
            const cq = (u['callback_query'] ?? {}) as Record<string, unknown>;
            const stop = (u['stopped_message_generation'] ?? {}) as Record<string, unknown>;
            const message = (cq['message'] ?? m) as Record<string, unknown>;
            const chat = (stop['chat'] ?? message['chat'] ?? {}) as Record<string, unknown>;
            const from = (m['from'] ?? cq['from'] ?? {}) as Record<string, unknown>;
            return {
              updateId: Number(u['update_id']),
              ...(typeof chat['id'] === 'number' ? { chatId: chat['id'] } : {}),
              ...(message['is_topic_message'] === true &&
              typeof message['message_thread_id'] === 'number'
                ? { threadId: message['message_thread_id'] }
                : {}),
              ...(typeof message['message_id'] === 'number'
                ? { messageId: message['message_id'] }
                : {}),
              ...(typeof from['id'] === 'number' ? { fromId: from['id'] } : {}),
              ...(typeof m['text'] === 'string' ? { text: m['text'] } : {}),
              ...(typeof cq['data'] === 'string' ? { callback: cq['data'] } : {}),
              ...(typeof cq['id'] === 'string' ? { callbackId: cq['id'] } : {}),
              ...(typeof stop['draft_id'] === 'number' ? { stoppedDraftId: stop['draft_id'] } : {}),
            };
          });
        } else if (
          parsed.result &&
          typeof parsed.result === 'object' &&
          'message_id' in (parsed.result as object)
        ) {
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
function muffin(
  args: string[],
  stdin?: string,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...nodeArgs, ...args], {
      env: runEnv,
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

const accepted = (c: Chiamata): boolean => c.status >= 200 && c.status < 300;
const isDraft = (c: Chiamata): boolean =>
  c.method === 'sendMessageDraft' || c.method === 'sendRichMessageDraft';
const isTextSend = (c: Chiamata): boolean =>
  c.method === 'sendMessage' || c.method === 'sendRichMessage';
const isTextEdit = (c: Chiamata): boolean => c.method === 'editMessageText'; // rich and legacy share the wire method
const isChatMessage = (c: Chiamata): boolean =>
  isTextSend(c) || isTextEdit(c) || c.method === 'sendDocument' || c.method === 'deleteMessage';
const messageIdOf = (c: Chiamata): unknown => c.payload['message_id'] ?? c.messageId;
const after = (n: number): Chiamata[] => filo.filter((c) => c.n > n);
const callsIn = (n: number, chatId: number): Chiamata[] =>
  after(n).filter((c) => c.payload['chat_id'] === chatId);
const updatesAfter = (n: number): (WireUpdate & { n: number })[] =>
  after(n).flatMap((c) => (c.updates ?? []).map((u) => ({ ...u, n: c.n })));
const buttons = (c: Chiamata): { text?: string; callback_data?: string }[] =>
  (
    c.payload['reply_markup'] as
      | { inline_keyboard?: { text?: string; callback_data?: string }[][] }
      | undefined
  )?.inline_keyboard?.flat() ?? [];

function visibleText(c: Chiamata): string {
  const rich = c.payload['rich_message'] as
    | { html?: string; markdown?: string; blocks?: { type: string; text?: unknown }[] }
    | undefined;
  // The inbound normalizer intentionally hides the contents of draft-only thinking blocks.
  const rendered = normalizeInboundRich({ rich_message: rich });
  if (rendered !== null) {
    const thinking =
      rich?.blocks?.filter((b) => b.type === 'thinking').map((b) => richPlain(b.text, 0)) ?? [];
    return [rendered, ...thinking].join('\n').trim();
  }
  return (
    rich?.markdown ??
    String(rich?.html ?? c.payload['text'] ?? '')
      .replace(/<[^>]*>/g, '')
      .replace(
        /&(?:amp|lt|gt|quot|#39);/g,
        (entity) =>
          ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[entity] ??
          entity,
      )
  );
}

const processLog =
  /\b(?:Processo|leggo un file|eseguo un comando|cerco in memoria|fs_read|shell_run_write)\b/i;
const statusText =
  /\b(?:sto preparando il contesto|preparo il contesto|aspetto il modello|sto pensando|sto lavorando|sto (?:ricevendo|scrivendo) la risposta)\b/i;

function checkNoProcess(scene: string, calls: Chiamata[]): void {
  const leaks = calls.filter(
    (c) => (isDraft(c) || isChatMessage(c)) && processLog.test(visibleText(c)),
  );
  esito(
    `${scene} · nessun registro dei passi`,
    leaks.length === 0,
    leaks.map((c) => `${c.method} #${c.n}`).join(', ') || 'solo testo utile',
  );
}

function checkSingleFinal(scene: string, calls: Chiamata[], final: Chiamata): void {
  const writes = calls.filter((c) => accepted(c) && isChatMessage(c));
  esito(
    `${scene} · un solo messaggio definitivo`,
    writes.length === 1 &&
      writes[0] === final &&
      final.messageId !== undefined &&
      buttons(final).length === 0,
    writes.map((c) => `${c.method} #${c.n}`).join(', ') || 'nessun messaggio',
  );
  checkNoProcess(scene, calls);
}

function approvalState(id: string) {
  const db = new Database(paths(HOME).db, { readonly: true });
  try {
    return db
      .prepare(`SELECT a.prompt, a.resource, a.capability, a.decision, a.decided_by, a.consumed_at, t.status, t.wait_for
                       FROM approvals a JOIN turns t ON t.id = a.turn_id WHERE a.id = ?`)
      .get(id) as
      | {
          prompt: string;
          resource: string | null;
          capability: string;
          decision: string | null;
          decided_by: string | null;
          consumed_at: string | null;
          status: string;
          wait_for: string | null;
        }
      | undefined;
  } finally {
    db.close();
  }
}

async function aspetta(cond: () => boolean, ms = STEP_TIMEOUT_MS): Promise<boolean> {
  const inizio = Date.now();
  while (!cond()) {
    if (Date.now() - inizio > ms) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
  return true;
}

async function expectOnWire<T>(
  label: string,
  find: () => T | undefined,
  ms = STEP_TIMEOUT_MS,
): Promise<T> {
  let found: T | undefined;
  await aspetta(() => {
    found = find();
    return found !== undefined;
  }, ms);
  if (found === undefined) throw new Error(label);
  return found;
}

function ownerMessage(n: number, matches: (text: string) => boolean, group = false) {
  return expectOnWire('messaggio atteso dell’owner non ricevuto', () => {
    for (const u of updatesAfter(n)) {
      const { chatId, messageId, text } = u;
      if (
        u.fromId === ownerId &&
        chatId !== undefined &&
        (group ? chatId < 0 : chatId === ownerId) &&
        messageId !== undefined &&
        text !== undefined &&
        matches(text)
      )
        return { ...u, chatId, messageId };
    }
  });
}

function chiedi(cosa: string): void {
  process.stderr.write(`\n▶ ${cosa}\n`);
}

// ---------------------------------------------------------------------------

process.stderr.write(`corsia reale Telegram · ${MODEL}\nscratch: ${ROOT}\n\n`);
writeFileSync(WIRE, '');
writeFileSync(join(WORKSPACE, 'spesa.txt'), 'pane 2.10\nlatte 1.35\nmele 5.00\n');
writeFileSync(join(WORKSPACE, 'spesa-extra.txt'), 'riso 4.27\n');

const { server: proxy, url: proxyUrl } = await avviaProxy();
let gateway: ReturnType<typeof spawn> | null = null;
let scene = 'setup';

try {
  const init = await muffin(
    ['init', '--provider', 'openai-compat', '--base-url', BASE_URL, '--model', MODEL],
    apiKey,
  );
  if (init.code !== 0) throw new Error(`muffin init: ${init.err.slice(-300)}`);
  const tok = await muffin(['secret', 'set', 'telegram_token'], token);
  if (tok.code !== 0) throw new Error(`secret set: ${senzaToken(tok.err.slice(-300))}`);
  const enable = await muffin([
    'surface',
    'enable',
    'telegram',
    '--api-base',
    proxyUrl,
    '--owner',
    String(ownerId),
  ]);
  if (enable.code !== 0) throw new Error(`surface enable: ${senzaToken(enable.err.slice(-300))}`);

  // Spawn the gateway directly so cleanup signals reach the only poller.
  gateway = spawn(process.execPath, [...nodeArgs, 'gateway', 'run'], {
    env: runEnv,
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

  {
    scene = 'DM · risultato (B11/B13)';
    const start = contatore;
    const prompt =
      'Quanto ho speso in totale? Somma le voci di spesa.txt e spesa-extra.txt. Dammi solo il totale in euro.';
    chiedi(`In privato manda: «${prompt}»`);
    const incoming = await ownerMessage(start, (text) => text === prompt);
    const calls = () => callsIn(incoming.n, ownerId);
    const total = /\b12[,.]72\b/;
    const final = await expectOnWire('manca il risultato con il totale 12,72', () =>
      calls().find(
        (c) => accepted(c) && (isTextSend(c) || isTextEdit(c)) && total.test(visibleText(c)),
      ),
    );
    // Leave a short window for an extra bubble or a stale draft refresh to surface.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    checkSingleFinal(scene, calls(), final);
    esito(
      `${scene} · risultato in risposta alla richiesta`,
      isTextSend(final) &&
        rispondeA(final) === incoming.messageId &&
        !statusText.test(visibleText(final)),
      `risultato: ${visibleText(final).slice(0, 100)}`,
    );
    const drafts = calls().filter((c) => accepted(c) && isDraft(c));
    const before = drafts.filter((c) => c.n < final.n);
    const id = before[0]?.payload['draft_id'];
    esito(
      `${scene} · anteprima utile con Stop nativo`,
      typeof id === 'number' &&
        id !== 0 &&
        before.some((c) => statusText.test(visibleText(c)) || total.test(visibleText(c))) &&
        before.every(
          (c) =>
            c.payload['draft_id'] === id &&
            c.payload['can_stop'] === true &&
            c.payload['keep_on_stop'] !== true,
        ) &&
        before.length === drafts.length,
      `${before.length} bozze prima del risultato, ${drafts.length - before.length} dopo; draft_id=${String(id)}`,
    );
    const exposedPaths = calls().filter(
      (c) => (isDraft(c) || isChatMessage(c)) && /\bspesa(?:-extra)?\.txt\b/.test(visibleText(c)),
    );
    esito(
      `${scene} · nessun argomento degli strumenti esposto`,
      exposedPaths.length === 0,
      `${exposedPaths.length} scritture mostrano i nomi dei file anziché soltanto stato o risultato`,
    );
    // A short turn need not refresh. A long one cannot leave a TTL-sized gap,
    // including the stretch from the last preview to the durable reply.
    const times = [...before, final].map((c) => Date.parse(c.at));
    const gap = times.slice(1).reduce((max, at, i) => Math.max(max, at - (times[i] ?? at)), 0);
    esito(
      `${scene} · nessun buco nella bozza prima della consegna`,
      before.length > 0 && gap < negoziazioneTelegram('direct').draftTtlMs,
      `${gap} ms di intervallo massimo; ${Math.max(0, before.length - 1)} aggiornamenti`,
    );
  }

  {
    scene = 'DM · approvazione (D12)';
    const start = contatore;
    // A read-only command would not ASK (ADR-0074). This writes only to scratch.
    const command = 'echo ciao > saluto.txt';
    const description = 'scrive ciao in un file di prova';
    const effect = join(WORKSPACE, 'saluto.txt');
    const prompt = `Esegui esattamente il comando ${command} dalla directory corrente, con descrizione «${description}». Se riesce, rispondi «File di prova creato».`;
    chiedi(`In privato manda: «${prompt}» e aspetta le istruzioni prima di premere un pulsante.`);
    await ownerMessage(start, (text) => text === prompt);
    const calls = () => callsIn(start, ownerId);
    const ask = await expectOnWire('nessuna domanda con tastiera', () =>
      calls().find((c) => accepted(c) && isTextSend(c) && buttons(c).length > 0),
    );
    const allow = buttons(ask).find((b) => b.text === 'Consenti "sys.shell.write"')?.callback_data;
    const approvalId = allow?.match(/^ok:([0-9a-f]+)$/)?.[1];
    if (
      approvalId === undefined ||
      ask.messageId === undefined ||
      !buttons(ask).some((b) => b.text === 'Rifiuta' && b.callback_data === `no:${approvalId}`)
    ) {
      throw new Error('la domanda non ha i due pulsanti per la stessa approvazione shell');
    }
    const waiting = await expectOnWire('il turno non si è sospeso sulla domanda registrata', () => {
      const state = approvalState(approvalId);
      return state?.status === 'waiting' && state.wait_for === `approval:${approvalId}`
        ? state
        : undefined;
    });
    const question = visibleText(ask).replace(/\s+/g, ' ');
    if (
      waiting.capability !== 'sys.shell.write' ||
      waiting.resource === null ||
      !waiting.resource.split(' · ').includes(`command: ${command}`) ||
      !question.includes(waiting.resource.replace(/\s+/g, ' ')) ||
      !question.includes(waiting.prompt.replace(/\s+/g, ' ')) ||
      !question.toLowerCase().includes(description) ||
      waiting.decision !== null ||
      waiting.consumed_at !== null ||
      existsSync(effect)
    ) {
      throw new Error(
        'domanda incompleta, azione diversa da quella attesa o effetto già eseguito; non approvare',
      );
    }
    esito(
      `${scene} · domanda integrale e turno in attesa`,
      true,
      `comando: ${command}; tastiera sul messaggio #${ask.messageId}`,
    );
    chiedi(
      `Controlla la domanda sul telefono e premi Consenti solo per «${command}». Non inviare un altro messaggio.`,
    );
    const click = await expectOnWire('non è arrivato il click dell’owner su quella domanda', () =>
      updatesAfter(ask.n).find(
        (u) =>
          u.fromId === ownerId &&
          u.chatId === ownerId &&
          u.messageId === ask.messageId &&
          u.callback === allow &&
          u.callbackId !== undefined,
      ),
    );
    const ack = await expectOnWire('nessuna conferma del click', () =>
      after(click.n).find(
        (c) =>
          accepted(c) &&
          c.method === 'answerCallbackQuery' &&
          c.payload['callback_query_id'] === click.callbackId &&
          visibleText(c) === 'Consentito.',
      ),
    );
    const final = await expectOnWire('manca il risultato del turno ripreso', () =>
      calls().find(
        (c) =>
          c.n > ack.n &&
          accepted(c) &&
          (isTextSend(c) || isTextEdit(c)) &&
          /\bfile di prova creato\b/i.test(visibleText(c)),
      ),
    );
    const keyboardCleared = () => {
      const lastMarkup = calls()
        .filter(
          (c) =>
            c.n > click.n &&
            accepted(c) &&
            messageIdOf(c) === ask.messageId &&
            (c.method === 'editMessageReplyMarkup' || isTextEdit(c)) &&
            c.payload['reply_markup'] !== undefined,
        )
        .at(-1);
      return lastMarkup !== undefined && buttons(lastMarkup).length === 0;
    };
    const cleared = await aspetta(keyboardCleared, 5_000);
    const resumed = approvalState(approvalId);
    esito(
      `${scene} · decisione manuale consumata e scrittura eseguita`,
      resumed?.decision === 'allow' &&
        resumed.decided_by === 'owner' &&
        resumed.consumed_at !== null &&
        resumed.status === 'done' &&
        existsSync(effect) &&
        readFileSync(effect, 'utf8') === 'ciao\n',
      `decisione=${resumed?.decision ?? 'assente'}; stato=${resumed?.status ?? 'assente'}`,
    );
    const lastEdit = calls()
      .filter((c) => accepted(c) && isTextEdit(c) && messageIdOf(c) === ask.messageId)
      .at(-1);
    const messages = calls().filter(
      (c) =>
        accepted(c) &&
        (isTextSend(c) || c.method === 'sendDocument' || c.method === 'deleteMessage'),
    );
    esito(
      `${scene} · tastiera rimossa e risultato sulla stessa bolla`,
      cleared &&
        messages.length === 1 &&
        messages[0] === ask &&
        messageIdOf(final) === ask.messageId &&
        lastEdit !== undefined &&
        /\bfile di prova creato\b/i.test(visibleText(lastEdit)) &&
        !/aspetto la tua approvazione/i.test(visibleText(lastEdit)) &&
        buttons(lastEdit).length === 0,
      `tastiera rimossa=${cleared}; ${messages.length} invii/cancellazioni durevoli`,
    );
    checkNoProcess(scene, calls());
  }

  {
    scene = 'DM · coda (B2)';
    const start = contatore;
    const story = 'Raccontami una storia di trenta righe su una mongolfiera.';
    const ping = 'Ci sei? Rispondi solo con «eccomi».';
    chiedi(`In privato manda «${story}» e, appena compare la bozza, manda «${ping}».`);
    const first = await ownerMessage(start, (text) => text === story);
    const second = await ownerMessage(start, (text) => text === ping);
    const replies = () => callsIn(first.n, ownerId).filter((c) => accepted(c) && isTextSend(c));
    const ack = await expectOnWire(
      'nessuna conferma «in coda» al secondo messaggio (era ancora in corso il primo?)',
      () =>
        replies().find(
          (c) => rispondeA(c) === second.messageId && /^(?:📥\s*)?in coda\b/i.test(visibleText(c)),
        ),
      60_000,
    );
    const firstAnswer = await expectOnWire('manca la risposta al primo messaggio', () =>
      replies().find(
        (c) =>
          rispondeA(c) === first.messageId &&
          /mongolfier/i.test(visibleText(c)) &&
          visibleText(c).length > 80,
      ),
    );
    const secondAnswer = await expectOnWire('manca la risposta al secondo messaggio', () =>
      replies().find(
        (c) => rispondeA(c) === second.messageId && /^eccomi[.!]?$/i.test(visibleText(c).trim()),
      ),
    );
    esito(
      `${scene} · conferma e consegne in ordine`,
      ack.n < firstAnswer.n && firstAnswer.n < secondAnswer.n,
      `conferma #${ack.n}; risposte #${firstAnswer.n} e #${secondAnswer.n}`,
    );
  }

  for (const native of [true, false]) {
    scene = native ? 'DM · Stop nativo (B2)' : 'DM · /stop (B2)';
    const start = contatore;
    const prompt = native
      ? 'Scrivi un poema di sessanta righe sul mare.'
      : 'Scrivi un poema di sessanta righe sulla montagna.';
    chiedi(
      `In privato manda «${prompt}» e, appena compare la bozza, ${native ? 'premi il suo pulsante Stop' : 'manda «/stop»'}.`,
    );
    const incoming = await ownerMessage(start, (text) => text === prompt);
    const calls = () => callsIn(incoming.n, ownerId);
    const replies = () => calls().filter((c) => accepted(c) && isTextSend(c));
    const stop = native
      ? await expectOnWire('nessun update Stop nativo per quella bozza', () =>
          updatesAfter(incoming.n).find(
            (u) =>
              u.chatId === ownerId &&
              u.stoppedDraftId !== undefined &&
              calls().some(
                (c) =>
                  c.n < u.n &&
                  accepted(c) &&
                  isDraft(c) &&
                  c.payload['can_stop'] === true &&
                  c.payload['draft_id'] === u.stoppedDraftId,
              ),
          ),
        )
      : await ownerMessage(incoming.n, (text) => text === '/stop');
    const interrupted = await expectOnWire(
      'manca «Interrotto.» in risposta alla richiesta originale',
      () =>
        replies().find(
          (c) =>
            c.n > stop.n && rispondeA(c) === incoming.messageId && visibleText(c) === 'Interrotto.',
        ),
      60_000,
    );
    if (native) checkSingleFinal(scene, calls(), interrupted);
    else {
      const ack = await expectOnWire(
        'manca «fermato» in risposta a /stop',
        () =>
          replies().find(
            (c) =>
              c.n > stop.n && rispondeA(c) === stop.messageId && /^fermato\b/i.test(visibleText(c)),
          ),
        60_000,
      );
      esito(
        `${scene} · comando confermato e turno interrotto`,
        true,
        `conferma #${ack.n}; interruzione #${interrupted.n}`,
      );
    }
  }

  if (values.group === true) {
    scene = 'gruppo · typing e risultato';
    const start = contatore;
    const username = /telegram abilitata: @([A-Za-z][A-Za-z0-9_]*)/.exec(enable.out)?.[1];
    if (username === undefined) throw new Error('username del bot di prova non trovato');
    const prompt = `@${username} Racconta una storia di venti righe su un tasso e chiudila con «Fine della storia».`;
    chiedi(`In un gruppo di prova o in un suo topic, manda: «${prompt}»`);
    const incoming = await ownerMessage(start, (text) => text === prompt, true);
    const calls = () => callsIn(incoming.n, incoming.chatId);
    const final = await expectOnWire('nessun risultato in risposta al messaggio nel gruppo', () =>
      calls().find(
        (c) =>
          accepted(c) &&
          isTextSend(c) &&
          rispondeA(c) === incoming.messageId &&
          c.payload['message_thread_id'] === incoming.threadId &&
          /fine della storia/i.test(visibleText(c)) &&
          visibleText(c).length > 80,
      ),
    );
    const typing = calls().some(
      (c) =>
        c.n < final.n &&
        accepted(c) &&
        c.method === 'sendChatAction' &&
        c.payload['action'] === 'typing' &&
        c.payload['message_thread_id'] === incoming.threadId,
    );
    esito(
      `${scene} · typing nel posto giusto, nessuna bozza`,
      typing && !calls().some(isDraft),
      `typing prima della risposta=${typing}`,
    );
    checkSingleFinal(scene, calls(), final);
  }
} catch (error) {
  esito(scene, false, senzaToken(error instanceof Error ? error.message : String(error)));
} finally {
  if (gateway !== null) {
    gateway.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 2_000));
    gateway.kill('SIGKILL');
  }
  proxy.close();
}

const overLimit = filo.filter(
  (c) => typeof c.payload['text'] === 'string' && c.payload['text'].length > TELEGRAM_MAX,
);
esito(
  'testo legacy · entro il limite',
  overLimit.length === 0,
  `${overLimit.length} scritture oltre ${TELEGRAM_MAX} caratteri`,
);
const rossi = passi.filter((p) => !p.ok);
process.stderr.write(
  `\n${String(passi.length - rossi.length)}/${String(passi.length)} verdi · filo: ${WIRE}\n`,
);
if (values.keep !== true && rossi.length === 0) rmSync(ROOT, { recursive: true, force: true });
else process.stderr.write(`scratch tenuto: ${ROOT}\n`);
process.exit(rossi.length === 0 ? 0 : 1);
