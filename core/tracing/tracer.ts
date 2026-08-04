import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { redactAttributes } from './redact.js';
import {
  SEMCONV_VERSION,
  type AttributeValue,
  type Span,
  type SpanExporter,
  type SpanHandle,
  type SpanName,
  type SpanStatus,
  type Tracer,
} from './types.js';

/**
 * One JSONL file per day under <home>/traces. No collector, no daemon, no
 * network: the only consumer is the owner (and later the agent reading its own
 * behaviour), and grep is a fine query engine for that.
 *
 * Writes are synchronous appends. A trace that is lost because the process
 * died before a flush is a trace that was needed precisely then.
 */
export class JsonlExporter implements SpanExporter {
  private readonly dir: string;

  constructor(homeDir: string) {
    this.dir = join(homeDir, 'traces');
    mkdirSync(this.dir, { recursive: true });
  }

  export(span: Span): void {
    const day = new Date(span.startTimeUnixNano / 1e6).toISOString().slice(0, 10);
    appendFileSync(join(this.dir, `${day}.jsonl`), `${JSON.stringify(span)}\n`, 'utf8');
  }

  flush(): void {
    /* appends are already durable */
  }

  /**
   * Retention runs at boot and on day rollover, from the runtime itself: there
   * is no scheduler yet in M0, and a retention policy nobody enforces is a
   * promise, not a policy.
   */
  pruneOlderThan(days: number, now: Date = new Date()): string[] {
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
    const removed: string[] = [];
    for (const file of readdirSync(this.dir)) {
      const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file);
      if (match && match[1] < cutoff) {
        rmSync(join(this.dir, file));
        removed.push(file);
      }
    }
    return removed;
  }
}

export class SimpleTracer implements Tracer {
  constructor(private readonly exporter: SpanExporter) {}

  start(
    name: SpanName,
    attributes: Record<string, AttributeValue> = {},
    parent?: SpanHandle,
  ): SpanHandle {
    const exporter = this.exporter;
    const traceId = parent?.traceId ?? id(16);
    const spanId = id(8);
    const parentSpanId = parent?.spanId ?? null;
    const startTimeUnixNano = Date.now() * 1e6;
    let current: Record<string, AttributeValue> = { ...attributes };
    let ended = false;

    return {
      traceId,
      spanId,
      setAttributes(next) {
        current = { ...current, ...next };
      },
      end(outcome) {
        if (ended) return; // ending twice would double-count tokens and cost
        ended = true;
        const status: SpanStatus = outcome?.status ?? (outcome?.error ? 'error' : 'ok');
        const span: Span = {
          name,
          traceId,
          spanId,
          parentSpanId,
          startTimeUnixNano,
          endTimeUnixNano: Date.now() * 1e6,
          status,
          attributes: redactAttributes(current),
          semconvVersion: SEMCONV_VERSION,
        };
        if (outcome?.error !== undefined) {
          span.error = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        }
        exporter.export(span);
      },
    };
  }
}

function id(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}
