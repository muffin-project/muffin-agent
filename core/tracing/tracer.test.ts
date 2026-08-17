import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonlExporter, SimpleTracer } from './tracer.js';

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
    const home = mkdtempSync(join(tmpdir(), 'muffin-tracer-'));
    const tracer = new SimpleTracer(new JsonlExporter(home));
    const leakedKey = 'sk-ant-abcdefghijklmnop0123456789';
    const message = `upstream rejected the request, Authorization: Bearer ${leakedKey}`;

    const handle = tracer.start('muffin.tool_call');
    handle.end({ error: new Error(message) });

    const file = readdirSync(join(home, 'traces'))[0]!;
    const line = readFileSync(join(home, 'traces', file), 'utf8').trim();
    const span = JSON.parse(line) as { error?: string };

    expect(line, 'a secret-shaped string reached the trace file in clear text').not.toContain(leakedKey);
    expect(span.error).toBe(`«redacted:${message.length}»`);
  });

  it('leaves an ordinary error message untouched', () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-tracer-'));
    const tracer = new SimpleTracer(new JsonlExporter(home));

    const handle = tracer.start('muffin.tool_call');
    handle.end({ error: new Error('connection reset') });

    const file = readdirSync(join(home, 'traces'))[0]!;
    const span = JSON.parse(readFileSync(join(home, 'traces', file), 'utf8').trim()) as { error?: string };
    expect(span.error).toBe('connection reset');
  });

  it('redacts a non-Error thrown value the same way', () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-tracer-'));
    const tracer = new SimpleTracer(new JsonlExporter(home));
    const leakedKey = 'ghp_abcdefghijklmnopqrstuvwxyz01';

    const handle = tracer.start('muffin.tool_call');
    handle.end({ error: `rejected token ${leakedKey}` });

    const file = readdirSync(join(home, 'traces'))[0]!;
    const line = readFileSync(join(home, 'traces', file), 'utf8').trim();
    expect(line, 'a secret-shaped string reached the trace file in clear text').not.toContain(leakedKey);
  });
});
