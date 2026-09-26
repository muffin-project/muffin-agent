import { randomBytes } from 'node:crypto';
import { ConfigError, loadConfig, readSecret, type Config } from '../../core/config/config.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { ReasoningConfigurationError } from './reasoning.js';
import { ProviderError, type Provider } from './types.js';

/**
 * One reusable inference-verification primitive (#523).
 *
 * The onboarding reconciliation found that install/bootstrap is shipped and the
 * OpenRouter OAuth PKCE core exists, but Muffin cannot prove that the selected
 * inference route actually works: `doctor --online` printed "online check not
 * implemented in M0" and init could declare setup complete without ever
 * performing a real model request. `configured != working`, and a plain text
 * answer is not proof of Muffin-compatible inference.
 *
 * This module is the single place that proof lives. Both future onboarding
 * slices and `muffin doctor --online` consume `verifyInferenceRoute` — no
 * second HTTP/provider client exists only for setup.
 *
 * Shape of the proof:
 *
 * - the probe constructs a normal bounded `ChatCall` through the production
 *   provider adapter seam (the same construction `agent/runtime.ts` uses:
 *   `readSecret` + `kind`/`baseUrl`/`routing`), with `toolChoice: 'required'`
 *   forcing one inert synthetic tool (`muffin_probe`, `{nonce}`).
 * - the route passes only when the provider request succeeds AND the expected
 *   tool call comes back with a matching name and valid, matching arguments.
 *   A text-only answer is `incompatible`, never `working`.
 * - the probe runs below the agent loop: no Turn, no Session history, no
 *   Memory/Episode/Belief, no Work, no capability execution. The synthetic
 *   tool is NEVER executed by the Kernel — producing the call is the proof.
 * - `requestedModel` is the configured identity (e.g. `openrouter/free`);
 *   `resolvedModel` is the actually served model the production adapter
 *   already preserves on `ChatResult.model` (the router's response `model`
 *   field). Requested is never replaced by resolved.
 * - bounded: tiny prompt, `VERIFY_MAX_OUTPUT_TOKENS` output allowance, one
 *   attempt (adapters already set `maxRetries: 0`), `VERIFY_TIMEOUT_MS`
 *   cancellation. No retry storm, no recovery ladder.
 * - diagnostics are curtailed and redacted: no secret values, no request or
 *   raw provider bodies, no prompt contents, no reasoning contents.
 */

export const PROBE_TOOL_NAME = 'muffin_probe';

/** Short on purpose: a capability probe, not a conversation. */
export const VERIFY_TIMEOUT_MS = 20_000;

/** Tiny output allowance: one tool call fits, prose does not need more. */
export const VERIFY_MAX_OUTPUT_TOKENS = 64;

export type VerificationStatus =
  | 'working'
  | 'misconfigured'
  | 'auth_failed'
  | 'unreachable'
  | 'timeout'
  | 'incompatible'
  | 'provider_error';

export type VerificationCapability = {
  completion: 'pass' | 'fail';
  toolCall: 'pass' | 'fail';
};

export type VerificationResult = {
  status: VerificationStatus;
  provider: 'anthropic' | 'openai-compat';
  requestedModel: string;
  /**
   * The actually served model, when the production adapter could observe it
   * (`ChatResult.model`, i.e. the wire response `model` field). Absent when
   * the provider reports none — never inferred from pricing or catalogue.
   */
  resolvedModel?: string | undefined;
  capability: VerificationCapability;
  /** Bounded, redacted diagnosis — safe to render and log. */
  diagnostic: string;
  /** Present whenever the owner has something to do about it. */
  remedy?: string | undefined;
  observedAt: string;
  durationMs: number;
};

