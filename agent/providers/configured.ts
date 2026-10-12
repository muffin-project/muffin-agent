import { ChatGPTConnection } from '../../core/config/chatgpt-oauth.js';
import { type Config, readSecret } from '../../core/config/config.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIChatGPTProvider } from './openai-chatgpt.js';
import { OpenAICompatProvider } from './openai-compat.js';
import type { Provider } from './types.js';

/** Runtime and online verification construct the same authenticated protocol. */
export function configuredProvider(
  config: Config,
  home: string,
  fetch?: typeof globalThis.fetch,
): Provider {
  if (config.provider.kind === 'openai-chatgpt') {
    return new OpenAIChatGPTProvider(
      new ChatGPTConnection(home, fetch ? { fetch } : {}),
      fetch ? { fetch } : {},
    );
  }
  const key = readSecret(config.provider.apiKeyRef, home);
  if (config.provider.kind === 'anthropic') {
    return new AnthropicProvider(key, config.provider.baseUrl, fetch ? { fetch } : {});
  }
  return new OpenAICompatProvider(
    key,
    config.provider.baseUrl,
    { 'HTTP-Referer': 'https://github.com/muffin-ai/muffin', 'X-Title': 'muffin' },
    {
      ...(config.provider.routing ? { routing: config.provider.routing } : {}),
      ...(config.provider.reasoningDialect
        ? { reasoningDialect: config.provider.reasoningDialect }
        : {}),
      ...(fetch ? { fetch, metadataFetch: fetch } : {}),
    },
  );
}
