import type { ProviderKind } from '../core/config/config.js';
import type { SandboxProbe } from '../core/sandbox/probe.js';
import { promptLine } from './prompt.js';

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
   * (`askLocalOrApi`), which `chooseProvider` never sees.
   */
  readonly reason: 'explicit' | 'inferred' | 'default' | 'local';
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
 */
export async function probeLocalRuntime(
  baseUrl: string = DEFAULT_LOCAL_RUNTIME_URL,
  timeoutMs: number = LOCAL_RUNTIME_PROBE_TIMEOUT_MS,
): Promise<LocalRuntimeProbe> {
  try {
    const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { available: false, baseUrl };
    const body = (await response.json()) as { data?: Array<{ id?: string }> };
    const models = (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    return { available: true, baseUrl, models };
  } catch {
    return { available: false, baseUrl };
  }
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
