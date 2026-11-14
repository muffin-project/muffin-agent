import type { ProviderKind } from '../core/config/config.js';
import { ChatGPTConnection } from '../core/config/chatgpt-oauth.js';
import { PROVIDERS } from '../core/config/providers.js';
import { openChatGPTBrowser } from './chatgpt-browser.js';
import { isOpenRouterKey, looksLikeTelegramToken } from './onboarding.js';
import {
  obtainOpenRouterAuthorization,
  openRouterAuthMode,
  safeLine,
} from './openrouter-connect.js';
import { promptLine, promptSecret } from './prompt.js';

/**
 * What the single init question resolved.
 *
 * A recognised key carries `bound: 'inferred'` — the prefix decided, and the
 * caller keeps today's inference. `bound: 'named'` is an explicit provider
 * pick on this same menu: the key shape was checked and a mismatch was not
 * returned. ChatGPT is the account file (`secret://chatgpt`), not a key in
 * the AuthProfile index. A custom endpoint is an openai-compat config, not
 * an account profile.
 */
export type InitCredential =
  | {
      kind: 'key';
      apiKey: string;
      method: 'oauth-pkce' | 'api-key';
      providerId: 'openrouter' | 'anthropic';
      bound: 'inferred' | 'named';
    }
  | { kind: 'chatgpt'; models: { main: string; light: string } }
  | { kind: 'custom'; baseUrl: string; apiKey?: string; models: { main: string; light: string } }
  | { kind: 'skip' }
  | { kind: 'cancelled' };

export type InitProviderChoice = {
  provider: ProviderKind;
  baseUrl: string | undefined;
  reason: 'oauth' | 'chosen';
};

type ChatGptClient = {
  session: () => { connected: boolean } | null;
  signIn: (options: { openBrowser: (url: string) => Promise<void> }) => Promise<unknown>;
  listModels: () => Promise<readonly { slug: string; displayName: string }[]>;
};

export type InitCredentialDeps = {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  stderr: (text: string) => void;
  obtain?: typeof obtainOpenRouterAuthorization;
  promptForSecret?: typeof promptSecret;
  promptForLine?: typeof promptLine;
  ssh?: boolean;
  stdinIsTTY?: boolean;
  /** Home for the ChatGPT account file. Required only when that choice runs. */
  home?: string;
  chatgpt?: (home: string) => ChatGptClient;
  openBrowser?: (url: string) => Promise<void>;
};

const YES = /^(y|yes|s|si|sì)$/i;

const MENU =
  '\nCollega il modello. OAuth è la strada consigliata; la chiave è il ripiego.\n' +
  '  [1] OpenRouter — browser, oppure un codice se sei in SSH\n' +
  '  [2] Incolla una chiave API (OpenRouter o Anthropic)\n' +
  '  [3] Salta per ora\n' +
  '  [4] Anthropic — chiave Console/API, nessun login claude.ai\n' +
  '  [5] Piano ChatGPT — collega l’account\n' +
  '  [6] Endpoint personalizzato (OpenAI-compatibile)\n' +
  'Scelta [1]: ';

/**
 * The provider decision this menu made, when it made one the key prefix did
 * not. `undefined` for a skip, a cancel, or a key whose prefix already
 * decided — those stay on `chooseProvider`.
 */
export function choiceFromInitPick(picked: InitCredential): InitProviderChoice | undefined {
  if (picked.kind === 'key' && picked.method === 'oauth-pkce') {
    return { provider: 'openai-compat', baseUrl: PROVIDERS.openrouter.baseUrl, reason: 'oauth' };
  }
  if (picked.kind === 'key' && picked.bound === 'named') {
    return picked.providerId === 'openrouter'
      ? { provider: 'openai-compat', baseUrl: PROVIDERS.openrouter.baseUrl, reason: 'chosen' }
      : { provider: 'anthropic', baseUrl: undefined, reason: 'chosen' };
  }
  if (picked.kind === 'chatgpt') {
    return { provider: 'openai-chatgpt', baseUrl: PROVIDERS.chatgpt.baseUrl, reason: 'chosen' };
  }
  if (picked.kind === 'custom') {
    return { provider: 'openai-compat', baseUrl: picked.baseUrl, reason: 'chosen' };
  }
  return undefined;
}

