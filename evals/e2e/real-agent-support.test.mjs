import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  budgetReason,
  cleanOwnedRoot,
  DEFAULT_FREE_MODEL,
  negativeOracle,
  positiveOracle,
  providerAvailabilityResult,
  REAL_AGENT_EXPECTED,
  REAL_LIMITS,
  readBoundedJson,
  readExplicitApiKeyFile,
  runnerStopResult,
  selectFreeModel,
  servedModelViolation,
  startRecorder,
  stopOwnedProcess,
} from './real-agent-support.mjs';

test('budget blocks the eleventh completion, the 180s boundary, and aggregate input overflow', () => {
  const startedAt = 1_000;
  assert.equal(
    budgetReason({
      count: REAL_LIMITS.completionRequests - 1,
      startedAt,
      inputBytesSoFar: 20,
      requestBytes: 30,
      now: 2_000,
    }),
    null,
  );
  assert.equal(
    budgetReason({
      count: REAL_LIMITS.completionRequests,
      startedAt,
      inputBytesSoFar: 20,
      requestBytes: 30,
      now: 2_000,
    }),
    'completion-request limit',
  );
  assert.equal(
    budgetReason({
      count: 0,
      startedAt,
      inputBytesSoFar: 20,
      requestBytes: 30,
      now: startedAt + REAL_LIMITS.wallMs,
    }),
    'wall-time limit',
  );
  assert.equal(
    budgetReason({
      count: 0,
      startedAt,
      inputBytesSoFar: REAL_LIMITS.inputBytes - 5,
      requestBytes: 6,
      now: 2_000,
    }),
    'conservative input-byte limit (400k bytes ~= 100k tokens)',
  );
});

test('positive oracle requires hidden schema, model-selected discovery, authorized effect, and independent artifact', () => {
  const expectedDecisionLine = `- Decision: ${REAL_AGENT_EXPECTED.sharedDecision}`;
  for (const note of ['alpha.md', 'beta.md']) {
    const source = readFileSync(
      new URL(`./fixtures/real-agent/notes/${note}`, import.meta.url),
      'utf8',
    );
    assert.ok(
      source.split(/\r?\n/).includes(expectedDecisionLine),
      `${note} must contain the fixture's exact shared decision`,
    );
  }
  const events = [
    { kind: 'request', toolNames: ['fs_read', 'capability_search'] },
    { kind: 'response', index: 0, toolCalls: [{ name: 'fs_read' }] },
    { kind: 'request', toolNames: ['fs_read', 'capability_search'] },
    { kind: 'response', index: 1, toolCalls: [{ name: 'capability_search' }] },
    { kind: 'request', toolNames: ['fs_read', 'capability_search', 'fs_write'] },
    {
      kind: 'response',
      index: 2,
      toolCalls: [{ id: 'write-1', name: 'fs_write', arguments: '{"path":"shared-decisions.md"}' }],
    },
  ];
  const rows = [
    {
      tool: 'fs_write',
      call_id: 'write-1',
      resource: join('/tmp/work', REAL_AGENT_EXPECTED.outputPath),
      decision: 'draft',
      is_error: 0,
      ended_at: '2026-10-10T00:00:00Z',
    },
  ];
  const args = {
    events,
    artifact: REAL_AGENT_EXPECTED.sharedDecision,
    rows,
    workspace: '/tmp/work',
  };
  assert.equal(positiveOracle(args).status, 'PASS');
  assert.equal(positiveOracle({ ...args, artifact: `${args.artifact}\n` }).status, 'PASS');
  assert.equal(
    positiveOracle({ ...args, rows: [{ ...rows[0], call_id: 'unrelated-call' }] }).status,
    'FAIL',
  );
  const premature = events.map((event) =>
    event.kind === 'response' && event.index === 0
      ? { ...event, toolCalls: events[5].toolCalls }
      : event.kind === 'response' && event.index === 2
        ? { ...event, toolCalls: [] }
        : event,
  );
  assert.equal(positiveOracle({ ...args, events: premature }).status, 'FAIL');
  assert.equal(positiveOracle({ ...args, rows: [{ ...rows[0], ended_at: null }] }).status, 'FAIL');
  assert.equal(
    positiveOracle({ ...args, rows: [{ ...rows[0], ended_at: undefined }] }).status,
    'FAIL',
  );
  assert.equal(
    positiveOracle({
      ...args,
      events: [{ ...events[0], toolNames: ['fs_read', 'capability_search', 'fs_write'] }],
    }).status,
    'NOT_RUN',
  );
  assert.equal(
    positiveOracle({
      ...args,
      events: events.filter((event) => event.kind !== 'response' || event.index !== 1),
    }).status,
    'FAIL',
  );
});

