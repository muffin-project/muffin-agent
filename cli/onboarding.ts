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

/** Where to get a key, shown before the prompt — the detail gh and Hermes get right. */
export function keyHint(provider: ProviderKind | undefined, baseUrl: string | undefined): string {
  if (provider === 'anthropic') {
    return 'Anthropic key → https://console.anthropic.com/settings/keys\n';
  }
  if (provider === 'openai-compat' || (baseUrl?.includes('openrouter') ?? false)) {
    return 'OpenRouter key (one key, every model) → https://openrouter.ai/keys\n';
  }
  return (
    'Paste an OpenRouter (sk-or-…) or Anthropic (sk-ant-…) key — the prefix picks the provider.\n' +
    '  OpenRouter, one key for every model → https://openrouter.ai/keys\n'
  );
}
