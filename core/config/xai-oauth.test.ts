import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readSecret } from './config.js';
import { pkceChallenge } from './openrouter-oauth.js';
import {
  beginLocalXaiOAuth,
  buildXaiAuthorizeUrl,
  exchangeXaiAuthorizationCode,
  parsePastedCallback,
  pollXaiDeviceToken,
  requestXaiDeviceAuthorization,
  tokenExpiresAt,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_SCOPE,
  XaiOAuthConnection,
  XaiReauthenticationRequired,
} from './xai-oauth.js';

const ACCESS = 'xai-access-canary';
const REFRESH = 'xai-refresh-canary';

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-xai-oauth-'));
  mkdirSync(join(dir, 'secrets'), { recursive: true, mode: 0o700 });
  return dir;
}

type Seen = { url: string; body: URLSearchParams; headers: Headers };

function stubFetch(answers: Array<(seen: Seen) => Response>) {
  const seen: Seen[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const entry: Seen = {
      url: request.url,
      body: new URLSearchParams(await request.text()),
      headers: request.headers,
    };
    seen.push(entry);
    const answer = answers.shift();
    if (!answer) throw new Error('unexpected request');
    return answer(entry);
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    httpRequest(url, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    })
      .on('error', reject)
      .end();
  });
}

describe('xAI OAuth protocol (ADR-0113)', () => {
  it('builds the authorize URL Grok Build sends, with Muffin as referrer', () => {
    const url = new URL(
      buildXaiAuthorizeUrl({
        redirectUri: 'http://127.0.0.1:4242/callback',
        challenge: 'challenge-x',
        state: 'state-x',
        nonce: 'nonce-x',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://auth.x.ai/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'b1a00492-073a-47ea-816f-4c329264a828',
      redirect_uri: 'http://127.0.0.1:4242/callback',
      scope: 'openid profile email offline_access grok-cli:access api:access',
      code_challenge: 'challenge-x',
      code_challenge_method: 'S256',
      state: 'state-x',
      nonce: 'nonce-x',
      referrer: 'muffin',
    });
  });

  it('receives the code on the loopback only with the right path and state', async () => {
    const session = await beginLocalXaiOAuth({ timeoutMs: 5_000 });
    try {
      expect(session.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      const authorize = new URL(session.authorizeUrl);
      expect(authorize.searchParams.get('redirect_uri')).toBe(session.redirectUri);
      expect(authorize.searchParams.get('code_challenge')).toBe(pkceChallenge(session.verifier));
      expect(session.verifier.length).toBeGreaterThanOrEqual(43);
      expect(
        (await get(`${session.redirectUri.replace('/callback', '/other')}?code=x`)).status,
      ).toBe(404);
      expect((await get(`${session.redirectUri}?code=x&state=wrong`)).status).toBe(400);
      const ok = await get(`${session.redirectUri}?code=the-code&state=${session.state}`);
      expect(ok.status).toBe(200);
      expect(ok.body).not.toContain('the-code');
      await expect(session.code).resolves.toBe('the-code');
      expect(
        (
          await get(`${session.redirectUri}?code=again&state=${session.state}`).catch(() => ({
            status: 0,
          }))
        ).status,
      ).not.toBe(200);
    } finally {
      await session.close();
    }
  });

  it('rejects a provider error on the callback without echoing it', async () => {
    const session = await beginLocalXaiOAuth({ timeoutMs: 5_000 });
    await get(
      `${session.redirectUri}?error=access_denied&error_description=secret-x&state=${session.state}`,
    );
    await expect(session.code).rejects.toThrow(/^xAI authorization was not completed$/);
    await session.close();
  });

  it('accepts a pasted callback URL with matching state, or a bare code', async () => {
    expect(parsePastedCallback('http://127.0.0.1:1/callback?code=abc&state=s1', 's1')).toBe('abc');
    expect(() =>
      parsePastedCallback('http://127.0.0.1:1/callback?code=abc&state=zz', 's1'),
    ).toThrow(/state did not match/);
    expect(() =>
      parsePastedCallback('http://127.0.0.1:1/callback?error=denied&state=s1', 's1'),
    ).toThrow(/not completed/);
    expect(parsePastedCallback('  bare-code  ', 's1')).toBe('bare-code');
    expect(() => parsePastedCallback('two words', 's1')).toThrow(/invalid/);
    const session = await beginLocalXaiOAuth({ timeoutMs: 5_000 });
    expect(() => session.submitPasted(`${session.redirectUri}?code=p&state=bad`)).toThrow();
    session.submitPasted(`${session.redirectUri}?code=pasted&state=${session.state}`);
    await expect(session.code).resolves.toBe('pasted');
    await session.close();
  });

  it('exchanges the code with a form-encoded public-client request and never echoes the body', async () => {
    const { fetchImpl, seen } = stubFetch([
      () =>
        Response.json({
          access_token: ACCESS,
          refresh_token: REFRESH,
          expires_in: 1800,
          token_type: 'Bearer',
        }),
      () =>
        new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'leak-me' }), {
          status: 400,
        }),
    ]);
    const token = await exchangeXaiAuthorizationCode({
      code: 'c1',
      verifier: 'v1',
      redirectUri: 'http://127.0.0.1:9/callback',
      fetchImpl,
    });
    expect(token).toEqual({ accessToken: ACCESS, refreshToken: REFRESH, expiresIn: 1800 });
    expect(seen[0]?.url).toBe('https://auth.x.ai/oauth2/token');
    expect(seen[0]?.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(seen[0]?.body ?? [])).toEqual({
      grant_type: 'authorization_code',
      code: 'c1',
      redirect_uri: 'http://127.0.0.1:9/callback',
      client_id: XAI_OAUTH_CLIENT_ID,
      code_verifier: 'v1',
    });
    const refused = exchangeXaiAuthorizationCode({
      code: 'c',
      verifier: 'v',
      redirectUri: 'r',
      fetchImpl,
    });
    await expect(refused).rejects.toThrow('code exchange refused (400)');
    await expect(refused).rejects.not.toThrow(/leak-me/);
  });

  it('runs the RFC 8628 device grant with pending and slow_down', async () => {
    const { fetchImpl, seen } = stubFetch([
      () =>
        Response.json({
          device_code: 'dev-1',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://accounts.x.ai/device',
          verification_uri_complete: 'https://accounts.x.ai/device?code=ABCD-EFGH',
          expires_in: 600,
          interval: 2,
        }),
      () => new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 }),
      () => new Response(JSON.stringify({ error: 'slow_down' }), { status: 400 }),
      () => Response.json({ access_token: ACCESS, refresh_token: REFRESH }),
    ]);
    const device = await requestXaiDeviceAuthorization({ fetchImpl });
    expect(device).toMatchObject({ userCode: 'ABCD-EFGH', interval: 2, expiresIn: 600 });
    expect(Object.fromEntries(seen[0]?.body ?? [])).toEqual({
      client_id: XAI_OAUTH_CLIENT_ID,
      scope: XAI_OAUTH_SCOPE,
      referrer: 'muffin',
    });
    const sleeps: number[] = [];
    const token = await pollXaiDeviceToken(device, {
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(token.accessToken).toBe(ACCESS);
    expect(sleeps).toEqual([2_000, 2_000, 7_000]);
    expect(seen[1]?.body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(seen[1]?.body.get('device_code')).toBe('dev-1');
  });

  it('refuses a device page outside x.ai and stops on denial or expiry', async () => {
    const phishing = stubFetch([
      () =>
        Response.json({
          device_code: 'd',
          user_code: 'U',
          verification_uri: 'https://evil.test/x.ai',
        }),
    ]);
    await expect(requestXaiDeviceAuthorization({ fetchImpl: phishing.fetchImpl })).rejects.toThrow(
      /invalid device code response/,
    );
    const device = {
      deviceCode: 'd',
      userCode: 'U',
      verificationUri: 'https://accounts.x.ai/d',
      expiresIn: 60,
      interval: 1,
    };
    const denied = stubFetch([
      () => new Response(JSON.stringify({ error: 'access_denied' }), { status: 400 }),
    ]);
    await expect(
      pollXaiDeviceToken(device, { fetchImpl: denied.fetchImpl, sleep: async () => {} }),
    ).rejects.toThrow('denied');
    let clock = 0;
    const pending = stubFetch([
      () => new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 }),
    ]);
    await expect(
      pollXaiDeviceToken(device, {
        fetchImpl: pending.fetchImpl,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms * 40;
        },
      }),
    ).rejects.toThrow('expired');
  });

  it('derives expiry from expires_in, then the JWT exp, then one hour', () => {
    expect(tokenExpiresAt({ accessToken: 'opaque', expiresIn: 10 }, 1_000)).toBe(11_000);
    const payload = Buffer.from(JSON.stringify({ exp: 5_000 })).toString('base64url');
    expect(tokenExpiresAt({ accessToken: `h.${payload}.s` }, 1_000)).toBe(5_000_000);
    expect(tokenExpiresAt({ accessToken: 'opaque' }, 1_000)).toBe(3_601_000);
  });
});

