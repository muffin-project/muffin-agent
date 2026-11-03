import { discoverOpenAICompatModels } from '../agent/providers/models-discovery.js';
import type { ProviderKind } from '../core/config/config.js';
import { ChatGPTConnection } from '../core/config/chatgpt-oauth.js';
import { PROVIDERS, type ProviderEntry, type ProviderId } from '../core/config/providers.js';
import type { SandboxProbe } from '../core/sandbox/probe.js';
import { openChatGPTBrowser } from './chatgpt-browser.js';
import { promptLine, promptSecret } from './prompt.js';

/** The one base URL we special-case, because it is the key most users bring. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** OpenRouter keys carry a stable, documented prefix. */
export function isOpenRouterKey(key: string | undefined): boolean {
  return key?.startsWith('sk-or-') ?? false;
}

/** Telegram bot tokens are `<digits>:<~35 url-safe chars>` — a shape people paste by mistake. */
export function looksLikeTelegramToken(key: string | undefined): boolean {
  return /^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(key ?? '');
}

/**
 * Infer the provider from the shape of the key, so the first run does not ask a
 * question it can answer by looking: an OpenRouter key means the openai-compat
 * gateway, an Anthropic key means Anthropic direct. Undefined when the prefix is
 * unknown — the caller keeps its own default. An explicit --provider always wins
 * over this.
 */
export function inferProvider(key: string | undefined): ProviderKind | undefined {
  if (isOpenRouterKey(key)) return 'openai-compat';
  if (key?.startsWith('sk-ant-')) return 'anthropic';
  return undefined;
}

export type ProviderChoice = {
  readonly provider: ProviderKind;
  readonly baseUrl: string | undefined;
  /**
   * How Muffin decided — the fact `describeProviderChoice` puts into words.
   * `local` is the one case with no key to read a prefix from at all: the
   * owner picked a probed local runtime over the API question entirely
   * (`askLocalOrApi`), which `chooseProvider` never sees. `chosen` is the
   * init provider menu below: the owner picked, neither a flag nor a key did.
   */
  readonly reason: 'explicit' | 'inferred' | 'chosen' | 'default' | 'local';
};

/**
 * The one decision `cmdInit` used to make in two places — a warning printed
 * only when inference *failed*, nothing at all when it succeeded — collapsed
 * into a single function, so there is one thing to call and one thing to test.
 * Precedence matches `inferProvider`: an explicit --provider always wins, then
 * the key's shape, then the compiled default (`anthropic`).
 */
export function chooseProvider(
  explicitProvider: ProviderKind | undefined,
  key: string | undefined,
  explicitBaseUrl: string | undefined,
): ProviderChoice {
  if (explicitProvider) {
    return { provider: explicitProvider, baseUrl: explicitBaseUrl, reason: 'explicit' };
  }
  const inferred = inferProvider(key);
  // Only reachable via inference: an explicit --provider never auto-fills a
  // base URL (the flag path above returns before this line), matching the
  // reading that an owner who names the provider by hand is also trusted to
  // name a non-default endpoint by hand.
  const baseUrl = explicitBaseUrl ?? (isOpenRouterKey(key) ? OPENROUTER_BASE_URL : undefined);
  if (inferred) return { provider: inferred, baseUrl, reason: 'inferred' };
  return { provider: 'anthropic', baseUrl, reason: 'default' };
}

/**
 * Says the decision out loud — the fix ADR-0036 asked for. A successful
 * inference was never wrong at runtime, only untraceable: nothing in the setup
 * transcript let the owner confirm "openai-compat" before the first message to
 * the model did instead, which is the worst place to learn it.
 *
 * `key` is only for the 'default' case, to tell apart the two different facts
 * that both fall through to the compiled default: no key yet at all, versus a
 * key present whose prefix nothing recognises. Collapsing those into one
 * message ("nothing to infer from") would be true of neither read literally
 * against the second case — there was something, it just did not match.
 */
