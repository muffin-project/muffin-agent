import { ChatGPTConnection } from '../../core/config/chatgpt-oauth.js';
import {
  type Config,
  type InferenceLane,
  inferenceProvider,
  readSecret,
} from '../../core/config/config.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIChatGPTProvider } from './openai-chatgpt.js';
import { OpenAICompatProvider } from './openai-compat.js';
import type { Provider } from './types.js';

/** Runtime and online verification construct the same authenticated protocol. */
export function configuredProvider(
  config: Config,
  home: string,
  fetch?: typeof globalThis.fetch,
  lane: InferenceLane = 'main',
): Provider {
  const selected = inferenceProvider(config, lane);
  if (selected.kind === 'openai-chatgpt') {
    return new OpenAIChatGPTProvider(
      new ChatGPTConnection(home, fetch ? { fetch } : {}),
      fetch ? { fetch } : {},
    );
  }
  const key = readSecret(selected.apiKeyRef, home);
  if (selected.kind === 'anthropic') {
    return new AnthropicProvider(key, selected.baseUrl, fetch ? { fetch } : {});
  }
  return new OpenAICompatProvider(
    key,
    selected.baseUrl,
    { 'HTTP-Referer': 'https://github.com/muffin-ai/muffin', 'X-Title': 'muffin' },
    {
      ...(selected.routing ? { routing: selected.routing } : {}),
      ...(selected.reasoningDialect ? { reasoningDialect: selected.reasoningDialect } : {}),
      ...(fetch ? { fetch, metadataFetch: fetch } : {}),
    },
  );
}
