import { test, expect } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHATGPT_E2E_MAX_REQUESTS,
  CHATGPT_E2E_MODEL,
  completedResponseViolation,
  isSyntheticDirectInferenceMarker,
  installChatGptWireRecorder,
  parseResponsesSse,
  responseToolSchemas,
  responsesRequestViolation,
  selectChatGptModel,
} from './real-agent-chatgpt-wire.mjs';

test('ChatGPT route requires the exact model and synthetic marker', () => {
  assert.equal(selectChatGptModel(true, undefined), CHATGPT_E2E_MODEL);
  assert.throws(() => selectChatGptModel(true, 'gpt-6-sol'), /does not accept model overrides/);
  assert.equal(selectChatGptModel(false, 'openrouter/free'), 'openrouter/free');
  assert.equal(
    isSyntheticDirectInferenceMarker({
      synthetic: true,
      ownerId: 12345,
      authScope: 'chatgpt.tokens.use.direct',
    }),
    true,
  );
  assert.equal(
    isSyntheticDirectInferenceMarker({
      synthetic: true,
      ownerId: 7,
      authScope: 'chatgpt.tokens.use.direct',
    }),
    false,
  );
});

test('request recorder projects the actual Responses function schemas without prompt fields', () => {
  const schemas = responseToolSchemas({
    input: [{ role: 'user', content: 'must not be recorded' }],
    tools: [
      {
        type: 'function',
        name: 'capability_search',
        description: 'Discover a capability',
        parameters: { type: 'object' },
        strict: true,
      },
      { type: 'web_search' },
    ],
  });
  assert.deepEqual(schemas, [
    {
      type: 'function',
      name: 'capability_search',
      description: 'Discover a capability',
      parameters: { type: 'object' },
      strict: true,
    },
  ]);
  assert.equal(JSON.stringify(schemas).includes('must not be recorded'), false);
});

test('completed SSE tool calls survive an empty completed envelope, while incomplete streams expose none', () => {
  const call = {
    type: 'function_call',
    status: 'completed',
    name: 'muffin.fs_write',
    call_id: 'call-synthetic',
    arguments: '{"path":"shared-decisions.md","content":"synthetic"}',
  };
  const line = (value) => `data: ${JSON.stringify(value)}\n\n`;
  const emptyTerminal = parseResponsesSse(
    line({ type: 'response.output_item.done', output_index: 0, item: call }) +
      line({
        type: 'response.completed',
        response: { status: 'completed', model: CHATGPT_E2E_MODEL, output: [] },
      }),
  );
  assert.deepEqual(emptyTerminal.toolCalls, [
    {
      id: 'call-synthetic',
      name: 'fs_write',
      arguments: { path: 'shared-decisions.md', content: 'synthetic' },
    },
  ]);
  assert.deepEqual(
    parseResponsesSse(line({ type: 'response.output_item.done', item: call })).toolCalls,
    [],
  );
  assert.deepEqual(
    parseResponsesSse(
      line({ type: 'response.output_item.done', item: { ...call, status: 'in_progress' } }) +
        line({
          type: 'response.completed',
          response: { status: 'incomplete', model: CHATGPT_E2E_MODEL, output: [] },
        }),
    ).toolCalls,
    [],
  );
});

test('served model mismatch and the shared ten-request/time budget fail closed', () => {
  assert.equal(
    completedResponseViolation(
      { status: 'completed', model: CHATGPT_E2E_MODEL },
      CHATGPT_E2E_MODEL,
    ),
    null,
  );
  assert.match(
    completedResponseViolation({ status: 'completed', model: 'gpt-6-sol' }, CHATGPT_E2E_MODEL),
    /different from the fixed ChatGPT pin/,
  );
  const body = { model: CHATGPT_E2E_MODEL, tools: [] };
  assert.equal(
    responsesRequestViolation({
      body,
      index: 0,
      count: CHATGPT_E2E_MAX_REQUESTS,
      startedAt: 10,
      now: 11,
    }),
    'Responses request/time budget exceeded',
  );
  assert.equal(
    responsesRequestViolation({ body, index: 0, count: 0, startedAt: 10, now: 10 + 180_001 }),
    'Responses request/time budget exceeded',
  );
});