export function describeProviderChoice(choice: ProviderChoice, key: string | undefined): string {
  const where = choice.baseUrl ? ` (${choice.baseUrl})` : '';
  const label = 'provider'.padEnd(16);
  if (choice.reason === 'explicit') {
    return `✓ ${label} ${choice.provider}${where} — indicato con --provider\n`;
  }
  if (choice.reason === 'inferred') {
    const prefix = choice.provider === 'openai-compat' ? 'sk-or-…' : 'sk-ant-…';
    return `✓ ${label} ${choice.provider}${where} — dedotto dalla chiave (${prefix})\n`;
  }
  if (choice.reason === 'chosen') {
    return `✓ ${label} ${choice.provider}${where} — scelto ora\n`;
  }
  if (choice.reason === 'local') {
    return `✓ ${label} ${choice.provider}${where} — runtime locale rilevato e scelto, nessuna chiave\n`;
  }
  if (key) {
    return `! ${label} ${choice.provider} — la chiave non è sk-or-… né sk-ant-…, uso il default (--provider per cambiarlo)\n`;
  }
  return `! ${label} ${choice.provider} — nessuna chiave ancora, dedurrò il provider quando la incolli\n`;
}

/** Where to get a key, shown before the prompt — the detail gh and Hermes get right. */
export function keyHint(provider: ProviderKind | undefined, baseUrl: string | undefined): string {
  if (provider === 'anthropic') {
    return 'Chiave Anthropic → https://console.anthropic.com/settings/keys\n';
  }
  if (provider === 'openai-compat' || (baseUrl?.includes('openrouter') ?? false)) {
    return 'Chiave OpenRouter (una chiave, tutti i modelli) → https://openrouter.ai/keys\n';
  }
  return (
    'Incolla una chiave OpenRouter (sk-or-…) o Anthropic (sk-ant-…) — il prefisso sceglie il provider.\n' +
    '  OpenRouter, una chiave per tutti i modelli → https://openrouter.ai/keys\n'
  );
}

/**
 * What the init provider menu resolves to: a catalog entry, or a custom
 * OpenAI-compatible endpoint (with the URL already captured when the owner
 * pasted one instead of writing `custom`).
 */
export type ProviderMenuPick =
  | { readonly kind: 'provider'; readonly id: ProviderId }
  | { readonly kind: 'custom'; readonly baseUrl?: string | undefined };

/**
 * The provider question ADR-0036 originally named (*«da chi passiamo?»*).
 *
 * Asked only when the key did not already answer it — a recognised key keeps
 * today's silent inference, an explicit flag keeps winning over everything.
 * The catalog entries come from `PROVIDERS`, never from a second list kept
 * here: a provider added to the catalog appears in this menu with no edit.
 * `custom` (or a pasted http(s) URL) is an endpoint the catalog does not
 * know; the caller prompts for the URL and the key next. Empty or EOF skips
 * the question and the caller falls back to today's default path; anything
 * else that is not a number, an id, `custom` or a URL re-asks instead of
 * guessing, because a mistyped provider is a misconfigured install.
 */
export async function askProviderChoice(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Promise<ProviderMenuPick | undefined> {
  const entries = Object.values(PROVIDERS);
  const menu = entries.map((e, i) => `  [${i + 1}] ${e.label} (${e.id})`).join('\n');
  const custom = entries.length + 1;
  for (;;) {
    const answer = await promptLine(
      `\nDa chi passiamo?\n${menu}\n  [${custom}] endpoint personalizzato (OpenAI-compatibile)\nScelta [1-${custom}] (nome, numero, URL http(s), o invio per saltare): `,
      input,
      output,
    );
    if (answer === undefined || answer === '') return undefined;
    const n = Number.parseInt(answer, 10);
    const numbered = Number.isInteger(n) && String(n) === answer ? n : undefined;
    if (numbered !== undefined && numbered >= 1 && numbered <= entries.length) {
      const picked = entries[numbered - 1]!;
      return { kind: 'provider', id: picked.id };
    }
    if (answer === 'custom' || numbered === custom) return { kind: 'custom' };
    const byId = entries.find((e) => e.id === answer.toLowerCase());
    if (byId !== undefined) return { kind: 'provider', id: byId.id };
    try {
      const parsed = new URL(answer);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return { kind: 'custom', baseUrl: answer };
      }
    } catch {
      // Not a URL — fall through to the re-ask below.
    }
    output.write(
      `«${answer}» non è un provider della lista — numero, nome, custom, URL http(s) o invio per saltare.\n`,
    );
  }
}

/**
 * Whether this key can belong to this catalog provider — the strictness the
 * menu flow applies after the owner just chose: a mismatch is almost certainly
 * a wrong paste, and writing it would fail at the first model call, which is
 * the worst place to learn it. Unknown shapes (and ChatGPT's OAuth, which has
 * no key shape at all) have nothing to check against and pass.
 */