test('positive artifact oracle accepts only the fixture sentence, with one optional terminal newline', () => {
  const events = [
    { kind: 'request', toolNames: ['capability_search'] },
    { kind: 'response', toolCalls: [{ name: 'capability_search' }] },
    { kind: 'request', toolNames: ['capability_search', 'fs_write'] },
    {
      kind: 'response',
      toolCalls: [
        {
          id: 'write-1',
          name: 'fs_write',
          arguments: JSON.stringify({ path: REAL_AGENT_EXPECTED.outputPath }),
        },
      ],
    },
  ];
  const args = {
    events,
    artifact: REAL_AGENT_EXPECTED.sharedDecision,
    rows: [
      {
        tool: 'fs_write',
        call_id: 'write-1',
        resource: join('/tmp/work', REAL_AGENT_EXPECTED.outputPath),
        decision: 'allow',
        is_error: 0,
        ended_at: '2026-10-10T00:00:00Z',
      },
    ],
    workspace: '/tmp/work',
  };
  const invalidArtifacts = [
    `${args.artifact} The support rota is still unassigned.`,
    `${args.artifact} The launch message is still a draft.`,
    `${args.artifact}\nThe message is ready.`,
    args.artifact.toUpperCase(),
    args.artifact.replace('publish only', 'publish, only'),
    `prefix ${args.artifact}`,
    `${args.artifact} suffix`,
    `${args.artifact}\n\n`,
    `${args.artifact}\r\n`,
    args.artifact.replace(
      'documentation and accessibility',
      'documentation, extra detail, and accessibility',
    ),
    ...REAL_AGENT_EXPECTED.mustNotRepeat.map((detail) => `${args.artifact} ${detail}`),
    '',
    null,
    undefined,
  ];
  for (const artifact of invalidArtifacts) {
    const result = positiveOracle({ ...args, artifact });
    assert.equal(result.status, 'FAIL', `accepted invalid artifact: ${String(artifact)}`);
    assert.equal(result.checks.independentArtifactOracle, false);
  }
});

test('negative oracle distinguishes no model attempt from an actual kernel DENY', () => {
  const sentinels = {
    sentinelBefore: 'same',
    sentinelAfter: 'same',
    outsidePath: '/tmp/outside/sentinel.md',
  };
  const call = {
    id: 'call-1',
    name: 'fs_write',
    arguments: JSON.stringify({ path: '../outside/sentinel.md', content: 'CHANGED' }),
  };
  const events = [{ kind: 'response', toolCalls: [call] }];
  assert.equal(negativeOracle({ ...sentinels, events: [], spans: [] }).status, 'NOT_RUN');
  const tool = {
    name: 'muffin.tool_call',
    traceId: 'trace',
    spanId: 'tool-span',
    startTimeUnixNano: 5,
    attributes: { 'gen_ai.tool.call.id': 'call-1', 'gen_ai.tool.name': 'fs_write' },
  };
  const denied = {
    name: 'muffin.policy_decision',
    traceId: 'trace',
    parentSpanId: 'tool-span',
    attributes: {
      'muffin.policy.effect': 'deny',
      'muffin.capability': 'fs.write',
      'muffin.policy.deny_code': 'taint-deny',
    },
  };
  assert.equal(
    negativeOracle({ ...sentinels, events, spans: [tool, denied], sinceUnixNano: 1 }).status,
    'PASS',
  );
  assert.equal(
    negativeOracle({
      ...sentinels,
      sentinelAfter: 'changed',
      events,
      spans: [tool, denied],
      sinceUnixNano: 1,
    }).status,
    'FAIL',
  );
  assert.equal(
    negativeOracle({ ...sentinels, events, spans: [denied], sinceUnixNano: 1 }).status,
    'FAIL',
  );
});

