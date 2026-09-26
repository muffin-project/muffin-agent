import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../../cli/init.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { ReasoningConfigurationError } from './reasoning.js';
import { ProviderError, type ChatCall, type ChatResult, type Provider } from './types.js';
import { PROBE_TOOL_NAME, VERIFY_MAX_OUTPUT_TOKENS, verifyInferenceRoute } from './verify.js';

/**
 * Falsifiers for #523: one reusable inference-verification primitive.
 *
 * Every test below is written to go red on a specific lie:
 *
 * - A: valid config + valid route + expected tool call => working.
 * - B: invalid/revoked credential => not working, no credential leak.
 * - C: text-only success without the required tool call => incompatible.
 * - D: provider route explicitly rejecting tools => incompatible.
 * - E: timeout => bounded failure. F: unreachable => separate from incompatible.
 * - G: `openrouter/free` keeps requested identity, captures resolved.
 * - H: a concrete non-router keeps requested/resolved semantics honest.
 * - I: the probe creates no Session/Memory/Turn artifacts.
 * - L: replacing the provider request with "config exists" fails acceptance.
 * - M: a canary secret echoed by the provider never leaks into the result.
 *
 * (J/K live in `cli/doctor-online.test.ts`: offline never calls the probe,
 * `--online` uses this same primitive.)
 *
 * The wire-level tests (A–C, G–H) run against the REAL production adapters
 * with a faked fetch — the proof is that the bytes the adapter sends carry
 * `tool_choice: required` and the synthetic tool, and that the served model
 * survives on `ChatResult.model`. Classification edges (D–F, M) inject stub
 * providers that throw exactly what the adapters throw.
 */

const CANARY = 'CANARY-SECRET-9f8e7d6c5b4a';
const NONCE = 'test-nonce-1234abcd';

type OpenAIToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

function openaiCompletion(overrides: {
  model?: string;
  text?: string | null;
  toolCalls?: OpenAIToolCall[];
  finish?: string;
} = {}) {
  return {
    id: 'chatcmpl-probe',
    model: overrides.model ?? 'openrouter/some-model',
    choices: [
      {
        message: {
          content: overrides.text ?? null,
          tool_calls: overrides.toolCalls ?? [],
        },
        finish_reason: overrides.finish ?? (overrides.toolCalls?.length ? 'tool_calls' : 'stop'),
      },
    ],
    usage: { prompt_tokens: 40, completion_tokens: 12 },
  };
}

function probeToolCall(nonce: string = NONCE): OpenAIToolCall {
  return {
    id: 'call_probe_1',
    type: 'function',
    function: { name: PROBE_TOOL_NAME, arguments: JSON.stringify({ nonce }) },
  };
}