export function keyMatchesProvider(key: string, id: ProviderId): boolean {
  if (id === 'openrouter') return isOpenRouterKey(key);
  if (id === 'anthropic') return key.startsWith('sk-ant-');
  return true;
}

/** The key shape the strict prompt names, so the refusal says what it wants. */
export function keyPrefixFor(id: ProviderId): string | undefined {
  if (id === 'openrouter') return 'sk-or-…';
  if (id === 'anthropic') return 'sk-ant-…';
  return undefined;
}

/**
 * The key for a provider just picked from the menu — strict, because a
 * mismatch here is almost certainly a wrong paste made seconds after choosing:
 * writing it would fail at the first model call, the worst place to learn it.
 * A refused key is never stored; skipping (empty) leaves key acquisition to
 * the caller's missing-key path, which stays resumable.
 */
export async function promptProviderKey(
  entry: ProviderEntry,
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  deps: {
    readonly out: (line: string) => void;
    readonly askSecret?: typeof promptSecret;
  },
): Promise<string | undefined> {
  const askSecret = deps.askSecret ?? promptSecret;
  for (;;) {
    const key = await askSecret(
      `Chiave ${entry.label} (nascosta — incollala, o invio per saltare): `,
      input,
      output,
    );
    if (key === undefined) return undefined;
    if (keyMatchesProvider(key, entry.id)) return key;
    const prefix = keyPrefixFor(entry.id);
    deps.out(
      `Non sembra una chiave di ${entry.label}${prefix === undefined ? '' : ` (attesa forma ${prefix})`} — non la salvo, riprova o invio per saltare.`,
    );
  }
}

export type MenuProviderDeps = {
  readonly out: (line: string) => void;
  readonly ask?: typeof promptLine;
  readonly askSecret?: typeof promptSecret;
  readonly chatgpt?: (home: string) => Pick<ChatGPTConnection, 'session' | 'signIn' | 'listModels'>;
  readonly openBrowser?: (url: string) => Promise<void>;
};

export type MenuProviderResult = {
  readonly provider: ProviderKind;
  readonly baseUrl?: string | undefined;
  /** A fresh key pasted for this pick, already shape-checked. Absent = skipped. */
  readonly apiKey?: string | undefined;
  /** Models resolved by the pick itself (ChatGPT account, custom endpoint). */
  readonly models?: { readonly main: string; readonly light: string } | undefined;
  /** True when OAuth already connected the account — the caller's key step. */
  readonly chatgpt: boolean;
};

/**
 * Runs the init provider menu to a decision. Returns `null` when the owner
 * skips (empty/EOF): the caller falls back to today's default path, announced
 * as today. Anything the menu resolves carries `reason: 'chosen'` upstream.
 *
 * Failures that cannot complete a pick (OAuth refused, empty account catalog,
 * invalid endpoint, skipped model) print why and return to the menu instead
 * of writing a half-decided provider — the loop ends on a pick, a skip, or
 * EOF, so it cannot spin forever.
 */
export async function resolveMenuProvider(
  home: string,
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  deps: MenuProviderDeps,
): Promise<MenuProviderResult | null> {
  for (;;) {
    const pick = await askProviderChoice(input, output);
    if (pick === undefined) return null;
    if (pick.kind === 'custom') {
      const resolved = await resolveCustomEndpoint(pick.baseUrl, input, output, deps);
      if (resolved !== undefined) return resolved;
      continue;
    }
    const entry = PROVIDERS[pick.id];
    if (entry.kind === 'openai-chatgpt') {
      const resolved = await resolveChatgptAccount(home, entry, input, output, deps);
      if (resolved !== undefined) return resolved;
      continue;
    }
    const apiKey = await promptProviderKey(entry, input, output, deps);
    return {
      provider: entry.kind,
      baseUrl: entry.baseUrl,
      ...(apiKey === undefined ? {} : { apiKey }),
      chatgpt: false,
    };
  }
}

