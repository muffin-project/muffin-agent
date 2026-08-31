/**
 * Tracing contracts.
 *
 * We adopt the OpenTelemetry GenAI semantic conventions as a *vocabulary*, not
 * as a dependency: every attribute in the `gen_ai.*` namespace means what the
 * spec says it means, but nothing here imports the OTel SDK. Rationale in
 * docs/decisions/0010-standard-esterni.md — the conventions are still Development, the only consumer is
 * the owner reading local files, and the SDK would drag async context
 * propagation into a runtime that does not need it.
 *
 * Our own attributes live under `muffin.*` so a future stabilization of
 * `gen_ai.*` cannot collide with them.
 */

/** Pinned deliberately. Bumping it is a PR with the attribute diff, not a default. */
export const SEMCONV_VERSION = '1.42.0';

export type SpanName =
  | 'muffin.turn'
  | 'muffin.chat_call'
  | 'muffin.tool_call'
  | 'muffin.policy_decision';

export type SpanStatus = 'ok' | 'error';

export type AttributeValue = string | number | boolean | null;

export type Span = {
  name: SpanName;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  startTimeUnixNano: number;
  endTimeUnixNano: number;
  status: SpanStatus;
  /** Present when status is 'error'. Never contains secrets (see redact.ts). */
  error?: string;
  attributes: Readonly<Record<string, AttributeValue>>;
  semconvVersion: string;
};

/**
 * The attribute names we actually emit. Anything not in this map is a bug:
 * a trace whose vocabulary drifts is a trace nobody can query six months later.
 */
export const ATTR = {
  // --- OTel GenAI semantic conventions (Development, pinned above) ---
  operationName: 'gen_ai.operation.name',
  providerName: 'gen_ai.provider.name',
  requestModel: 'gen_ai.request.model',
  responseModel: 'gen_ai.response.model',
  usageInputTokens: 'gen_ai.usage.input_tokens',
  usageOutputTokens: 'gen_ai.usage.output_tokens',
  toolName: 'gen_ai.tool.name',
  toolCallId: 'gen_ai.tool.call.id',

  // --- ours: identity, tenancy, policy, cost ---
  principalKind: 'muffin.principal.kind',
  tenant: 'muffin.tenant',
  surface: 'muffin.surface',
  capability: 'muffin.capability',
  taint: 'muffin.taint',
  policyEffect: 'muffin.policy.effect',
  policyDenyCode: 'muffin.policy.deny_code',
  cacheReadTokens: 'muffin.usage.cache_read_tokens',
  cacheWriteTokens: 'muffin.usage.cache_write_tokens',
  costUsd: 'muffin.cost.usd',
  turnIteration: 'muffin.turn.iteration',
  /**
   * The turn's row id.
   *
   * Redundant on a fresh turn — it equals the trace id — and load-bearing on a
   * resumed one, where the span is a child of a trace whose root belonged to a
   * process that is gone. Emitted on both, so a query does not have to know
   * which kind of turn it is reading.
   */
  turnId: 'muffin.turn.id',
  /** Which attempt this is. 0 on a turn that never died and never waited. */
  turnResume: 'muffin.turn.resume',
  stopReason: 'muffin.stop_reason',
} as const;

export interface Tracer {
  /** Starts a span; the returned handle must be ended exactly once. */
  start(name: SpanName, attributes?: Record<string, AttributeValue>, parent?: SpanHandle): SpanHandle;
}

export interface SpanHandle {
  readonly traceId: string;
  readonly spanId: string;
  setAttributes(attributes: Record<string, AttributeValue>): void;
  end(outcome?: { status?: SpanStatus; error?: unknown }): void;
}

export interface SpanExporter {
  export(span: Span): void;
  flush(): void;
}
