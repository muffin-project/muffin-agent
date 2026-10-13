import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

export const CHATGPT_E2E_MODEL = 'gpt-6.1-sol';
export const CHATGPT_E2E_MAX_REQUESTS = 10;
export const CHATGPT_E2E_MAX_WALL_MS = 180_000;

export function selectChatGptModel(chatgptRoot, requestedModel) {
  if (chatgptRoot && requestedModel !== undefined && requestedModel !== CHATGPT_E2E_MODEL)
    throw new Error('ChatGPT E2E pins gpt-6.1-sol and does not accept model overrides');
  return chatgptRoot ? CHATGPT_E2E_MODEL : requestedModel;
}

export function isSyntheticDirectInferenceMarker(marker) {
  return (
    marker?.synthetic === true &&
    marker?.ownerId === 12345 &&
    marker?.authScope === 'chatgpt.tokens.use.direct'
  );
}

export function responseToolSchemas(body) {
  if (!Array.isArray(body?.tools)) return [];
  const functions = body.tools.flatMap((tool) => {
    if (tool?.type === 'function') return [tool];
    if (tool?.type === 'namespace' && tool?.name === 'muffin' && Array.isArray(tool.tools))
      return tool.tools.filter((nested) => nested?.type === 'function');
    return [];
  });
  return functions.map((tool) => ({
    type: 'function',
    name:
      typeof tool.name === 'string' && tool.name.startsWith('muffin.')
        ? tool.name.slice(7)
        : tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    parameters: tool.parameters,
    ...(tool.strict === undefined ? {} : { strict: tool.strict }),
  }));
}

function completedCall(item) {
  if (
    item?.type !== 'function_call' ||
    (item.status !== undefined && item.status !== 'completed') ||
    typeof item.name !== 'string' ||
    typeof item.call_id !== 'string' ||
    typeof item.arguments !== 'string'
  )
    return null;
  let args;
  try {
    args = JSON.parse(item.arguments);
  } catch {
    return null;
  }
  return {
    id: item.call_id,
    name: item.name.startsWith('muffin.') ? item.name.slice(7) : item.name,
    arguments: args,
  };
}

export function parseResponsesSse(text) {
  const calls = new Map();
  let terminal = null;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') continue;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event.type === 'response.output_item.done') {
      const call = completedCall(event.item);
      if (call) calls.set(call.id, call);
    } else if (event.type === 'response.completed') {
      terminal = event.response;
      for (const item of terminal?.output ?? []) {
        const call = completedCall(item);
        if (call) calls.set(call.id, call);
      }
    }
  }
  return {
    terminal,
    toolCalls: terminal?.status === 'completed' ? [...calls.values()] : [],
  };
}

export function completedResponseViolation(terminal, requestedModel) {
  if (terminal?.status !== 'completed') return null;
  return terminal.model === requestedModel
    ? null
    : 'provider served a model different from the fixed ChatGPT pin';
}

export function responsesRequestViolation({ body, index, count, startedAt, now }) {
  if (count >= CHATGPT_E2E_MAX_REQUESTS || now - startedAt > CHATGPT_E2E_MAX_WALL_MS)
    return 'Responses request/time budget exceeded';
  if (body?.model !== CHATGPT_E2E_MODEL) return 'requested model differs from fixed ChatGPT pin';
  if (index === 0 && responseToolSchemas(body).some((tool) => tool.name === 'fs_write'))
    return 'fs_write present in first provider request';
  return null;
}