/** An OAuth account instead of a pasted key: connect, then name both models. */
async function resolveChatgptAccount(
  home: string,
  entry: ProviderEntry,
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  deps: MenuProviderDeps,
): Promise<MenuProviderResult | undefined> {
  const ask = deps.ask ?? promptLine;
  const connection = (deps.chatgpt ?? ((h: string) => new ChatGPTConnection(h)))(home);
  try {
    const existing = connection.session();
    if (existing === null || !existing.connected) {
      deps.out('Collego l’account ChatGPT nel browser…');
      await connection.signIn({ openBrowser: deps.openBrowser ?? openChatGPTBrowser });
    }
  } catch (error) {
    deps.out(
      `ChatGPT non collegato (${error instanceof Error ? error.message : String(error)}) — torno al menu.`,
    );
    return undefined;
  }
  let models: { slug: string; displayName: string }[];
  try {
    models = await connection.listModels();
  } catch (error) {
    deps.out(
      `Non leggo i modelli dell’account (${error instanceof Error ? error.message : String(error)}) — torno al menu.`,
    );
    return undefined;
  }
  if (models.length === 0) {
    deps.out('L’account non espone modelli — torno al menu.');
    return undefined;
  }
  for (const model of models.slice(0, 60)) deps.out(`${model.slug} — ${model.displayName}`);
  const main = await ask(`Modello main di ${entry.label} (esatto, invio per tornare al menu): `, input, output);
  if (main === undefined || main === '' || !models.some((m) => m.slug === main)) {
    if (main !== undefined && main !== '') deps.out(`«${main}» non è nel catalogo dell’account — torno al menu.`);
    return undefined;
  }
  const lightAnswer = await ask(`Modello light (invio = ${main}): `, input, output);
  const light = lightAnswer === undefined || lightAnswer === '' ? main : lightAnswer;
  if (!models.some((m) => m.slug === light)) {
    deps.out(`«${light}» non è nel catalogo dell’account — torno al menu.`);
    return undefined;
  }
  return {
    provider: entry.kind,
    baseUrl: entry.baseUrl,
    models: { main, light },
    chatgpt: true,
  };
}

/** A hand-named endpoint: URL, key of any shape, and both model slugs. */
async function resolveCustomEndpoint(
  prefilled: string | undefined,
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  deps: MenuProviderDeps,
): Promise<MenuProviderResult | undefined> {
  const ask = deps.ask ?? promptLine;
  const askSecret = deps.askSecret ?? promptSecret;
  let baseUrl = prefilled;
  if (baseUrl === undefined) {
    const answer = await ask(
      'Endpoint base http(s) (es. https://llm.example.com/v1 — invio per tornare al menu): ',
      input,
      output,
    );
    if (answer === undefined || answer === '') return undefined;
    try {
      const parsed = new URL(answer);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
      if (parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') {
        throw new Error('parts');
      }
      baseUrl = answer;
    } catch {
      deps.out('Endpoint non valido: serve un URL http(s) senza utente né hash — torno al menu.');
      return undefined;
    }
  }
  let apiKey: string | undefined;
  for (;;) {
    const key = await askSecret(
      'Chiave API (nascosta; server locale senza auth: inserisci local; invio per saltare): ',
      input,
      output,
    );
    if (key === undefined) break;
    if (looksLikeTelegramToken(key)) {
      deps.out('Sembra il token di un bot Telegram, non una chiave — non la salvo, riprova o invio per saltare.');
      continue;
    }
    apiKey = key;
    break;
  }
  const main = await ask('Modello main (esatto, come lo serve l’endpoint — invio per tornare al menu): ', input, output);
  if (main === undefined || main === '') return undefined;
  const lightAnswer = await ask(`Modello light (invio = ${main}): `, input, output);
  const light = lightAnswer === undefined || lightAnswer === '' ? main : lightAnswer;
  return {
    provider: 'openai-compat',
    baseUrl,
    ...(apiKey === undefined ? {} : { apiKey }),
    models: { main, light },
    chatgpt: false,
  };
}

/**
 * Which supervisor `offerGateway` will target, said before the gateway
 * question instead of only implied by it. `planUnit` (core/gateway/unit.ts)
 * already routes darwin to launchd and everything else to systemd — this adds
 * no new decision, it just names the existing one up front, on the machine
 * that is about to make it (owner's brief: "capire la macchina... prima").
 */
export function describeSupervisor(platform: NodeJS.Platform): string {
  const name = platform === 'darwin' ? 'launchd' : 'systemd (utente)';
  return `Supervisore: ${name} — se poi installi il gateway, i job continuano a girare a finestra chiusa.\n`;
}

/**
 * `probeSandbox` (core/sandbox/probe.ts) already runs a real containment and
 * names why it failed; before this, `doctor` was the only reader of that
 * reason, so a first run learned about a broken sandbox only by running a
 * second command afterward. `remedy` is printed in full, not summarised —
 * ADR-0018's field note is explicit that the AppArmor fix "va nell'installer,
 * non nella documentazione che nessuno legge".
 */
