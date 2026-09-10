import type { ReasoningCapabilities, ReasoningCapabilitySource } from './reasoning.js';

export type OpenRouterReasoningMetadata = {
  id?: string;
  canonical_slug?: string;
  reasoning?: {
    mandatory?: boolean;
    default_enabled?: boolean;
    default_effort?: string;
    supported_efforts?: string[];
    supports_max_tokens?: boolean;
  };
  supported_parameters?: string[];
};

type CachedMetadata = { metadata: OpenRouterReasoningMetadata; expiresAt: number };

export type OpenRouterDiscoveryResult = {
  capabilities: ReasoningCapabilities;
  source: ReasoningCapabilitySource;
  canonicalModel?: string | undefined;
};

export const DEFAULT_OPENROUTER_REASONING_TTL_MS = 6 * 60 * 60 * 1000;

/** Small in-memory model metadata cache; it is deliberately not a general cache framework. */
export class OpenRouterReasoningDiscovery {
  private readonly cache = new Map<string, CachedMetadata>();

  constructor(
    private readonly opts: {
      fetch?: typeof globalThis.fetch;
      now?: () => number;
      ttlMs?: number;
      headers?: Record<string, string>;
    } = {},
  ) {}

  async resolve(baseURL: string, model: string): Promise<OpenRouterDiscoveryResult> {
    const key = this.key(baseURL, model);
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.expiresAt > this.now()) {
      return this.fromMetadata(cached.metadata, 'openrouter-cache');
    }

    try {
      const metadata = await this.fetchMetadata(baseURL, model);
      const expiresAt = this.now() + (this.opts.ttlMs ?? DEFAULT_OPENROUTER_REASONING_TTL_MS);
      this.cache.set(key, { metadata, expiresAt });
      const canonical = metadata.canonical_slug ?? metadata.id;
      if (canonical !== undefined) this.cache.set(this.key(baseURL, canonical), { metadata, expiresAt });
      const discovered = this.fromMetadata(metadata, 'openrouter-live');
      if (discovered.capabilities.support === 'unknown') return discovered;
      return discovered;
    } catch {
      return { capabilities: unknownCapabilities(), source: 'unknown' };
    }
  }

  seed(baseURL: string, model: string, metadata: OpenRouterReasoningMetadata): void {
    this.cache.set(this.key(baseURL, model), { metadata, expiresAt: this.now() + (this.opts.ttlMs ?? DEFAULT_OPENROUTER_REASONING_TTL_MS) });
  }

  private async fetchMetadata(baseURL: string, model: string): Promise<OpenRouterReasoningMetadata> {
    const parts = model.split('/');
    if (parts.length !== 2 || parts.some((part) => part.length === 0)) throw new Error('OpenRouter model must be author/slug');
    const url = `${baseURL.replace(/\/$/, '')}/model/${encodeURIComponent(parts[0]!)}/${encodeURIComponent(parts[1]!)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await (this.opts.fetch ?? globalThis.fetch)(url, {
        headers: { accept: 'application/json', ...(this.opts.headers ?? {}) },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`OpenRouter metadata returned ${response.status}`);
      const body = (await response.json()) as { data?: OpenRouterReasoningMetadata };
      if (body.data === undefined || typeof body.data !== 'object') throw new Error('OpenRouter metadata missing data');
      return body.data;
    } finally {
      clearTimeout(timeout);
    }
  }

  private fromMetadata(metadata: OpenRouterReasoningMetadata, source: ReasoningCapabilitySource): OpenRouterDiscoveryResult {
    const reasoning = metadata.reasoning;
    if (reasoning === undefined) return { capabilities: unknownCapabilities(), source, ...(metadata.canonical_slug ?? metadata.id ? { canonicalModel: metadata.canonical_slug ?? metadata.id } : {}) };
    return {
      source,
      ...(metadata.canonical_slug ?? metadata.id ? { canonicalModel: metadata.canonical_slug ?? metadata.id } : {}),
      capabilities: {
        support: 'supported',
        canDisable: reasoning.mandatory !== true,
        ...(reasoning.supported_efforts === undefined ? {} : { supportedEfforts: reasoning.supported_efforts.filter(isReasoningEffort) }),
        ...(reasoning.default_enabled === undefined ? {} : { defaultEnabled: reasoning.default_enabled }),
        ...(reasoning.default_effort !== undefined && isReasoningEffort(reasoning.default_effort) ? { defaultEffort: reasoning.default_effort } : {}),
        supportsMaxTokens: reasoning.supports_max_tokens === true,
        mandatory: reasoning.mandatory === true,
      },
    };
  }

  private key(baseURL: string, model: string): string {
    return `${baseURL.replace(/\/$/, '').toLowerCase()}|${model.toLowerCase()}`;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
}

function unknownCapabilities(): ReasoningCapabilities {
  return { support: 'unknown', canDisable: false, supportsMaxTokens: false, mandatory: false };
}

function isReasoningEffort(value: string): value is NonNullable<ReasoningCapabilities['supportedEfforts']>[number] {
  return ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value);
}
