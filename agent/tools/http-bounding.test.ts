import { brotliCompressSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { toolContext } from '../fixtures/tool-context.js';
import { makeHttpTool, readBoundedBody } from './http.js';

const ctx = toolContext();
const publicLookup = async () => [{ address: '93.184.216.34' }];

function fetchScript(responses: Response[]) {
  let i = 0;
  const fetchFn = (async () => {
    const next = responses[i++];
    if (!next) throw new Error('fetch called more times than scripted');
    return next;
  }) as typeof fetch;
  return { fetchFn };
}

function chunkedStream(totalChunks: number, chunkText: string, onRead?: (n: number) => void) {
  let n = 0;
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (n >= totalChunks) {
        controller.close();
        return;
      }
      n++;
      onRead?.(n);
      controller.enqueue(enc.encode(chunkText));
    },
  });
}

describe('http_get bounded body (#644)', () => {
  it('ordinary small text passes through unchanged, fenced tier-3, no marker', async () => {
    const { fetchFn } = fetchScript([new Response('piccolo corpo', { status: 200 })]);
    const tool = makeHttpTool({ fetchFn, lookupFn: publicLookup });
    const out = await tool.handler({ url: 'https://api.example.com/small' }, ctx);
    expect(out.isError).toBeUndefined();
    expect(out.tier).toBe(3);
    expect(out.content).toContain('piccolo corpo');
    expect(out.content).not.toContain('risposta troncata');
    expect(out.content).toMatch(/<<<web_[0-9a-f]+/);
  });

  it('Content-Length above the cap is bounded, not buffered', async () => {
    const big = `INIZIO${'x'.repeat(200_000)}FINE`;
    const { fetchFn } = fetchScript([
      new Response(big, { status: 200, headers: { 'content-length': String(200_000) } }),
    ]);
    const tool = makeHttpTool({ fetchFn, lookupFn: publicLookup });
    const out = await tool.handler({ url: 'https://api.example.com/big' }, ctx);
    expect(out.tier).toBe(3);
    expect(out.content).toContain('risposta troncata');
    expect(out.content).toContain('INIZIO');
    expect(out.content).not.toContain('FINE');
  });

  it('a lying Content-Length (small header, huge body) still stops at the cap', async () => {
    const big = `INIZIO${'y'.repeat(200_000)}FINE`;
    const { fetchFn } = fetchScript([
      new Response(big, { status: 200, headers: { 'content-length': '10' } }),
    ]);
    const tool = makeHttpTool({ fetchFn, lookupFn: publicLookup });
    const out = await tool.handler({ url: 'https://api.example.com/liar' }, ctx);
    expect(out.tier).toBe(3);
    expect(out.content).toContain('risposta troncata');
    expect(out.content).toContain('INIZIO');
    expect(out.content).not.toContain('FINE');
  });

  it('chunked body without Content-Length aborts early instead of buffering', async () => {
    let chunksRead = 0;
    // 100 chunks x 10k = ~1MB available; the cap must stop far earlier.
    const stream = chunkedStream(100, `INIZIO${'z'.repeat(10_000)}`, (n) => (chunksRead = n));
    const { fetchFn } = fetchScript([new Response(stream, { status: 200 })]);
    const tool = makeHttpTool({ fetchFn, lookupFn: publicLookup });
    const out = await tool.handler({ url: 'https://api.example.com/chunked' }, ctx);
    expect(out.tier).toBe(3);
    expect(out.content).toContain('risposta troncata');
    expect(out.content).toContain('INIZIO');
    // Early abort: only a handful of chunks were consumed to reach 50k chars.
    expect(chunksRead).toBeLessThan(20);
  });

  it('gzip expansion cannot exceed the in-process bound', async () => {
    const huge = `INIZIO${'g'.repeat(300_000)}FINE`;
    const gz = gzipSync(huge);
    // Wire is tiny, decompressed is huge — the bomb shape.
    expect(gz.length).toBeLessThan(2_000);
    const { fetchFn } = fetchScript([
      new Response(gz, { status: 200, headers: { 'content-encoding': 'gzip' } }),
    ]);
    const tool = makeHttpTool({ fetchFn, lookupFn: publicLookup });
    const out = await tool.handler({ url: 'https://api.example.com/gzip-bomb' }, ctx);
    expect(out.tier).toBe(3);
    expect(out.content).toContain('risposta troncata');
    expect(out.content).toContain('INIZIO');
    expect(out.content).not.toContain('FINE');
  });

  it('br expansion cannot exceed the in-process bound', async () => {
    const huge = `INIZIO${'b'.repeat(300_000)}FINE`;
    const br = brotliCompressSync(huge);
    expect(br.length).toBeLessThan(2_000);
    const { fetchFn } = fetchScript([
      new Response(br, { status: 200, headers: { 'content-encoding': 'br' } }),
    ]);
    const tool = makeHttpTool({ fetchFn, lookupFn: publicLookup });
    const out = await tool.handler({ url: 'https://api.example.com/br-bomb' }, ctx);
    expect(out.tier).toBe(3);
    expect(out.content).toContain('risposta troncata');
    expect(out.content).toContain('INIZIO');
    expect(out.content).not.toContain('FINE');
  });

  it('rejects unsupported content encodings without exposing the encoded body', async () => {
    let cancelled = false;
    const marker = 'OPAQUE-ZSTD-MARKER';
    const payload = `${marker} encoded bytes`;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const { fetchFn } = fetchScript([
      new Response(body, { status: 200, headers: { 'content-encoding': 'zstd' } }),
    ]);
    const tool = makeHttpTool({ fetchFn, lookupFn: publicLookup });

    const out = await tool.handler({ url: 'https://api.example.com/zstd' }, ctx);

    expect(out.isError).toBe(true);
    expect(out.content).toContain('unsupported Content-Encoding');
    expect(out.content).not.toContain(marker);
    expect(out.retryable).toBeUndefined();
    expect(out.tier).toBe(0);
    expect(cancelled).toBe(true);
  });

  it('identity Content-Encoding remains a no-op', async () => {
    const { fetchFn } = fetchScript([
      new Response('identity body', { status: 200, headers: { 'content-encoding': 'identity' } }),
    ]);
    const tool = makeHttpTool({ fetchFn, lookupFn: publicLookup });

    const out = await tool.handler({ url: 'https://api.example.com/identity' }, ctx);

    expect(out.isError).toBeUndefined();
    expect(out.content).toContain('identity body');
    expect(out.tier).toBe(3);
  });

  it('ordinary gzip still decompresses unchanged when under the cap', async () => {
    const small = 'corpo piccolo gzip';
    const gz = gzipSync(small);
    const { fetchFn } = fetchScript([
      new Response(gz, { status: 200, headers: { 'content-encoding': 'gzip' } }),
    ]);
    const tool = makeHttpTool({ fetchFn, lookupFn: publicLookup });
    const out = await tool.handler({ url: 'https://api.example.com/gzip-small' }, ctx);
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain(small);
    expect(out.content).not.toContain('risposta troncata');
  });

  it('redirect semantics are unchanged by the bound', async () => {
    const { fetchFn } = fetchScript([
      new Response(null, { status: 302, headers: { location: 'https://api.example.com/real' } }),
      new Response('arrivato', { status: 200 }),
    ]);
    const tool = makeHttpTool({ fetchFn, lookupFn: publicLookup });
    const out = await tool.handler({ url: 'https://api.example.com/moved' }, ctx);
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain('arrivato');
  });

  it('readBoundedBody never builds the giant string: 1MB stream aborts at the cap', async () => {
    let chunksRead = 0;
    const stream = chunkedStream(100, 'q'.repeat(10_000), (n) => (chunksRead = n));
    const response = new Response(stream, { status: 200 });
    const { text, truncated } = await readBoundedBody(response, 50_000);
    expect(truncated).toBe(true);
    expect(text.length).toBe(50_000);
    expect(chunksRead).toBeLessThan(20);
  });
});
