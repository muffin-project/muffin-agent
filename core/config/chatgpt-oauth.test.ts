import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatGPTConnection } from './chatgpt-oauth.js';

const ISSUER = 'https://auth.openai.com';
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const CLIENT_ID = 'oaiapp_test-issued-client';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const homes: string[] = [];
const { privateKey, publicKey } = await generateKeyPair('RS256');
const publicJwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };

afterEach(() => {
  for (const home of homes.splice(0)) {
    // Test homes are deliberately private and contain only synthetic tokens.
    rmSync(home, { recursive: true, force: true });
  }
});

function home(): string {
  const path = mkdtempSync(join(tmpdir(), 'muffin-chatgpt-oauth-'));
  homes.push(path);
  return path;
}

async function idToken(
  input: {
    nonce?: string;
    sub?: string;
    audience?: string | string[];
    azp?: string;
    expired?: boolean;
    issuer?: string;
    expiresInSeconds?: number;
  } = {},
): Promise<string> {
  let jwt = new SignJWT({
    email: 'account@example.test',
    ...(input.nonce ? { nonce: input.nonce } : {}),
    ...(input.azp ? { azp: input.azp } : {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(input.issuer ?? ISSUER)
    .setSubject(input.sub ?? 'subject-1')
    .setAudience(input.audience ?? CLIENT_ID)
    .setIssuedAt();
  const expiration = input.expired
    ? Math.floor(Date.now() / 1000) - 60
    : input.expiresInSeconds === undefined
      ? '10m'
      : Math.floor(Date.now() / 1000) + input.expiresInSeconds;
  return jwt.setExpirationTime(expiration).sign(privateKey);
}

function fakeFetch(
  options: {
    refresh?: () => Promise<Record<string, unknown>>;
    loginScopes?: string;
    loginIdToken?: (nonce: string) => Promise<string>;
    loginExpiresIn?: number;
    loginTokenType?: string;
  } = {},
) {
  let refreshCount = 0;
  const requests: Array<{ url: string; body?: URLSearchParams }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body instanceof URLSearchParams ? init.body : undefined;
    requests.push({ url, ...(body ? { body } : {}) });
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/api/accounts/authorize`,
        token_endpoint: `${ISSUER}/api/accounts/oauth/token`,
        jwks_uri: JWKS_URL,
        revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke`,
      });
    }
    if (url === JWKS_URL) return Response.json({ keys: [publicJwk] });
    if (url === `${ISSUER}/api/accounts/oauth/token`) {
      if (body?.get('grant_type') === 'authorization_code') {
        const authNonce = new URLSearchParams(String(init?.body)).get('nonce') ?? '';
        // The test injects nonce out-of-band after the authorize URL is observed.
        const nonce = loginNonce;
        return Response.json({
          access_token: 'access-login-secret',
          refresh_token: 'refresh-login-secret',
          id_token: await (options.loginIdToken?.(nonce) ?? idToken({ nonce })),
          token_type: options.loginTokenType ?? 'Bearer',
          scope: options.loginScopes ?? SCOPES,
          expires_in: options.loginExpiresIn ?? 3600,
        });
      }
      if (body?.get('grant_type') === 'refresh_token') {
        refreshCount += 1;
        const value = options.refresh
          ? await options.refresh()
          : {
              access_token: 'access-rotated-secret',
              refresh_token: 'refresh-rotated-secret',
              id_token: await idToken(),
              token_type: 'Bearer',
              scope: SCOPES,
              expires_in: 3600,
            };
        return Response.json(value);
      }
      return new Response('unexpected', { status: 400 });
    }
    if (url === 'https://api.openai.com/v1/models') {
      return Response.json({
        models: [
          {
            slug: 'model-visible',
            display_name: 'Visible model',
            visibility: 'list',
            supported_reasoning_levels: [
              { effort: 'low', description: 'Low reasoning' },
              { effort: 'medium', description: 'Medium reasoning' },
              { effort: 'none', description: 'Disable reasoning', instructions: 'ignored' },
              { effort: 'ultra', description: 'Unsupported by Muffin' },
              { effort: 'unknown', description: 'Unknown effort' },
              'low',
            ],
            default_reasoning_level: 'low',
            provider_private_field: 'must not escape parser',
          },
          { slug: 'model-hidden', display_name: 'Hidden model', visibility: 'hide' },
        ],
      });
    }
    if (url === `${ISSUER}/api/accounts/oauth/revoke`) return new Response(null, { status: 200 });
    throw new Error(`Unexpected URL ${url}`);
  };
  return { fetchImpl, requests, refreshCount: () => refreshCount };
}

