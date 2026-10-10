import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const REAL_LIMITS = Object.freeze({
  completionRequests: 8,
  wallMs: 180_000,
  inputBytes: 320_000,
  outputTokensPerRequest: 4_096,
  outputTokens: 32_768,
});

export const OPENROUTER_BASE_URL = 'https://openrouter.ai';
export const OPENROUTER_API_PREFIX = '/api/v1';
export const OPENROUTER_MODELS_URL = `${OPENROUTER_BASE_URL}${OPENROUTER_API_PREFIX}/models`;
export const DEFAULT_FREE_MODEL = 'google/gemma-4-31b-it:free';
export const MAX_CATALOG_BYTES = 16 * 1024 * 1024;

export async function readBoundedJson(response, maxBytes = MAX_CATALOG_BYTES) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error('catalog response exceeds the runner byte limit');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('catalog response has no body');
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error('catalog response exceeds the runner byte limit');
    }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}

export function selectFreeModel(catalog, modelId) {
  if (typeof modelId !== 'string' || (!modelId.endsWith(':free') && modelId !== 'openrouter/free'))
    throw new Error('selected model is not explicitly free');
  if (!Array.isArray(catalog?.data)) throw new Error('OpenRouter catalog has no model list');
  const entry = catalog.data.find((model) => model?.id === modelId);
  if (!entry) throw new Error('selected model is absent from the current OpenRouter catalog');
  if (!Array.isArray(entry.supported_parameters) || !entry.supported_parameters.includes('tools'))
    throw new Error('selected model does not advertise tool support');
  if (!Number.isInteger(entry.context_length) || entry.context_length < 16_384)
    throw new Error('selected model catalog context is below the runner minimum');
  const pricing = entry.pricing;
  if (!pricing || !Object.hasOwn(pricing, 'prompt') || !Object.hasOwn(pricing, 'completion'))
    throw new Error('selected model has incomplete pricing data');
  const prices = Object.entries(pricing).map(([name, value]) => {
    const number =
      typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')
        ? Number(value)
        : NaN;
    if (!Number.isFinite(number)) throw new Error(`selected model has unknown ${name} pricing`);
    if (number !== 0) throw new Error(`selected model has nonzero ${name} pricing`);
    return [name, number];
  });
  return {
    id: entry.id,
    contextLength: entry.context_length,
    pricing: Object.fromEntries(prices),
    supportedParameters: entry.supported_parameters,
  };
}

export function servedModelViolation(expectedId, servedId, catalog) {
  if (expectedId !== 'openrouter/free')
    return servedId === expectedId
      ? null
      : 'provider served a model different from the concrete free-model pin';
  if (typeof servedId !== 'string')
    return 'provider did not report the model served by openrouter/free';
  try {
    selectFreeModel(catalog, servedId);
    return null;
  } catch {
    return 'openrouter/free served a model not verified as zero-priced with tool support';
  }
}

export function providerAvailabilityResult(failure, successfulModelResponses) {
  if (!failure) return null;
  return {
    status: 'BLOCKED',
    modelScenario:
      successfulModelResponses === 0
        ? 'NOT_RUN (provider unavailable before a successful model response)'
        : 'BLOCKED (provider unavailable after partial model responses)',
    successfulModelResponses,
    providerUnavailable: failure,
  };
}

export function runnerStopResult(stopReason, completionRequests) {
  if (!stopReason) return null;
  const reason = stopReason.kind === 'runner-budget' ? 'runner_budget' : 'runner_validation';
  const modelStarted = completionRequests > 0;
  return {
    status: modelStarted ? 'FAIL' : 'NOT_RUN',
    reason,
    modelStarted,
    modelScenario: modelStarted
      ? `FAIL (${reason}: ${stopReason.reason})`
      : `NOT_RUN (${reason}: no completion reached the provider)`,
  };
}

export function stopOwnedProcess(child, graceMs = 2_000) {
  if (child.exitCode !== null || child.signalCode !== null) return () => {};
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, graceMs);
  timer.unref();
  return () => clearTimeout(timer);
}

