import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Span } from '../core/tracing/types.js';

/**
 * Reading your own traces.
 *
 * `trace_query` as a tool is M3; this is the human-facing half, and it has to
 * exist now for a blunt reason: without it, M1 is debugged by guessing. The
 * traces are JSONL on purpose — grep works, and so does this.
 */

export type TraceFilter = {
  /** Substring match across span name, attribute keys and values. */
  pattern?: string;
  traceId?: string;
  limit: number;
  /** Only spans that ended in error. */
  errorsOnly?: boolean;
};

export function readSpans(homeDir: string, filter: TraceFilter): Span[] {
  const dir = join(homeDir, 'traces');
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort()
    .reverse(); // newest day first: tail is what you almost always want

  const out: Span[] = [];
  for (const file of files) {
    const lines = readFileSync(join(dir, file), 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0 && out.length < filter.limit; i--) {
      const line = lines[i];
      if (line === undefined || line.trim() === '') continue;
      let span: Span;
      try {
        span = JSON.parse(line) as Span;
      } catch {
        continue; // a torn line is not a reason to stop reading the file
      }
      if (matches(span, filter)) out.push(span);
    }
    if (out.length >= filter.limit) break;
  }
  return out.reverse(); // chronological once selected
}

function matches(span: Span, filter: TraceFilter): boolean {
  if (filter.errorsOnly && span.status !== 'error') return false;
  if (filter.traceId && span.traceId !== filter.traceId) return false;
  if (!filter.pattern) return true;
  const needle = filter.pattern.toLowerCase();
  if (span.name.toLowerCase().includes(needle)) return true;
  if (span.error?.toLowerCase().includes(needle)) return true;
  return Object.entries(span.attributes).some(
    ([k, v]) => k.toLowerCase().includes(needle) || String(v).toLowerCase().includes(needle),
  );
}

export function formatSpan(span: Span): string {
  const started = new Date(span.startTimeUnixNano / 1e6).toISOString().slice(11, 23);
  const ms = Math.round((span.endTimeUnixNano - span.startTimeUnixNano) / 1e6);
  const mark = span.status === 'error' ? '✗' : ' ';
  // The attributes that answer "who, on what, and what did the kernel say" —
  // the rest is one --json away.
  const salient = ['muffin.capability', 'muffin.policy.effect', 'muffin.policy.deny_code', 'gen_ai.request.model']
    .map((k) => (span.attributes[k] === undefined ? null : `${short(k)}=${span.attributes[k]}`))
    .filter((x): x is string => x !== null)
    .join(' ');
  const tail = span.error ? ` — ${span.error}` : '';
  return `${mark} ${started} ${span.name.padEnd(22)} ${String(ms).padStart(5)}ms  ${salient}${tail}`;
}

function short(attributeName: string): string {
  const parts = attributeName.split('.');
  return parts[parts.length - 1] ?? attributeName;
}
