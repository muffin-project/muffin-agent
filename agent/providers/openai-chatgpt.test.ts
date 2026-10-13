import { describe, expect, it } from 'vitest';
import type { ChatGPTModel } from '../../core/config/chatgpt-oauth.js';
import { OpenAIChatGPTProvider } from './openai-chatgpt.js';
import type { ChatCall } from './types.js';

const tool = {
  name: 'read_file',
  description: 'Read a file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
};

const CALL: ChatCall = {
  model: 'gpt-6.1-sol',
  maxOutputTokens: 321,
  stream: false,
  system: [{ type: 'text', text: 'Muffin system rules.' }],
  tools: [tool],
  messages: [
    { role: 'user', origin: 'owner', content: [{ type: 'text', text: 'Read the file.' }] },
  ],
};

function responseOutput(output: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    id: 'resp_abc',
    object: 'response',
    created_at: 1,
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: 'Muffin system rules.',
    model: CALL.model,
    output,
    parallel_tool_calls: true,
    store: false,
    tools: [],
    usage: {
      input_tokens: 17,
      input_tokens_details: { cached_tokens: 5, cache_write_tokens: 2 },
      output_tokens: 8,
      output_tokens_details: { reasoning_tokens: 3 },
      total_tokens: 25,
    },
    ...overrides,
  };
}

