import { type ChildProcess, spawn } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  type Stats,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { ChatGPTConnection } from '../../core/config/chatgpt-oauth.js';
import { loadConfig } from '../../core/config/config.js';
import { type FakeTelegram, startFakeTelegram } from '../acceptance/telegram.js';
import { MEMORY_QUERY, MEMORY_REQUEST, MEMORY_VALUE, memoryWitness } from './telegram-memory.js';

// This runner owns only children it spawned; no shared gateway/process lookup.
function stopOwnedProcess(child: ChildProcess, graceMs = 2_000): () => void {
  if (child.exitCode !== null || child.signalCode !== null) return () => {};
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, graceMs);
  timer.unref();
  return () => clearTimeout(timer);
}

const { values } = parseArgs({
  options: {
    home: { type: 'string' },
    scene: { type: 'string' },
    'step-timeout-s': { type: 'string' },
  },
});
const SCENE = values.scene ?? 'all';
if (!['all', 'memory', 'files'].includes(SCENE))
  throw new Error('Use --scene all, memory or files');
const MESSAGE_BASE = Math.floor(Date.now() / 1000);
const FIRST_MESSAGE_ID = MESSAGE_BASE + 1;
const SECOND_MESSAGE_ID = MESSAGE_BASE + 2;
const FILE_MESSAGE_ID = MESSAGE_BASE + 3;
const rootArg = values.home;
if (!rootArg?.startsWith('/private/tmp/')) {
  throw new Error('BLOCKED: pass an explicit isolated test root under /private/tmp with --home');
}

const ROOT = resolve(rootArg);
const HOME = join(ROOT, 'home', '.muffin');
const WORKSPACE = join(ROOT, 'workspace');
const MARKER = join(HOME, '.e2e-synthetic');
const CLI = join(import.meta.dirname, '..', '..', 'dist', 'cli', 'main.js');
const RESPONSE_COUNT = join(ROOT, 'responses-count.txt');
const FETCH_PRELOAD = join(ROOT, 'count-responses.mjs');
const OWNER_ID = 12345;
const BOT_TOKEN = '123:synthetic';
const STEP_TIMEOUT_MS = Number(values['step-timeout-s'] ?? '180') * 1000;
if (!Number.isFinite(STEP_TIMEOUT_MS) || STEP_TIMEOUT_MS < 1_000 || STEP_TIMEOUT_MS > 180_000)
  throw new Error('BLOCKED: each runtime step deadline must be between 1 and 180 seconds');
const ROOT_CANONICAL = realpathSync(ROOT);
if (!ROOT_CANONICAL.startsWith('/private/tmp/'))
  throw new Error('BLOCKED: canonical test root must remain under /private/tmp');

function requireSyntheticFixture(): { model: string } {
  let markerStat: Stats;
  try {
    markerStat = lstatSync(MARKER);
  } catch {
    throw new Error('BLOCKED: isolated synthetic OAuth marker is missing');
  }
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || (markerStat.mode & 0o077) !== 0)
    throw new Error('BLOCKED: synthetic marker must be a private regular file');
  let marker: unknown;
  try {
    marker = JSON.parse(readFileSync(MARKER, 'utf8'));
  } catch {
    throw new Error('BLOCKED: synthetic marker is malformed');
  }
  if (
    marker === null ||
    typeof marker !== 'object' ||
    (marker as Record<string, unknown>).synthetic !== true ||
    (marker as Record<string, unknown>).ownerId !== OWNER_ID ||
    (marker as Record<string, unknown>).authScope !== 'chatgpt.tokens.use.direct'
  ) {
    throw new Error('BLOCKED: synthetic marker does not authorize this test identity and scope');
  }
  if (!existsSync(CLI)) throw new Error('BLOCKED: compile the real CLI before ChatGPT runtime E2E');
  if (existsSync(join(HOME, 'gateway.sock')))
    throw new Error('BLOCKED: test gateway is already owned');
  if (SCENE !== 'files' && existsSync(join(HOME, 'muffin.db'))) {
    const db = new Database(join(HOME, 'muffin.db'), { readonly: true });
    try {
      for (const table of ['turns', 'episodes', 'facts', 'memory_proposals']) {
        const exists = db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
          .get(table);
        if (
          exists &&
          (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n > 0
        )
          throw new Error('BLOCKED: memory E2E requires an unused synthetic database');
      }
    } finally {
      db.close();
    }
  }

  const config = loadConfig(HOME);
  const model = config.models.main;
  if (
    config.provider.kind !== 'openai-chatgpt' ||
    config.provider.baseUrl !== 'https://api.openai.com/v1' ||
    !model ||
    config.models.light !== model
  ) {
    throw new Error(
      'BLOCKED: isolated home must use openai-chatgpt with the same pinned main/light model',
    );
  }
  const session = new ChatGPTConnection(HOME).session();
  if (!session?.connected || !session.scopes.includes('chatgpt.tokens.use.direct'))
    throw new Error(
      'BLOCKED: isolated home has no connected ChatGPT session with direct inference scope',
    );
  return { model };
}