/** A named pick replaces the prior provider. An inferred key does not. */
export function initPickOverridesPrior(picked: InitCredential | undefined): boolean {
  return picked !== undefined && choiceFromInitPick(picked) !== undefined;
}

/**
 * TTY onboarding choice. Empty Enter is OpenRouter OAuth, not a silent skip.
 * Headless callers never reach this: init reads the key from stdin instead.
 *
 * One question. A recognised key still names its provider. A key that does
 * not, or an explicit catalog choice, is answered here — never by a second
 * menu, and never by storing a shape that does not belong to the provider
 * just named.
 */
export async function acquireInitCredential(deps: InitCredentialDeps): Promise<InitCredential> {
  const ask = deps.promptForLine ?? promptLine;
  const secret = deps.promptForSecret ?? promptSecret;
  const input = deps.input ?? process.stdin;
  const output = deps.output ?? process.stdout;

  const say = (line: string) => deps.stderr(`${line}\n`);

  const namedKey = async (
    id: 'openrouter' | 'anthropic',
  ): Promise<InitCredential | undefined> => {
    const key = await promptMatchingKey(id, input, output, secret, say);
    if (key === undefined) return undefined;
    return { kind: 'key', apiKey: key, method: 'api-key', providerId: id, bound: 'named' };
  };

  for (;;) {
    const answer = await ask(MENU, input, output);
    // EOF is the old "no answer" path: init continues and records the key as
    // missing. A failed OAuth attempt is the case that stops, below.
    if (answer === undefined) return { kind: 'skip' };
    const choice = normaliseChoice(answer);
    if (choice === 'openrouter') {
      const mode = openRouterAuthMode({
        ssh: deps.ssh ?? false,
        stdinIsTTY: deps.stdinIsTTY ?? input.isTTY === true,
      });
      if (mode === 'unavailable') {
        say('OpenRouter OAuth vuole un terminale. In headless: echo -n "$KEY" | muffin init');
        return { kind: 'cancelled' };
      }
      try {
        const apiKey = await (deps.obtain ?? obtainOpenRouterAuthorization)({
          mode,
          out: (line) => deps.stderr(`${line}\n`),
        });
        return {
          kind: 'key',
          apiKey,
          method: 'oauth-pkce',
          providerId: 'openrouter',
          bound: 'named',
        };
      } catch (error) {
        say(safeLine(error instanceof Error ? error.message : 'OpenRouter authorization failed'));
        return { kind: 'cancelled' };
      }
    }
    if (choice === 'paste') {
      say(
        `Incolla una chiave OpenRouter (sk-or-…) o Anthropic (sk-ant-…). OpenRouter: ${PROVIDERS.openrouter.keysUrl}`,
      );
      const apiKey = await secret(
        'Chiave API (nascosta — invio vuoto chiede conferma): ',
        input,
        output,
      );
      if (!apiKey) return { kind: 'skip' };
      if (looksLikeTelegramToken(apiKey)) {
        say('Sembra il token di un bot Telegram, non una chiave — non la salvo.');
        continue;
      }
      const inferred = providerIdForKey(apiKey);
      if (inferred !== undefined) {
        return { kind: 'key', apiKey, method: 'api-key', providerId: inferred, bound: 'inferred' };
      }
      const resolved = await resolveUnrecognisedKey(
        apiKey,
        input,
        output,
        ask,
        secret,
        say,
        namedKey,
        deps,
      );
      if (resolved !== undefined) return resolved;
      continue;
    }
    if (choice === 'skip') {
      const confirm = await ask('Saltare il collegamento? [y/N] ', input, output);
      if (confirm === undefined) return { kind: 'skip' };
      if (YES.test(confirm)) return { kind: 'skip' };
      continue;
    }
    if (choice === 'anthropic') {
      const resolved = await namedKey('anthropic');
      if (resolved !== undefined) return resolved;
      continue;
    }
    if (choice === 'chatgpt') {
      const resolved = await resolveChatgpt(input, output, ask, say, deps);
      if (resolved !== undefined) return resolved;
      continue;
    }
    if (typeof choice === 'object') {
      const resolved = await resolveCustom(choice.baseUrl, input, output, ask, secret, say);
      if (resolved !== undefined) return resolved;
      continue;
    }
    say('Scegli 1, 2, 3, 4, 5 o 6.');
  }
}

