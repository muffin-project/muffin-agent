import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { sleep } from '../net/sleep.js';
import { createPkcePair } from './openrouter-oauth.js';
import { ensurePrivateDir, tightenPrivateDb, tightenPrivateFile } from './private-fs.js';

/**
 * xAI / Grok account login (ADR-0113): OAuth 2.0 authorization code + PKCE on
 * a loopback redirect, or the RFC 8628 device grant, against `auth.x.ai`.
 *
 * Protocol facts, each checked on 2026-11-26 against the live discovery
 * document (`https://auth.x.ai/.well-known/openid-configuration`) and xAI's own
 * open-source client (`xai-org/grok-build`, crates `xai-grok-login`):
 *
 * - endpoints: `/oauth2/authorize`, `/oauth2/token`, `/oauth2/device/code`,
 *   `/oauth2/revoke`; grants `authorization_code`, `refresh_token`,
 *   `urn:ietf:params:oauth:grant-type:device_code`; PKCE `S256` only; public
 *   clients (`token_endpoint_auth_methods_supported` contains `none`).
 * - xAI publishes no client registration for third-party agents. Muffin uses
 *   the Grok CLI's public client id, the same one Grok Build, OpenCode and
 *   Hermes use — a borrowed identity xAI can restrict per account.
 * - Grok Build binds `127.0.0.1` on an OS-chosen port with path `/callback`
 *   in production, and accepts a pasted callback URL or bare code when the
 *   browser cannot reach the loopback.
 * - Refresh tokens rotate; the IdP detects reuse. Every refresh therefore runs
 *   under a cross-process lock and checkpoints the rotated token before the
 *   access token is used.
 *
 * Tokens are returned to the store and the provider only: never logged, never
 * in argv/env, never in an error string.
 */

export const XAI_OAUTH_ISSUER = 'https://auth.x.ai';
export const XAI_AUTHORIZE_URL = `${XAI_OAUTH_ISSUER}/oauth2/authorize`;
export const XAI_TOKEN_URL = `${XAI_OAUTH_ISSUER}/oauth2/token`;
export const XAI_DEVICE_URL = `${XAI_OAUTH_ISSUER}/oauth2/device/code`;
export const XAI_REVOKE_URL = `${XAI_OAUTH_ISSUER}/oauth2/revoke`;
/** Grok CLI's public OAuth client (xai-org/grok-build `xai-grok-login/src/config.rs`). */
export const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
/**
 * The smallest set the peers use for inference: `api:access` lets the token
 * authorize `api.x.ai`, `grok-cli:access` the CLI surface, `offline_access`
 * the refresh token. Grok Build also asks for conversations/workspaces; Muffin
 * does not need them.
 */
export const XAI_OAUTH_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
/** Attribution only (Grok Build sends `grok-build`, OpenCode `opencode`). */
export const XAI_OAUTH_REFERRER = 'muffin';
export const XAI_CALLBACK_PATH = '/callback';
export const XAI_DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** The secret name of the login session; `secret://xai_oauth` on a lane or link. */
export const XAI_OAUTH_SECRET = 'xai_oauth';
export const XAI_OAUTH_REF = `secret://${XAI_OAUTH_SECRET}`;

const REFRESH_SKEW_MS = 120_000;
/** xAI omits `expires_in` on some replies; peers assume one hour. */
const DEFAULT_LIFETIME_S = 3_600;
const NETWORK_TIMEOUT_MS = 15_000;
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const MAX_VALUE = 16_384;
const DEVICE_DEFAULT_INTERVAL_S = 5;
const DEVICE_SLOW_DOWN_S = 5;
const DEVICE_DEFAULT_EXPIRES_S = 900;
const SAFE_ERROR = 'xAI login failed';

export class XaiReauthenticationRequired extends Error {
  constructor(reason = 'xAI login expired or was revoked.') {
    super(`${reason} Run \`muffin auth login xai\` to reconnect.`);
    this.name = 'XaiReauthenticationRequired';
  }
}

export type XaiTokenResponse = {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
};

