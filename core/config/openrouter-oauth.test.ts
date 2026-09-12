import { describe, expect, it, vi } from 'vitest';
import {
  OPENROUTER_AUTH_KEYS_URL,
  beginHeadlessOpenRouterOAuth,
  beginLocalOpenRouterOAuth,
  buildOpenRouterAuthorizeUrl,
  exchangeOpenRouterAuthorizationCode,
  pkceChallenge,
} from './openrouter-oauth.js';

const RFC7636_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC7636_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('OpenRouter OAuth PKCE', () => {
  it('implements the RFC 7636 S256 transform exactly', () => {
    expect(pkceChallenge(RFC7636_VERIFIER)).toBe(RFC7636_CHALLENGE);
  });

  it('builds the localhost authorization URL with S256 and no secret material', () => {
    const url = new URL(
      buildOpenRouterAuthorizeUrl({
        challenge: RFC7636_CHALLENGE,
        callbackUrl: 'http://127.0.0.1:43123/oauth/openrouter/random-path',
        keyLabel: 'Muffin',
      }),
    );

    expect(url.origin + url.pathname).toBe('https://openrouter.ai/auth');
    expect(url.searchParams.get('callback_url')).toBe('http://127.0.0.1:43123/oauth/openrouter/random-path');
    expect(url.searchParams.get('code_challenge')).toBe(RFC7636_CHALLENGE);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('key_label')).toBe('Muffin');
    expect(url.toString()).not.toContain(RFC7636_VERIFIER);
  });

  it('headless auth deliberately omits callback_url and still requires PKCE', () => {
    const session = beginHeadlessOpenRouterOAuth('Muffin CLI');
    const url = new URL(session.authorizeUrl);

    expect(url.searchParams.has('callback_url')).toBe(false);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(pkceChallenge(session.verifier));
    expect(url.searchParams.get('key_label')).toBe('Muffin CLI');
  });

  it('exchanges the code directly and never puts verifier/code in the URL', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(String(_url)).toBe(OPENROUTER_AUTH_KEYS_URL);
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(JSON.parse(String(init?.body))).toEqual({
        code: 'one-use-code',
        code_verifier: RFC7636_VERIFIER,
        code_challenge_method: 'S256',
      });
      return new Response(JSON.stringify({ key: 'sk-or-v1-secret-value' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const key = await exchangeOpenRouterAuthorizationCode({
      code: 'one-use-code',
      verifier: RFC7636_VERIFIER,
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(key).toBe('sk-or-v1-secret-value');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not echo provider response bodies on an exchange failure', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('do-not-log-code-or-key-material', { status: 403 }),
    );

    await expect(
      exchangeOpenRouterAuthorizationCode({
        code: 'secret-code',
        verifier: RFC7636_VERIFIER,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toThrow('OpenRouter OAuth exchange failed (403)');
  });

  it('binds to loopback, ignores the wrong callback path, then resolves once', async () => {
    const session = await beginLocalOpenRouterOAuth({ timeoutMs: 5_000, keyLabel: 'Muffin' });
    const callback = new URL(session.callbackUrl);
    const auth = new URL(session.authorizeUrl);

    try {
      expect(callback.hostname).toBe('127.0.0.1');
      expect(callback.port).not.toBe('');
      expect(auth.searchParams.get('callback_url')).toBe(session.callbackUrl);
      expect(auth.searchParams.get('code_challenge')).toBe(pkceChallenge(session.verifier));

      const wrong = await fetch(`http://127.0.0.1:${callback.port}/oauth/openrouter/not-the-session?code=wrong`);
      expect(wrong.status).toBe(404);

      const right = await fetch(`${session.callbackUrl}?code=right-code`);
      expect(right.status).toBe(200);
      await expect(session.code).resolves.toBe('right-code');
    } finally {
      await session.close();
    }
  });

  it('fails closed when the local callback expires', async () => {
    const session = await beginLocalOpenRouterOAuth({ timeoutMs: 20 });
    try {
      await expect(session.code).rejects.toThrow('OpenRouter OAuth authorization timed out');
    } finally {
      await session.close();
    }
  });
});
