import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlExporter, SimpleTracer } from './tracer.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'muffin-tracer-'));
  homes.push(home);
  return home;
}

function traceFile(home: string): string {
  const file = readdirSync(join(home, 'traces')).at(0);
  if (!file) throw new Error('il trace non è stato scritto');
  return join(home, 'traces', file);
}

/**
 * P34-1 (audit-2026-08-16 #16): `redactAttributes()` runs on `span.attributes`
 * at tracer.ts:94, but `span.error` was assigned straight from the raw
 * exception message two lines later — never through `redactValue`. types.ts:36
 * promises "Present when status is 'error'. Never contains secrets (see
 * redact.ts)" for that exact field; the promise was false for any error whose
 * message happened to carry a key. This is the wiring test: it exercises the
 * real `JsonlExporter`, so it fails unless the redaction actually reaches the
 * file on disk, not just some in-memory span object.
 */
describe('SimpleTracer — span.error redaction (P34-1)', () => {
  it('redacts a secret-shaped string carried in the error message before it reaches the trace file', () => {
    const home = makeHome();
    const tracer = new SimpleTracer(new JsonlExporter(home));
    const leakedKey = 'sk-ant-abcdefghijklmnop0123456789';
    const message = `upstream rejected the request, Authorization: Bearer ${leakedKey}`;

    const handle = tracer.start('muffin.tool_call');
    handle.end({ error: new Error(message) });

    const line = readFileSync(traceFile(home), 'utf8').trim();
    const span = JSON.parse(line) as { error?: string };

    expect(line, 'a secret-shaped string reached the trace file in clear text').not.toContain(
      leakedKey,
    );
    expect(span.error).toBe(`«redacted:${message.length}»`);
  });

  it('leaves an ordinary error message untouched', () => {
    const home = makeHome();
    const tracer = new SimpleTracer(new JsonlExporter(home));

    const handle = tracer.start('muffin.tool_call');
    handle.end({ error: new Error('connection reset') });

    const span = JSON.parse(readFileSync(traceFile(home), 'utf8').trim()) as { error?: string };
    expect(span.error).toBe('connection reset');
  });

  it('does not record attributes added after a span has ended', () => {
    const home = makeHome();
    const tracer = new SimpleTracer(new JsonlExporter(home));

    const handle = tracer.start('muffin.turn');
    handle.end();
    handle.setAttributes({ 'muffin.turn.late_diagnostic': 'must not appear' });

    const line = readFileSync(traceFile(home), 'utf8').trim();
    const span = JSON.parse(line) as { attributes: Record<string, string> };
    expect(span.attributes).not.toHaveProperty('muffin.turn.late_diagnostic');
  });

  it('redacts a non-Error thrown value the same way', () => {
    const home = makeHome();
    const tracer = new SimpleTracer(new JsonlExporter(home));
    const leakedKey = 'ghp_abcdefghijklmnopqrstuvwxyz01';

    const handle = tracer.start('muffin.tool_call');
    handle.end({ error: `rejected token ${leakedKey}` });

    const line = readFileSync(traceFile(home), 'utf8').trim();
    expect(line, 'a secret-shaped string reached the trace file in clear text').not.toContain(
      leakedKey,
    );
  });
});