function event(type: string, fields: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: 1, ...fields })}\n\n`;
}

function sse(events: string[]): Response {
  return new Response(events.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function harness(
  events: string[],
  tokens = ['access-token'],
  models: ChatGPTModel[] = [
    {
      slug: CALL.model,
      displayName: 'GPT 6.1 Sol',
      supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'] as const,
      defaultReasoningLevel: 'low' as const,
    },
  ],
) {
  const requests: { url: string; authorization: string | null; body: Record<string, unknown> }[] =
    [];
  let accessCount = 0;
  let modelListCalls = 0;
  const provider = new OpenAIChatGPTProvider(
    {
      accessToken: async () => tokens[Math.min(accessCount++, tokens.length - 1)]!,
      listModels: async () => {
        modelListCalls += 1;
        return models;
      },
    },
    {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get('authorization'),
          body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
        });
        return sse(events);
      }) as typeof fetch,
    },
  );
  return { provider, requests, modelListCalls: () => modelListCalls };
}

describe('OpenAI ChatGPT plan Responses provider', () => {
  it('does not classify credential acquisition failures as retryable stream failures', async () => {
    let requests = 0;
    const provider = new OpenAIChatGPTProvider(
      {
        accessToken: async () => {
          throw new Error('synthetic private credential detail');
        },
        listModels: async () => [],
      },
      {
        fetch: (async () => {
          requests += 1;
          return sse([]);
        }) as typeof fetch,
      },
    );
    const error = await provider.chat(CALL).catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      name: 'ProviderError',
      retryable: false,
      message: 'ChatGPT access token unavailable',
    });
    expect(requests).toBe(0);
    expect(String(error)).not.toContain('private credential detail');
  });

  it.each([401, 403, 400])('does not make HTTP %s retryable', async (status) => {
    const provider = new OpenAIChatGPTProvider(
      { accessToken: async () => 'synthetic-token', listModels: async () => [] },
      {
        fetch: (async () =>
          new Response(JSON.stringify({ error: { message: 'synthetic rejection' } }), {
            status,
          })) as typeof fetch,
      },
    );
    await expect(provider.chat(CALL)).rejects.toMatchObject({
      name: 'ProviderError',
      status,
      retryable: false,
      source: 'transport',
    });
  });

  it('sends full semantic history to the public streaming endpoint and maps a completed response and usage', async () => {
    const output = [
      {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'The answer.' }],
      },
    ];
    const h = harness([
      event('response.created', {
        response: { id: 'resp_abc', model: CALL.model, status: 'in_progress' },
      }),
      event('response.output_text.delta', { delta: 'The ' }),
      event('response.output_text.delta', { delta: 'answer.' }),
      event('response.completed', { response: responseOutput(output) }),
    ]);
    const result = await h.provider.chat({
      ...CALL,
      temperature: 0,
      sampling: { temperature: 0, topP: 0.8 },
      messages: [
        { role: 'user', origin: 'owner', content: [{ type: 'text', text: 'Earlier question.' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer.' }] },
        { role: 'user', origin: 'harness', content: [{ type: 'text', text: 'Recovery control.' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_prior', name: 'read_file', input: { path: 'README.md' } },
          ],
        },
        {
          role: 'user',
          origin: 'tool',
          content: [{ type: 'tool_result', toolCallId: 'call_prior', content: 'file bytes' }],
        },
        { role: 'user', origin: 'owner', content: [{ type: 'text', text: 'Now summarize.' }] },
      ],
    });

    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({
      url: 'https://api.openai.com/v1/responses',
      authorization: 'Bearer access-token',
      body: {
        model: CALL.model,
        store: false,
        stream: true,
        instructions: 'Muffin system rules.',
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'Earlier question.' }] },
          { role: 'assistant', content: 'Earlier answer.' },
          { role: 'developer', content: [{ type: 'input_text', text: 'Recovery control.' }] },
          {
            type: 'function_call',
            namespace: 'muffin',
            call_id: 'call_prior',
            name: 'read_file',
            arguments: '{"path":"README.md"}',
          },
          { type: 'function_call_output', call_id: 'call_prior', output: 'file bytes' },
          { role: 'user', content: [{ type: 'input_text', text: 'Now summarize.' }] },
        ],
        tools: [
          { type: 'namespace', name: 'muffin', tools: [{ type: 'function', name: 'read_file' }] },
        ],
      },
    });
    expect(h.requests[0]!.body).not.toHaveProperty('max_output_tokens');
    expect(h.requests[0]!.body).not.toHaveProperty('temperature');
    expect(h.requests[0]!.body).not.toHaveProperty('top_p');
    expect(h.requests[0]!.body).toHaveProperty('include', ['reasoning.encrypted_content']);
    expect(result).toMatchObject({
      text: 'The answer.',
      model: CALL.model,
      requestId: 'resp_abc',
      finishReason: 'stop',
      stopReason: 'end',
      usage: {
        inputTokens: 17,
        outputTokens: 8,
        reasoningTokens: 3,
        cacheReadTokens: 5,
        cacheWriteTokens: 2,
      },
    });
    expect(result.model).toBe(CALL.model);
  });

  it('streams text and tool deltas, then emits done only after response.completed with parsed namespaced calls', async () => {
    const output = [
      {
        id: 'fc_item',
        type: 'function_call',
        call_id: 'call_next',
        namespace: 'muffin',
        name: 'read_file',
        arguments: '{"path":"notes.txt"}',
        status: 'completed',
      },
    ];
    const h = harness([
      event('response.output_text.delta', { delta: 'Checking.' }),
      event('response.output_item.added', {
        output_index: 2,
        item: {
          id: 'fc_item',
          type: 'function_call',
          call_id: 'call_next',
          namespace: 'muffin',
          name: 'read_file',
          arguments: '',
        },
      }),
      event('response.function_call_arguments.delta', {
        output_index: 2,
        item_id: 'fc_item',
        delta: '{"path":"notes.txt"}',
      }),
      event('response.output_item.done', { output_index: 2, item: output[0] }),
      event('response.completed', { response: responseOutput(output) }),
    ]);

    const result = await h.provider.chat({ ...CALL, stream: true });
    expect(result).toMatchObject({
      text: null,
      toolCalls: [{ id: 'call_next', name: 'read_file', args: { path: 'notes.txt' } }],
      stopReason: 'tool_use',
    });
    expect(h.requests).toHaveLength(1);
    expect('chatStream' in h.provider).toBe(false);
  });

  it('reconstructs completed output items when the terminal response envelope has an empty output', async () => {
    const reasoning = {
      id: 'rs_streamed',
      type: 'reasoning',
      summary: [],
      encrypted_content: 'opaque-reasoning',
      status: 'completed',
    };
    const functionCall = {
      id: 'fc_streamed',
      type: 'function_call',
      call_id: 'call_streamed',
      namespace: 'muffin',
      name: 'read_file',
      arguments: '{"path":"notes.txt"}',
      status: 'completed',
    };
    const message = {
      id: 'msg_streamed',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'I will read it.' }],
    };
    const h = harness([
      event('response.output_item.done', { output_index: 0, item: reasoning }),
      event('response.function_call_arguments.done', {
        output_index: 1,
        item_id: functionCall.id,
        arguments: functionCall.arguments,
      }),
      event('response.output_item.done', { output_index: 1, item: functionCall }),
      event('response.output_item.done', { output_index: 2, item: message }),
      event('response.completed', { response: responseOutput([]) }),
    ]);

    const result = await h.provider.chat(CALL);
    expect(result).toMatchObject({
      text: 'I will read it.',
      toolCalls: [{ id: 'call_streamed', name: 'read_file', args: { path: 'notes.txt' } }],
      finishReason: 'tool_calls',
      stopReason: 'tool_use',
      providerMetadata: {
        reasoning: { provider: 'openai-chatgpt', details: [reasoning] },
      },
    });
    expect(h.requests).toHaveLength(1);
  });

  it('rejects a tool item emitted after the completed terminal event', async () => {
    const h = harness([
      event('response.completed', { response: responseOutput([]) }),
      event('response.output_item.done', {
        output_index: 0,
        item: {
          id: 'fc_late',
          type: 'function_call',
          call_id: 'call_late',
          namespace: 'muffin',
          name: 'read_file',
          arguments: '{"path":"notes.txt"}',
          status: 'completed',
        },
      }),
    ]);
    await expect(h.provider.chat(CALL)).rejects.toMatchObject({
      name: 'ProviderError',
      retryable: false,
    });
    expect(h.requests).toHaveLength(1);
  });

  it('does not return a completed tool item when the stream ends before response.completed', async () => {
    const h = harness([
      event('response.output_item.done', {
        output_index: 0,
        item: {
          id: 'fc_truncated',
          type: 'function_call',
          call_id: 'call_truncated',
          namespace: 'muffin',
          name: 'read_file',
          arguments: '{"path":"notes.txt"}',
          status: 'completed',
        },
      }),
    ]);
    await expect(h.provider.chat(CALL)).rejects.toMatchObject({
      name: 'ProviderError',
      retryable: true,
      source: 'transport',
    });
    expect(h.requests).toHaveLength(1);
  });

  it('rejects duplicate completed output indexes instead of overwriting stream evidence', async () => {
    const item = {
      id: 'msg_duplicate',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'ok' }],
    };
    const h = harness([
      event('response.output_item.done', { output_index: 0, item }),
      event('response.output_item.done', { output_index: 0, item }),
      event('response.completed', { response: responseOutput([]) }),
    ]);
    await expect(h.provider.chat(CALL)).rejects.toMatchObject({
      source: 'output',
      retryable: false,
    });
  });

  it('preserves encrypted reasoning items as opaque provider metadata and resends them in the next full-history request', async () => {
    const reasoning = {
      id: 'rs_opaque',
      type: 'reasoning',
      summary: [],
      encrypted_content: 'encrypted-payload',
      status: 'completed',
    };
    const first = harness([
      event('response.completed', {
        response: responseOutput([
          reasoning,
          {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Done.' }],
          },
        ]),
      }),
    ]);
    const result = await first.provider.chat(CALL);
    expect(result.providerMetadata).toEqual({
      reasoning: { provider: 'openai-chatgpt', details: [reasoning] },
    });

    const second = harness([
      event('response.completed', {
        response: responseOutput([
          {
            id: 'msg_2',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Again.' }],
          },
        ]),
      }),
    ]);
    await second.provider.chat({
      ...CALL,
      messages: [
        {
          role: 'assistant',
          ...(result.providerMetadata ? { providerMetadata: result.providerMetadata } : {}),
          content: [{ type: 'text', text: 'Done.' }],
        },
        { role: 'user', content: [{ type: 'text', text: 'Again?' }] },
      ],
    });
    expect(second.requests[0]!.body.input).toEqual([
      reasoning,
      { role: 'assistant', content: 'Done.' },
      { role: 'user', content: [{ type: 'input_text', text: 'Again?' }] },
    ]);
  });

  it('omits adaptive and refuses unsupported off and exact reasoning token budgets', async () => {
    const h = harness([
      event('response.completed', {
        response: responseOutput([
          {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        ]),
      }),
    ]);
    await h.provider.chat({ ...CALL, reasoning: { mode: 'adaptive' } });
    expect(h.requests[0]!.body).not.toHaveProperty('reasoning');
    await expect(h.provider.chat({ ...CALL, reasoning: { mode: 'off' } })).rejects.toThrow(
      /cannot disable/i,
    );
    expect(
      await h.provider.resolveReasoning!({ ...CALL, reasoning: { mode: 'on', maxTokens: 50 } }),
    ).toMatchObject({ status: 'unsupported' });
    await expect(
      h.provider.chat({ ...CALL, reasoning: { mode: 'on', maxTokens: 50 } }),
    ).rejects.toThrow(/exact token budget/i);
    expect(h.requests).toHaveLength(1);
  });

  it('sends explicit off only when the account catalog advertises none', async () => {
    const h = harness(
      [event('response.completed', { response: responseOutput([]) })],
      ['access-token'],
      [
        {
          slug: CALL.model,
          displayName: 'GPT 6.1 Sol',
          supportedReasoningLevels: ['low', 'medium', 'high', 'none'],
        },
      ],
    );
    await h.provider.chat({ ...CALL, reasoning: { mode: 'off' } });
    await h.provider.chat({ ...CALL, reasoning: { mode: 'off' } });
    expect(h.requests[0]!.body).toMatchObject({ reasoning: { effort: 'none' } });
    expect(h.modelListCalls()).toBe(1);
  });

  it('refuses unsupported exact efforts and does not infer support from unknown catalog data', async () => {
    const known = harness(
      [],
      ['access-token'],
      [
        {
          slug: CALL.model,
          displayName: 'GPT 6.1 Sol',
          supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
      ],
    );
    await expect(
      known.provider.chat({ ...CALL, reasoning: { mode: 'on', effort: 'minimal' } }),
    ).rejects.toThrow(/effort minimal is not supported/i);
    expect(known.requests).toHaveLength(0);

    const h = harness([], ['access-token'], [{ slug: CALL.model, displayName: 'GPT 6.1 Sol' }]);
    await expect(
      h.provider.chat({ ...CALL, reasoning: { mode: 'on', effort: 'minimal' } }),
    ).rejects.toThrow(/unknown|supported/i);
    await expect(h.provider.chat({ ...CALL, reasoning: { mode: 'off' } })).rejects.toThrow(
      /unknown/i,
    );
    expect(h.requests).toHaveLength(0);
  });

  it('fetches a fresh access token per attempt and keeps the caller-pinned model', async () => {
    const h = harness(
      [
        event('response.completed', {
          response: responseOutput([
            {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'ok' }],
            },
          ]),
        }),
      ],
      ['token-one', 'token-two'],
    );
    await h.provider.chat(CALL);
    await h.provider.chat(CALL);
    expect(h.requests.map((request) => [request.authorization, request.body.model])).toEqual([
      ['Bearer token-one', 'gpt-6.1-sol'],
      ['Bearer token-two', 'gpt-6.1-sol'],
    ]);
  });

  it('rejects failed, incomplete, missing-terminal, malformed-tool, audio, and aborted responses', async () => {
    const failed = harness([
      event('response.failed', {
        response: {
          id: 'resp_fail',
          error: {
            code: 'subscription_sharing_usage_limit_exceeded',
            message: 'Usage limit reached',
          },
        },
      }),
    ]);
    const failure = await failed.provider.chat(CALL).catch((error: unknown) => error);
    expect(failure).toMatchObject({ retryable: false });
    expect((failure as Error).message).not.toContain('Usage limit reached');

    const incomplete = harness([
      event('response.incomplete', {
        response: { incomplete_details: { reason: 'max_output_tokens' } },
      }),
    ]);
    await expect(incomplete.provider.chat(CALL)).rejects.toThrow(/incomplete response/);

    const noTerminal = harness([event('response.output_text.delta', { delta: 'partial' })]);
    await expect(noTerminal.provider.chat(CALL)).rejects.toMatchObject({
      name: 'ProviderError',
      retryable: true,
      source: 'transport',
    });

    const invalidTool = harness([
      event('response.completed', {
        response: responseOutput([
          {
            id: 'fc',
            type: 'function_call',
            call_id: 'call_bad',
            name: 'muffin.read_file',
            arguments: '{bad',
            status: 'completed',
          },
        ]),
      }),
    ]);
    await expect(invalidTool.provider.chat(CALL)).rejects.toThrow(/invalid JSON arguments/);

    const substituted = harness([
      event('response.completed', {
        response: responseOutput(
          [
            {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'wrong model' }],
            },
          ],
          { model: 'other-model' },
        ),
      }),
    ]);
    await expect(substituted.provider.chat(CALL)).rejects.toThrow(
      /different from the pinned request model/,
    );

    const unexpectedNamespace = harness([
      event('response.completed', {
        response: responseOutput([
          {
            id: 'fc',
            type: 'function_call',
            call_id: 'call_bad',
            namespace: 'other',
            name: 'read_file',
            arguments: '{}',
            status: 'completed',
          },
        ]),
      }),
    ]);
    await expect(unexpectedNamespace.provider.chat(CALL)).rejects.toThrow(
      /unexpected function namespace/,
    );

    await expect(
      harness([]).provider.chat({
        ...CALL,
        messages: [
          { role: 'user', content: [{ type: 'audio', mediaType: 'audio/ogg', data: 'AA==' }] },
        ],
      }),
    ).rejects.toThrow(/does not support audio/);

    const controller = new AbortController();
    controller.abort();
    const aborted = harness([]);
    await expect(aborted.provider.chat({ ...CALL, signal: controller.signal })).rejects.toThrow(
      /aborted/,
    );

    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const streamingAbort = new OpenAIChatGPTProvider(
      {
        accessToken: async () => 'token',
        listModels: async () => [
          {
            slug: CALL.model,
            displayName: 'GPT 6.1 Sol',
            supportedReasoningLevels: ['low'],
          },
        ],
      },
      {
        fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
          requestStarted();
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                init?.signal?.addEventListener('abort', () => controller.close(), { once: true });
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          );
        }) as typeof fetch,
      },
    );
    const active = new AbortController();
    const pending = streamingAbort.chat({ ...CALL, signal: active.signal });
    await started;
    active.abort();
    await expect(pending).rejects.toThrow(/aborted/);
  });
});