type MenuChoice =
  | 'openrouter'
  | 'paste'
  | 'skip'
  | 'anthropic'
  | 'chatgpt'
  | { kind: 'custom'; baseUrl?: string }
  | 'again';

function normaliseChoice(answer: string): MenuChoice {
  if (answer === '' || answer === '1' || answer.toLowerCase() === 'openrouter') return 'openrouter';
  if (answer === '2') return 'paste';
  if (answer === '3') return 'skip';
  if (answer === '4' || answer.toLowerCase() === 'anthropic') return 'anthropic';
  if (answer === '5' || answer.toLowerCase() === 'chatgpt') return 'chatgpt';
  if (answer === '6' || answer.toLowerCase() === 'custom') return { kind: 'custom' };
  const url = httpUrl(answer);
  if (url !== undefined) return { kind: 'custom', baseUrl: url };
  return 'again';
}

function providerIdForKey(key: string): 'openrouter' | 'anthropic' | undefined {
  if (isOpenRouterKey(key)) return 'openrouter';
  if (key.startsWith('sk-ant-')) return 'anthropic';
  return undefined;
}

function prefixFor(id: 'openrouter' | 'anthropic'): string {
  return id === 'openrouter' ? 'sk-or-…' : 'sk-ant-…';
}

/**
 * Strict after the owner named the provider. A mismatch is not returned, so
 * the caller cannot store it. Empty or EOF leaves the menu.
 */
async function promptMatchingKey(
  id: 'openrouter' | 'anthropic',
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  secret: typeof promptSecret,
  say: (line: string) => void,
): Promise<string | undefined> {
  const entry = PROVIDERS[id];
  const prefix = prefixFor(id);
  for (;;) {
    const key = await secret(
      `Chiave ${entry.label} (nascosta — attesa ${prefix}; invio per tornare al menu): `,
      input,
      output,
    );
    if (key === undefined) return undefined;
    if (looksLikeTelegramToken(key)) {
      say('Sembra il token di un bot Telegram, non una chiave — non la salvo, riprova o invio per tornare al menu.');
      continue;
    }
    if (providerIdForKey(key) === id) return key;
    say(
      `Non sembra una chiave di ${entry.label} (attesa forma ${prefix}) — non la salvo, riprova o invio per tornare al menu.`,
    );
  }
}

/**
 * The key was pasted and did not name a catalog provider. Ask which provider
 * it was for, on this same question, and do not hand the mismatched value
 * back for a provider that has a shape.
 */
async function resolveUnrecognisedKey(
  rejected: string,
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  ask: typeof promptLine,
  secret: typeof promptSecret,
  say: (line: string) => void,
  namedKey: (id: 'openrouter' | 'anthropic') => Promise<InitCredential | undefined>,
  deps: InitCredentialDeps,
): Promise<InitCredential | undefined> {
  say('Non sembra una chiave OpenRouter (sk-or-…) né Anthropic (sk-ant-…).');
  for (;;) {
    const answer = await ask(
      'Da chi è, se non dal prefisso?\n' +
        '  [1] OpenRouter — ne serve una sk-or-…\n' +
        '  [2] Anthropic — ne serve una sk-ant-…\n' +
        '  [3] Endpoint personalizzato\n' +
        '  [4] Piano ChatGPT (questa chiave non si usa)\n' +
        'Invio = torna al menu: ',
      input,
      output,
    );
    if (answer === undefined || answer === '') return undefined;
    if (answer === '1' || answer.toLowerCase() === 'openrouter') return namedKey('openrouter');
    if (answer === '2' || answer.toLowerCase() === 'anthropic') return namedKey('anthropic');
    if (answer === '3' || answer.toLowerCase() === 'custom') {
      return resolveCustom(undefined, input, output, ask, secret, say, rejected);
    }
    if (answer === '4' || answer.toLowerCase() === 'chatgpt') {
      return resolveChatgpt(input, output, ask, say, deps);
    }
    say('Scegli 1, 2, 3 o 4, oppure invio per tornare al menu.');
  }
}

