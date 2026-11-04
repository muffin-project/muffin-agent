import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { discoverOpenAICompatModels } from './models-discovery.js';

const BASE = 'http://llm.example.test:8080/v1';

/** Fake fetch answering one fixed response, recording what was asked. */
function answer(
  status: number,
  body: string,
): { fetch: typeof globalThis.fetch; seen: { url: string; auth: string | null }[] } {
  const seen: { url: string; auth: string | null }[] = [];
  const fetch = (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
    return new Response(body, { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}

const list = (...ids: unknown[]) =>
  JSON.stringify({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) });

describe('discoverOpenAICompatModels', () => {
  it('reads the listed ids from {baseUrl}/models, sending the credential as a bearer token', async () => {
    const net = answer(200, list('qwen3.6-35b', 'gemma-4-12b'));
    const found = await discoverOpenAICompatModels({
      baseUrl: BASE,
      apiKey: 'canary-key',
      fetch: net.fetch,
    });
    expect(found).toEqual({ status: 'known', models: ['qwen3.6-35b', 'gemma-4-12b'] });
    expect(net.seen).toEqual([{ url: `${BASE}/models`, auth: 'Bearer canary-key' }]);
  });

  it('sends no Authorization without a credential, and tolerates a trailing slash', async () => {
    const net = answer(200, list('a'));
    await discoverOpenAICompatModels({ baseUrl: `${BASE}/`, fetch: net.fetch });
    await discoverOpenAICompatModels({ baseUrl: BASE, apiKey: '', fetch: net.fetch });
    expect(net.seen).toEqual([
      { url: `${BASE}/models`, auth: null },
      { url: `${BASE}/models`, auth: null },
    ]);
  });

  it('drops entries without a string id and duplicates, keeping order', async () => {
    const found = await discoverOpenAICompatModels({
      baseUrl: BASE,
      fetch: answer(200, list('a', 7, '', 'b', 'a')).fetch,
    });
    expect(found).toEqual({ status: 'known', models: ['a', 'b'] });
  });

  it('an empty, null or absent data list is zero models, not another shape', async () => {
    for (const body of [
      list(),
      JSON.stringify({ object: 'list', data: null }),
      JSON.stringify({ object: 'list' }),
    ]) {
      expect(
        await discoverOpenAICompatModels({ baseUrl: BASE, fetch: answer(200, body).fetch }),
      ).toEqual({
        status: 'known',
        models: [],
      });
    }
  });

  it('a rejected credential is unreachable(auth), and the key never appears in the detail', async () => {
    for (const status of [401, 403]) {
      const found = await discoverOpenAICompatModels({
        baseUrl: BASE,
        apiKey: 'canary-key',
        fetch: answer(status, '{"error":{"message":"Invalid API Key"}}').fetch,
      });
      expect(found).toMatchObject({ status: 'unreachable', reason: 'auth' });
      expect(JSON.stringify(found)).not.toContain('canary-key');
    }
  });

  it('no list at this path, or not a list, is unsupported', async () => {
    for (const [status, body] of [
      [404, 'not found'],
      [405, ''],
      [200, '<html>'],
      [200, '[]'],
      [200, '"x"'],
      [200, JSON.stringify({ data: 'x' })],
    ] as const) {
      expect(
        await discoverOpenAICompatModels({ baseUrl: BASE, fetch: answer(status, body).fetch }),
      ).toMatchObject({
        status: 'unsupported',
      });
    }
  });

  it('a server error is unreachable(http)', async () => {
    expect(
      await discoverOpenAICompatModels({ baseUrl: BASE, fetch: answer(503, 'busy').fetch }),
    ).toMatchObject({
      status: 'unreachable',
      reason: 'http',
    });
  });

  it('a network failure is unreachable(network)', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    }) as unknown as typeof globalThis.fetch;
    expect(await discoverOpenAICompatModels({ baseUrl: BASE, fetch })).toEqual({
      status: 'unreachable',
      reason: 'network',
      detail: 'ECONNREFUSED',
    });
  });

  it('gives up at the timeout instead of hanging', async () => {
    const fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      })) as unknown as typeof globalThis.fetch;
    const started = Date.now();
    const found = await discoverOpenAICompatModels({ baseUrl: BASE, fetch, timeoutMs: 50 });
    expect(found).toMatchObject({ status: 'unreachable', reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

/** Real loopback HTTP, real fetch: the header and redirect behaviour are the runtime's, not a fake's. */
describe('discoverOpenAICompatModels against a real loopback server', () => {
  async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port assigned');
    return {
      baseUrl: `http://127.0.0.1:${String(addr.port)}/v1`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it('an --api-key server: listed with the right key, rejected without it', async () => {
    const srv = await serve((req, res) => {
      if (req.headers.authorization !== 'Bearer right-key') {
        res
          .writeHead(401, { 'content-type': 'application/json' })
          .end('{"error":{"message":"Invalid API Key"}}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(list('qwen3.6-35b'));
    });
    try {
      expect(
        await discoverOpenAICompatModels({ baseUrl: srv.baseUrl, apiKey: 'right-key' }),
      ).toEqual({
        status: 'known',
        models: ['qwen3.6-35b'],
      });
      expect(await discoverOpenAICompatModels({ baseUrl: srv.baseUrl })).toMatchObject({
        status: 'unreachable',
        reason: 'auth',
      });
    } finally {
      await srv.close();
    }
  });

  it('does not follow a redirect, so the credential stays on the configured endpoint', async () => {
    let followed = false;
    const target = await serve((_req, res) => {
      followed = true;
      res.writeHead(200).end(list('elsewhere'));
    });
    const srv = await serve((_req, res) => {
      res.writeHead(302, { location: `${target.baseUrl}/models` }).end();
    });
    try {
      expect(
        await discoverOpenAICompatModels({ baseUrl: srv.baseUrl, apiKey: 'right-key' }),
      ).toMatchObject({
        status: 'unreachable',
        reason: 'http',
      });
      expect(followed).toBe(false);
    } finally {
      await srv.close();
      await target.close();
    }
  });
});