export function installChatGptWireRecorder({ wirePath, controlPath, expectedModel }) {
  const startedAt = readControl(controlPath).startedAt ?? Date.now();
  const originalFetch = globalThis.fetch;
  const append = (value) => appendFileSync(wirePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  const updateControl = (changes) => {
    const current = readControl(controlPath);
    writeFileSync(
      controlPath,
      JSON.stringify({ ...current, ...changes, elapsedMs: Date.now() - startedAt }),
      { mode: 0o600 },
    );
  };
  const fail = (message) => {
    updateControl({ violation: readControl(controlPath).violation ?? message });
    throw new Error(`ChatGPT E2E stopped: ${message}`);
  };

  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    if (isAlternateInferenceUrl(url) && method === 'POST')
      return fail('alternate inference provider/model route attempted');
    if (!isResponsesUrl(url) || method !== 'POST') return originalFetch(input, init);

    let rawBody = typeof init?.body === 'string' ? init.body : null;
    if (rawBody === null && input instanceof Request) rawBody = await input.clone().text();
    if (typeof rawBody !== 'string' || Buffer.byteLength(rawBody) > 1_000_000)
      return fail('Responses request body missing or exceeds observer byte cap');
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return fail('Responses request body was not JSON');
    }
    const control = readControl(controlPath);
    const count = Number.isInteger(control.count) ? control.count : 0;
    const schemas = responseToolSchemas(body);
    const request = {
      kind: 'request',
      index: count,
      model: body.model ?? null,
      toolNames: schemas.map((tool) => tool.name),
      tools: schemas,
    };
    const violation = responsesRequestViolation({
      body,
      index: count,
      count,
      startedAt,
      now: Date.now(),
    });
    if (violation) request.rejected = violation;
    append(request);
    updateControl({
      count: count + 1,
      ...(violation ? { violation: control.violation ?? violation } : {}),
    });
    if (violation) throw new Error(`ChatGPT E2E request rejected: ${violation}`);

    const requestDeadline = AbortSignal.timeout(
      Math.max(1, CHATGPT_E2E_MAX_WALL_MS - (Date.now() - startedAt)),
    );
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, requestDeadline])
      : requestDeadline;
    const response = await originalFetch(input, { ...init, signal });
    if (!response.ok) {
      append({
        kind: 'response',
        index: request.index,
        status: response.status,
        model: null,
        toolCalls: [],
        completed: false,
      });
      if ([401, 402, 403].includes(response.status))
        updateControl({
          providerUnavailable: { kind: 'fatal-upstream-status', status: response.status },
        });
      return response;
    }
    if (!response.body) {
      append({
        kind: 'response',
        index: request.index,
        status: response.status,
        model: null,
        toolCalls: [],
        completed: false,
        observation: 'no-body',
      });
      return response;
    }
    let text = '';
    let size = 0;
    let truncated = false;
    const decoder = new TextDecoder();
    const observedBody = response.body.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          size += chunk.byteLength;
          if (!truncated && size <= 5_000_000) text += decoder.decode(chunk, { stream: true });
          else truncated = true;
          controller.enqueue(chunk);
        },
        flush() {
          const event = {
            kind: 'response',
            index: request.index,
            status: response.status,
            model: null,
            toolCalls: [],
          };
          if (truncated) event.observation = 'response observation byte cap exceeded';
          else {
            text += decoder.decode();
            const parsed = parseResponsesSse(text);
            event.model = typeof parsed.terminal?.model === 'string' ? parsed.terminal.model : null;
            event.toolCalls = parsed.toolCalls;
            event.completed = parsed.terminal?.status === 'completed';
            const modelViolation = completedResponseViolation(parsed.terminal, expectedModel);
            if (modelViolation)
              updateControl({ violation: readControl(controlPath).violation ?? modelViolation });
          }
          append(event);
          updateControl({});
        },
      }),
    );
    return new Response(observedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  updateControl({ startedAt, count: readControl(controlPath).count ?? 0 });
  return {
    close: async () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function isResponsesUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://api.openai.com' && url.pathname === '/v1/responses';
  } catch {
    return false;
  }
}

function isAlternateInferenceUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.hostname === 'openrouter.ai' ||
      url.hostname.endsWith('.openrouter.ai') ||
      url.hostname === 'api.anthropic.com' ||
      (url.hostname === 'api.openai.com' && url.pathname === '/v1/chat/completions')
    );
  } catch {
    return false;
  }
}

function readControl(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}