async function resolveChatgpt(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  ask: typeof promptLine,
  say: (line: string) => void,
  deps: InitCredentialDeps,
): Promise<InitCredential | undefined> {
  if (deps.home === undefined || deps.home === '') {
    say('ChatGPT vuole una home — torno al menu.');
    return undefined;
  }
  const connection = (deps.chatgpt ?? ((home: string) => new ChatGPTConnection(home)))(deps.home);
  try {
    const existing = connection.session();
    if (existing === null || !existing.connected) {
      say('Collego l’account ChatGPT nel browser…');
      await connection.signIn({ openBrowser: deps.openBrowser ?? openChatGPTBrowser });
    }
  } catch (error) {
    say(
      `ChatGPT non collegato (${safeLine(error instanceof Error ? error.message : 'ChatGPT connection failed')}) — torno al menu.`,
    );
    return undefined;
  }
  let models: readonly { slug: string; displayName: string }[];
  try {
    models = await connection.listModels();
  } catch (error) {
    say(
      `Non leggo i modelli dell’account (${safeLine(error instanceof Error ? error.message : 'models unavailable')}) — torno al menu.`,
    );
    return undefined;
  }
  if (models.length === 0) {
    say('L’account non espone modelli — torno al menu.');
    return undefined;
  }
  for (const model of models.slice(0, 60)) say(`${model.slug} — ${model.displayName}`);
  const main = await ask('Modello main di ChatGPT (esatto, invio per tornare al menu): ', input, output);
  if (main === undefined || main === '' || !models.some((model) => model.slug === main)) {
    if (main !== undefined && main !== '') say(`«${main}» non è nel catalogo dell’account — torno al menu.`);
    return undefined;
  }
  const lightAnswer = await ask(`Modello light (invio = ${main}): `, input, output);
  const light = lightAnswer === undefined || lightAnswer === '' ? main : lightAnswer;
  if (!models.some((model) => model.slug === light)) {
    say(`«${light}» non è nel catalogo dell’account — torno al menu.`);
    return undefined;
  }
  return { kind: 'chatgpt', models: { main, light } };
}

async function resolveCustom(
  prefilledUrl: string | undefined,
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  ask: typeof promptLine,
  secret: typeof promptSecret,
  say: (line: string) => void,
  prefilledKey?: string,
): Promise<InitCredential | undefined> {
  let baseUrl = prefilledUrl;
  if (baseUrl === undefined) {
    const answer = await ask(
      'Endpoint base http(s) (es. https://llm.example.com/v1 — invio per tornare al menu): ',
      input,
      output,
    );
    if (answer === undefined || answer === '') return undefined;
    const parsed = httpUrl(answer);
    if (parsed === undefined) {
      say('Endpoint non valido: serve un URL http(s) senza utente né hash — torno al menu.');
      return undefined;
    }
    baseUrl = parsed;
  }
  let apiKey = prefilledKey;
  if (apiKey !== undefined && looksLikeTelegramToken(apiKey)) apiKey = undefined;
  if (apiKey === undefined) {
    for (;;) {
      const key = await secret(
        'Chiave API (nascosta; server locale senza auth: inserisci local; invio per saltare): ',
        input,
        output,
      );
      if (key === undefined) break;
      if (looksLikeTelegramToken(key)) {
        say('Sembra il token di un bot Telegram, non una chiave — non la salvo, riprova o invio per saltare.');
        continue;
      }
      apiKey = key;
      break;
    }
  }
  const main = await ask(
    'Modello main (esatto, come lo serve l’endpoint — invio per tornare al menu): ',
    input,
    output,
  );
  if (main === undefined || main === '') return undefined;
  const lightAnswer = await ask(`Modello light (invio = ${main}): `, input, output);
  const light = lightAnswer === undefined || lightAnswer === '' ? main : lightAnswer;
  return {
    kind: 'custom',
    baseUrl,
    ...(apiKey === undefined ? {} : { apiKey }),
    models: { main, light },
  };
}

/** An http(s) URL with no userinfo and no fragment, or undefined. */
function httpUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    if (parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') return undefined;
    return value;
  } catch {
    return undefined;
  }
}