type FetchLike = typeof fetch;

function safeString(value: unknown, max = MAX_VALUE): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function request(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  const timeout = AbortSignal.timeout(NETWORK_TIMEOUT_MS);
  return fetchImpl(url, {
    ...init,
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
}

function form(fields: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(fields).toString(),
  };
}

async function jsonBody(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await response.json();
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseTokenResponse(body: Record<string, unknown> | null): XaiTokenResponse {
  if (!body || !safeString(body.access_token)) throw new Error(`${SAFE_ERROR}: no access token`);
  if (body.token_type !== undefined && String(body.token_type).toLowerCase() !== 'bearer') {
    throw new Error(`${SAFE_ERROR}: unexpected token type`);
  }
  const expiresIn = Number(body.expires_in);
  return {
    accessToken: body.access_token,
    ...(safeString(body.refresh_token) ? { refreshToken: body.refresh_token } : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresIn } : {}),
    ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
  };
}

/** `exp` of a JWT access token, unverified: used only to schedule a refresh. */
export function jwtExpiryMs(token: string): number | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof claims.exp === 'number' && Number.isFinite(claims.exp)
      ? claims.exp * 1000
      : undefined;
  } catch {
    return undefined;
  }
}

export function tokenExpiresAt(token: XaiTokenResponse, receivedAt: number): number {
  if (token.expiresIn !== undefined) return receivedAt + token.expiresIn * 1000;
  return jwtExpiryMs(token.accessToken) ?? receivedAt + DEFAULT_LIFETIME_S * 1000;
}

export function buildXaiAuthorizeUrl(input: {
  redirectUri: string;
  challenge: string;
  state: string;
  nonce: string;
}): string {
  const url = new URL(XAI_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', XAI_OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', XAI_OAUTH_SCOPE);
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', input.state);
  url.searchParams.set('nonce', input.nonce);
  url.searchParams.set('referrer', XAI_OAUTH_REFERRER);
  return url.toString();
}

/**
 * A pasted callback: the full redirect URL from the address bar (its `state`
 * must match) or the bare code. A bare code carries no state; PKCE still makes
 * a code minted for someone else's verifier useless here.
 */
export function parsePastedCallback(input: string, expectedState: string): string {
  const text = input.trim();
  if (text.length === 0 || text.length > MAX_VALUE || /\s/.test(text)) {
    throw new Error('xAI authorization code is invalid');
  }
  if (!/^https?:\/\//i.test(text) && !text.startsWith('/') && !text.includes('code=')) return text;
  let url: URL;
  try {
    url = new URL(text, 'http://127.0.0.1');
  } catch {
    throw new Error('xAI authorization code is invalid');
  }
  if (url.searchParams.get('error') !== null) {
    throw new Error('xAI authorization was not completed');
  }
  const code = url.searchParams.get('code') ?? '';
  const state = url.searchParams.get('state') ?? '';
  if (!safeString(code)) throw new Error('xAI authorization code is invalid');
  if (!constantTimeEqual(state, expectedState)) {
    throw new Error('xAI authorization state did not match. Retry the login.');
  }
  return code;
}

export type LocalXaiOAuthSession = {
  authorizeUrl: string;
  redirectUri: string;
  /** PKCE verifier for the exchange; never display or log it. */
  verifier: string;
  state: string;
  /** Resolves once, from the loopback callback or from `submitPasted`. */
  code: Promise<string>;
  /** Paste path: throws on a malformed or mismatched value, leaves the session open. */
  submitPasted: (input: string) => void;
  close: () => Promise<void>;
};

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    if (!server.listening) return resolveClose();
    server.close(() => resolveClose());
  });
}

/**
 * Loopback redirect on `127.0.0.1`, OS-chosen port, path `/callback` — the
 * shape Grok Build registers. The state is checked in constant time; an
 * unrelated localhost request cannot finish the flow.
 */
