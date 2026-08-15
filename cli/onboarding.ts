import type { ProviderKind } from '../core/config/config.js';

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
  /** How Muffin decided — the fact `describeProviderChoice` puts into words. */
  readonly reason: 'explicit' | 'inferred' | 'default';
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