export function describeSandboxProbe(probe: SandboxProbe): string {
  const label = 'sandbox'.padEnd(16);
  if (probe.available) return `✓ ${label} ${probe.mechanism}: contenimento verificato\n`;
  const lines = [
    `! ${label} ${probe.mechanism} non disponibile (${probe.reason}): ${probe.detail}`,
    `  → ${probe.remedy}`,
  ];
  // The fix is a privileged step (apparmor_parser -r, or lowering the sysctl)
  // that init must never take for you — weakening a sandbox with a sudo the
  // owner never typed is exactly the kind of silent decision ADR-0036 forbids
  // for a question; it is worse for a root-level side effect. Taught, not run.
  if (probe.reason === 'userns_denied') {
    lines.push('  (serve sudo — init non lo esegue da solo: copia il comando sopra ed eseguilo tu)');
  }
  return `${lines.join('\n')}\n`;
}

export type LocalRuntimeProbe =
  | { available: true; baseUrl: string; models: readonly string[] }
  | { available: false; baseUrl: string };

/** Short enough that a machine with nothing listening never makes `init` feel hung. */
const LOCAL_RUNTIME_PROBE_TIMEOUT_MS = 1_000;

/** Ollama's default — the one local OpenAI-compatible port worth guessing at without being asked. */
export const DEFAULT_LOCAL_RUNTIME_URL = 'http://127.0.0.1:11434/v1';

/**
 * A short, best-effort look for an OpenAI-compatible server already running on
 * this machine. Loopback only, 1s timeout — never a real network call, and a
 * silent machine must not make the command feel stuck. Any failure (refused,
 * timeout, non-JSON, wrong shape) reads as "not found": the owner's brief is
 * "fallito = semplicemente non proposto", not a warning about a server that
 * was never expected to be there.
 *
 * The HTTP reading is the shared `discoverOpenAICompatModels` (#763); this
 * function only applies the onboarding policy on top: no credential, and every
 * outcome other than a model list collapses to "not available".
 */
export async function probeLocalRuntime(
  baseUrl: string = DEFAULT_LOCAL_RUNTIME_URL,
  timeoutMs: number = LOCAL_RUNTIME_PROBE_TIMEOUT_MS,
): Promise<LocalRuntimeProbe> {
  const found = await discoverOpenAICompatModels({ baseUrl, timeoutMs });
  return found.status === 'known' ? { available: true, baseUrl, models: found.models } : { available: false, baseUrl };
}

/**
 * The one question the owner asked for verbatim: "chiedere se si vuole andare
 * in locale o in API" — but only once a probe already found something to
 * offer; `cmdInit` never calls this when `probeLocalRuntime` came back empty,
 * so there is never a question with only one real answer.
 */