export async function beginLocalXaiOAuth(
  input: { timeoutMs?: number } = {},
): Promise<LocalXaiOAuthSession> {
  const pkce = createPkcePair();
  const state = randomToken();
  const nonce = randomToken();
  let settled = false;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolvePromise, rejectPromise) => {
    resolveCode = resolvePromise;
    rejectCode = rejectPromise;
  });
  void code.catch(() => undefined);

  const finish = (outcome: { code: string } | { error: Error }): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if ('code' in outcome) resolveCode(outcome.code);
    else rejectCode(outcome.error);
    void closeServer(server);
  };

  const server = createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      res.writeHead(400).end('Invalid login callback.');
      return;
    }
    if (req.method !== 'GET' || url.pathname !== XAI_CALLBACK_PATH) {
      res.writeHead(404).end('Not this login callback.');
      return;
    }
    if (settled) {
      res.writeHead(410).end('This login callback is closed.');
      return;
    }
    if (!constantTimeEqual(url.searchParams.get('state') ?? '', state)) {
      res.writeHead(400).end('Login state did not match. Retry the login.');
      return;
    }
    if (url.searchParams.get('error') !== null) {
      res
        .writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('xAI authorization was not completed. You can close this tab.');
      // The provider's error text is browser input: keep it out of errors and logs.
      finish({ error: new Error('xAI authorization was not completed') });
      return;
    }
    const value = url.searchParams.get('code') ?? '';
    if (!safeString(value)) {
      res.writeHead(400).end('Missing or invalid authorization code.');
      return;
    }
    res
      .writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      .end('Muffin is connected to xAI. You can close this tab.');
    finish({ code: value });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Could not allocate a local login callback port');
  }
  const redirectUri = `http://127.0.0.1:${address.port}${XAI_CALLBACK_PATH}`;
  const timer = setTimeout(
    () => finish({ error: new Error('xAI login timed out') }),
    input.timeoutMs ?? SIGN_IN_TIMEOUT_MS,
  );
  timer.unref?.();

  return {
    authorizeUrl: buildXaiAuthorizeUrl({
      redirectUri,
      challenge: pkce.challenge,
      state,
      nonce,
    }),
    redirectUri,
    verifier: pkce.verifier,
    state,
    code,
    submitPasted: (pasted: string) => {
      if (settled) return;
      finish({ code: parsePastedCallback(pasted, state) });
    },
    close: async () => {
      finish({ error: new Error('xAI login cancelled') });
      await closeServer(server);
    },
  };
}

export async function exchangeXaiAuthorizationCode(input: {
  code: string;
  verifier: string;
  redirectUri: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<XaiTokenResponse> {
  let response: Response;
  try {
    response = await request(
      input.fetchImpl ?? fetch,
      XAI_TOKEN_URL,
      form({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: XAI_OAUTH_CLIENT_ID,
        code_verifier: input.verifier,
      }),
      input.signal,
    );
  } catch {
    throw new Error(`${SAFE_ERROR}: token endpoint unreachable`);
  }
  // Status only: an OAuth error body can echo request data on a credential path.
  if (!response.ok) throw new Error(`${SAFE_ERROR}: code exchange refused (${response.status})`);
  return parseTokenResponse(await jsonBody(response));
}

export type XaiDeviceAuthorization = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
};

/** Only an https page on an x.ai host may be shown as the place to type the code. */
function trustedVerificationUri(value: unknown): value is string {
  if (!safeString(value, 2_048)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (url.hostname === 'x.ai' || url.hostname.endsWith('.x.ai'))
    );
  } catch {
    return false;
  }
}