describe('XaiOAuthConnection', () => {
  it('stores the session 0600 and reports status without tokens', async () => {
    const dir = home();
    const connection = new XaiOAuthConnection(dir, { now: () => 1_000_000 });
    expect(connection.status()).toMatchObject({ connected: false, usable: false });
    await connection.save(
      { accessToken: ACCESS, refreshToken: REFRESH, expiresIn: 3600 },
      'oauth-device',
      'me@example.com',
    );
    const file = join(dir, 'secrets', 'xai_oauth');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const status = connection.status();
    expect(status).toMatchObject({
      connected: true,
      usable: true,
      method: 'oauth-device',
      email: 'me@example.com',
    });
    expect(JSON.stringify(status)).not.toContain(ACCESS);
    expect(JSON.stringify(status)).not.toContain(REFRESH);
    expect(() => readSecret('secret://xai_oauth', dir)).toThrow(/login session, not an API key/);
  });

  it('refuses a login without a refresh token', async () => {
    const connection = new XaiOAuthConnection(home());
    await expect(connection.save({ accessToken: ACCESS }, 'oauth-pkce')).rejects.toThrow(
      /no refresh token/,
    );
  });

  it('returns a fresh token without network and refreshes once near expiry, persisting the rotation', async () => {
    const dir = home();
    let now = 1_000_000;
    const { fetchImpl, seen } = stubFetch([
      () =>
        Response.json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }),
    ]);
    const connection = new XaiOAuthConnection(dir, { fetch: fetchImpl, now: () => now });
    await connection.save(
      { accessToken: ACCESS, refreshToken: REFRESH, expiresIn: 600 },
      'oauth-pkce',
    );
    expect(await connection.accessToken()).toBe(ACCESS);
    expect(seen).toHaveLength(0);
    now += 500_000; // within two minutes of expiry
    const [a, b] = await Promise.all([connection.accessToken(), connection.accessToken()]);
    expect([a, b]).toEqual(['access-2', 'access-2']);
    expect(seen).toHaveLength(1);
    expect(Object.fromEntries(seen[0]?.body ?? [])).toEqual({
      grant_type: 'refresh_token',
      refresh_token: REFRESH,
      client_id: XAI_OAUTH_CLIENT_ID,
    });
    const stored = JSON.parse(readFileSync(join(dir, 'secrets', 'xai_oauth'), 'utf8'));
    expect(stored).toMatchObject({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      lastRefresh: { outcome: 'ok' },
    });
    // Another process (a second instance) sees the refreshed token without refreshing again.
    expect(
      await new XaiOAuthConnection(dir, { fetch: fetchImpl, now: () => now }).accessToken(),
    ).toBe('access-2');
    expect(seen).toHaveLength(1);
  });

  it('latches invalid_grant as re-login and never replays the dead refresh token', async () => {
    const dir = home();
    let now = 1_000_000;
    const { fetchImpl, seen } = stubFetch([
      () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    ]);
    const connection = new XaiOAuthConnection(dir, { fetch: fetchImpl, now: () => now });
    await connection.save(
      { accessToken: ACCESS, refreshToken: REFRESH, expiresIn: 60 },
      'oauth-pkce',
    );
    now += 1;
    await expect(connection.accessToken()).rejects.toBeInstanceOf(XaiReauthenticationRequired);
    await expect(connection.accessToken()).rejects.toThrow('muffin auth login xai');
    expect(seen).toHaveLength(1);
    expect(connection.status()).toMatchObject({
      needsLogin: true,
      renewable: false,
      usable: false,
    });
    expect(connection.cachedAccessToken()).toBeUndefined();
  });

  it('a transient refresh failure is not a re-login', async () => {
    const dir = home();
    const { fetchImpl } = stubFetch([() => new Response('busy', { status: 503 })]);
    const connection = new XaiOAuthConnection(dir, { fetch: fetchImpl, now: () => 1_000_000 });
    await connection.save(
      { accessToken: ACCESS, refreshToken: REFRESH, expiresIn: 1 },
      'oauth-pkce',
    );
    await expect(connection.accessToken()).rejects.toThrow('refresh refused (503)');
    expect(connection.status()).toMatchObject({ needsLogin: false, renewable: true });
  });

  it('logout removes the session and revokes the refresh token', async () => {
    const dir = home();
    const { fetchImpl, seen } = stubFetch([() => new Response(null, { status: 200 })]);
    const connection = new XaiOAuthConnection(dir, { fetch: fetchImpl });
    await connection.save({ accessToken: ACCESS, refreshToken: REFRESH }, 'oauth-pkce');
    expect(await connection.disconnect()).toEqual({ removed: true, remoteRevoked: true });
    expect(existsSync(join(dir, 'secrets', 'xai_oauth'))).toBe(false);
    expect(seen[0]?.url).toBe('https://auth.x.ai/oauth2/revoke');
    expect(Object.fromEntries(seen[0]?.body ?? [])).toEqual({
      token: REFRESH,
      token_type_hint: 'refresh_token',
      client_id: XAI_OAUTH_CLIENT_ID,
    });
    expect(await connection.disconnect()).toEqual({ removed: false, remoteRevoked: false });
  });

  it('refuses a tampered or symlinked store instead of reading it', () => {
    const dir = home();
    writeFileSync(join(dir, 'secrets', 'xai_oauth'), '{"version":1}', { mode: 0o600 });
    expect(() => new XaiOAuthConnection(dir).status()).toThrow('xAI login store is invalid');
  });
});
