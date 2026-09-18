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
  /**
   * Matched as a **prefix**, and that is the whole point.
   *
   * A finished turn prints `trace c22cb4445952` — twelve characters of a
   * thirty-two character id, because that is what fits on the line an owner
   * reads. This filter used to compare for equality, so the one id the product
   * hands you was the one id it refused: `no spans matched`, on a trace that
   * was sitting right there. The id printed and the id accepted have to be the
   * same id (dogfood, 26/08/2026).
   */
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
  if (filter.traceId && !span.traceId.startsWith(filter.traceId)) return false;
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
  const mark = span.status === 'error' ? '✗' : ' ';
  const tail = span.error ? ` — ${span.error}` : '';
  return `${mark} ${started} ${span.name.padEnd(22)} ${String(msOf(span)).padStart(6)}ms  ${salient(span)}${tail}`;
}

/**
 * One turn, step by step: what it did, how long each step took, what it cost.
 *
 * The data was always there — every `chat_call` span already carries
 * `gen_ai.usage.*`, the cache split and the stop reason — and none of it
 * reached the human view, which printed a duration and a model name. So the
 * question an owner actually asks after a slow turn ("what was it *doing* for
 * 108 seconds?") could only be answered by piping `--json` through `jq`.
 *
 * Offsets are relative to the first span, because "at 13:46:41.675" answers a
 * question nobody asked; "+44.3s in" is the one that finds the slow step.
 *
 * The root span is the turn itself, so it belongs in the header and not in the
 * list: it opens first and closes last, which puts a `+0.0s` row underneath a
 * `+259.8s` one and makes the reader stop to work out that it is the frame.
 */
export function formatTurn(spans: readonly Span[]): string {
  if (spans.length === 0) return 'nessuno span per questo turno\n';
  const first = Math.min(...spans.map((s) => s.startTimeUnixNano));
  const last = Math.max(...spans.map((s) => s.endTimeUnixNano));
  let inTok = 0;
  let outTok = 0;
  let cacheRead = 0;
  let calls = 0;
  for (const s of spans) {
    const i = s.attributes['gen_ai.usage.input_tokens'];
    const o = s.attributes['gen_ai.usage.output_tokens'];
    const c = s.attributes['muffin.usage.cache_read_tokens'];
    if (typeof i === 'number') inTok += i;
    if (typeof o === 'number') outTok += o;
    if (typeof c === 'number') cacheRead += c;
    if (s.name === 'muffin.chat_call') calls += 1;
  }
  const root = spans.find((s) => s.parentSpanId === null && s.name === 'muffin.turn');
  // Spans are appended when they *close*, so a parent lands after its children.
  // Sorting by start is what makes an offset column mean "in this order".
  const steps = [...spans].filter((s) => s !== root).sort((a, b) => a.startTimeUnixNano - b.startTimeUnixNano);
  const header =
    `turno ${spans[0]!.traceId.slice(0, 12)} · ${steps.length} step · ${calls} chiamate al modello · ` +
    `${((last - first) / 1e9).toFixed(1)}s · ${inTok} in / ${outTok} out` +
    (cacheRead > 0 ? ` (${cacheRead} da cache)` : '') +
    (root && salient(root) !== '' ? ` · ${salient(root)}` : '');
  if (steps.length === 0) return `${header}\n  (nessuno step registrato dentro il turno)\n`;
  const lines = steps.map((s) => {
    const offset = `+${((s.startTimeUnixNano - first) / 1e9).toFixed(1)}s`.padStart(8);
    const mark = s.status === 'error' ? '✗' : ' ';
    const tail = s.error ? ` — ${s.error}` : '';
    return `${mark} ${offset}  ${s.name.replace('muffin.', '').padEnd(18)} ${String(msOf(s)).padStart(6)}ms  ${salient(s)}${tail}`;
  });
  return `${header}\n${lines.join('\n')}\n`;
}

function msOf(span: Span): number {
  return Math.round((span.endTimeUnixNano - span.startTimeUnixNano) / 1e6);
}

/**
 * What a step *did*, in one line. Tokens are here and not one `--json` away
 * because "how long" without "how much" cannot tell a slow provider from a
 * long generation — the exact confusion that made a 108s turn look like a hang
 * when it was 2576 tokens of output doing their job.
 */
function salient(span: Span): string {
  return [
    'muffin.capability',
    'muffin.policy.effect',
    'muffin.policy.deny_code',
    // Not every `tool_call` span is a tool: memory recall rides the same span
    // name and names itself in `operation.name`, so leaving this out printed a
    // blank line for the first step of every turn — the recall that decides
    // what the model is even looking at.
    'gen_ai.operation.name',
    'gen_ai.tool.name',
    'gen_ai.request.model',
    // Who actually served the request behind the router: twelve upstreams
    // share one model id, and a zero without this name is undiagnosable.
    'gen_ai.provider.name',
    'gen_ai.usage.input_tokens',
    'gen_ai.usage.output_tokens',
    'muffin.chat_call.reasoning_tokens',
    'muffin.stop_reason',
    // The verbatim wire reason beside the mapped stop: an unmapped provider
    // reason reads `error` while this names what actually arrived.
    'muffin.chat_call.finish_reason',
    // Which recovery rung (if any) this attempt ran, and which provider-side
    // failure class (if any) was classified instead of the semantic cascade.
    'muffin.recovery.strategy',
    'muffin.provider_failure.class',
    // How the model call ended at the lease level: watchdog cause and which
    // budget set the effective deadline.
    'muffin.chat_call.abort_reason',
    'muffin.chat_call.effective_deadline_source',
  ]
    .map((k) => (span.attributes[k] === undefined ? null : `${short(k)}=${span.attributes[k]}`))
    .filter((x): x is string => x !== null)
    .join(' ');
}

/**
 * The tail of the attribute name, except where the tail is worse than a word.
 * `gen_ai.usage.input_tokens=5938` on every line pushes the thing you are
 * reading off the right edge; `in=5938` does not.
 */
const SHORTER: Readonly<Record<string, string>> = {
  'gen_ai.usage.input_tokens': 'in',
  'gen_ai.usage.output_tokens': 'out',
  'gen_ai.tool.name': 'tool',
  'gen_ai.operation.name': 'op',
  'muffin.stop_reason': 'stop',
  'gen_ai.provider.name': 'upstream',
  'muffin.chat_call.reasoning_tokens': 'reasoning',
  'muffin.chat_call.finish_reason': 'finish',
  'muffin.recovery.strategy': 'recovery',
  'muffin.provider_failure.class': 'provfail',
  'muffin.chat_call.abort_reason': 'abort',
  'muffin.chat_call.effective_deadline_source': 'deadline',
};

function short(attributeName: string): string {
  const alias = SHORTER[attributeName];
  if (alias) return alias;
  const parts = attributeName.split('.');
  return parts[parts.length - 1] ?? attributeName;
}