const { model: MODEL } = requireSyntheticFixture();
writeFileSync(RESPONSE_COUNT, '', { mode: 0o600 });
writeFileSync(
  FETCH_PRELOAD,
  `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const counter = ${JSON.stringify(RESPONSE_COUNT)};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (url === 'https://api.openai.com/v1/responses' && method === 'POST') {
    let count = 0;
    try { count = readFileSync(counter, 'utf8').split('\\n').filter(Boolean).length; } catch { /* first request */ }
    if (count >= 10) throw new Error('ChatGPT E2E Responses request budget exceeded');
    appendFileSync(counter, '1\\n', { mode: 0o600 });
    const originalSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const deadline = AbortSignal.timeout(180000);
    const signal = originalSignal ? AbortSignal.any([originalSignal, deadline]) : deadline;
    let response;
    try { response = await originalFetch(input, { ...init, signal }); }
    catch (error) {
      const code = typeof error.cause?.code === 'string' && /^[A-Z0-9_]+$/.test(error.cause.code) ? error.cause.code : undefined;
      writeFileSync(${JSON.stringify(join(ROOT, 'responses-errors.json'))}, JSON.stringify({stage:'fetch',code,aborted:signal.aborted}), {mode:0o600});
      throw error;
    }
    if (!response.ok) {
      const body = await response.clone().json().catch(() => ({}));
      const bearer = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('authorization')?.replace(/^Bearer /, '');
      let message = typeof body.error?.message === 'string' ? body.error.message : 'No structured error message';
      if (bearer) message = message.split(bearer).join('[redacted]');
      writeFileSync(${JSON.stringify(join(ROOT, 'responses-errors.json'))}, JSON.stringify({status:response.status,code:body.error?.code,param:body.error?.param,message:message.slice(0,500)}), {mode:0o600});
    }
    return response;
  }
  return originalFetch(input, init);
};
`,
  { mode: 0o600 },
);
const isolatedPaths = {
  tmp: join(ROOT, 'tmp'),
  xdgConfig: join(ROOT, 'xdg', 'config'),
  xdgCache: join(ROOT, 'xdg', 'cache'),
  xdgData: join(ROOT, 'xdg', 'data'),
};
const childEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: join(ROOT, 'home'),
  MUFFIN_HOME: HOME,
  MUFFIN_WORKSPACE: WORKSPACE,
  XDG_CONFIG_HOME: isolatedPaths.xdgConfig,
  XDG_CACHE_HOME: isolatedPaths.xdgCache,
  XDG_DATA_HOME: isolatedPaths.xdgData,
  TMPDIR: isolatedPaths.tmp,
  NODE_OPTIONS: `--import=${FETCH_PRELOAD}`,
  NO_COLOR: '1',
};
mkdirSync(WORKSPACE, { recursive: true, mode: 0o700 });
mkdirSync(isolatedPaths.tmp, { recursive: true, mode: 0o700 });
mkdirSync(isolatedPaths.xdgConfig, { recursive: true, mode: 0o700 });
mkdirSync(isolatedPaths.xdgCache, { recursive: true, mode: 0o700 });
mkdirSync(isolatedPaths.xdgData, { recursive: true, mode: 0o700 });

const steps: { name: string; status: 'PASS' | 'FAIL' | 'NOT_RUN'; evidence: string }[] = [];
function record(name: string, ok: boolean, evidence: string): void {
  steps.push({ name, status: ok ? 'PASS' : 'FAIL', evidence });
  process.stderr.write(`${ok ? '✓' : '✗'} ${name}\n    ${evidence}\n`);
}