let loginNonce = '';

async function signIn(
  connection: ChatGPTConnection,
  options: { profileId?: string; newProfile?: boolean } = {},
): Promise<{ session: Awaited<ReturnType<ChatGPTConnection['signIn']>>; authorize: URL }> {
  let authorize: URL | undefined;
  const session = await connection.signIn({
    ...options,
    openBrowser: async (url) => {
      authorize = new URL(url);
      loginNonce = authorize.searchParams.get('nonce') ?? '';
      const callback = authorize.searchParams.get('redirect_uri');
      if (!callback) throw new Error('missing callback');
      const state = authorize.searchParams.get('state') ?? '';
      const wrong = await fetch(`${callback}?state=wrong&code=forged&client_id=${CLIENT_ID}`);
      expect(wrong.status).toBe(400);
      const response = await fetch(
        `${callback}?state=${encodeURIComponent(state)}&code=auth-code&client_id=${CLIENT_ID}`,
      );
      expect(response.status).toBe(200);
    },
  });
  if (!authorize) throw new Error('browser was not opened');
  return { session, authorize };
}

describe('ChatGPT plan OAuth credentials', () => {
  it('uses the official public-client callback contract and returns safe profile metadata', async () => {
    const path = home();
    const { fetchImpl, requests } = fakeFetch();
    const connection = new ChatGPTConnection(path, { fetch: fetchImpl });
    const { session, authorize } = await signIn(connection);

    expect(authorize.origin + authorize.pathname).toBe(`${ISSUER}/api/accounts/authorize`);
    expect(authorize.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(authorize.searchParams.get('response_type')).toBe('code');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('redirect_uri')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/,
    );
    expect(authorize.searchParams.get('scope')).toContain('chatgpt.tokens.use.direct');
    expect(
      requests
        .find((request) => request.body?.get('grant_type') === 'authorization_code')
        ?.body?.get('client_id'),
    ).toBe(CLIENT_ID);
    expect(
      requests
        .find((request) => request.body?.get('grant_type') === 'authorization_code')
        ?.body?.get('redirect_uri'),
    ).toBe(authorize.searchParams.get('redirect_uri'));
    expect(session).toMatchObject({
      connected: true,
      email: 'account@example.test',
      scopes: expect.arrayContaining(['chatgpt.tokens.use.direct']),
    });
    expect(JSON.stringify(session)).not.toContain('access-login-secret');
    expect(JSON.stringify(connection.profiles())).not.toContain('refresh-login-secret');
    expect(statSync(join(path, 'secrets')).mode & 0o777).toBe(0o700);
    expect(statSync(join(path, 'secrets', 'chatgpt')).mode & 0o777).toBe(0o600);
    expect(connection.session()?.profileId).toBe(session.profileId);
    expect(await connection.listModels()).toEqual([
      {
        slug: 'model-visible',
        displayName: 'Visible model',
        supportedReasoningLevels: ['low', 'medium', 'none'],
        defaultReasoningLevel: 'low',
      },
    ]);
  });

  it('rejects signature, nonce, and audience faults without activating the pending account', async () => {
    for (const [index, bad] of [
      { loginIdToken: async (nonce: string) => idToken({ nonce: `${nonce}-wrong` }) },
      { loginIdToken: async (nonce: string) => idToken({ nonce, audience: 'other-client' }) },
      {
        loginIdToken: async (nonce: string) =>
          idToken({ nonce, audience: [CLIENT_ID, 'other-client'] }),
      },
      {
        loginIdToken: async (nonce: string) =>
          idToken({ nonce, audience: [CLIENT_ID, 'other-client'], azp: 'other-client' }),
      },
      { loginIdToken: async (nonce: string) => idToken({ nonce, expired: true }) },
      { loginIdToken: async (nonce: string) => idToken({ nonce, issuer: 'https://evil.example' }) },
      {
        loginIdToken: async (nonce: string) => {
          const token = await idToken({ nonce });
          const [header, payload, signature] = token.split('.');
          const first = signature?.[0] === 'a' ? 'b' : 'a';
          return `${header}.${payload}.${first}${signature?.slice(1) ?? ''}`;
        },
      },
    ].entries()) {
      const path = home();
      const connection = new ChatGPTConnection(path, { fetch: fakeFetch(bad).fetchImpl });
      let signInError: unknown;
      try {
        await signIn(connection);
      } catch (error) {
        signInError = error;
      }
      expect(signInError, `fault case ${index}`).toBeInstanceOf(Error);
      expect(signInError, `fault case ${index}`).toMatchObject({
        message: expect.stringMatching(/ChatGPT identity validation failed/),
      });
      expect(connection.session()).toBeNull();
      expect(connection.profiles()).toHaveLength(1); // issued client registration was checkpointed
      expect(connection.profiles()[0]?.connected).toBe(false);
    }
  });

  it('does not accept a token grant that lacks direct plan-use scope', async () => {
    const path = home();
    const connection = new ChatGPTConnection(path, {
      fetch: fakeFetch({ loginScopes: 'openid profile offline_access resource.invoke' }).fetchImpl,
    });
    await expect(signIn(connection)).rejects.toThrow('ChatGPT connection failed');
    expect(connection.session()).toBeNull();
  });

  it('requires a positive expiry and bearer token type in the authorization grant', async () => {
    for (const grant of [{ loginExpiresIn: 0 }, { loginTokenType: 'MAC' }]) {
      const path = home();
      const connection = new ChatGPTConnection(path, { fetch: fakeFetch(grant).fetchImpl });
      await expect(signIn(connection)).rejects.toThrow('ChatGPT connection failed');
      expect(connection.session()).toBeNull();
    }
  });

  it('keeps existing credentials until a reauthorization identity is validated', async () => {
    const path = home();
    let loginNumber = 0;
    const service = fakeFetch({
      loginIdToken: (nonce) => {
        loginNumber += 1;
        return idToken({ nonce, sub: loginNumber === 1 ? 'subject-1' : 'subject-2' });
      },
    });
    const connection = new ChatGPTConnection(path, { fetch: service.fetchImpl });
    const { session } = await signIn(connection);
    const before = JSON.parse(readFileSync(join(path, 'secrets', 'chatgpt'), 'utf8')) as {
      profiles: Array<{ tokens: { refreshToken: string } }>;
    };
    let reauthUrl: URL | undefined;
    await expect(
      connection.signIn({
        profileId: session.profileId,
        openBrowser: async (url) => {
          reauthUrl = new URL(url);
          loginNonce = reauthUrl.searchParams.get('nonce') ?? '';
          const callback = reauthUrl.searchParams.get('redirect_uri')!;
          await fetch(
            `${callback}?state=${encodeURIComponent(reauthUrl.searchParams.get('state')!)}&code=reauth-code`,
          );
        },
      }),
    ).rejects.toThrow('ChatGPT account identity changed');
    const after = JSON.parse(readFileSync(join(path, 'secrets', 'chatgpt'), 'utf8')) as {
      profiles: Array<{ tokens: { refreshToken: string }; pendingSignIn?: unknown }>;
    };
    expect(reauthUrl?.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(reauthUrl?.searchParams.has('agent_name_hint')).toBe(false);
    expect(reauthUrl?.searchParams.has('id_token_hint')).toBe(true);
    expect(after.profiles[0]?.tokens.refreshToken).toBe(before.profiles[0]?.tokens.refreshToken);
    expect(after.profiles[0]?.pendingSignIn).toBeDefined();
    expect(connection.profiles()[0]?.connected).toBe(true);
  });

  it('keeps provider callback and token endpoint error text out of thrown errors', async () => {
    const callbackPath = home();
    const connection = new ChatGPTConnection(callbackPath, { fetch: fakeFetch().fetchImpl });
    await expect(
      connection.signIn({
        openBrowser: async (url) => {
          const auth = new URL(url);
          const callback = auth.searchParams.get('redirect_uri');
          await fetch(
            `${callback}?state=${encodeURIComponent(auth.searchParams.get('state') ?? '')}&error=${encodeURIComponent('provider-secret-detail')}`,
          );
        },
      }),
    ).rejects.toThrow('ChatGPT authorization was not completed');

    const exchangePath = home();
    const failing: typeof fetch = async (input) => {
      if (String(input) === `${ISSUER}/api/accounts/oauth/token`)
        return new Response('response-body-has-secret', { status: 403 });
      return fakeFetch().fetchImpl(input);
    };
    const exchangeConnection = new ChatGPTConnection(exchangePath, { fetch: failing });
    await expect(signIn(exchangeConnection)).rejects.toThrow('ChatGPT connection failed');
  });

  it('serializes independent refresh callers and checkpoints the rotating token set', async () => {
    const path = home();
    let refreshStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => {
      refreshStarted = resolveStarted;
    });
    const service = fakeFetch({
      refresh: async () => {
        refreshStarted();
        await new Promise((resolveWait) => setTimeout(resolveWait, 35));
        return {
          access_token: 'access-rotated-secret',
          refresh_token: 'refresh-rotated-secret',
          id_token: await idToken(),
          token_type: 'Bearer',
          scope: SCOPES,
          expires_in: 3600,
        };
      },
    });
    const first = new ChatGPTConnection(path, { fetch: service.fetchImpl });
    const { session } = await signIn(first);
    const credentialFile = join(path, 'secrets', 'chatgpt');
    const saved = JSON.parse(readFileSync(credentialFile, 'utf8')) as {
      profiles: Array<{ tokens: { expiresAt: number } }>;
    };
    saved.profiles[0]!.tokens.expiresAt = Date.now() - 1;
    writeFileSync(credentialFile, JSON.stringify(saved));
    chmodSync(credentialFile, 0o600);
    const second = new ChatGPTConnection(path, { fetch: service.fetchImpl });

    const one = first.accessToken();
    await started;
    const two = second.accessToken();
    await expect(Promise.all([one, two])).resolves.toEqual([
      'access-rotated-secret',
      'access-rotated-secret',
    ]);
    expect(service.refreshCount()).toBe(1);
    const updated = JSON.parse(readFileSync(credentialFile, 'utf8')) as {
      profiles: Array<{
        tokens: { refreshToken: string; accessToken: string; pendingIdentity: boolean };
      }>;
    };
    expect(updated.profiles[0]?.tokens).toMatchObject({
      accessToken: 'access-rotated-secret',
      refreshToken: 'refresh-rotated-secret',
      pendingIdentity: false,
    });
    expect(first.profiles()[0]?.profileId).toBe(session.profileId);
  });

  it('retains a successful rotation if later JWKS identity validation is unavailable', async () => {
    const path = home();
    const normal = fakeFetch();
    const connection = new ChatGPTConnection(path, { fetch: normal.fetchImpl });
    await signIn(connection);
    const credentialFile = join(path, 'secrets', 'chatgpt');
    const saved = JSON.parse(readFileSync(credentialFile, 'utf8')) as {
      profiles: Array<{ tokens: { expiresAt: number } }>;
    };
    saved.profiles[0]!.tokens.expiresAt = Date.now() - 1;
    writeFileSync(credentialFile, JSON.stringify(saved));
    chmodSync(credentialFile, 0o600);
    let jwksUnavailable = false;
    const failing: typeof fetch = async (input, init) => {
      if (jwksUnavailable && String(input) === JWKS_URL)
        return new Response('secret-provider-body', { status: 503 });
      return normal.fetchImpl(input, init);
    };
    const recovery = new ChatGPTConnection(path, { fetch: failing });
    jwksUnavailable = true;
    await expect(recovery.accessToken()).rejects.toThrow('ChatGPT identity validation unavailable');
    const checkpoint = JSON.parse(readFileSync(credentialFile, 'utf8')) as {
      profiles: Array<{ tokens: { refreshToken: string; pendingIdentity: boolean } }>;
    };
    expect(checkpoint.profiles[0]?.tokens).toMatchObject({
      refreshToken: 'refresh-rotated-secret',
      pendingIdentity: true,
    });
    jwksUnavailable = false;
    await expect(recovery.accessToken()).resolves.toBe('access-rotated-secret');
    expect(normal.refreshCount()).toBe(1);
  });

  it('retains authorization-code tokens before first identity validation so a pending profile can recover', async () => {
    const path = home();
    const normal = fakeFetch({ loginIdToken: (nonce) => idToken({ nonce, expiresInSeconds: 2 }) });
    let jwksUnavailable = true;
    const failing: typeof fetch = async (input, init) => {
      if (jwksUnavailable && String(input) === JWKS_URL)
        return new Response('temporary JWKS outage', { status: 503 });
      return normal.fetchImpl(input, init);
    };
    const connection = new ChatGPTConnection(path, { fetch: failing });
    await expect(signIn(connection)).rejects.toThrow('ChatGPT identity validation unavailable');
    const [pending] = connection.profiles();
    expect(pending).toMatchObject({ connected: false, active: false });
    expect(pending?.profileId).toBeTruthy();
    jwksUnavailable = false;
    await connection.select(pending!.profileId);
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_100));
    await expect(connection.accessToken()).resolves.toBe('access-login-secret');
    expect(connection.session()).toMatchObject({ connected: true, email: 'account@example.test' });
  });

  it('clears local credentials when revocation cannot be confirmed and reports that fact safely', async () => {
    const path = home();
    const normal = fakeFetch();
    const failing: typeof fetch = async (input, init) => {
      if (String(input) === `${ISSUER}/api/accounts/oauth/revoke`)
        return new Response('do-not-surface-provider-body', { status: 503 });
      return normal.fetchImpl(input, init);
    };
    const connection = new ChatGPTConnection(path, { fetch: failing });
    const { session: firstSession } = await signIn(connection);
    await expect(connection.disconnect()).resolves.toEqual({ remoteRevoked: false });
    expect(connection.session()).toBeNull();
    expect(connection.profiles()[0]).toMatchObject({ connected: false, active: false });
    const resumed = await signIn(connection, { profileId: firstSession.profileId });
    expect(resumed.session.profileId).toBe(firstSession.profileId);
    expect(resumed.authorize.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(resumed.authorize.searchParams.has('agent_name_hint')).toBe(false);
  });

  it('rejects symlinked credential and lock files before following them', async () => {
    const path = home();
    const connection = new ChatGPTConnection(path, { fetch: fakeFetch().fetchImpl });
    connection.profiles();
    const secretFile = join(path, 'secrets', 'chatgpt');
    const outside = join(path, 'outside-secret');
    writeFileSync(outside, 'untouched');
    rmSync(secretFile);
    symlinkSync(outside, secretFile);
    expect(() => connection.session()).toThrow('ChatGPT credential file is unsafe');
    expect(readFileSync(outside, 'utf8')).toBe('untouched');

    rmSync(secretFile);
    writeFileSync(secretFile, '{}', { mode: 0o600 });
    const lock = join(path, 'secrets', 'chatgpt-lock.db');
    symlinkSync(outside, lock);
    await expect(connection.select('profile')).rejects.toThrow('ChatGPT credential lock is unsafe');
    expect(readFileSync(outside, 'utf8')).toBe('untouched');
  });
});
