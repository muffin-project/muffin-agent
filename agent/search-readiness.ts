import { ChatGPTConnection } from '../core/config/chatgpt-oauth.js';
import { type Config, ConfigError, loadConfig } from '../core/config/config.js';
import { CHATGPT_SEARCH_PROVIDER } from '../core/config/providers.js';
import type { EgressPolicy } from '../core/net/egress.js';
import { OpenAIChatGPTProvider } from './providers/openai-chatgpt.js';
import { ProviderError } from './providers/types.js';
import { diagnoseSearch, type SearchBackend, type SearchDiagnosis } from './tools/search.js';

export function chatGPTSearchBackend(config: Config, home: string): SearchBackend {
  if (config.provider.kind !== 'openai-chatgpt') {
    throw new ConfigError('ChatGPT is not selected as the main provider', 'muffin model');
  }
  const connection = new ChatGPTConnection(home);
  let connected = false;
  try {
    connected = connection.session()?.connected === true;
  } catch {
    // The persisted credential or its backing store is unavailable.
  }
  if (!connected) {
    throw new ConfigError('ChatGPT plan permission is unavailable', 'muffin chatgpt login');
  }
  const provider = new OpenAIChatGPTProvider(connection);
  return {
    ...CHATGPT_SEARCH_PROVIDER,
    search(query, signal) {
      let current: Config;
      try {
        current = loadConfig(home);
      } catch {
        throw new ProviderError('ChatGPT search configuration is unavailable', false);
      }
      if (current.search?.provider !== 'chatgpt' || current.provider.kind !== 'openai-chatgpt') {
        throw new ProviderError(
          'ChatGPT search is no longer selected on the active main provider',
          false,
        );
      }
      return provider.searchWeb(current.models.main, query, signal, current.search.maxResults);
    },
  };
}

export function diagnoseConfiguredSearch(
  config: Config,
  egress: EgressPolicy,
  home: string,
  resolveApiKey?: (ref: string) => string,
): SearchDiagnosis {
  return diagnoseSearch(config, egress, resolveApiKey, () => chatGPTSearchBackend(config, home));
}