export type VerifyInferenceOptions = {
  /** Home to load config/secret from. Defaults to the real muffin home. */
  home?: string | undefined;
  /** Already-loaded config; wins over `home`. */
  config?: Config | undefined;
  /**
   * Injected provider (tests, doctor). When present, no config or secret is
   * read and no provider is constructed — the probe still exercises the same
   * `Provider.chat` boundary the runtime uses.
   */
  provider?: Provider | undefined;
  providerKind?: 'anthropic' | 'openai-compat' | undefined;
  /** Requested model identity; defaults to `config.models.main`. */
  model?: string | undefined;
  timeoutMs?: number | undefined;
  /** Deterministic nonce for tests; random bounded hex otherwise. */
  nonce?: string | undefined;
  /**
   * Injected fetch for constructed providers (tests). Passed as both the chat
   * fetch and the OpenRouter reasoning-metadata fetch so the probe never
   * touches the real network when faked.
   */
  fetch?: typeof globalThis.fetch | undefined;
  /** Extra values to redact (e.g. a canary that is not the stored secret). */
  secrets?: string[] | undefined;
};

/**
 * Verify that the selected inference route satisfies Muffin's minimum
 * capability contract: a real request through the production adapter that
 * returns a structurally valid call to the synthetic probe tool.
 *
 * Exported for `doctor --online` today and the onboarding slices next: they
 * call this exact function rather than reimplementing it.
 */