export async function requestXaiDeviceAuthorization(
  input: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<XaiDeviceAuthorization> {
  let response: Response;
  try {
    response = await request(
      input.fetchImpl ?? fetch,
      XAI_DEVICE_URL,
      form({
        client_id: XAI_OAUTH_CLIENT_ID,
        scope: XAI_OAUTH_SCOPE,
        referrer: XAI_OAUTH_REFERRER,
      }),
      input.signal,
    );
  } catch {
    throw new Error(`${SAFE_ERROR}: device endpoint unreachable`);
  }
  if (!response.ok) throw new Error(`${SAFE_ERROR}: device code refused (${response.status})`);
  const body = await jsonBody(response);
  if (
    !body ||
    !safeString(body.device_code) ||
    !safeString(body.user_code, 64) ||
    !trustedVerificationUri(body.verification_uri)
  ) {
    throw new Error(`${SAFE_ERROR}: invalid device code response`);
  }
  const expiresIn = Number(body.expires_in);
  const interval = Number(body.interval);
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    ...(trustedVerificationUri(body.verification_uri_complete)
      ? { verificationUriComplete: body.verification_uri_complete }
      : {}),
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : DEVICE_DEFAULT_EXPIRES_S,
    interval: Number.isFinite(interval) && interval >= 1 ? interval : DEVICE_DEFAULT_INTERVAL_S,
  };
}