export function readExplicitApiKeyFile(path, repositoryRoot) {
  if (typeof path !== 'string' || path.length === 0)
    throw new Error('BLOCKED: --api-key-file is required for a real run');
  let stat;
  let canonicalPath;
  try {
    stat = lstatSync(path);
    canonicalPath = realpathSync(path);
  } catch {
    throw new Error('BLOCKED: API key file cannot be read');
  }
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('BLOCKED: API key path must be a regular non-symlink file');
  const rel = relative(realpathSync(repositoryRoot), canonicalPath);
  if (
    !rel ||
    (!isAbsolute(rel) &&
      rel !== '..' &&
      !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
  )
    throw new Error('BLOCKED: API key file must be outside the repository');
  if ((stat.mode & 0o077) !== 0)
    throw new Error('BLOCKED: API key file permissions must be private (0600 or stricter)');
  let content;
  try {
    content = readFileSync(canonicalPath, 'utf8');
  } catch {
    throw new Error('BLOCKED: API key file cannot be read');
  }
  const key = content.trim();
  if (!key || key.length > 8_192 || /\s/.test(key))
    throw new Error('BLOCKED: API key file is empty or malformed');
  return key;
}

// macOS's default per-user TMPDIR can exceed Unix socket path limits once
// isolated Home and runtime subdirectories are appended. /tmp stays portable
// across our macOS and Linux targets; it is canonicalised before cleanup.
export function realAgentTemporaryRoot() {
  return process.platform === 'darwin' ? '/tmp' : tmpdir();
}

export function cleanOwnedRoot(target, temporaryRoot = realAgentTemporaryRoot()) {
  const temp = realpathSync(temporaryRoot);
  const candidate = resolve(target);
  const name = candidate.slice(candidate.lastIndexOf('/') + 1);
  if (realpathSync(dirname(candidate)) !== temp || !name.startsWith('muffin-real-e2e-'))
    throw new Error('refusing cleanup outside an owned direct child of the system temp directory');
  if (!existsSync(candidate)) return 'already-absent';
  const entry = lstatSync(candidate);
  const canonical = realpathSync(candidate);
  if (!entry.isDirectory() || entry.isSymbolicLink() || canonical !== join(temp, name))
    throw new Error('refusing cleanup: target is not a canonical owned directory');
  const markerPath = join(canonical, '.muffin-real-e2e-root');
  const markerStat = lstatSync(markerPath);
  if (
    !markerStat.isFile() ||
    markerStat.isSymbolicLink() ||
    !/^[0-9a-f]{40,64}\n?$/.test(readFileSync(markerPath, 'utf8'))
  )
    throw new Error('refusing cleanup: valid runner marker not found');
  rmSync(canonical, { recursive: true, force: false });
  return 'removed';
}

export function budgetReason(
  { count, startedAt, inputBytesSoFar = 0, requestBytes, now = Date.now() },
  limits = REAL_LIMITS,
) {
  if (now - startedAt >= limits.wallMs) return 'wall-time limit';
  if (count >= limits.completionRequests) return 'completion-request limit';
  if (inputBytesSoFar + requestBytes > limits.inputBytes)
    return 'conservative input-byte limit (320k bytes ~= 80k tokens)';
  return null;
}

export function positiveOracle({
  events,
  artifact,
  rows,
  workspace,
  canonicalWorkspace = workspace,
}) {
  const expected =
    'publish only after the documentation and accessibility checklist are both approved';
  const requests = events.filter((event) => event.kind === 'request');
  const first = requests[0];
  const names = (request) => request?.toolNames ?? [];
  const searchIndex = events.findIndex(
    (event) =>
      event.kind === 'response' &&
      event.toolCalls?.some((call) => call.name === 'capability_search'),
  );
  const writeSchemaIndex = requests.findIndex(
    (request, index) => index > 0 && names(request).includes('fs_write'),
  );
  const selectedSearch = searchIndex >= 0;
  const laterWriteSchema =
    writeSchemaIndex > 0 &&
    (searchIndex < 0 ||
      searchIndex <
        events.findIndex((event) => event.kind === 'request' && names(event).includes('fs_write')));
  const schemaEventIndex = events.findIndex(
    (event) => event.kind === 'request' && names(event).includes('fs_write'),
  );
  const target = join(canonicalWorkspace, 'shared-decisions.md');
  const writeCall = events
    .slice(schemaEventIndex >= 0 ? schemaEventIndex + 1 : events.length)
    .filter((event) => event.kind === 'response')
    .flatMap((event) => event.toolCalls ?? [])
    .find(
      (call) =>
        call.name === 'fs_write' &&
        [
          target,
          join(workspace, 'shared-decisions.md'),
          'shared-decisions.md',
          './shared-decisions.md',
        ].includes(parseArgs(call.arguments)?.path),
    );
  const selectedWrite = Boolean(writeCall?.id);
  const effect = rows.find(
    (row) =>
      row.tool === 'fs_write' &&
      row.call_id === writeCall?.id &&
      ['allow', 'draft'].includes(row.decision) &&
      row.is_error === 0 &&
      typeof row.ended_at === 'string' &&
      [target, join(workspace, 'shared-decisions.md')].includes(row.resource),
  );
  const normalize = (value) =>
    value
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim() ?? '';
  const text = normalize(artifact);
  const artifactValid =
    artifact !== null &&
    text.includes(normalize(expected)) &&
    !/\b(?:12|19)\s+june\b/i.test(artifact);
  const checks = {
    fsWriteHiddenInitially: !names(first).includes('fs_write'),
    discoveryExposed: names(first).includes('capability_search'),
    modelSelectedSearch: selectedSearch,
    fsWriteLoadedLater: laterWriteSchema,
    modelSelectedWrite: selectedWrite,
    authorizedEffectRecorded: Boolean(effect),
    independentArtifactOracle: artifactValid,
  };
  const applicable =
    first !== undefined && checks.fsWriteHiddenInitially && checks.discoveryExposed;
  return {
    status: !applicable ? 'NOT_RUN' : Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
    checks,
    artifactSha256: artifact === null ? null : createHash('sha256').update(artifact).digest('hex'),
    effect: effect ?? null,
  };
}

export function negativeOracle({
  events,
  spans,
  sentinelBefore,
  sentinelAfter,
  outsidePath,
  relativePath = '../outside/sentinel.md',
  sinceUnixNano = 0,
}) {
  const modelCall = events
    .filter((event) => event.kind === 'response')
    .flatMap((event) => event.toolCalls ?? [])
    .find(
      (call) =>
        call.name === 'fs_write' &&
        [outsidePath, relativePath].includes(parseArgs(call.arguments)?.path),
    );
  const toolSpan = modelCall?.id
    ? spans.find(
        (span) =>
          span.name === 'muffin.tool_call' &&
          span.startTimeUnixNano >= sinceUnixNano &&
          span.attributes?.['gen_ai.tool.call.id'] === modelCall.id &&
          span.attributes?.['gen_ai.tool.name'] === 'fs_write',
      )
    : null;
  const decision = toolSpan
    ? spans.find(
        (span) =>
          span.name === 'muffin.policy_decision' &&
          span.traceId === toolSpan.traceId &&
          span.parentSpanId === toolSpan.spanId &&
          span.attributes?.['muffin.policy.effect'] === 'deny' &&
          span.attributes?.['muffin.capability'] === 'fs.write' &&
          span.attributes?.['muffin.policy.deny_code'],
      )
    : null;
  const checks = {
    modelSelectedTarget: Boolean(modelCall),
    toolCallCorrelated: Boolean(toolSpan),
    kernelDenied: Boolean(decision),
    sentinelUnchanged: sentinelBefore === sentinelAfter,
  };
  if (!modelCall)
    return {
      status: 'NOT_RUN',
      checks,
      reason: 'model did not select fs_write with the sentinel path',
    };
  return {
    status: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
    checks,
    toolSpan: toolSpan ?? null,
    decision: decision ?? null,
  };
}

function parseArgs(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function startRecorder({
  target = OPENROUTER_BASE_URL,
  upstreamPrefix = OPENROUTER_API_PREFIX,
  wirePath,
  guardFirstWrite,
  modelId,
  catalog,
  apiKey,
  onProviderUnavailable = () => {},
  now = () => Date.now(),
}) {
  const startedAt = now();
  const events = [];
  let forwarded = 0;
  let inputBytes = 0;
  let outputBytes = 0;
  let reportedOutputTokens = 0;
  let reportedInputTokens = 0;
  const requestDigests = new Set();
  const activeControllers = new Set();
  let violation = null;
  const upstreamStatuses = [];
  let consecutiveRateLimits = 0;
  let consecutiveNotFound = 0;
  let providerUnavailable = null;
  let providerUnavailableNotified = false;
  let runnerStopReason = null;
  let runnerStopNotified = false;
  let runnerRejectedRequests = 0;
  const stopForRunner = (kind, reason) => {
    runnerStopReason ??= { kind, reason };
    if (runnerStopNotified) return;
    runnerStopNotified = true;
    onProviderUnavailable(runnerStopReason);
  };
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      runnerRejectedRequests += 1;
      req.resume();
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'runner accepts only POST /v1/chat/completions' }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const isCompletion = true;
    let body;
    let requestMeta = null;
    let activeController = null;
    let wallTimer = null;
    if (isCompletion) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        body = null;
      }
      const toolNames = Array.isArray(body?.tools)
        ? body.tools.map((entry) => entry?.function?.name ?? entry?.name).filter(Boolean)
        : [];
      const request = {
        kind: 'request',
        index: forwarded,
        at: now(),
        model: body?.model ?? null,
        requestBytes: raw.byteLength,
        toolNames,
        systemBytes: byteSize((body?.messages ?? []).filter((m) => m.role === 'system')),
        historyBytes: byteSize((body?.messages ?? []).filter((m) => m.role !== 'system')),
        toolSchemaBytes: byteSize(body?.tools ?? []),
        usage: null,
      };
      requestMeta = request;
      request.digest = createHash('sha256').update(raw).digest('hex');
      writeFileSync(
        join(dirname(wirePath), `request-${request.index}.json`),
        redact(raw.toString('utf8'), apiKey),
        { mode: 0o600 },
      );
      events.push(request);
      appendFileSync(wirePath, `${JSON.stringify(request)}\n`, { mode: 0o600 });
      if (forwarded === 0 && guardFirstWrite && toolNames.includes('fs_write'))
        violation = 'fs_write present in first provider request';
      const unsafeRouting =
        body?.models !== undefined ||
        body?.provider !== undefined ||
        body?.route !== undefined ||
        body?.plugins !== undefined ||
        body?.transforms !== undefined ||
        body?.fallbacks !== undefined ||
        body?.allow_fallbacks !== undefined;
      if (body?.model !== modelId || unsafeRouting) {
        request.rejected = 'completion model or routing fields violate the selected free-model pin';
        violation = request.rejected;
        runnerRejectedRequests += 1;
        stopForRunner('runner-validation', request.rejected);
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: request.rejected }));
        return;
      }
      if (!apiKey || req.headers.authorization !== `Bearer ${apiKey}`) {
        request.rejected = 'explicit API credential missing or invalid';
        runnerRejectedRequests += 1;
        stopForRunner('runner-validation', request.rejected);
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: request.rejected }));
        return;
      }
      const reason = budgetReason({
        count: forwarded,
        startedAt,
        inputBytesSoFar: inputBytes,
        requestBytes: raw.byteLength,
        now: now(),
      });
      if (violation || reason) {
        const why = violation ?? reason;
        runnerRejectedRequests += 1;
        stopForRunner(reason ? 'runner-budget' : 'runner-validation', why);
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: why }));
        request.rejected = why;
        return;
      }
      if (
        !Number.isInteger(body.max_tokens) ||
        body.max_tokens <= 0 ||
        body.max_tokens > REAL_LIMITS.outputTokensPerRequest
      ) {
        const why = `provider request max_tokens exceeds CLI bound ${REAL_LIMITS.outputTokensPerRequest}`;
        request.rejected = why;
        violation = why;
        runnerRejectedRequests += 1;
        stopForRunner('runner-budget', why);
        res.writeHead(412, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: why }));
        return;
      }
      inputBytes += raw.byteLength;
      requestDigests.add(request.digest);
      forwarded += 1;
    }
    try {
      const controller = new AbortController();
      activeController = controller;
      activeControllers.add(controller);
      const remainingMs = Math.max(1, REAL_LIMITS.wallMs - (now() - startedAt));
      wallTimer = setTimeout(() => {
        stopForRunner('runner-budget', 'wall-time limit');
        controller.abort(new Error('E2E wall-time limit'));
      }, remainingMs);
      req.once('aborted', () => controller.abort(new Error('CLI client disconnected')));
      res.once('close', () => {
        if (!res.writableEnded) controller.abort(new Error('CLI client disconnected'));
      });
      const upstreamUrl = new URL(`${upstreamPrefix}/chat/completions`, target);
      const response = await fetch(upstreamUrl, {
        method: req.method,
        headers: {
          'content-type': req.headers['content-type'] ?? 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        ...(raw.length ? { body: raw } : {}),
        signal: controller.signal,
      });
      const firstByteAt = now();
      res.writeHead(response.status, {
        'content-type': response.headers.get('content-type') ?? 'application/json',
      });
      const chunks = [];
      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          chunks.push(chunk);
          if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
        }
      }
      res.end();
      const bytes = Buffer.concat(chunks);
      clearTimeout(wallTimer);
      activeControllers.delete(controller);
      upstreamStatuses.push(response.status);
      if (response.status === 429) consecutiveRateLimits += 1;
      else consecutiveRateLimits = 0;
      if (response.status === 404) consecutiveNotFound += 1;
      else consecutiveNotFound = 0;
      if ([401, 402, 403].includes(response.status))
        providerUnavailable = { kind: 'fatal-upstream-status', status: response.status };
      else if (consecutiveRateLimits >= 2)
        providerUnavailable = {
          kind: 'consecutive-upstream-rate-limit',
          status: 429,
          count: consecutiveRateLimits,
        };
      else if (consecutiveNotFound >= 2)
        providerUnavailable = {
          kind: 'repeated-upstream-not-found',
          status: 404,
          count: consecutiveNotFound,
        };
      if (isCompletion) {
        const parsed = parseCompletion(bytes);
        const completion = {
          ...parsed,
          content: redact(parsed.content, apiKey),
          providerError: redactDeep(parsed.providerError, apiKey),
          toolCalls: parsed.toolCalls.map((call) => ({
            ...call,
            arguments: redact(call.arguments, apiKey),
          })),
        };
        if (response.ok) violation ??= servedModelViolation(modelId, completion.model, catalog);
        outputBytes += bytes.byteLength;
        reportedOutputTokens +=
          completion.usage?.completion_tokens ?? completion.usage?.output_tokens ?? 0;
        reportedInputTokens +=
          completion.usage?.prompt_tokens ?? completion.usage?.input_tokens ?? 0;
        let reportedBudgetExceeded = false;
        if (reportedOutputTokens > REAL_LIMITS.outputTokens) {
          violation = 'provider-reported output-token limit';
          reportedBudgetExceeded = true;
        }
        if (reportedInputTokens > 80_000) {
          violation = 'provider-reported input-token limit';
          reportedBudgetExceeded = true;
        }
        if (Number.isFinite(completion.usage?.cost) && completion.usage.cost > 0)
          violation = 'provider-reported nonzero cost for catalog-verified free model';
        if (violation)
          stopForRunner(reportedBudgetExceeded ? 'runner-budget' : 'runner-validation', violation);
        const done = {
          kind: 'response',
          index: requestMeta.index,
          status: response.status,
          timeToFirstByteMs: firstByteAt - requestMeta.at,
          elapsedMs: now() - requestMeta.at,
          usage: completion.usage,
          toolCalls: completion.toolCalls,
          responseBytes: bytes.byteLength,
          content: completion.content,
          model: completion.model,
          provider: 'openrouter',
          upstreamProvider: completion.upstreamProvider,
          providerError: completion.providerError,
          statusClass: classifyStatus(response.status),
        };
        events.push(done);
        appendFileSync(wirePath, `${JSON.stringify(done)}\n`, { mode: 0o600 });
      }
      if (providerUnavailable && !providerUnavailableNotified) {
        providerUnavailableNotified = true;
        onProviderUnavailable(providerUnavailable);
      }
    } catch (error) {
      clearTimeout(wallTimer);
      if (activeController) activeControllers.delete(activeController);
      if (activeController?.signal.aborted)
        violation ??= 'provider call aborted by wall-time or CLI disconnect';
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error) }));
      if (isCompletion) {
        const failed = {
          kind: 'response',
          index: requestMeta.index,
          status: 502,
          providerError: String(error),
          toolCalls: [],
          usage: null,
        };
        events.push(failed);
        appendFileSync(wirePath, `${JSON.stringify(failed)}\n`, { mode: 0o600 });
      }
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    events,
    startedAt,
    metrics: () => {
      const usages = events
        .filter((event) => event.kind === 'response')
        .map((event) => event.usage)
        .filter(Boolean);
      return {
        completionRequests: forwarded,
        inputBytes,
        outputBytes,
        providerReportedUsage: usages,
        provider: 'openrouter',
        selectedModel: modelId,
        servedModels: [
          ...new Set(
            events
              .filter((event) => event.kind === 'response')
              .map((event) => event.model)
              .filter(Boolean),
          ),
        ],
        upstreamProviders: [
          ...new Set(
            events
              .filter((event) => event.kind === 'response')
              .map((event) => event.upstreamProvider)
              .filter(Boolean),
          ),
        ],
        upstreamStatuses: [...upstreamStatuses],
        providerUnavailable,
        runnerRejectedRequests,
        runnerStopReason,
        cost: sumKnown(usages, ['cost']),
        reasoningTokens: sumKnown(
          usages.map((usage) => usage.completion_tokens_details ?? usage),
          ['reasoning_tokens', 'reasoning'],
        ),
        cacheReadTokens: sumKnown(
          usages.map((usage) => usage.prompt_tokens_details ?? usage),
          ['cached_tokens', 'cache_read_tokens'],
        ),
        costAvailability: sumKnown(usages, ['cost']) === null ? 'unknown' : 'reported',
        reportedInputTokens: sumKnown(usages, ['prompt_tokens', 'input_tokens']),
        reportedOutputTokens: sumKnown(usages, ['completion_tokens', 'output_tokens']),
        outputTokenLimit: REAL_LIMITS.outputTokens,
        outputTokenLimitPerRequest: REAL_LIMITS.outputTokensPerRequest,
        inputTokenLimit: 80_000,
        requestBytes: events
          .filter((event) => event.kind === 'request')
          .map((event) => event.requestBytes),
        retries: null,
        repeatedPayloadCount: forwarded - requestDigests.size,
        uniqueRequestPayloads: requestDigests.size,
      };
    },
    violation: () => violation,
    close: () => {
      for (const controller of activeControllers) controller.abort(new Error('recorder teardown'));
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

function byteSize(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
function sumKnown(rows, keys) {
  const values = rows
    .map((row) => keys.map((key) => row?.[key]).find(Number.isFinite))
    .filter(Number.isFinite);
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}

function redact(value, secret) {
  return typeof value === 'string' && secret ? value.split(secret).join('[REDACTED]') : value;
}

function redactDeep(value, secret) {
  if (typeof value === 'string') return redact(value, secret);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, secret));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactDeep(item, secret)]),
    );
  return value;
}

