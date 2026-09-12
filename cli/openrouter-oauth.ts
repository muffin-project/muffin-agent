import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Local-first OpenRouter OAuth/PKCE primitive.
 *
 * This module deliberately does not write config or secrets and does not open a
 * browser. It owns exactly the protocol boundary: PKCE material, the loopback
 * callback, state verification and code exchange. The caller owns presentation
 * and the existing persistent secret writer owns the resulting key.
 *
 * Security invariants:
 * - callback binds only to 127.0.0.1 on an OS-selected port;
 * - PKCE uses S256 and cryptographically random verifier/state values;
 * - authorization code, verifier, state and API key are never logged here;
 * - the callback accepts one exact path and verifies state before returning a
 *   code;
 * - every listener has a bounded lifetime and is closed after settle;
 * - exchange failures expose status, never the response body (which is outside
 *   our secret/logging trust boundary).
 */

export const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
export const OPENROUTER_EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys';
export const OPENROUTER_CALLBACK_PATH = '/callback';
export const OPENROUTER_OAUTH_TIMEOUT_MS = 120_000;

export type PkcePair = {
  verifier: string;
  challenge: string;
};

export type LoopbackCallback = {
  callbackUrl: string;
  state: string;
  waitForCode: () => Promise<string>;
  close: () => Promise<void>;
};

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

export function createPkcePair(): PkcePair {
  // RFC 7636 allows 43-128 unreserved characters. 32 random bytes encoded as
  // base64url produce 43 characters with no padding.
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function createOauthState(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * OpenRouter documents state support by preserving it in the callback URL.
 * Keeping it there means the same opaque callback URL is what OpenRouter sees
 * and what the local listener later verifies; there is no second state channel
 * that can silently diverge.
 */
export function buildOpenRouterAuthorizationUrl(callbackUrl: string, challenge: string): string {
  const url = new URL(OPENROUTER_AUTH_URL);
  url.searchParams.set('callback_url', callbackUrl);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function startOpenRouterLoopback(options: {
  state?: string;
  timeoutMs?: number;
} = {}): Promise<LoopbackCallback> {
  const state = options.state ?? createOauthState();
  const timeoutMs = options.timeoutMs ?? OPENROUTER_OAUTH_TIMEOUT_MS;

  let server: Server | undefined;
  let settled = false;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const close = async (): Promise<void> => {
    const current = server;
    if (!current?.listening) return;
    await new Promise<void>((resolve) => current.close(() => resolve()));
  };

  const finish = (outcome: { code: string } | { error: Error }): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    void close();
    if ('code' in outcome) resolveCode(outcome.code);
    else rejectCode(outcome.error);
  };

  server = createServer((request, response) => {
    const host = request.headers.host ?? '127.0.0.1';
    const requestUrl = new URL(request.url ?? '/', `http://${host}`);

    if (request.method !== 'GET' || requestUrl.pathname !== OPENROUTER_CALLBACK_PATH) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }

    if (requestUrl.searchParams.get('state') !== state) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Authorization state did not match. You can close this tab.');
      return;
    }

    const oauthError = requestUrl.searchParams.get('error');
    if (oauthError) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('OpenRouter authorization was not completed. You can close this tab.');
      finish({ error: new Error('OpenRouter authorization was not completed') });
      return;
    }

    const authorizationCode = requestUrl.searchParams.get('code');
    if (!authorizationCode) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Authorization code missing. You can close this tab.');
      return;
    }

    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Muffin is connected to OpenRouter. You can close this tab.');
    finish({ code: authorizationCode });
  });

  server.on('error', (error) => finish({ error: new Error(`OpenRouter callback failed: ${error.message}`) }));

  await new Promise<void>((resolve, reject) => {
    server!.once('listening', resolve);
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1');
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await close();
    throw new Error('OpenRouter callback did not bind a TCP port');
  }

  const callback = new URL(`http://127.0.0.1:${(address as AddressInfo).port}${OPENROUTER_CALLBACK_PATH}`);
  callback.searchParams.set('state', state);

  const timer = setTimeout(() => {
    finish({ error: new Error('OpenRouter authorization timed out') });
  }, timeoutMs);
  timer.unref?.();

  return {
    callbackUrl: callback.toString(),
    state,
    waitForCode: () => code,
    close: async () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectCode(new Error('OpenRouter authorization cancelled'));
      }
      await close();
    },
  };
}

export async function exchangeOpenRouterAuthorizationCode(options: {
  code: string;
  verifier: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(OPENROUTER_EXCHANGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: options.code,
      code_verifier: options.verifier,
      code_challenge_method: 'S256',
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    // Do not include the body. It is controlled by an external auth boundary
    // and could contain data we have no reason to copy into terminal/log text.
    throw new Error(`OpenRouter authorization exchange failed (HTTP ${response.status})`);
  }

  const body = (await response.json()) as { key?: unknown };
  if (typeof body.key !== 'string' || body.key.length === 0) {
    throw new Error('OpenRouter authorization exchange returned no API key');
  }
  return body.key;
}
