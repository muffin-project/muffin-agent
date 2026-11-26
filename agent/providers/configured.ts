import { ChatGPTConnection } from '../../core/config/chatgpt-oauth.js';
import {
  type Config,
  type FallbackLink,
  type InferenceLane,
  type InferenceProviderConfig,
  inferenceChain,
  readSecret,
} from '../../core/config/config.js';
import {
  chainStateWatcher,
  linkId,
  linkLabel,
  readChainState,
  writeLaneChainState,
} from '../../core/config/provider-chain.js';
import { providerFor } from '../../core/config/providers.js';
import {
  XAI_OAUTH_REF,
  XaiOAuthConnection,
  XaiReauthenticationRequired,
} from '../../core/config/xai-oauth.js';
import { AnthropicProvider } from './anthropic.js';
import { type ChainEvent, type ChainLink, providerChain } from './chain.js';
import { OpenAIChatGPTProvider } from './openai-chatgpt.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { type Provider, ProviderError } from './types.js';

/** One authenticated adapter for one connection — the only place adapters are chosen. */
export function connectionProvider(
  selected: InferenceProviderConfig,
  home: string,
  fetch?: typeof globalThis.fetch,
): Provider {
  if (selected.kind === 'openai-chatgpt') {
    return new OpenAIChatGPTProvider(
      new ChatGPTConnection(home, fetch ? { fetch } : {}),
      fetch ? { fetch } : {},
    );
  }
  const key = isXaiLogin(selected)
    ? xaiLoginToken(home, fetch)
    : readSecret(selected.apiKeyRef, home);
  if (selected.kind === 'anthropic') {
    if (typeof key !== 'string') throw new Error('secret://xai_oauth is not an Anthropic key');
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

/** An xAI connection that authenticates with the xAI login instead of a key (ADR-0113). */
export function isXaiLogin(selected: InferenceProviderConfig): boolean {
  return selected.apiKeyRef === XAI_OAUTH_REF && providerFor(selected)?.id === 'xai';
}

/**
 * The per-request bearer for an xAI login: refreshed before expiry, shared by
 * every request of this adapter. Failures are classified here so the chain
 * (ADR-0110) treats them as an account problem and moves on.
 */
function xaiLoginToken(home: string, fetch?: typeof globalThis.fetch): () => Promise<string> {
  const connection = new XaiOAuthConnection(home, fetch ? { fetch } : {});
  // Fail at construction, like a missing key file: no login, no adapter.
  if (!connection.status().connected) throw new Error('xAI login missing: muffin auth login xai');
  return async () => {
    try {
      return await connection.accessToken();
    } catch (error) {
      if (error instanceof XaiReauthenticationRequired) {
        throw new ProviderError(error.message, false, undefined, 'transport', undefined, false, {
          reauthentication: 'xai',
        });
      }
      throw new ProviderError(
        'xAI access token unavailable',
        false,
        undefined,
        'transport',
        undefined,
        false,
        { credentials: 'unavailable' },
      );
    }
  };
}

export type ConfiguredProviderOptions = {
  /** Persist chain transitions so `muffin doctor` can read them (runtime only). */
  persistChainState?: boolean;
  onFailover?: (event: ChainEvent) => void;
};

function chainLink(
  link: FallbackLink,
  index: number,
  home: string,
  fetch?: typeof globalThis.fetch,
): ChainLink {
  return {
    id: linkId(link),
    label: linkLabel(link),
    kind: link.provider.kind,
    ...(link.provider.baseUrl === undefined ? {} : { baseUrl: link.provider.baseUrl }),
    // Link 0 keeps the caller's `call.model`: the loop and the light lane
    // already send the lane's configured slug.
    ...(index === 0 ? {} : { model: link.model }),
    create: () => connectionProvider(link.provider, home, fetch),
  };
}

/**
 * Runtime and online verification construct the same authenticated protocol.
 *
 * A lane with fallbacks becomes an ordered chain (ADR-0110); a lane without
 * them is the bare adapter, built eagerly exactly as before so a missing
 * primary secret still fails at construction.
 */
export function configuredProvider(
  config: Config,
  home: string,
  fetch?: typeof globalThis.fetch,
  lane: InferenceLane = 'main',
  options: ConfiguredProviderOptions = {},
): Provider {
  const chain = inferenceChain(config, lane);
  if (chain.length === 1) return connectionProvider(chain[0].provider, home, fetch);
  const links = chain.map((link, index) => chainLink(link, index, home, fetch)) as [
    ChainLink,
    ...ChainLink[],
  ];
  const initial = options.persistChainState ? readChainState(home).lanes[lane] : undefined;
  return providerChain(links, {
    lane,
    ...(initial === undefined ? {} : { initial }),
    ...(options.persistChainState
      ? {
          onState: (state) => writeLaneChainState(home, lane, state),
          refresh: chainStateWatcher(home, lane),
        }
      : {}),
    ...(options.onFailover ? { onFailover: options.onFailover } : {}),
  });
}
