import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

export const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
export const OPENROUTER_AUTH_KEYS_URL = 'https://openrouter.ai/api/v1/auth/keys';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;

/**
 * OAuth PKCE for the low-friction OpenRouter onboarding path.
 *
 * This module deliberately stops below UI and secret storage. It owns only the
 * protocol facts that must not be reimplemented by every surface:
 *
 * - high-entropy verifier;
 * - S256 challenge;
 * - loopback-only, one-shot callback on an arbitrary free port;
 * - an unguessable callback path as the request-correlation token;
 * - bounded lifetime;
 * - direct code → user-controlled API-key exchange.
 *
 * The resulting key is intentionally returned to the caller and never logged,
 * persisted or put in argv/env here. The onboarding caller must hand it directly
 * to Muffin's authoritative secret store.
 */

export type PkcePair = {
  verifier: string;
  challenge: string;
};

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function createPkcePair(): PkcePair {
  // 48 random bytes → 64 base64url characters, inside RFC 7636's 43–128 range.
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function buildOpenRouterAuthorizeUrl(input: {
  challenge: string;
  callbackUrl?: string;
  keyLabel?: string;
}): string {
  const url = new URL(OPENROUTER_AUTH_URL);
  if (input.callbackUrl) url.searchParams.set('callback_url', input.callbackUrl);
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (input.keyLabel) url.searchParams.set('key_label', input.keyLabel);
  return url.toString();
}

export async function exchangeOpenRouterAuthorizationCode(input: {
  code: string;
  verifier: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const request = input.fetchImpl ?? fetch;
  const response = await request(OPENROUTER_AUTH_KEYS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: input.code,
      code_verifier: input.verifier,
      code_challenge_method: 'S256',
    }),
  });

  if (!response.ok) {
    // Do not echo a provider body here: OAuth errors can contain request data,
    // and this function sits on a credential path. Status is enough for the UI
    // to explain/retry without making logs a second secret sink.
    throw new Error(`OpenRouter OAuth exchange failed (${response.status})`);
  }

  const body = (await response.json()) as { key?: unknown };
  if (typeof body.key !== 'string' || body.key.length === 0) {
    throw new Error('OpenRouter OAuth exchange returned no API key');
  }
  return body.key;
}

export type LocalOpenRouterOAuthSession = {
  /** Open this URL in the user's browser. */
  authorizeUrl: string;
  /** The exact loopback callback registered in authorizeUrl. */
  callbackUrl: string;
  /** PKCE verifier needed only for the exchange; never display or log it. */
  verifier: string;
  /** Resolves exactly once with the authorization code. */
  code: Promise<string>;
  /** Idempotent cancellation/cleanup. */
  close: () => Promise<void>;
};

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Starts a localhost OAuth callback without opening a browser.
 *
 * The callback uses 127.0.0.1 rather than an all-interface bind. The random path
 * is a request-correlation secret: an unrelated localhost request cannot finish
 * the OAuth flow merely by guessing `/callback`. PKCE independently makes a
 * stolen authorization code useless without the verifier.
 */
export async function beginLocalOpenRouterOAuth(input: {
  timeoutMs?: number;
  keyLabel?: string;
} = {}): Promise<LocalOpenRouterOAuthSession> {
  const pkce = createPkcePair();
  const callbackPath = `/oauth/openrouter/${randomBytes(24).toString('base64url')}`;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let settled = false;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((request, response) => {
    const host = request.headers.host ?? '127.0.0.1';
    let incoming: URL;
    try {
      incoming = new URL(request.url ?? '/', `http://${host}`);
    } catch {
      response.writeHead(400).end('Invalid OAuth callback.');
      return;
    }

    if (request.method !== 'GET' || incoming.pathname !== callbackPath) {
      response.writeHead(404).end('Not this OAuth callback.');
      return;
    }
    if (settled) {
      response.writeHead(410).end('This OAuth callback is already closed.');
      return;
    }

    const providerError = incoming.searchParams.get('error');
    const authCode = incoming.searchParams.get('code');
    if (providerError) {
      settled = true;
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('OpenRouter authorization was not completed. You can close this tab.');
      rejectCode(new Error(`OpenRouter OAuth authorization failed (${providerError})`));
      void closeServer(server);
      return;
    }
    if (!authCode) {
      response.writeHead(400).end('Missing OAuth authorization code.');
      return;
    }

    settled = true;
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Muffin is connected to OpenRouter. You can close this tab.');
    resolveCode(authCode);
    void closeServer(server);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Could not allocate a local OAuth callback port');
  }

  const callbackUrl = `http://127.0.0.1:${address.port}${callbackPath}`;
  const authorizeUrl = buildOpenRouterAuthorizeUrl({
    challenge: pkce.challenge,
    callbackUrl,
    ...(input.keyLabel ? { keyLabel: input.keyLabel } : {}),
  });

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectCode(new Error('OpenRouter OAuth authorization timed out'));
    void closeServer(server);
  }, timeoutMs);
  timer.unref?.();
  void code.finally(() => clearTimeout(timer)).catch(() => undefined);

  return {
    authorizeUrl,
    callbackUrl,
    verifier: pkce.verifier,
    code,
    close: async () => {
      if (!settled) {
        settled = true;
        rejectCode(new Error('OpenRouter OAuth authorization cancelled'));
      }
      clearTimeout(timer);
      await closeServer(server);
    },
  };
}

/**
 * Headless authorization uses the same PKCE pair but no callback URL. OpenRouter
 * then displays the one-use authorization code to the user for paste-back.
 */
export function beginHeadlessOpenRouterOAuth(keyLabel = 'Muffin'): {
  authorizeUrl: string;
  verifier: string;
} {
  const pkce = createPkcePair();
  return {
    authorizeUrl: buildOpenRouterAuthorizeUrl({ challenge: pkce.challenge, keyLabel }),
    verifier: pkce.verifier,
  };
}