function runCli(
  args: string[],
  stdin?: string,
  timeoutMs = 120_000,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: childEnv,
      cwd: WORKSPACE,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    ownedCommands.add(child);
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stopOwnedProcess(child);
    }, timeoutMs);
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (err += chunk));
    if (stdin !== undefined) child.stdin?.write(stdin);
    child.stdin?.end();
    child.once('error', () => {
      ownedCommands.delete(child);
      clearTimeout(timer);
      resolveResult({ code: -1, out, err: 'CLI process could not start' });
    });
    child.once('close', (code) => {
      ownedCommands.delete(child);
      clearTimeout(timer);
      resolveResult({
        code: timedOut ? -1 : (code ?? -1),
        out,
        err: timedOut ? 'CLI setup command timed out' : err,
      });
    });
  });
}

type SentCall = ReturnType<FakeTelegram['sent']>[number];
function replyTo(call: SentCall): number | undefined {
  const direct = call.payload.reply_to_message_id;
  if (typeof direct === 'number') return direct;
  const params = call.payload.reply_parameters;
  if (params !== null && typeof params === 'object' && 'message_id' in params) {
    const id = (params as { message_id: unknown }).message_id;
    if (typeof id === 'number') return id;
  }
  return undefined;
}

function textOf(call: SentCall): string {
  if (typeof call.payload.text === 'string') return call.payload.text;
  const rich = call.payload.rich_message;
  if (rich !== null && typeof rich === 'object' && 'html' in rich && typeof rich.html === 'string')
    return rich.html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '');
  return '';
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = STEP_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (globalTimeout) throw new Error('global runtime E2E deadline exceeded');
    if (gateway && (gateway.exitCode !== null || gateway.signalCode !== null))
      throw new Error('owned gateway exited during a runtime step');
    const result = read();
    if (result !== undefined) return result;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error('runtime E2E step exceeded its configured deadline');
}

function inbound(messageId: number, text: string): Record<string, unknown> {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      from: { id: OWNER_ID, is_bot: false, first_name: 'synthetic-owner' },
      chat: { id: OWNER_ID, type: 'private' },
      text,
    },
  };
}

let telegram: FakeTelegram | undefined;
let gateway: ChildProcess | undefined;
const ownedCommands = new Set<ChildProcess>();
let wallTimer: ReturnType<typeof setTimeout> | undefined;
let globalTimeout = false;

async function startGateway(): Promise<ChildProcess> {
  const child = spawn(process.execPath, [CLI, 'gateway', 'run'], {
    env: childEnv,
    cwd: WORKSPACE,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ownedCommands.add(child);
  child.once('close', () => ownedCommands.delete(child));
  gateway = child;
  let log = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (log += chunk));
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (log += chunk));
  await waitFor(() => {
    if (globalTimeout) throw new Error('global runtime E2E deadline exceeded');
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`owned gateway exited before Telegram connected: ${log.slice(-500)}`);
    return /telegram: conness[oa]/i.test(log) ? child : undefined;
  }, 30_000);
  return child;
}

async function stopGateway(): Promise<void> {
  const child = gateway;
  gateway = undefined;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveStop) => {
    child.once('close', () => resolveStop());
    stopOwnedProcess(child);
  });
}

function sqlite(): Database.Database {
  const dbPath = join(HOME, 'muffin.db');
  if (!existsSync(dbPath) || !realpathSync(dbPath).startsWith(`${ROOT_CANONICAL}/`))
    throw new Error('runtime database is missing or escaped the synthetic test root');
  return new Database(dbPath, { readonly: true });
}

async function waitForFinal(
  transport: FakeTelegram,
  messageId: number,
  request: string,
  afterEpisodeId = 0,
): Promise<SentCall> {
  return waitFor(() => {
    if (!existsSync(join(HOME, 'muffin.db'))) return undefined;
    const db = sqlite();
    try {
      const turn = db
        .prepare(
          "SELECT t.status, t.turn_outcome FROM turns t JOIN episodes e ON e.turn_id = t.id WHERE e.connector = 'telegram' AND e.tenant_id = 'host' AND e.role = 'user' AND e.content = ? AND e.id > ? ORDER BY e.id DESC LIMIT 1",
        )
        .get(request, afterEpisodeId) as { status: string; turn_outcome: string } | undefined;
      if (!turn || turn.status !== 'done') return undefined;
      if (turn.turn_outcome !== 'answered')
        throw new Error(`runtime turn ended with ${turn.turn_outcome}`);
    } finally {
      db.close();
    }
    const found = transport
      .sent()
      .findLast(
        (call) =>
          ['sendMessage', 'sendRichMessage'].includes(call.method) &&
          replyTo(call) === messageId &&
          call.payload.reply_markup === undefined,
      );
    return found;
  });
}

