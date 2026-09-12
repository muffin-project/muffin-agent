import { describe, expect, it } from 'vitest';
import {
  buildOpenRouterAuthorizationUrl,
  createOauthState,
  createPkcePair,
  exchangeOpenRouterAuthorizationCode,
  OPENROUTER_EXCHANGE_URL,
  pkceChallenge,
  startOpenRouterLoopback,
} from './openrouter-oauth.js';

describe('OpenRouter PKCE', () => {
  it('matches the RFC 7636 S256 example', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(pkceChallenge(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('generates verifier and state with enough entropy and no base64 padding', () => {
    const a = createPkcePair();
    const b = createPkcePair();
    const stateA = createOauthState();
    const stateB = createOauthState();

    expect(a.verifier).toHaveLength(43);
    expect(a.challenge).toHaveLength(43);
    expect(a.challenge).toBe(pkceChallenge(a.verifier));
    expect(a.verifier).not.toBe(b.verifier);
    expect(stateA).toHaveLength(43);
    expect(stateA).not.toBe(stateB);
    expect(`${a.verifier}${a.challenge}${stateA}`).not.toContain('=');
  });

  it('builds the authorization URL without moving state out of the callback URL', () => {
    const callback = 'http://127.0.0.1:51423/callback?state=opaque-state';
    const url = new URL(buildOpenRouterAuthorizationUrl(callback, 'challenge'));

    expect(url.origin).toBe('https://openrouter.ai');
    expect(url.pathname).toBe('/auth');
    expect(url.searchParams.get('callback_url')).toBe(callback);
    expect(url.searchParams.get('code_challenge')).toBe('challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.has('state')).toBe(false);
  });
});

describe('OpenRouter loopback callback', () => {
  it('binds only to loopback, rejects the wrong state, then accepts the right code', async () => {
    const callback = await startOpenRouterLoopback({ state: 'expected-state', timeoutMs: 5_000 });
    const expected = new URL(callback.callbackUrl);
    expect(expected.hostname).toBe('127.0.0.1');
    expect(expected.pathname).toBe('/callback');
    expect(expected.searchParams.get('state')).toBe('expected-state');

    const waiting = callback.waitForCode();
    let settled = false;
    void waiting.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    const wrong = new URL(callback.callbackUrl);
    wrong.searchParams.set('state', 'attacker-state');
    wrong.searchParams.set('code', 'must-not-win');
    const wrongResponse = await fetch(wrong);
    expect(wrongResponse.status).toBe(400);
    await Promise.resolve();
    expect(settled).toBe(false);

    const right = new URL(callback.callbackUrl);
    right.searchParams.set('code', 'authorization-code');
    const rightResponse = await fetch(right);
    expect(rightResponse.status).toBe(200);
    expect(await waiting).toBe('authorization-code');
    await callback.close();
  });

  it('times out instead of leaving a listener alive forever', async () => {
    const callback = await startOpenRouterLoopback({ state: 'timeout-state', timeoutMs: 20 });
    await expect(callback.waitForCode()).rejects.toThrow('timed out');
    await callback.close();
  });

  it('does not reflect an OAuth error value into the surfaced failure', async () => {
    const callback = await startOpenRouterLoopback({ state: 'error-state', timeoutMs: 5_000 });
    const failed = callback.waitForCode();
    const url = new URL(callback.callbackUrl);
    url.searchParams.set('error', 'sensitive-provider-detail');

    const response = await fetch(url);
    expect(response.status).toBe(400);
    await expect(failed).rejects.toThrow('OpenRouter authorization was not completed');
    await expect(failed).rejects.not.toThrow('sensitive-provider-detail');
    await callback.close();
  });
});

describe('OpenRouter authorization-code exchange', () => {
  it('posts the PKCE verifier directly and returns the key without an auth header', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const fakeFetch: typeof fetch = async (input, init) => {
      seenUrl = String(input);
      seenInit = init;
      return new Response(JSON.stringify({ key: 'sk-or-v1-returned-once' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const key = await exchangeOpenRouterAuthorizationCode({
      code: 'authorization-code',
      verifier: 'pkce-verifier',
      fetchImpl: fakeFetch,
    });

    expect(key).toBe('sk-or-v1-returned-once');
    expect(seenUrl).toBe(OPENROUTER_EXCHANGE_URL);
    expect(seenInit?.method).toBe('POST');
    expect(new Headers(seenInit?.headers).has('authorization')).toBe(false);
    expect(JSON.parse(String(seenInit?.body))).toEqual({
      code: 'authorization-code',
      code_verifier: 'pkce-verifier',
      code_challenge_method: 'S256',
    });
  });

  it('never copies a provider error body into the thrown message', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response('provider said: sk-or-v1-do-not-log-this', { status: 403 });

    let message = '';
    try {
      await exchangeOpenRouterAuthorizationCode({
        code: 'bad-code',
        verifier: 'pkce-verifier',
        fetchImpl: fakeFetch,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe('OpenRouter authorization exchange failed (HTTP 403)');
    expect(message).not.toContain('sk-or-v1-do-not-log-this');
  });
});