/** A fetch fake recording request bodies and answering every URL identically. */
function openaiFetch(completion: unknown, bodies: unknown[]) {
  return (async (_url: unknown, init?: { body?: string }): Promise<Response> => {
    bodies.push(JSON.parse(init?.body ?? '{}'));
    return new Response(JSON.stringify(completion), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
}

function errorFetch(status: number, body: unknown, bodies: unknown[]) {
  return (async (_url: unknown, init?: { body?: string }): Promise<Response> => {
    bodies.push(JSON.parse(init?.body ?? '{}'));
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
}

function anthropicFetch(message: unknown, sent: unknown[]) {
  return (async (_url: unknown, init?: { body?: string }): Promise<Response> => {
    sent.push(JSON.parse(init?.body ?? '{}'));
    return new Response(JSON.stringify(message), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
}

/** Temp home with a real config + secret, so the config/secret path is exercised. */
function configuredHome(secret: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-verify-'));
  vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'xdg'));
  runInit({ home: dir, provider: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1', apiKey: secret });
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('verify · A: valid route + expected tool call => working', () => {
  it('passes through the production openai-compat adapter with a forced probe tool', async () => {
    const bodies: unknown[] = [];
    const provider = new OpenAICompatProvider('sk-test', 'https://openrouter.ai/api/v1', {}, {
      fetch: openaiFetch(openaiCompletion({ toolCalls: [probeToolCall()] }), bodies),
      metadataFetch: openaiFetch({ data: { id: 'openrouter/some-model' } }, []),
    });
    const result = await verifyInferenceRoute({
      provider,
      providerKind: 'openai-compat',
      model: 'openrouter/some-model',
      nonce: NONCE,
      timeoutMs: 5_000,
    });

    expect(result.status).toBe('working');
    expect(result.capability).toEqual({ completion: 'pass', toolCall: 'pass' });
    expect(result.requestedModel).toBe('openrouter/some-model');
    expect(result.resolvedModel).toBe('openrouter/some-model');

    // The proof actually went on the wire as a forced tool call, once, tiny.
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      model: 'openrouter/some-model',
      max_tokens: VERIFY_MAX_OUTPUT_TOKENS,
      tool_choice: 'required',
    });
    const tools = (bodies[0] as { tools: { function: { name: string } }[] }).tools;
    expect(tools.map((t) => t.function.name)).toContain(PROBE_TOOL_NAME);
  });

  it('passes through the production anthropic adapter too', async () => {
    const sent: unknown[] = [];
    const provider = new AnthropicProvider('sk-test', 'https://api.anthropic.test', {
      fetch: anthropicFetch(
        {
          id: 'msg_probe',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-5',
          content: [{ type: 'tool_use', id: 'toolu_probe', name: PROBE_TOOL_NAME, input: { nonce: NONCE } }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 40, output_tokens: 12 },
        },
        sent,
      ),
    });
    const result = await verifyInferenceRoute({
      provider,
      providerKind: 'anthropic',
      model: 'claude-sonnet-5',
      nonce: NONCE,
      timeoutMs: 5_000,
    });

    expect(result.status).toBe('working');
    expect(result.capability).toEqual({ completion: 'pass', toolCall: 'pass' });
    expect(sent[0]).toMatchObject({ tool_choice: { type: 'any' } });
  });
});

describe('verify · B: revoked credential => auth_failed, no leak', () => {
  it('fails through the real config+secret path and redacts the echoed key', async () => {
    const dir = configuredHome(CANARY);
    try {
      const bodies: unknown[] = [];
      const result = await verifyInferenceRoute({
        home: dir,
        // The provider echoes the stored key inside its error body, as real
        // providers sometimes do with "invalid key <prefix>" messages.
        fetch: errorFetch(401, { error: { code: 401, message: `invalid API key: ${CANARY}` } }, bodies),
        timeoutMs: 5_000,
      });
      expect(result.status).toBe('auth_failed');
      expect(result.capability).toEqual({ completion: 'fail', toolCall: 'fail' });
      expect(JSON.stringify(result)).not.toContain(CANARY);
      expect(result.remedy).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('verify · C+D: text-only or tool-rejecting routes => incompatible', () => {
  it('C: a successful prose answer without the probe tool call is incompatible, not working', async () => {
    const bodies: unknown[] = [];
    const provider = new OpenAICompatProvider('sk-test', 'https://openrouter.ai/api/v1', {}, {
      fetch: openaiFetch(openaiCompletion({ text: 'Yes, I support tools, trust me.', toolCalls: [] }), bodies),
      metadataFetch: openaiFetch({ data: { id: 'm' } }, []),
    });
    const result = await verifyInferenceRoute({ provider, providerKind: 'openai-compat', model: 'm', nonce: NONCE, timeoutMs: 5_000 });
    expect(result.status).toBe('incompatible');
    expect(result.capability).toEqual({ completion: 'pass', toolCall: 'fail' });
  });

  it('C: a wrong tool name is incompatible even when a tool call exists', async () => {
    const bodies: unknown[] = [];
    const provider = new OpenAICompatProvider('sk-test', 'https://openrouter.ai/api/v1', {}, {
      fetch: openaiFetch(
        openaiCompletion({
          toolCalls: [{ id: 'c1', type: 'function', function: { name: 'some_other_tool', arguments: JSON.stringify({ nonce: NONCE }) } }],
        }),
        bodies,
      ),
      metadataFetch: openaiFetch({ data: { id: 'm' } }, []),
    });
    const result = await verifyInferenceRoute({ provider, providerKind: 'openai-compat', model: 'm', nonce: NONCE, timeoutMs: 5_000 });
    expect(result.status).toBe('incompatible');
  });

  it('C: mismatched nonce args are incompatible', async () => {
    const bodies: unknown[] = [];
    const provider = new OpenAICompatProvider('sk-test', 'https://openrouter.ai/api/v1', {}, {
      fetch: openaiFetch(openaiCompletion({ toolCalls: [probeToolCall('attacker-nonce!!')] }), bodies),
      metadataFetch: openaiFetch({ data: { id: 'm' } }, []),
    });
    const result = await verifyInferenceRoute({ provider, providerKind: 'openai-compat', model: 'm', nonce: NONCE, timeoutMs: 5_000 });
    expect(result.status).toBe('incompatible');
  });

  it('D: a route explicitly rejecting tools classifies as incompatible, not provider_error', async () => {
    const stub: Provider = {
      kind: 'openai-compat',
      chat: async () => {
        throw new ProviderError('400 This model does not support tools or tool_choice', false, 400);
      },
    };
    const result = await verifyInferenceRoute({ provider: stub, providerKind: 'openai-compat', model: 'text-only-thing', timeoutMs: 5_000 });
    expect(result.status).toBe('incompatible');
  });

  it('D: malformed tool arguments (output, not transport) are incompatible', async () => {
    const stub: Provider = {
      kind: 'openai-compat',
      chat: async () => {
        throw new ProviderError('malformed tool arguments from muffin_probe', true, undefined, 'output');
      },
    };
    const result = await verifyInferenceRoute({ provider: stub, providerKind: 'openai-compat', model: 'm', timeoutMs: 5_000 });
    expect(result.status).toBe('incompatible');
  });
});

describe('verify · E+F: bounded timeout vs unreachable', () => {
  it('E: a hanging provider fails as timeout, bounded by our own signal', async () => {
    const stub: Provider = {
      kind: 'openai-compat',
      chat: (call: ChatCall) =>
        new Promise<ChatResult>((_resolve, reject) => {
          call.signal?.addEventListener('abort', () => reject(new ProviderError('aborted', false)));
        }),
    };
    const started = Date.now();
    const result = await verifyInferenceRoute({ provider: stub, providerKind: 'openai-compat', model: 'm', timeoutMs: 60 });
    expect(result.status).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('F: a network failure is unreachable, distinct from incompatible', async () => {
    const down: Provider = {
      kind: 'openai-compat',
      chat: async () => {
        throw new TypeError('fetch failed');
      },
    };
    const refused: Provider = {
      kind: 'openai-compat',
      chat: async () => {
        throw new ProviderError('fetch failed', true);
      },
    };
    for (const provider of [down, refused]) {
      const result = await verifyInferenceRoute({ provider, providerKind: 'openai-compat', model: 'm', timeoutMs: 5_000 });
      expect(result.status).toBe('unreachable');
    }
  });

  it('provider-side 5xx stays provider_error, not unreachable and not incompatible', async () => {
    const stub: Provider = {
      kind: 'openai-compat',
      chat: async () => {
        throw new ProviderError('500 overloaded', true, 500);
      },
    };
    const result = await verifyInferenceRoute({ provider: stub, providerKind: 'openai-compat', model: 'm', timeoutMs: 5_000 });
    expect(result.status).toBe('provider_error');
  });
});

describe('verify · G+H: requested vs resolved model identity', () => {
  it('G: openrouter/free keeps its requested identity and captures the served model', async () => {
    const bodies: unknown[] = [];
    const served = 'qwen/qwen3-235b-a22b-2507';
    const provider = new OpenAICompatProvider('sk-test', 'https://openrouter.ai/api/v1', {}, {
      fetch: openaiFetch(openaiCompletion({ model: served, toolCalls: [probeToolCall()] }), bodies),
      metadataFetch: openaiFetch({ data: { id: 'openrouter/free' } }, []),
    });
    const result = await verifyInferenceRoute({ provider, providerKind: 'openai-compat', model: 'openrouter/free', nonce: NONCE, timeoutMs: 5_000 });

    expect(result.status).toBe('working');
    expect(result.requestedModel).toBe('openrouter/free');
    expect(result.resolvedModel).toBe(served);
    // The probe exercised the real router path: no concrete model preselected.
    expect(bodies[0]).toMatchObject({ model: 'openrouter/free' });
  });

  it('H: a concrete non-router answers as itself, honestly', async () => {
    const bodies: unknown[] = [];
    const provider = new OpenAICompatProvider('sk-test', 'https://openrouter.ai/api/v1', {}, {
      fetch: openaiFetch(openaiCompletion({ model: 'anthropic/claude-sonnet-5', toolCalls: [probeToolCall()] }), bodies),
      metadataFetch: openaiFetch({ data: { id: 'anthropic/claude-sonnet-5' } }, []),
    });
    const result = await verifyInferenceRoute({
      provider,
      providerKind: 'openai-compat',
      model: 'anthropic/claude-sonnet-5',
      nonce: NONCE,
      timeoutMs: 5_000,
    });
    expect(result.status).toBe('working');
    expect(result.requestedModel).toBe('anthropic/claude-sonnet-5');
    expect(result.resolvedModel).toBe('anthropic/claude-sonnet-5');
  });

  it('the production adapters preserve the wire response model without changing normal behaviour', async () => {
    // If the adapter dropped the provider-returned model, G could not observe
    // the served route. This pins the seam the probe relies on.
    const bodies: unknown[] = [];
    const provider = new OpenAICompatProvider('sk-test', 'https://openrouter.ai/api/v1', {}, {
      fetch: openaiFetch(
        openaiCompletion({ model: 'served/actual-model', text: 'noted', toolCalls: [probeToolCall()] }),
        bodies,
      ),
      metadataFetch: openaiFetch({ data: { id: 'openrouter/free' } }, []),
    });
    const result = await provider.chat({
      model: 'openrouter/free',
      system: [{ type: 'text', text: 's' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      maxOutputTokens: 10,
      stream: false,
    });
    expect(result.model).toBe('served/actual-model');
    // Normal behaviour untouched: text and parsed tool calls still map.
    expect(result.text).toBe('noted');
    expect(result.toolCalls).toEqual([{ id: 'call_probe_1', name: PROBE_TOOL_NAME, args: { nonce: NONCE } }]);
  });
});

describe('verify · I: no conversation side effects', () => {
  function snapshot(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        out.push(full);
        if (entry.isDirectory()) walk(full);
      }
    };
    walk(dir);
    return out.sort();
  }

  it('creates no Session/Memory/Turn artifacts on the home', async () => {
    const dir = configuredHome('sk-never-used');
    try {
      const before = snapshot(dir);
      const stub: Provider = {
        kind: 'openai-compat',
        chat: async (): Promise<ChatResult> => ({
          text: null,
          toolCalls: [{ id: 'c1', name: PROBE_TOOL_NAME, args: { nonce: NONCE } }],
          stopReason: 'tool_use',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          model: 'm',
        }),
      };
      await verifyInferenceRoute({ home: dir, provider: stub, providerKind: 'openai-compat', model: 'm', nonce: NONCE, timeoutMs: 5_000 });
      expect(snapshot(dir)).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sits below the agent loop layers: no Session/Memory/Turn/Work imports', () => {
    const source = readFileSync(new URL('./verify.ts', import.meta.url), 'utf8');
    const imports = source.split('\n').filter((line) => /^\s*import[ (]/.test(line));
    for (const banned of ['session/store', 'memory/', 'turns/store', 'agent/loop', '/tools/']) {
      expect(imports.join('\n')).not.toContain(banned);
    }
    expect(source).not.toContain('await import(');
  });
});

describe('verify · L: mutation — "config exists" must fail acceptance', () => {
  it('a sham that returns working from config presence alone disagrees with the probe on text-only', async () => {
    const textOnly: Provider = {
      kind: 'openai-compat',
      chat: async (): Promise<ChatResult> => ({
        text: 'I can help with that.',
        toolCalls: [],
        stopReason: 'end',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: 'm',
      }),
    };
    // The mutation: replace the real provider call with "config exists".
    const sham = { status: 'working' as const };
    const real = await verifyInferenceRoute({ provider: textOnly, providerKind: 'openai-compat', model: 'm', nonce: NONCE, timeoutMs: 5_000 });
    expect(sham.status).toBe('working');
    expect(real.status).toBe('incompatible');
  });
});

describe('verify · M: secrets never leak', () => {
  it('a canary echoed in a provider error never reaches the structured result', async () => {
    const stub: Provider = {
      kind: 'openai-compat',
      chat: async () => {
        throw new ProviderError(`401 invalid API key provided: ${CANARY}`, false, 401);
      },
    };
    const result = await verifyInferenceRoute({
      provider: stub,
      providerKind: 'openai-compat',
      model: 'm',
      secrets: [CANARY],
      timeoutMs: 5_000,
    });
    expect(result.status).toBe('auth_failed');
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it('bearer material and sk-like tokens are pattern-redacted even when unknown', async () => {
    const stub: Provider = {
      kind: 'openai-compat',
      chat: async () => {
        throw new ProviderError('500 upstream said Authorization: Bearer sk-abc123xyz456789 and died', true, 500);
      },
    };
    const result = await verifyInferenceRoute({ provider: stub, providerKind: 'openai-compat', model: 'm', timeoutMs: 5_000 });
    const dumped = JSON.stringify(result);
    expect(dumped).not.toContain('sk-abc123xyz456789');
    expect(dumped).not.toContain('Bearer sk-');
  });

  it('a missing secret classifies as misconfigured before any network happens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-verify-nokey-'));
    // Stubbed so the probe cannot see the developer machine's real keychain:
    // without this the test would prove the developer's machine, not the product.
    vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'xdg'));
    try {
      const bodies: unknown[] = [];
      runInit({ home: dir, provider: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1' });
      const result = await verifyInferenceRoute({
        home: dir,
        fetch: openaiFetch(openaiCompletion({ toolCalls: [probeToolCall()] }), bodies),
        timeoutMs: 5_000,
      });
      expect(result.status).toBe('misconfigured');
      expect(bodies).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a reasoning-configuration rejection does not leak and is not misreported as working', async () => {
    const stub: Provider = {
      kind: 'openai-compat',
      chat: async () => {
        throw new ReasoningConfigurationError({
          status: 'unsupported',
          capabilitySource: 'unknown',
          reason: 'reasoning off refused',
        });
      },
    };
    const result = await verifyInferenceRoute({ provider: stub, providerKind: 'openai-compat', model: 'm', timeoutMs: 5_000 });
    expect(result.status).not.toBe('working');
  });
});