async function runMemoryScene(transport: FakeTelegram): Promise<void> {
  const firstGateway = await startGateway();
  transport.deliver(inbound(FIRST_MESSAGE_ID, MEMORY_REQUEST));
  const proposalReply = await waitForFinal(transport, FIRST_MESSAGE_ID, MEMORY_REQUEST);
  const firstPid = firstGateway.pid;
  await stopGateway();

  const db = sqlite();
  try {
    const witness = memoryWitness(db);
    record(
      'memory proposal persisted with actual Telegram episode and canonical fact',
      witness.ok,
      JSON.stringify(witness),
    );
    const proposal = db
      .prepare(
        "SELECT COUNT(*) AS n FROM turn_tool_calls t JOIN episodes e ON e.turn_id = t.turn_id WHERE t.tool = 'memory_propose' AND t.is_error = 0 AND t.ended_at IS NOT NULL AND e.tenant_id = 'host' AND e.connector = 'telegram' AND e.role = 'user' AND e.content = ? AND e.id > ?",
      )
      .get(MEMORY_REQUEST, 0) as { n: number };
    record(
      'memory_propose effect settled successfully',
      proposal.n === 1,
      `${proposal.n} successful settled calls`,
    );
    if (!witness.ok || proposal.n !== 1) throw new Error('memory write witness failed');
    record(
      'proposal produced a final Telegram response',
      textOf(proposalReply).length > 0,
      `final response length ${textOf(proposalReply).length}`,
    );
  } finally {
    db.close();
  }

  const restarted = await startGateway();
  record(
    'owned gateway restarted as a new process against the same home',
    firstPid !== undefined && restarted.pid !== firstPid,
    `first=${firstPid ?? 'unknown'} restart=${restarted.pid ?? 'unknown'}`,
  );
  if (firstPid === undefined || restarted.pid === undefined || restarted.pid === firstPid)
    throw new Error('gateway restart witness failed');

  transport.deliver(inbound(SECOND_MESSAGE_ID, MEMORY_QUERY));
  const answer = await waitForFinal(transport, SECOND_MESSAGE_ID, MEMORY_QUERY);
  const recallDb = sqlite();
  try {
    const reads = recallDb
      .prepare(
        "SELECT t.content FROM turn_tool_calls t JOIN episodes e ON e.turn_id = t.turn_id WHERE t.tool = 'memory_search' AND t.is_error = 0 AND t.ended_at IS NOT NULL AND e.tenant_id = 'host' AND e.connector = 'telegram' AND e.role = 'user' AND e.content = ? AND e.id > ?",
      )
      .all(MEMORY_QUERY, 0) as { content: string }[];
    const canonicalLine = `] owner — e2e_verification_code — ${MEMORY_VALUE}`;
    const toolContainsValue = reads.some((row) =>
      row.content
        .split('\n')
        .some((line) => line.startsWith('- [tu, ') && line.endsWith(canonicalLine)),
    );
    const answerContainsValue = textOf(answer).includes(MEMORY_VALUE);
    record(
      'settled memory_search result contains canonical fact and provenance',
      toolContainsValue,
      `${reads.length} settled search results`,
    );
    record(
      'correlated Telegram answer after restart contains stored value',
      answerContainsValue,
      `message ${answer.messageId ?? 'unknown'}`,
    );
    record(
      'canonical fact remains unique after restart',
      memoryWitness(recallDb).ok,
      JSON.stringify(memoryWitness(recallDb)),
    );
    if (!toolContainsValue || !answerContainsValue || !memoryWitness(recallDb).ok)
      throw new Error('memory recall witness failed');
  } finally {
    recallDb.close();
  }
}