export async function verifyInferenceRoute(opts: VerifyInferenceOptions = {}): Promise<VerificationResult> {
  const startedAt = Date.now();
  const observedAt = new Date(startedAt).toISOString();
  const timeoutMs = opts.timeoutMs ?? VERIFY_TIMEOUT_MS;
  const finish = (partial: Omit<VerificationResult, 'observedAt' | 'durationMs'>): VerificationResult => ({
    ...partial,
    observedAt,
    durationMs: Date.now() - startedAt,
  });

  let config: Config | undefined = opts.config;
  if (config === undefined && opts.provider === undefined) {
    try {
      config = loadConfig(opts.home);
    } catch (error) {
      return finish({
        status: 'misconfigured',
        provider: opts.providerKind ?? 'openai-compat',
        requestedModel: opts.model ?? '(unknown)',
        capability: { completion: 'fail', toolCall: 'fail' },
        diagnostic: redact(error instanceof Error ? error.message : String(error), opts.secrets ?? []),
        remedy: error instanceof ConfigError ? error.remedy : 'run `muffin init` first',
      });
    }
  }

  const requestedModel = opts.model ?? config?.models.main ?? '(unknown)';
  const providerKind = opts.providerKind ?? config?.provider.kind ?? 'openai-compat';

  let provider = opts.provider;
  const knownSecrets: string[] = [...(opts.secrets ?? [])];
  if (provider === undefined) {
    if (config === undefined) {
      return finish({
        status: 'misconfigured',
        provider: providerKind,
        requestedModel,
        capability: { completion: 'fail', toolCall: 'fail' },
        diagnostic: 'no config and no provider to verify',
        remedy: 'run `muffin init` first',
      });
    }
    let apiKey: string;
    try {
      apiKey = readSecret(config.provider.apiKeyRef, opts.home);
    } catch (error) {
      return finish({
        status: 'misconfigured',
        provider: config.provider.kind,
        requestedModel,
        capability: { completion: 'fail', toolCall: 'fail' },
        diagnostic: redact(error instanceof Error ? error.message : String(error), knownSecrets),
        remedy: error instanceof ConfigError ? error.remedy : 'set the key',
      });
    }
    if (apiKey.length === 0) {
      return finish({
        status: 'misconfigured',
        provider: config.provider.kind,
        requestedModel,
        capability: { completion: 'fail', toolCall: 'fail' },
        diagnostic: 'secret file is empty',
        remedy: 'write it with `muffin secret set`',
      });
    }
    knownSecrets.push(apiKey);
    // Same construction as `agent/runtime.ts#createMainProvider`: the probe
    // must exercise the same route real inference takes, not a lookalike.
    provider =
      config.provider.kind === 'anthropic'
        ? new AnthropicProvider(apiKey, config.provider.baseUrl, opts.fetch ? { fetch: opts.fetch } : {})
        : new OpenAICompatProvider(
            apiKey,
            config.provider.baseUrl,
            { 'HTTP-Referer': 'https://github.com/muffin-ai/muffin', 'X-Title': 'muffin' },
            {
              ...(config.provider.routing ? { routing: config.provider.routing } : {}),
              ...(opts.fetch ? { fetch: opts.fetch, metadataFetch: opts.fetch } : {}),
            },
          );
  }

  const nonce = opts.nonce ?? randomBytes(8).toString('hex');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // `true` only when OUR timer fired: the signal is ours, so an aborted
  // signal is our bounded timeout, whatever shape the adapter's error takes.
  let timedOut = false;
  controller.signal.addEventListener('abort', () => {
    timedOut = true;
  });

  try {
    const result = await provider.chat({
      model: requestedModel,
      system: [{ type: 'text', text: 'Muffin capability probe. Answer only by calling the probe tool.' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: `Call ${PROBE_TOOL_NAME} with nonce "${nonce}".` }] }],
      tools: [
        {
          name: PROBE_TOOL_NAME,
          description: 'Inert capability probe. Never executed; producing the call is the proof.',
          inputSchema: {
            type: 'object',
            properties: { nonce: { type: 'string', minLength: 8, maxLength: 64 } },
            required: ['nonce'],
            additionalProperties: false,
          },
        },
      ],
      // Forced through the provider-neutral `toolChoice` semantics both
      // adapters implement (openai-compat `required`, anthropic `any`): a
      // route that cannot place tool calls fails here instead of answering
      // in prose and looking healthy.
      toolChoice: 'required',
      maxOutputTokens: VERIFY_MAX_OUTPUT_TOKENS,
      stream: false,
      signal: controller.signal,
    });

    const resolvedModel = result.model.length > 0 ? result.model : undefined;
    const base = {
      provider: providerKind,
      requestedModel,
      ...(resolvedModel === undefined ? {} : { resolvedModel }),
    };
    const match = result.toolCalls.find((call) => call.name === PROBE_TOOL_NAME);
    if (match !== undefined && isMatchingProbeArgs(match.args, nonce)) {
      return finish({
        ...base,
        status: 'working',
        capability: { completion: 'pass', toolCall: 'pass' },
        diagnostic: describeRoute(requestedModel, resolvedModel),
      });
    }
    if (match !== undefined) {
      return finish({
        ...base,
        status: 'incompatible',
        capability: { completion: 'pass', toolCall: 'fail' },
        diagnostic: `route answered but the ${PROBE_TOOL_NAME} arguments did not match the probe contract`,
        remedy: 'pick a route that returns structurally valid tool calls, not just prose',
      });
    }
    return finish({
      ...base,
      status: 'incompatible',
      capability: { completion: 'pass', toolCall: 'fail' },
      diagnostic: 'route answered in prose without the required probe tool call: text generation is not Muffin-compatible inference',
      remedy: 'pick a route that supports tool calls (a text-only route is not enough)',
    });
  } catch (error) {
    if (timedOut || isAbortError(error)) {
      return finish({
        provider: providerKind,
        requestedModel,
        status: 'timeout',
        capability: { completion: 'fail', toolCall: 'fail' },
        diagnostic: `probe timed out after ${String(timeoutMs)}ms`,
        remedy: 'retry `muffin doctor --online`; if it persists, check provider.baseUrl and network',
      });
    }
    return finish(classifyProbeError(error, providerKind, requestedModel, knownSecrets));
  } finally {
    clearTimeout(timer);
  }
}

function isMatchingProbeArgs(args: unknown, nonce: string): boolean {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return false;
  return (args as { nonce?: unknown }).nonce === nonce;
}

function describeRoute(requested: string, resolved: string | undefined): string {
  if (resolved === undefined) return `${requested} answered the probe tool call (served model not reported)`;
  if (resolved === requested) return `${requested} answered the probe tool call`;
  return `${requested} answered the probe tool call as ${resolved}`;
}