/** RFC 8628 §3.4–3.5: sleep first, `authorization_pending` keeps going, `slow_down` adds 5 s. */
export async function pollXaiDeviceToken(
  device: XaiDeviceAuthorization,
  input: {
    fetchImpl?: FetchLike;
    signal?: AbortSignal;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<XaiTokenResponse> {
  const wait = input.sleep ?? ((ms: number) => sleep(ms, input.signal));
  const now = input.now ?? Date.now;
  const deadline = now() + device.expiresIn * 1000;
  let intervalS = device.interval;
  for (;;) {
    await wait(intervalS * 1000).catch(() => undefined);
    if (input.signal?.aborted) throw new Error('xAI login cancelled');
    if (now() >= deadline) throw new Error('xAI device code expired. Run the login again.');
    let response: Response;
    try {
      response = await request(
        input.fetchImpl ?? fetch,
        XAI_TOKEN_URL,
        form({
          grant_type: XAI_DEVICE_GRANT,
          device_code: device.deviceCode,
          client_id: XAI_OAUTH_CLIENT_ID,
        }),
        input.signal,
      );
    } catch {
      // A dropped poll is not a refusal: the next interval asks again.
      continue;
    }
    if (response.ok) return parseTokenResponse(await jsonBody(response));
    const error = (await jsonBody(response))?.error;
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      intervalS += DEVICE_SLOW_DOWN_S;
      continue;
    }
    if (error === 'access_denied') throw new Error('xAI authorization was denied');
    if (error === 'expired_token') throw new Error('xAI device code expired. Run the login again.');
    throw new Error(`${SAFE_ERROR}: device token refused (${response.status})`);
  }
}

export type XaiLoginMethod = 'oauth-pkce' | 'oauth-device';
type RefreshOutcome = 'ok' | 'reauth' | 'failed';

type Store = {
  version: 1;
  method: XaiLoginMethod;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  receivedAt: number;
  scope?: string;
  email?: string;
  lastRefresh?: { at: number; outcome: RefreshOutcome };
};

function isStore(value: unknown): value is Store {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<Store>;
  return (
    v.version === 1 &&
    (v.method === 'oauth-pkce' || v.method === 'oauth-device') &&
    safeString(v.accessToken) &&
    safeString(v.refreshToken) &&
    typeof v.expiresAt === 'number' &&
    typeof v.receivedAt === 'number'
  );
}

/** Everything about the login except the tokens. */
export type XaiOAuthStatus = {
  connected: boolean;
  method?: XaiLoginMethod;
  email?: string;
  expiresAt?: number;
  /** The saved access token is valid beyond the refresh margin. */
  usable: boolean;
  /** A refresh can be attempted. */
  renewable: boolean;
  accessExpired: boolean;
  /** xAI refused the refresh token: only a new login fixes it. */
  needsLogin: boolean;
  refreshOutcome?: RefreshOutcome;
};

export type XaiOAuthConnectionOptions = { fetch?: FetchLike; now?: () => number };

/**
 * The one owner of `<home>/secrets/xai_oauth`. CLI and gateway both construct
 * it; the SQLite lock beside the file serializes refreshes across processes.
 */
export class XaiOAuthConnection {
  private readonly file: string;
  private readonly lockFile: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private inflight: Promise<string> | undefined;

  constructor(home: string, options: XaiOAuthConnectionOptions = {}) {
    const secrets = join(resolve(home), 'secrets');
    this.file = join(secrets, XAI_OAUTH_SECRET);
    this.lockFile = join(secrets, `${XAI_OAUTH_SECRET}-lock.db`);
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  status(): XaiOAuthStatus {
    const store = this.readStore();
    if (store === null) {
      return {
        connected: false,
        usable: false,
        renewable: false,
        accessExpired: true,
        needsLogin: false,
      };
    }
    const accessExpired = store.expiresAt <= this.now() + REFRESH_SKEW_MS;
    const needsLogin = store.lastRefresh?.outcome === 'reauth';
    return {
      connected: true,
      method: store.method,
      ...(store.email ? { email: store.email } : {}),
      expiresAt: store.expiresAt,
      usable: !accessExpired && !needsLogin,
      renewable: !needsLogin,
      accessExpired,
      needsLogin,
      ...(store.lastRefresh ? { refreshOutcome: store.lastRefresh.outcome } : {}),
    };
  }

  /** The saved access token while it is fresh, without network or lock (model catalog reads). */
  cachedAccessToken(): string | undefined {
    const store = this.readStore();
    if (store === null || store.lastRefresh?.outcome === 'reauth') return undefined;
    return store.expiresAt > this.now() + REFRESH_SKEW_MS ? store.accessToken : undefined;
  }

  /** Persists a fresh login, replacing any previous one. */
  async save(token: XaiTokenResponse, method: XaiLoginMethod, email?: string): Promise<void> {
    if (!token.refreshToken) {
      // Without offline_access the session dies within the hour and Muffin
      // would fail silently in the middle of the night: refuse it now.
      throw new Error(`${SAFE_ERROR}: xAI returned no refresh token`);
    }
    const refreshToken = token.refreshToken;
    await this.withLock(async () => {
      const receivedAt = this.now();
      this.writeStore({
        version: 1,
        method,
        accessToken: token.accessToken,
        refreshToken,
        expiresAt: tokenExpiresAt(token, receivedAt),
        receivedAt,
        ...(token.scope ? { scope: token.scope } : {}),
        ...(email ? { email } : {}),
      });
    });
  }

  /**
   * A valid access token, refreshed when it expires within two minutes.
   * Concurrent callers in this process share one refresh; other processes wait
   * on the lock and then reuse what the winner wrote.
   */
  async accessToken(_signal?: AbortSignal): Promise<string> {
    const store = this.readStore();
    if (store === null) throw new XaiReauthenticationRequired('xAI is not connected.');
    if (store.lastRefresh?.outcome === 'reauth') throw new XaiReauthenticationRequired();
    if (store.expiresAt > this.now() + REFRESH_SKEW_MS) return store.accessToken;
    if (this.inflight === undefined) {
      // Not tied to one caller's abort signal: the refresh is shared, and an
      // aborted turn must not leave the others without a token.
      this.inflight = this.refresh().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  /** Removes the local session, then asks xAI to revoke the refresh token. */
  async disconnect(): Promise<{ removed: boolean; remoteRevoked: boolean }> {
    const store = await this.withLock(async () => {
      const current = this.readStore();
      try {
        unlinkSync(this.file);
      } catch {
        /* already gone */
      }
      return current;
    });
    if (store === null) return { removed: false, remoteRevoked: false };
    try {
      const response = await request(
        this.fetchImpl,
        XAI_REVOKE_URL,
        form({
          token: store.refreshToken,
          token_type_hint: 'refresh_token',
          client_id: XAI_OAUTH_CLIENT_ID,
        }),
      );
      return { removed: true, remoteRevoked: response.ok };
    } catch {
      return { removed: true, remoteRevoked: false };
    }
  }

  private async refresh(): Promise<string> {
    return this.withLock(async () => {
      // Another process may have refreshed while we waited for the lock.
      const store = this.readStore();
      if (store === null) throw new XaiReauthenticationRequired('xAI is not connected.');
      if (store.lastRefresh?.outcome === 'reauth') throw new XaiReauthenticationRequired();
      if (store.expiresAt > this.now() + REFRESH_SKEW_MS) return store.accessToken;
      let response: Response;
      try {
        response = await request(
          this.fetchImpl,
          XAI_TOKEN_URL,
          form({
            grant_type: 'refresh_token',
            refresh_token: store.refreshToken,
            client_id: XAI_OAUTH_CLIENT_ID,
          }),
        );
      } catch {
        this.writeStore({ ...store, lastRefresh: { at: this.now(), outcome: 'failed' } });
        throw new Error('xAI token refresh unavailable');
      }
      if (!response.ok) {
        const error = (await jsonBody(response))?.error;
        // RFC 6749 §5.2: a spent, revoked or rotated-away refresh token. Retrying
        // the same token would trip xAI's reuse detection, so latch it.
        if (error === 'invalid_grant' || response.status === 401) {
          this.writeStore({ ...store, lastRefresh: { at: this.now(), outcome: 'reauth' } });
          throw new XaiReauthenticationRequired();
        }
        this.writeStore({ ...store, lastRefresh: { at: this.now(), outcome: 'failed' } });
        throw new Error(`xAI token refresh refused (${response.status})`);
      }
      const token = parseTokenResponse(await jsonBody(response));
      const receivedAt = this.now();
      // Checkpoint the rotated refresh token before anyone uses the access token.
      this.writeStore({
        ...store,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken ?? store.refreshToken,
        expiresAt: tokenExpiresAt(token, receivedAt),
        receivedAt,
        ...(token.scope ? { scope: token.scope } : {}),
        lastRefresh: { at: receivedAt, outcome: 'ok' },
      });
      return token.accessToken;
    });
  }

  private readStore(): Store | null {
    const stat = lstatSync(this.file, { throwIfNoEntry: false });
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('xAI login store is unsafe');
    tightenPrivateFile(this.file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      throw new Error('xAI login store is invalid');
    }
    if (!isStore(parsed)) throw new Error('xAI login store is invalid');
    return parsed;
  }

  private writeStore(store: Store): void {
    this.ensureStorage();
    const temp = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
    const fd = openSync(temp, 'wx', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(store)}\n`, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temp, this.file);
      const dirFd = openSync(dirname(this.file), 'r');
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
      tightenPrivateFile(this.file);
    } finally {
      try {
        unlinkSync(temp);
      } catch {
        /* already renamed */
      }
    }
  }

  private ensureStorage(): void {
    if (!ensurePrivateDir(dirname(this.file))) throw new Error('xAI login directory is unsafe');
    const lock = lstatSync(this.lockFile, { throwIfNoEntry: false });
    if (lock && (!lock.isFile() || lock.isSymbolicLink())) {
      throw new Error('xAI login lock is unsafe');
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    this.ensureStorage();
    const db = new Database(this.lockFile, { timeout: 0 });
    try {
      db.pragma('busy_timeout = 0');
      tightenPrivateDb(this.lockFile);
      const deadline = Date.now() + 30_000;
      for (;;) {
        try {
          db.exec('BEGIN IMMEDIATE');
          break;
        } catch (error) {
          if (!(error instanceof Error) || !/locked|busy/i.test(error.message)) throw error;
          if (Date.now() >= deadline) throw new Error('xAI login lock unavailable');
          await new Promise((resolveWait) =>
            setTimeout(resolveWait, 20 + Math.floor(Math.random() * 30)),
          );
        }
      }
      try {
        const result = await fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* no active transaction */
        }
        throw error;
      }
    } finally {
      db.close();
    }
  }
}

/** Best-effort account label for `muffin auth status`; never required for inference. */
export async function fetchXaiEmail(
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<string | undefined> {
  try {
    const response = await request(fetchImpl, `${XAI_OAUTH_ISSUER}/oauth2/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!response.ok) return undefined;
    const email = (await jsonBody(response))?.email;
    return safeString(email, 320) && /^[^\s@]+@[^\s@]+$/.test(email) ? email : undefined;
  } catch {
    return undefined;
  }
}