async function runFileScene(transport: FakeTelegram): Promise<void> {
  writeFileSync(
    join(WORKSPACE, 'spese.csv'),
    'articolo,prezzo\npane,2.10\nlatte,1.35\nmele,5.00\n',
    { mode: 0o600 },
  );
  const prompt =
    'Leggi spese.csv, calcola la somma dei prezzi e scrivi esattamente la parola ciao seguita da newline in saluto.txt. Dimmi il totale.';
  const before = sqlite();
  const baseline = (
    before.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM episodes').get() as { id: number }
  ).id;
  before.close();
  transport.deliver(inbound(FILE_MESSAGE_ID, prompt));
  const answer = await waitForFinal(transport, FILE_MESSAGE_ID, prompt, baseline);
  const filePath = join(WORKSPACE, 'saluto.txt');
  const db = sqlite();
  try {
    const calls = db
      .prepare(
        "SELECT t.tool, t.content FROM turn_tool_calls t JOIN episodes e ON e.turn_id = t.turn_id WHERE t.ended_at IS NOT NULL AND t.is_error = 0 AND e.tenant_id = 'host' AND e.connector = 'telegram' AND e.role = 'user' AND e.content = ? AND e.id > ?",
      )
      .all(prompt, baseline) as { tool: string; content: string | null }[];
    const readUsed = calls.some((call) => call.tool === 'fs_read');
    const writeUsed = calls.some((call) => call.tool === 'fs_write');
    const exactFile = existsSync(filePath) && readFileSync(filePath, 'utf8') === 'ciao\n';
    const totalReported = /8[.,]45/.test(textOf(answer));
    record(
      'CSV was read and file was written through settled fs tools',
      readUsed && writeUsed,
      calls.map((call) => call.tool).join(', '),
    );
    record(
      'fs_write produced exact ciao newline file',
      exactFile,
      exactFile ? 'saluto.txt contains ciao + LF' : 'file absent or content differs',
    );
    record(
      'Telegram answer reports the CSV total',
      totalReported,
      totalReported ? '8.45 found in final answer' : 'expected 8.45 in final answer',
    );
    if (!readUsed || !writeUsed || !exactFile || !totalReported)
      throw new Error('composed file scene witness failed');
  } finally {
    db.close();
  }
}

try {
  telegram = await startFakeTelegram();
  wallTimer = setTimeout(() => {
    globalTimeout = true;
    for (const child of ownedCommands) stopOwnedProcess(child);
  }, 600_000);

  const secret = await runCli(['secret', 'set', 'telegram_token'], BOT_TOKEN);
  if (secret.code !== 0)
    throw new Error(
      `could not configure synthetic Telegram token in test home: ${secret.err.slice(-300)}`,
    );
  const enabled = await runCli([
    'surface',
    'enable',
    'telegram',
    '--api-base',
    telegram.url,
    '--owner',
    String(OWNER_ID),
  ]);
  if (enabled.code !== 0)
    throw new Error(`could not configure fake Telegram transport: ${enabled.err.slice(-300)}`);

  process.stderr.write(`ChatGPT runtime E2E · ${MODEL}\ntest root: ${ROOT}\n`);
  if (SCENE !== 'files') await runMemoryScene(telegram);
  if (SCENE !== 'memory') {
    if (!gateway) await startGateway();
    await runFileScene(telegram);
  }
  const responseCount = readFileSync(RESPONSE_COUNT, 'utf8').split('\n').filter(Boolean).length;
  record(
    'ChatGPT Responses request budget stayed within ten',
    responseCount <= 10,
    `${responseCount} real Responses requests counted in the gateway child`,
  );
  steps.push({
    name: 'literal shell authorization scene',
    status: 'NOT_RUN',
    evidence: 'separate human-approval scenario; no shell command was requested or executed',
  });
  process.stdout.write(
    `${JSON.stringify({ status: 'PASS', scene: SCENE, model: MODEL, provider: 'openai-chatgpt', telegram: 'fake Bot API HTTP; authentic Telegram UI NOT_RUN', steps, shellAuthorization: 'NOT_RUN' })}\n`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : 'runtime E2E failed';
  record('runtime scenario failure', false, message);
  for (const name of [
    'memory proposal',
    'owned gateway restarted',
    'composed file scene',
    'literal shell authorization scene',
  ]) {
    if (!steps.some((step) => step.name.startsWith(name)))
      steps.push({ name, status: 'NOT_RUN', evidence: 'an earlier runtime step did not pass' });
  }
  process.stdout.write(
    `${JSON.stringify({ status: 'FAIL', scene: SCENE, model: MODEL, provider: 'openai-chatgpt', telegram: 'fake Bot API HTTP; authentic Telegram UI NOT_RUN', steps, shellAuthorization: 'NOT_RUN' })}\n`,
  );
  process.exitCode = 1;
} finally {
  if (telegram)
    writeFileSync(
      join(ROOT, 'controlled-telegram-wire.json'),
      JSON.stringify(telegram.sent(), null, 2),
      { mode: 0o600 },
    );
  if (wallTimer) clearTimeout(wallTimer);
  for (const child of ownedCommands) stopOwnedProcess(child);
  await stopGateway();
  await telegram?.close();
}