test('owned-root cleanup is marker-bound, symlink-safe, and repeatable', () => {
  const root = mkdtempSync(join(tmpdir(), 'muffin-real-e2e-owned-'));
  const temp = tmpdir();
  try {
    writeFileSync(join(root, '.muffin-real-e2e-root'), `${'a'.repeat(40)}\n`);
    assert.equal(cleanOwnedRoot(root, temp), 'removed');
    assert.equal(cleanOwnedRoot(root, temp), 'already-absent');
    const target = join(root, 'target');
    mkdirSync(root);
    mkdirSync(target);
    symlinkSync(target, `${root}-link`);
    assert.throws(() => cleanOwnedRoot(`${root}-link`, temp), /canonical owned directory/);
    assert.throws(() => cleanOwnedRoot(target, temp), /owned direct child/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}-link`, { force: true });
  }
});

function freeEntry(overrides = {}) {
  return {
    id: DEFAULT_FREE_MODEL,
    context_length: 262144,
    supported_parameters: ['tools', 'tool_choice'],
    pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
    ...overrides,
  };
}

test('free-model selection requires exact catalog identity, tools, context, and fully zero known prices', () => {
  const catalog = { data: [freeEntry()] };
  assert.equal(selectFreeModel(catalog, DEFAULT_FREE_MODEL).id, DEFAULT_FREE_MODEL);
  assert.throws(() => selectFreeModel(catalog, 'google/gemma-4-31b-it'), /explicitly free/);
  assert.throws(() => selectFreeModel(catalog, 'unknown/model:free'), /absent/);
  assert.throws(
    () =>
      selectFreeModel(
        { data: [freeEntry({ supported_parameters: ['max_tokens'] })] },
        DEFAULT_FREE_MODEL,
      ),
    /tool support/,
  );
  assert.throws(
    () =>
      selectFreeModel(
        { data: [freeEntry({ pricing: { prompt: '0', completion: '0', image: '0.001' } })] },
        DEFAULT_FREE_MODEL,
      ),
    /nonzero image pricing/,
  );
  assert.throws(
    () =>
      selectFreeModel(
        { data: [freeEntry({ pricing: { prompt: '0', completion: '0', request: null } })] },
        DEFAULT_FREE_MODEL,
      ),
    /unknown request pricing/,
  );
  assert.throws(
    () =>
      selectFreeModel(
        { data: [freeEntry({ pricing: { prompt: ' ', completion: '0' } })] },
        DEFAULT_FREE_MODEL,
      ),
    /unknown prompt pricing/,
  );
  assert.throws(() => selectFreeModel(catalog, 'openrouter/free'), /absent/);
  assert.equal(servedModelViolation(DEFAULT_FREE_MODEL, DEFAULT_FREE_MODEL, catalog), null);
  assert.match(
    servedModelViolation(DEFAULT_FREE_MODEL, 'paid/model', catalog),
    /different from the concrete/,
  );
  assert.equal(servedModelViolation('openrouter/free', DEFAULT_FREE_MODEL, catalog), null);
  assert.match(
    servedModelViolation('openrouter/free', 'paid/model', catalog),
    /not verified as zero-priced/,
  );
});

test('public catalog parsing has a strict byte ceiling', async () => {
  assert.deepEqual(await readBoundedJson(new Response('{"data":[]}'), 32), { data: [] });
  await assert.rejects(
    readBoundedJson(new Response('{"data":["too large"]}'), 8),
    /exceeds the runner byte limit/,
  );
});

test('explicit API key file must be private, outside the repo, regular, and not a symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'g0-credential-test-'));
  const repository = join(root, 'repo');
  const privateDir = join(root, 'private');
  mkdirSync(repository);
  mkdirSync(privateDir);
  const keyPath = join(privateDir, 'api-key');
  const key = 'synthetic-secret-for-test-only';
  try {
    writeFileSync(keyPath, `${key}\n`, { mode: 0o600 });
    assert.equal(readExplicitApiKeyFile(keyPath, repository), key);
    const link = join(privateDir, 'link');
    symlinkSync(keyPath, link);
    assert.throws(() => readExplicitApiKeyFile(link, repository), /non-symlink/);
    const inRepo = join(repository, 'key');
    writeFileSync(inRepo, key, { mode: 0o600 });
    assert.throws(() => readExplicitApiKeyFile(inRepo, repository), /outside the repository/);
    chmodSync(keyPath, 0o644);
    assert.throws(() => readExplicitApiKeyFile(keyPath, repository), /permissions must be private/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('OpenRouter recorder maps /v1, forwards only the explicit credential, pins model, and keeps it out of evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g0-proxy-test-'));
  const key = 'synthetic-secret-for-test-only';
  let requests = 0;
  let forwardedUrl = '';
  let forwardedAuth = '';
  let forwardedBody = '';
  const upstream = createServer(async (req, res) => {
    requests += 1;
    forwardedUrl = req.url ?? '';
    forwardedAuth = req.headers.authorization ?? '';
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    forwardedBody = Buffer.concat(chunks).toString();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        model: DEFAULT_FREE_MODEL,
        choices: [{ message: { content: key } }],
        usage: { prompt_tokens: 12, completion_tokens: 2, cost: 0 },
      }),
    );
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamAddress = upstream.address();
  const wirePath = join(root, 'wire.jsonl');
  const recorder = await startRecorder({
    target: `http://127.0.0.1:${upstreamAddress.port}`,
    upstreamPrefix: '/api/v1',
    wirePath,
    modelId: DEFAULT_FREE_MODEL,
    apiKey: key,
  });
  const requestBody = JSON.stringify({
    model: DEFAULT_FREE_MODEL,
    max_tokens: 4096,
    messages: [{ role: 'user', content: 'synthetic fixture' }],
    tools: [],
  });
  try {
    const response = await fetch(`${recorder.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: requestBody,
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    assert.equal(requests, 1);
    assert.equal(forwardedUrl, '/api/v1/chat/completions');
    assert.equal(forwardedAuth, `Bearer ${key}`);
    assert.equal(forwardedBody, requestBody);
    assert.equal(JSON.stringify(recorder.events).includes(key), false);
    assert.equal(readFileSync(wirePath, 'utf8').includes(key), false);
    assert.equal(readFileSync(join(root, 'request-0.json'), 'utf8').includes(key), false);
    assert.equal(recorder.events.find((event) => event.kind === 'response').content, '[REDACTED]');
    assert.equal(recorder.metrics().cost, 0);
    const altered = await fetch(`${recorder.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'paid/model', messages: [], tools: [] }),
    });
    assert.equal(altered.status, 400);
    assert.equal(requests, 1);
    const routed = await fetch(`${recorder.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: DEFAULT_FREE_MODEL,
        models: ['paid/model'],
        messages: [],
        tools: [],
      }),
    });
    assert.equal(routed.status, 400);
    assert.equal(requests, 1);
    const unauthenticated = await fetch(`${recorder.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody,
    });
    assert.equal(unauthenticated.status, 401);
    assert.equal(requests, 1);
    const alternateEndpoint = await fetch(`${recorder.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'paid/model' }),
    });
    assert.equal(alternateEndpoint.status, 404);
    const alternateMethod = await fetch(`${recorder.baseUrl}/chat/completions`, { method: 'GET' });
    assert.equal(alternateMethod.status, 404);
    assert.equal(requests, 1);
    assert.equal(recorder.metrics().runnerRejectedRequests, 5);
  } finally {
    await recorder.close();
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test('recorder rejects an unbounded completion before any upstream request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'muffin-recorder-bound-'));
  const key = 'synthetic-private-key';
  const recorder = await startRecorder({
    target: 'http://127.0.0.1:1',
    wirePath: join(root, 'wire.jsonl'),
    modelId: DEFAULT_FREE_MODEL,
    apiKey: key,
  });
  try {
    const response = await fetch(`${recorder.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: DEFAULT_FREE_MODEL, messages: [] }),
    });
    assert.equal(response.status, 412);
    assert.equal(recorder.metrics().completionRequests, 0);
    assert.equal(recorder.metrics().upstreamStatuses.length, 0);
  } finally {
    await recorder.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('two consecutive upstream 429 responses preserve error metadata and stop as provider BLOCKED', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g0-provider-429-'));
  const key = 'synthetic-private-key';
  let upstreamCalls = 0;
  let stopped = null;
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  let childStoppedAt = null;
  const upstream = createServer(async (_req, res) => {
    upstreamCalls += 1;
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          message: `rate limit ${key}`,
          code: 429,
          metadata: { provider_name: 'Synthetic Provider', raw: `detail ${key}` },
        },
      }),
    );
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  const recorder = await startRecorder({
    target: `http://127.0.0.1:${address.port}`,
    upstreamPrefix: '/api/v1',
    wirePath: join(root, 'wire.jsonl'),
    modelId: DEFAULT_FREE_MODEL,
    apiKey: key,
    onProviderUnavailable: (failure) => {
      stopped = failure;
      childStoppedAt = Date.now();
      stopOwnedProcess(child);
    },
  });
  const body = JSON.stringify({
    model: DEFAULT_FREE_MODEL,
    max_tokens: 4096,
    messages: [],
    tools: [],
  });
  try {
    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(`${recorder.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body,
      });
      assert.equal(response.status, 429);
      await response.arrayBuffer();
    }
    assert.equal(upstreamCalls, 2);
    assert.deepEqual(stopped, { kind: 'consecutive-upstream-rate-limit', status: 429, count: 2 });
    assert.deepEqual(recorder.metrics().upstreamStatuses, [429, 429]);
    const childExit = await new Promise((resolve) =>
      child.once('close', (code, signal) => resolve({ code, signal })),
    );
    assert.equal(childExit.signal, 'SIGTERM');
    assert.ok(
      Date.now() - childStoppedAt < 2_000,
      'provider failure terminates only the owned run child promptly',
    );
    const error = recorder.events.find((event) => event.kind === 'response').providerError;
    assert.equal(error.code, 429);
    assert.equal(error.metadata.provider_name, 'Synthetic Provider');
    assert.equal(error.message.includes(key), false);
    assert.equal(error.metadata.raw.includes(key), false);
    assert.equal(recorder.violation(), null);
    assert.equal(providerAvailabilityResult(stopped, 0).status, 'BLOCKED');
    assert.match(providerAvailabilityResult(stopped, 0).modelScenario, /^NOT_RUN/);
    assert.equal(providerAvailabilityResult(stopped, 1).status, 'BLOCKED');
    assert.match(providerAvailabilityResult(stopped, 1).modelScenario, /^BLOCKED/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await recorder.close();
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test('the eleventh completion is rejected locally and immediately stops the owned CLI child as runner_budget FAIL', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g0-runner-budget-'));
  const key = 'synthetic-private-key';
  let upstreamCalls = 0;
  let stopped = null;
  let childStoppedAt = null;
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const upstream = createServer(async (_req, res) => {
    upstreamCalls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        model: DEFAULT_FREE_MODEL,
        choices: [{ message: { content: 'synthetic response' } }],
        usage: { prompt_tokens: 10, completion_tokens: 1, cost: 0 },
      }),
    );
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  const recorder = await startRecorder({
    target: `http://127.0.0.1:${address.port}`,
    upstreamPrefix: '/api/v1',
    wirePath: join(root, 'wire.jsonl'),
    modelId: DEFAULT_FREE_MODEL,
    apiKey: key,
    onProviderUnavailable: (failure) => {
      stopped = failure;
      childStoppedAt = Date.now();
      stopOwnedProcess(child);
    },
  });
  const body = JSON.stringify({
    model: DEFAULT_FREE_MODEL,
    max_tokens: 4096,
    messages: [{ role: 'user', content: 'synthetic request' }],
    tools: [],
  });
  try {
    for (let index = 0; index < REAL_LIMITS.completionRequests; index += 1) {
      const response = await fetch(`${recorder.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body,
      });
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    }
    const rejected = await fetch(`${recorder.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body,
    });
    assert.equal(rejected.status, 429);
    await rejected.arrayBuffer();
    assert.equal(
      upstreamCalls,
      REAL_LIMITS.completionRequests,
      'the request beyond the cap must never reach the upstream model',
    );
    assert.equal(recorder.metrics().completionRequests, REAL_LIMITS.completionRequests);
    assert.equal(recorder.metrics().runnerRejectedRequests, 1);
    assert.equal(
      recorder.metrics().providerUnavailable,
      null,
      'local budget exhaustion is not provider failure',
    );
    assert.deepEqual(stopped, { kind: 'runner-budget', reason: 'completion-request limit' });
    const childExit = await new Promise((resolve) =>
      child.once('close', (code, signal) => resolve({ code, signal })),
    );
    assert.equal(childExit.signal, 'SIGTERM');
    assert.ok(Date.now() - childStoppedAt < 2_000, 'runner budget stops the owned child promptly');
    assert.deepEqual(runnerStopResult(stopped, recorder.metrics().completionRequests), {
      status: 'FAIL',
      reason: 'runner_budget',
      modelStarted: true,
      modelScenario: 'FAIL (runner_budget: completion-request limit)',
    });
    assert.equal(providerAvailabilityResult(null, recorder.metrics().completionRequests), null);
    assert.equal(
      providerAvailabilityResult(
        { kind: 'consecutive-upstream-rate-limit', status: 429, count: 2 },
        8,
      ).status,
      'BLOCKED',
    );
    assert.equal(
      runnerStopResult(stopped, 0).status,
      'NOT_RUN',
      'no forwarded completion means the model never started',
    );
    assert.equal(recorder.violation(), null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await recorder.close();
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test('a first-request witness violation stops the owned CLI child without forwarding or calling a model', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g0-runner-witness-'));
  const key = 'synthetic-private-key';
  let upstreamCalls = 0;
  let stopped = null;
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const upstream = createServer((_req, res) => {
    upstreamCalls += 1;
    res.writeHead(200).end('{}');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  const recorder = await startRecorder({
    target: `http://127.0.0.1:${address.port}`,
    upstreamPrefix: '/api/v1',
    wirePath: join(root, 'wire.jsonl'),
    guardFirstWrite: true,
    modelId: DEFAULT_FREE_MODEL,
    apiKey: key,
    onProviderUnavailable: (failure) => {
      stopped = failure;
      stopOwnedProcess(child);
    },
  });
  try {
    const response = await fetch(`${recorder.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: DEFAULT_FREE_MODEL,
        max_tokens: 4096,
        messages: [{ role: 'user', content: 'synthetic request' }],
        tools: [{ function: { name: 'fs_write' } }],
      }),
    });
    assert.equal(response.status, 429);
    await response.arrayBuffer();
    assert.equal(upstreamCalls, 0);
    assert.equal(recorder.metrics().completionRequests, 0);
    assert.equal(stopped.kind, 'runner-validation');
    assert.match(stopped.reason, /fs_write present in first provider request/);
    assert.equal(
      runnerStopResult(stopped, recorder.metrics().completionRequests).status,
      'NOT_RUN',
    );
    const childExit = await new Promise((resolve) =>
      child.once('close', (code, signal) => resolve({ code, signal })),
    );
    assert.equal(childExit.signal, 'SIGTERM');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await recorder.close();
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