function classifyProbeError(
  error: unknown,
  provider: 'anthropic' | 'openai-compat',
  requestedModel: string,
  secrets: string[],
): Omit<VerificationResult, 'observedAt' | 'durationMs'> {
  const base = { provider, requestedModel, capability: { completion: 'fail', toolCall: 'fail' } as VerificationCapability };
  if (error instanceof ConfigError) {
    return { ...base, status: 'misconfigured', diagnostic: redact(error.message, secrets), remedy: error.remedy };
  }
  if (error instanceof ReasoningConfigurationError) {
    return {
      ...base,
      status: 'provider_error',
      diagnostic: redact(`reasoning configuration rejected: ${error.message}`, secrets),
      remedy: 'check the model profile and retry',
    };
  }
  const status = error instanceof ProviderError ? error.status : undefined;
  const raw = redact(error instanceof Error ? error.message : String(error), secrets);
  if (status === 401 || status === 403 || (status === undefined && isAuthMessage(raw))) {
    return {
      ...base,
      status: 'auth_failed',
      diagnostic: `endpoint rejected the credential${status === undefined ? '' : ` (${String(status)})`} for ${requestedModel}`,
      remedy: 'check the stored key (never printed) and rotate it with `muffin secret set`',
    };
  }
  if (error instanceof ProviderError && error.source === 'output') {
    return {
      ...base,
      status: 'incompatible',
      diagnostic: `route produced an unusable tool call (${raw})`,
      remedy: 'pick a route that returns structurally valid tool calls',
    };
  }
  if (status === 404) {
    return {
      ...base,
      status: 'incompatible',
      diagnostic: `model ${requestedModel} not found on this endpoint`,
      remedy: 'pick an existing model with `muffin model`',
    };
  }
  if (status === 400 && isToolRejection(raw)) {
    return {
      ...base,
      status: 'incompatible',
      diagnostic: `endpoint rejected the tool-capable request (${raw})`,
      remedy: 'pick a route that supports tool calls (a text-only route is not enough)',
    };
  }
  if (isNetworkMessage(raw)) {
    return {
      ...base,
      status: 'unreachable',
      diagnostic: `endpoint did not answer (${raw})`,
      remedy: 'check network and provider.baseUrl, then retry',
    };
  }
  return {
    ...base,
    status: 'provider_error',
    diagnostic: redact(`provider failure${status === undefined ? '' : ` (${String(status)})`}: ${raw}`, secrets),
    remedy: 'retry later; if it persists, check the provider status page',
  };
}

function isAbortError(error: unknown): boolean {
  if (error instanceof ProviderError && error.message === 'aborted') return true;
  return error instanceof Error && error.name === 'AbortError';
}

/** Auth words only — matched against the already-redacted message. */
function isAuthMessage(message: string): boolean {
  return /unauthorized|invalid api key|invalid_api_key|authentication failed|authentication_error|forbidden/i.test(message);
}

/** A 400 that names the tool contract is a capability verdict, not a transport one. */
function isToolRejection(message: string): boolean {
  return /tool|function calling|function_call|parameter|schema|require_parameters|tool_choice/i.test(message);
}

function isNetworkMessage(message: string): boolean {
  return /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ENETUNREACH|socket hang up|network|getaddrinfo|DNS/i.test(
    message,
  );
}

/**
 * Curtailed redaction for anything that reaches the structured result.
 *
 * The diagnostic is built from curated sentences plus a short fragment of the
 * provider's own message — never the request body, never a raw provider body.
 * Known secret values are excised verbatim (a canary stored as the credential
 * is therefore removed even when the provider echoes it), bearer material and
 * key-like tokens are pattern-redacted, and the whole is truncated: a leak
 * cannot hide past the cut because nothing past the cut is kept.
 */
export function redact(raw: string, secrets: string[]): string {
  let out = raw;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  out = out
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/=]+/g, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9\-_]{8,}/g, '[redacted]')
    .replace(/api[_-]?key["'\s:=]+[A-Za-z0-9\-._~+/=]{8,}/gi, 'api_key [redacted]');
  return out.length > 300 ? `${out.slice(0, 300)}…` : out;
}