test('wire recorder streams the unchanged SSE body and shares the ten-request cap across installs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'muffin-chatgpt-wire-'));
  const wirePath = join(root, 'wire.jsonl');
  const controlPath = join(root, 'control.json');
  writeFileSync(wirePath, '');
  writeFileSync(controlPath, JSON.stringify({ startedAt: Date.now(), count: 0 }));
  const realFetch = globalThis.fetch;
  let forwarded = 0;
  const terminal = `data: ${JSON.stringify({
    type: 'response.completed',
    response: { status: 'completed', model: CHATGPT_E2E_MODEL, output: [] },
  })}\n\n`;
  globalThis.fetch = async () => {
    forwarded += 1;
    const split = Math.floor(terminal.length / 2);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(terminal.slice(0, split)));
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode(terminal.slice(split)));
            controller.close();
          }, 25);
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  };
  try {
    for (const calls of [5, 5]) {
      const recorder = installChatGptWireRecorder({
        wirePath,
        controlPath,
        expectedModel: CHATGPT_E2E_MODEL,
      });
      for (let index = 0; index < calls; index += 1) {
        const response = await globalThis.fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          body: JSON.stringify({ model: CHATGPT_E2E_MODEL, tools: [] }),
        });
        const reader = response.body.getReader();
        const first = await reader.read();
        expect(first.done).toBe(false);
        const rest = await new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(first.value);
              while (true) {
                const part = await reader.read();
                if (part.done) break;
                controller.enqueue(part.value);
              }
              controller.close();
            },
          }),
        ).text();
        expect(rest.length).toBeGreaterThan(0);
      }
      await recorder.close();
    }
    const thirdRecorder = installChatGptWireRecorder({
      wirePath,
      controlPath,
      expectedModel: CHATGPT_E2E_MODEL,
    });
    await expect(
      globalThis.fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        body: JSON.stringify({ model: CHATGPT_E2E_MODEL, tools: [] }),
      }),
    ).rejects.toThrow(/budget exceeded/);
    await thirdRecorder.close();
    expect(forwarded).toBe(CHATGPT_E2E_MAX_REQUESTS);
    const events = readFileSync(wirePath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.filter((event) => event.kind === 'request')).toHaveLength(11);
    expect(events.filter((event) => event.kind === 'response')).toHaveLength(10);
    expect(
      events
        .filter((event) => event.kind === 'response')
        .every((event) => event.model === CHATGPT_E2E_MODEL),
    ).toBe(true);
    expect(JSON.parse(readFileSync(controlPath, 'utf8')).count).toBe(11);
  } finally {
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test('installed recorder records a served-model mismatch as a fatal control violation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'muffin-chatgpt-mismatch-'));
  const wirePath = join(root, 'wire.jsonl');
  const controlPath = join(root, 'control.json');
  writeFileSync(wirePath, '');
  writeFileSync(controlPath, JSON.stringify({ startedAt: Date.now(), count: 0 }));
  const realFetch = globalThis.fetch;
  const body = `data: ${JSON.stringify({
    type: 'response.completed',
    response: { status: 'completed', model: 'gpt-6-sol', output: [] },
  })}\n\n`;
  globalThis.fetch = async () => new Response(body, { status: 200 });
  const recorder = installChatGptWireRecorder({
    wirePath,
    controlPath,
    expectedModel: CHATGPT_E2E_MODEL,
  });
  try {
    const response = await globalThis.fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model: CHATGPT_E2E_MODEL, tools: [] }),
    });
    await response.text();
    expect(JSON.parse(readFileSync(controlPath, 'utf8')).violation).toMatch(
      /different from the fixed ChatGPT pin/,
    );
    const records = readFileSync(wirePath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records.find((event) => event.kind === 'response').model).toBe('gpt-6-sol');
    expect(JSON.stringify(records)).not.toMatch(/authorization|bearer|api[_-]?key|input|prompt/i);
  } finally {
    await recorder.close();
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
