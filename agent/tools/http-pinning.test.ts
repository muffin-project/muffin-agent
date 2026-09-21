import { createServer, request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import { describe, expect, it } from 'vitest';
import { isForbiddenAddress } from '../../core/net/egress.js';
import { toolContext } from '../fixtures/tool-context.js';
import { buildPinnedUrl, defaultPinnedFetch, hostHeaderFor, makeHttpTool, serverNameFor } from './http.js';

const ctx = toolContext();

function fetchRecorder(responses: Response[]) {
  const calls: Array<{ url: string; host: string | null }> = [];
  let i = 0;
  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, host: headers.get('host') });
    const next = responses[i++];
    if (!next) throw new Error('fetch called more times than scripted');
    return next;
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe('http_get DNS pinning (#640)', () => {
  it('connects to the validated IP, not the hostname — no second lookup to rebind', async () => {
    const { fetchFn, calls } = fetchRecorder([
      new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }),
    ]);
    const seenLookups: string[] = [];
    const tool = makeHttpTool({
      fetchFn,
      lookupFn: async (hostname) => {
        seenLookups.push(hostname);
        return [{ address: '93.184.216.34' }];
      },
    });
    const out = await tool.handler({ url: 'https://rebind.example.com/page' }, ctx);
    expect(out.isError).toBeUndefined();
    expect(seenLookups).toEqual(['rebind.example.com']);
    expect(calls.length).toBe(1);
    const called = new URL(calls[0]!.url);
    // The wire target is the validated answer itself.
    expect(called.hostname).toBe('93.184.216.34');
    expect(called.pathname).toBe('/page');
    // Host still names the origin, so vhosts keep working.
    expect(calls[0]!.host).toBe('rebind.example.com');
    // The old shape (hostname on the wire) would have failed the line above:
    // a hostname fetch performs its own resolution after the veto.
    expect(called.hostname).not.toBe('rebind.example.com');
  });

  it('a rebinding answer on the would-be second lookup never reaches the wire', async () => {
    // Deterministic rebinding without Internet: first answer public, second
    // private. A check-then-hostname-fetch would resolve again at connect
    // time and land on the private answer; a pinned fetch cannot, because it
    // never resolves the hostname a second time.
    const answers = [[{ address: '93.184.216.34' }], [{ address: '127.0.0.1' }]];
    let n = 0;
    const lookupFn = async (hostname: string) => {
      expect(hostname).toBe('evil-rebind.example.com');
      return answers[n++] ?? [{ address: '127.0.0.1' }];
    };
    let wireAddress = '';
    const fetchFn = (async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      // Simulate the network: an IP literal is dialled directly (no DNS);
      // a hostname would be resolved again — here, the recorded second answer.
      if (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) {
        wireAddress = url.hostname.replace(/^\[|\]$/g, '');
      } else {
        const second = await lookupFn(url.hostname);
        wireAddress = second[0]!.address;
      }
      // The test transport itself must refuse to cross the boundary, exactly
      // like the production transport does for a pinned literal.
      expect(isForbiddenAddress(wireAddress)).toBe(false);
      return new Response('public body', { status: 200 });
    }) as typeof fetch;
    const tool = makeHttpTool({ fetchFn, lookupFn });
    const out = await tool.handler({ url: 'https://evil-rebind.example.com/' }, ctx);
    expect(out.isError).toBeUndefined();
    expect(wireAddress).toBe('93.184.216.34');
    expect(n).toBe(1);
  });

  it('one private answer vetoes the hop even when a public answer exists', async () => {
    const { fetchFn, calls } = fetchRecorder([]);
    const tool = makeHttpTool({
      fetchFn,
      lookupFn: async () => [{ address: '93.184.216.34' }, { address: '10.0.0.7' }],
    });
    const out = await tool.handler({ url: 'https://mixed.example.com/' }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).toContain('non-routable');
    expect(calls.length).toBe(0);
  });

  it('every redirect hop resolves and pins anew', async () => {
    const { fetchFn, calls } = fetchRecorder([
      new Response(null, { status: 302, headers: { location: 'https://second.example.com/next' } }),
      new Response('arrived', { status: 200 }),
    ]);
    const lookups: string[] = [];
    const tool = makeHttpTool({
      fetchFn,
      lookupFn: async (hostname) => {
        lookups.push(hostname);
        return hostname === 'second.example.com'
          ? [{ address: '93.184.216.35' }]
          : [{ address: '93.184.216.34' }];
      },
    });
    const out = await tool.handler({ url: 'https://first.example.com/start' }, ctx);
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain('arrived');
    expect(lookups).toEqual(['first.example.com', 'second.example.com']);
    expect(calls.length).toBe(2);
    expect(new URL(calls[0]!.url).hostname).toBe('93.184.216.34');
    expect(calls[0]!.host).toBe('first.example.com');
    expect(new URL(calls[1]!.url).hostname).toBe('93.184.216.35');
    expect(calls[1]!.host).toBe('second.example.com');
  });

  it('preserves port, path and query on the pinned URL', async () => {
    const original = new URL('https://shop.example.com:8443/items?page=2#frag');
    const pinned = buildPinnedUrl(original, '93.184.216.34');
    expect(pinned.href).toBe('https://93.184.216.34:8443/items?page=2#frag');
    expect(hostHeaderFor(original)).toBe('shop.example.com:8443');
    const plain = new URL('https://shop.example.com/items');
    expect(hostHeaderFor(plain)).toBe('shop.example.com');
  });

  it('SNI carries the hostname, never an IP literal', () => {
    expect(serverNameFor('shop.example.com')).toBe('shop.example.com');
    expect(serverNameFor('shop.example.com.')).toBe('shop.example.com');
    expect(serverNameFor('93.184.216.34')).toBeUndefined();
    expect(serverNameFor('::1')).toBeUndefined();
    expect(serverNameFor('[::1]')).toBeUndefined();
  });

  it('a pinned IP request presents the original Host to a local server', async () => {
    // Deterministic local proof that pinning preserves virtual hosting: the
    // socket dials the IP literal while the origin sees the hostname. This
    // goes through `node:http` directly because `defaultPinnedFetch`
    // correctly refuses loopback (see the fail-closed tests) — the handler
    // tests above already prove the handler hands the transport an IP URL
    // plus the original `Host`, and this proves that pair behaves on the
    // wire. TLS SNI follows the same `Host`-derived value (`serverNameFor`);
    // the SNI handshake itself was verified manually against a local
    // self-signed `fake-example.test` server during the fix.
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'text/plain');
      res.end(`host=${req.headers.host}`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    try {
      const original = new URL(`http://shop.example.com:${port}/items?q=1`);
      const pinned = buildPinnedUrl(original, '127.0.0.1');
      expect(new URL(pinned.href).hostname).toBe('127.0.0.1');
      const body = await new Promise<string>((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: '127.0.0.1',
            port,
            path: '/items?q=1',
            method: 'GET',
            headers: { host: hostHeaderFor(original), 'user-agent': 'muffin/0.2 (+personal-agent)' },
          },
          (res) => {
            let text = '';
            res.on('data', (chunk) => (text += chunk));
            res.on('end', () => resolve(text));
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(body).toBe(`host=shop.example.com:${port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('default transport fails closed on a hostname instead of a pinned IP', async () => {
    await expect(
      defaultPinnedFetch(new URL('https://shop.example.com/'), { signal: AbortSignal.timeout(1_000) }),
    ).rejects.toThrow(/IP literal/);
  });
});
