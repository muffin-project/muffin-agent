/**
 * One provider-neutral reading of an OpenAI-compatible `GET {baseUrl}/models`
 * (#763).
 *
 * Self-hosted servers (llama-server, vLLM, Ollama, LM Studio, a proxy) accept
 * whatever model name a request carries: llama-server answers under any name
 * (measured with `--api-key`), so a typo or a model swapped on the server
 * passes silently. What such a server does expose is `/models`. This module is
 * the single HTTP reading of it; each consumer applies its own policy:
 *
 * - `probeLocalRuntime` (onboarding): loopback default, no credential, short
 *   timeout, any failure reads as "nothing to propose";
 * - `muffin model` (model management): the saved credential, and the result is
 *   advisory: a generic endpoint's list is evidence, not authority, because a
 *   proxy can expose a wildcard or incomplete list.
 *
 * The outcome keeps "not verified" apart from "does not exist": only `known`
 * says anything about which models are served. Redirects are not followed, so
 * the credential never travels past the configured endpoint.
 */

export type ModelDiscovery =
  /** The endpoint listed its models (possibly none). */
  | { status: 'known'; models: readonly string[] }
  /** The endpoint answered, but not with a usable model list (404, non-JSON, another shape). */
  | { status: 'unsupported'; detail: string }
  /** No answer to read: network, timeout, rejected credential, server error, redirect. */
  | { status: 'unreachable'; reason: 'network' | 'timeout' | 'auth' | 'http'; detail: string };

export type DiscoverOptions = {
  baseUrl: string;
  /** Sent as `Authorization: Bearer` when present and non-empty; never echoed in `detail`. */
  apiKey?: string | undefined;
  timeoutMs?: number | undefined;
  fetch?: typeof globalThis.fetch | undefined;
};

export const DISCOVERY_TIMEOUT_MS = 5_000;

export async function discoverOpenAICompatModels(opts: DiscoverOptions): Promise<ModelDiscovery> {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/models`;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: {
        accept: 'application/json',
        ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (timedOut)
      return {
        status: 'unreachable',
        reason: 'timeout',
        detail: `no answer within ${String(timeoutMs)}ms`,
      };
    const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
    return {
      status: 'unreachable',
      reason: 'network',
      detail:
        typeof cause === 'string' ? cause : error instanceof Error ? error.message : String(error),
    };
  }

  try {
    if (res.status === 401 || res.status === 403) {
      return {
        status: 'unreachable',
        reason: 'auth',
        detail: `HTTP ${String(res.status)}: credential rejected`,
      };
    }
    if (res.status >= 300 && res.status < 400) {
      return {
        status: 'unreachable',
        reason: 'http',
        detail: `HTTP ${String(res.status)}: redirect not followed`,
      };
    }
    if (res.status === 404 || res.status === 405 || res.status === 501) {
      return { status: 'unsupported', detail: `HTTP ${String(res.status)}: no model list here` };
    }
    if (!res.ok)
      return { status: 'unreachable', reason: 'http', detail: `HTTP ${String(res.status)}` };

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { status: 'unsupported', detail: 'the answer is not JSON' };
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return { status: 'unsupported', detail: 'the answer is not a model list' };
    }
    const data = (body as { data?: unknown }).data;
    // `null`/absent: a server with nothing loaded yet (an Ollama with no model
    // pulled). A list of zero, not a different shape.
    if (data === undefined || data === null) return { status: 'known', models: [] };
    if (!Array.isArray(data))
      return { status: 'unsupported', detail: 'the answer is not a model list' };
    const models: string[] = [];
    for (const entry of data) {
      const id = (entry as { id?: unknown } | null)?.id;
      if (typeof id === 'string' && id.length > 0 && !models.includes(id)) models.push(id);
    }
    return { status: 'known', models };
  } catch (error) {
    if (timedOut)
      return {
        status: 'unreachable',
        reason: 'timeout',
        detail: `no answer within ${String(timeoutMs)}ms`,
      };
    return {
      status: 'unreachable',
      reason: 'network',
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