export async function askLocalOrApi(
  local: Extract<LocalRuntimeProbe, { available: true }>,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Promise<{ baseUrl: string; models: readonly string[] } | undefined> {
  const count = local.models.length > 0 ? ` (${local.models.length} modelli)` : '';
  const answer = await promptLine(
    `\nTrovato un runtime locale su ${local.baseUrl}${count}. Usarlo invece di una chiave API? [Y/n] `,
    input,
    output,
  );
  // No-TTY resolves undefined same as promptLine itself; cmdInit already gates
  // this call on process.stdin.isTTY, so this branch is a safety net, not the
  // path anything takes in practice.
  if (answer === undefined) return undefined;
  if (answer === '' || /^(y(es)?|s(i|ì)?)$/i.test(answer)) {
    return { baseUrl: local.baseUrl, models: local.models };
  }
  return undefined;
}

export type ModelChoice = { readonly label: string; readonly main: string; readonly light: string };

/**
 * OpenRouter family presets (slice/init-interroga, 2026-08-2x). Qwen is first
 * because it is the owner's actual install: `qwen/qwen3.8-27b` main, `qwen/qwen3.7-flash`
 * light — verified live on OpenRouter 2026-08-15
 * (docs/evidence/modelli-agosto-2026.md §"Comparison table"). Before
 * this the compiled default for any openai-compat key was
 * `anthropic/claude-sonnet-5`, which meant a hand-typed --model flag on every
 * install of exactly this shape.
 *
 * Anthropic mirrors `defaultModels`'s own compat pair (cli/init.ts) — picking
 * it here changes nothing that was not already the default.
 *
 * GPT skips the open-weight `openai/gpt-oss-20b`: its mandatory "harmony"
 * tool-call format has zero matches in agent/, core/ or cli/ — an unimplemented
 * integration risk named in the same research doc (§2, "gpt-oss's mandatory
 * harmony format is unimplemented"). Proposing it as a numbered default would
 * hand a fresh install a model that cannot reliably call tools. `gpt-5*`
 * already matches agent/profiles/frontier.json's glob, so the hosted line is
 * both supported today and the safer default.
 *
 * Gemma pairs the incumbent `google/gemma-4-26b-a4b-it` as light — reasoning
 * OFF by default, the one candidate in that table that is, which matters
 * because reasoning-on measurably regressed this exact model's tool-calling in
 * production (docs/evidence/stato-componenti-vecchio-muffin.md) — with the
 * larger dense `google/gemma-4-31b-it` as main; both verified on OpenRouter's
 * own catalogue (docs/evidence/catalogo-openrouter-e-multimodale.md).
 */
export const OPENROUTER_MODEL_FAMILIES: readonly ModelChoice[] = [
  { label: 'Qwen', main: 'qwen/qwen3.8-27b', light: 'qwen/qwen3.7-flash' },
  { label: 'Anthropic', main: 'anthropic/claude-sonnet-5', light: 'anthropic/claude-haiku-4.5' },
  { label: 'GPT', main: 'openai/gpt-5.6-terra', light: 'openai/gpt-5-nano' },
  { label: 'Gemma', main: 'google/gemma-4-31b-it', light: 'google/gemma-4-26b-a4b-it' },
  { label: 'OpenRouter Free', main: 'openrouter/free', light: 'openrouter/free' },
];

/** A locally probed model has no separate main/light tier on offer — same id serves both. */
export function localModelChoices(models: readonly string[]): ModelChoice[] {
  return models.map((id) => ({ label: id, main: id, light: id }));
}

/**
 * One numbered menu, reused for the OpenRouter family list and a local
 * runtime's own model list — "3-4 scelte numerate più altro" either way (owner,
 * verbatim). Enter alone accepts the first entry (the proposed default, always
 * listed first); a listed number picks that entry; anything else is taken as a
 * model id typed by hand — "altro" is not a second round-trip, just whatever
 * did not match a number.
 */
export async function askModelChoice(
  choices: readonly ModelChoice[],
  header: string,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Promise<{ main: string; light: string } | undefined> {
  if (choices.length === 0) {
    // A local runtime probed clean but listed no models (e.g. Ollama up, none
    // pulled yet) — nothing to number, so ask directly instead of printing an
    // empty menu.
    const answer = await promptLine(`${header}\nNessun modello elencato — scrivine uno (Invio per lasciare il default): `, input, output);
    return answer ? { main: answer, light: answer } : undefined;
  }
  const menu = choices.map((c, i) => `  [${i + 1}] ${c.label} — ${c.main} (main) · ${c.light} (light)`).join('\n');
  const answer = await promptLine(
    `${header}\n${menu}\n  ...oppure scrivi il nome di un modello\nScelta [1-${choices.length}] (Invio = 1): `,
    input,
    output,
  );
  if (answer === undefined) return undefined;
  if (answer === '') return { main: choices[0]!.main, light: choices[0]!.light };
  const n = Number.parseInt(answer, 10);
  if (Number.isInteger(n) && String(n) === answer && n >= 1 && n <= choices.length) {
    const picked = choices[n - 1]!;
    return { main: picked.main, light: picked.light };
  }
  return { main: answer, light: answer }; // "altro": whatever did not parse as a valid number
}

export type ModelChoiceReason = 'explicit' | 'chosen' | 'default';

/**
 * The model's own `describeProviderChoice`: before this, nothing `cmdInit`
 * printed ever named which model got written into config.json, TTY or not —
 * an owner on a headless install had no way to learn the compiled default
 * without opening config.json by hand. Symmetrical with that function even
 * headless (owner's brief: the print happens regardless of whether a
 * question was ever asked, on a TTY or off one).
 */
export function describeModelChoice(main: string, light: string, reason: ModelChoiceReason): string {
  const label = 'modelli'.padEnd(16);
  const pair = `${main} (main) · ${light} (light)`;
  if (reason === 'explicit') return `✓ ${label} ${pair} — da --model/--light-model\n`;
  if (reason === 'chosen') return `✓ ${label} ${pair} — scelti ora\n`;
  return `! ${label} ${pair} — default compilato (--model per cambiarlo)\n`;
}