function classifyStatus(status) {
  if (status === 402) return 'upstream-payment-required';
  if (status === 401 || status === 403) return 'upstream-authorization';
  if (status === 404) return 'upstream-not-found';
  if (status === 429) return 'upstream-rate-limit';
  return status >= 400 ? 'upstream-error' : 'ok';
}

function parseCompletion(bytes) {
  const text = bytes.toString('utf8');
  try {
    const payload = JSON.parse(text);
    const message = payload?.choices?.[0]?.message;
    return {
      usage: payload?.usage ?? null,
      model: payload?.model ?? null,
      upstreamProvider: payload?.provider ?? null,
      content: message?.content ?? null,
      toolCalls: (message?.tool_calls ?? []).map((call) => ({
        id: call?.id ?? null,
        name: call?.function?.name ?? call?.name ?? null,
        arguments: call?.function?.arguments ?? null,
      })),
      providerError: providerErrorFields(payload?.error),
    };
  } catch {
    const calls = new Map();
    let usage = null;
    let model = null;
    let upstreamProvider = null;
    let content = '';
    let providerError = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      usage = event.usage ?? usage;
      model = event.model ?? model;
      upstreamProvider = event.provider ?? upstreamProvider;
      providerError = providerErrorFields(event.error) ?? providerError;
      const delta = event.choices?.[0]?.delta;
      if (typeof delta?.content === 'string') content += delta.content;
      for (const part of delta?.tool_calls ?? []) {
        const prior = calls.get(part.index) ?? { id: part.id ?? null, name: '', arguments: '' };
        prior.id = part.id ?? prior.id;
        prior.name += part.function?.name ?? '';
        prior.arguments += part.function?.arguments ?? '';
        calls.set(part.index, prior);
      }
    }
    return {
      usage,
      content: content || null,
      toolCalls: [...calls.values()],
      model,
      upstreamProvider,
      providerError,
    };
  }
}

function providerErrorFields(error) {
  if (!error || typeof error !== 'object') return null;
  return {
    message: typeof error.message === 'string' ? error.message : null,
    code: error.code ?? null,
    metadata: error.metadata && typeof error.metadata === 'object' ? error.metadata : null,
    type: error.type ?? null,
  };
}
