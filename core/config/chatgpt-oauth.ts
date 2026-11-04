import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  existsSync,
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
import { createLocalJWKSet, type JSONWebKeySet, type JWTPayload, jwtVerify } from 'jose';
import { ensurePrivateDir, tightenPrivateDb, tightenPrivateFile } from './private-fs.js';
import { THINKING_EFFORTS, type ThinkingEffort } from './thinking.js';

export const CHATGPT_SECRET_REF = 'secret://chatgpt';
const AUTH_ORIGIN = 'https://auth.openai.com';
const API_ORIGIN = 'https://api.openai.com';
const AUTHORIZE_URL = `${AUTH_ORIGIN}/api/accounts/authorize`;
const TOKEN_URL = `${AUTH_ORIGIN}/api/accounts/oauth/token`;
const DISCOVERY_URL = `${AUTH_ORIGIN}/.well-known/openid-configuration`;
const MODEL_URL = `${API_ORIGIN}/v1/models`;
const RESOURCE = `${API_ORIGIN}/v1`;
const REQUIRED_SCOPES = ['chatgpt.tokens.use.direct', 'offline_access', 'resource.invoke'] as const;
const REQUESTED_SCOPES =
  'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const INITIAL_CLIENT_ID = 'dynamic_agent_client';

export type ChatGPTModel = {
  slug: string;
  displayName: string;
  supportedReasoningLevels?: readonly (ThinkingEffort | 'none')[];
  defaultReasoningLevel?: ThinkingEffort | 'none';
};

function isChatGPTReasoningLevel(value: unknown): value is ThinkingEffort | 'none' {
  return (
    value === 'none' ||
    (typeof value === 'string' && (THINKING_EFFORTS as readonly string[]).includes(value))
  );
}

function parseChatGPTReasoningLevel(value: unknown): ThinkingEffort | 'none' | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const effort = (value as { effort?: unknown }).effort;
  return isChatGPTReasoningLevel(effort) ? effort : undefined;
}
const CALLBACK_PATH = '/auth/callback';
const MAX_CALLBACK_VALUE = 8_192;
const ACCESS_REFRESH_SKEW_MS = 60_000;
const SAFE_ERROR = 'ChatGPT connection failed';
const NETWORK_TIMEOUT_MS = 10_000;
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

type TokenSet = {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  tokenType: string;
  scopes: string[];
  receivedAt: number;
  idTokenReceivedAt: number;
  expiresAt: number;
  pendingIdentity: boolean;
};

type Profile = {
  id: string;
  clientId: string;
  subject: string;
  pendingNonce?: string;
  pendingSignIn?: { nonce: string; tokens: TokenSet };
  email?: string;
  tokens: TokenSet | null;
};

type Store = {
  version: 1;
  hostId: string;
  activeProfileId: string | null;
  profiles: Profile[];
};

export type ChatGPTSession = {
  profileId: string;
  email?: string;
  connected: boolean;
  scopes: string[];
  expiresAt?: number;
};

export type ChatGPTProfile = ChatGPTSession & { active: boolean };

export type ChatGPTConnectionOptions = { fetch?: typeof fetch };

export type SignInOptions = {
  openBrowser: (url: string) => Promise<void>;
  signal?: AbortSignal;
  profileId?: string;
  newProfile?: boolean;
};

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('ChatGPT sign-in cancelled');
}

function safeString(value: unknown, max = 16_384): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function parseScopes(value: unknown): string[] {
  if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    return [...new Set(value)];
  if (typeof value === 'string') return [...new Set(value.split(/\s+/).filter(Boolean))];
  return [];
}

function hasRequiredScopes(scopes: string[]): boolean {
  return REQUIRED_SCOPES.every((scope) => scopes.includes(scope));
}

function randomId(): string {
  return randomBytes(18).toString('base64url');
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    if (!server.listening) return resolveClose();
    server.close(() => resolveClose());
  });
}

type Callback = { code: string; clientId?: string };

async function listenForCallback(input: { state: string; signal?: AbortSignal }): Promise<{
  callbackUrl: string;
  callback: Promise<Callback>;
  close: () => Promise<void>;
}> {
  let settled = false;
  let resolveCallback!: (value: Callback) => void;
  let rejectCallback!: (reason: Error) => void;
  const callback = new Promise<Callback>((resolvePromise, rejectPromise) => {
    resolveCallback = resolvePromise;
    rejectCallback = rejectPromise;
  });
  // Browser launch can outlive cancellation; keep the callback rejection handled.
  void callback.catch(() => undefined);
  let timeout: NodeJS.Timeout | undefined;

  const server = createServer((request, response) => {
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1');
    } catch {
      response.writeHead(400).end('Invalid sign-in callback.');
      return;
    }
    if (request.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
      response.writeHead(404).end('Not this sign-in callback.');
      return;
    }
    if (settled) {
      response.writeHead(410).end('This sign-in callback is closed.');
      return;
    }
    const returnedState = url.searchParams.get('state') ?? '';
    if (!constantTimeEqual(returnedState, input.state)) {
      response.writeHead(400).end('Sign-in state did not match. Retry sign-in.');
      return;
    }
    const providerError = url.searchParams.get('error');
    if (providerError !== null) {
      settled = true;
      if (timeout) clearTimeout(timeout);
      response
        .writeHead(400)
        .end('ChatGPT authorization was not completed. You can close this tab.');
      rejectCallback(new Error('ChatGPT authorization was not completed'));
      void closeServer(server);
      return;
    }
    const code = url.searchParams.get('code') ?? '';
    const clientId = url.searchParams.get('client_id') ?? undefined;
    if (
      !safeString(code, MAX_CALLBACK_VALUE) ||
      (clientId !== undefined && !safeString(clientId, 256))
    ) {
      response.writeHead(400).end('Missing or invalid sign-in result.');
      return;
    }
    settled = true;
    if (timeout) clearTimeout(timeout);
    response
      .writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      .end('Muffin is connected to ChatGPT. You can close this tab.');
    resolveCallback({ code, ...(clientId === undefined ? {} : { clientId }) });
    void closeServer(server);
  });

  const onAbort = () => {
    if (settled) return;
    settled = true;
    rejectCallback(new Error('ChatGPT sign-in cancelled'));
    void closeServer(server);
  };
  input.signal?.addEventListener('abort', onAbort, { once: true });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  }).catch((error: unknown) => {
    input.signal?.removeEventListener('abort', onAbort);
    throw error;
  });
  if (input.signal?.aborted) {
    input.signal.removeEventListener('abort', onAbort);
    await closeServer(server);
    throw new Error('ChatGPT sign-in cancelled');
  }
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer(server);
    throw new Error(SAFE_ERROR);
  }
  timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectCallback(new Error('ChatGPT sign-in timed out'));
    void closeServer(server);
  }, SIGN_IN_TIMEOUT_MS);
  timeout.unref?.();
  return {
    callbackUrl: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
    callback,
    close: async () => {
      input.signal?.removeEventListener('abort', onAbort);
      if (timeout) clearTimeout(timeout);
      if (!settled) {
        settled = true;
        rejectCallback(new Error('ChatGPT sign-in cancelled'));
      }
      await closeServer(server);
    },
  };
}

function emptyStore(): Store {
  return { version: 1, hostId: `urn:uuid:${randomUUID()}`, activeProfileId: null, profiles: [] };
}

function isStore(value: unknown): value is Store {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Store>;
  return (
    candidate.version === 1 &&
    typeof candidate.hostId === 'string' &&
    (candidate.activeProfileId === null || typeof candidate.activeProfileId === 'string') &&
    Array.isArray(candidate.profiles)
  );
}

function safeSession(profile: Profile, active = false): ChatGPTProfile {
  const scopes = profile.tokens?.scopes ?? [];
  return {
    profileId: profile.id,
    ...(profile.email ? { email: profile.email } : {}),
    connected:
      profile.tokens !== null &&
      !profile.tokens.pendingIdentity &&
      profile.subject.length > 0 &&
      profile.tokens.tokenType === 'Bearer' &&
      hasRequiredScopes(scopes),
    scopes: [...scopes],
    ...(profile.tokens ? { expiresAt: profile.tokens.expiresAt } : {}),
    active,
  };
}

export class ChatGPTConnection {
  private readonly file: string;
  private readonly lockFile: string;
  private readonly fetchImpl: typeof fetch;
  private readonly localLocks = new Map<string, Promise<void>>();

  constructor(home: string, options: ChatGPTConnectionOptions = {}) {
    this.file = join(resolve(home), 'secrets', 'chatgpt');
    this.lockFile = join(resolve(home), 'secrets', 'chatgpt-lock.db');
    this.fetchImpl = options.fetch ?? fetch;
  }

  session(): ChatGPTSession | null {
    const store = this.readStore();
    const profile = store.profiles.find((item) => item.id === store.activeProfileId);
    return profile ? safeSession(profile, true) : null;
  }

  profiles(): ChatGPTProfile[] {
    const store = this.readStore();
    return store.profiles.map((profile) =>
      safeSession(profile, profile.id === store.activeProfileId),
    );
  }

  async select(profileId: string): Promise<ChatGPTSession> {
    return this.withRefreshLock(async () => {
      const store = this.readStore();
      const profile = store.profiles.find((item) => item.id === profileId);
      if (!profile) throw new Error('ChatGPT profile is unavailable');
      store.activeProfileId = profile.id;
      this.writeStore(store);
      return safeSession(profile);
    });
  }

  async signIn(options: SignInOptions): Promise<ChatGPTSession> {
    abortIfNeeded(options.signal);
    if (options.newProfile && options.profileId)
      throw new Error('Choose either a saved ChatGPT profile or a new profile');
    const store = this.readStore();
    const activeAtStart = store.activeProfileId;
    const requested = options.profileId
      ? store.profiles.find((profile) => profile.id === options.profileId)
      : undefined;
    if (options.profileId && !requested) throw new Error('ChatGPT profile is unavailable');
    const existing = !options.newProfile
      ? (requested ?? store.profiles.find((p) => p.id === store.activeProfileId))
      : undefined;
    const profileId = existing?.id ?? randomId();
    const state = randomId();
    const nonce = randomId();
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    const pending = await listenForCallback({
      state,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const authorize = new URL(AUTHORIZE_URL);
    authorize.searchParams.set('client_id', existing?.clientId ?? INITIAL_CLIENT_ID);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('redirect_uri', pending.callbackUrl);
    authorize.searchParams.set('scope', REQUESTED_SCOPES);
    authorize.searchParams.set('resource', RESOURCE);
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('nonce', nonce);
    authorize.searchParams.set('code_challenge_method', 'S256');
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('ext_agent_host_id', store.hostId);
    if (existing) {
      if (existing.tokens?.idToken)
        authorize.searchParams.set('id_token_hint', existing.tokens.idToken);
      if (existing.email) authorize.searchParams.set('login_hint', existing.email);
    } else {
      authorize.searchParams.set('agent_name_hint', 'Muffin');
    }

    try {
      await options.openBrowser(authorize.toString());
      const result = await pending.callback;
      abortIfNeeded(options.signal);
      const issuedClientId = existing?.clientId ?? result.clientId;
      if (
        !safeString(issuedClientId, 256) ||
        issuedClientId === INITIAL_CLIENT_ID ||
        (existing && result.clientId !== undefined && result.clientId !== existing.clientId)
      ) {
        throw new Error(SAFE_ERROR);
      }
      if (!existing) {
        await this.withRefreshLock(async () => {
          const latest = this.readStore();
          if (latest.profiles.some((item) => item.id === profileId))
            throw new Error('ChatGPT profile changed during sign-in');
          latest.profiles.push({
            id: profileId,
            clientId: issuedClientId,
            subject: '',
            tokens: null,
          });
          this.writeStore(latest); // retain the issued registration before one-use code exchange
        }, options.signal);
      }
      const token = await this.exchange(
        {
          grant_type: 'authorization_code',
          client_id: issuedClientId,
          code: result.code,
          code_verifier: verifier,
          redirect_uri: pending.callbackUrl,
          resource: RESOURCE,
        },
        options.signal,
      );
      const scopes = parseScopes(token.scope);
      const receivedAt = Date.now();
      const expiresAt =
        typeof token.expires_in === 'number' ? receivedAt + token.expires_in * 1000 : 0;
      if (
        !hasRequiredScopes(scopes) ||
        !safeString(token.access_token) ||
        !safeString(token.refresh_token) ||
        !safeString(token.id_token) ||
        token.token_type !== 'Bearer' ||
        typeof token.expires_in !== 'number' ||
        !Number.isFinite(token.expires_in) ||
        token.expires_in <= 0 ||
        !Number.isFinite(expiresAt)
      ) {
        throw new Error(SAFE_ERROR);
      }
      const profile: Profile = {
        id: profileId,
        clientId: issuedClientId,
        subject: existing?.subject ?? '',
        ...(existing?.email ? { email: existing.email } : {}),
        pendingNonce: nonce,
        tokens: {
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          idToken: token.id_token,
          tokenType: 'Bearer',
          scopes,
          receivedAt,
          idTokenReceivedAt: receivedAt,
          expiresAt,
          pendingIdentity: true,
        },
      };
      await this.withRefreshLock(async () => {
        const latest = this.readStore();
        const current = latest.profiles.find((item) => item.id === profileId);
        if (
          existing &&
          (!current ||
            current.clientId !== existing.clientId ||
            current.subject !== existing.subject ||
            current.tokens?.refreshToken !== existing.tokens?.refreshToken ||
            current.tokens?.idToken !== existing.tokens?.idToken)
        ) {
          throw new Error('ChatGPT profile changed during sign-in');
        }
        if (
          !existing &&
          (!current || current.clientId !== issuedClientId || current.subject !== '')
        ) {
          throw new Error('ChatGPT profile changed during sign-in');
        }
        if (existing) {
          if (!current) throw new Error('ChatGPT profile changed during sign-in');
          current.pendingSignIn = { nonce, tokens: profile.tokens! };
        } else {
          const index = latest.profiles.findIndex((item) => item.id === profileId);
          if (index >= 0) latest.profiles[index] = profile;
          else latest.profiles.push(profile);
        }
        this.writeStore(latest);
      }, options.signal);
      const validated = await this.validateIdentity(
        token.id_token,
        issuedClientId,
        nonce,
        options.signal,
        receivedAt,
      );
      if (existing && existing.subject !== validated.sub)
        throw new Error('ChatGPT account identity changed');
      await this.withRefreshLock(async () => {
        const latest = this.readStore();
        const current = latest.profiles.find((item) => item.id === profileId);
        const candidate = existing ? current?.pendingSignIn?.tokens : current?.tokens;
        const candidateNonce = existing ? current?.pendingSignIn?.nonce : current?.pendingNonce;
        if (
          !current ||
          !candidate ||
          current.clientId !== issuedClientId ||
          candidate.refreshToken !== token.refresh_token ||
          candidate.idToken !== token.id_token ||
          candidateNonce !== nonce
        ) {
          throw new Error('ChatGPT profile changed during sign-in');
        }
        current.subject = validated.sub;
        if (typeof validated.email === 'string') current.email = validated.email;
        delete current.pendingNonce;
        current.tokens = candidate;
        current.tokens.pendingIdentity = false;
        delete current.pendingSignIn;
        if (latest.activeProfileId === activeAtStart) latest.activeProfileId = current.id;
        this.writeStore(latest);
      }, options.signal);
      profile.subject = validated.sub;
      if (typeof validated.email === 'string') profile.email = validated.email;
      delete profile.pendingNonce;
      if (!profile.tokens) throw new Error('ChatGPT profile changed during sign-in');
      profile.tokens.pendingIdentity = false;
      return safeSession(profile);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === SAFE_ERROR || error.message.startsWith('ChatGPT '))
      )
        throw error;
      throw new Error(SAFE_ERROR);
    } finally {
      await pending.close();
    }
  }

  async accessToken(signal?: AbortSignal): Promise<string> {
    return this.withRefreshLock(async () => {
      abortIfNeeded(signal);
      const store = this.readStore();
      const profile = store.profiles.find((item) => item.id === store.activeProfileId);
      if (!profile) throw new Error('ChatGPT plan access is not authorized');
      if (profile.pendingSignIn) {
        const candidate = profile.pendingSignIn;
        const identity = await this.validateIdentity(
          candidate.tokens.idToken,
          profile.clientId,
          candidate.nonce,
          signal,
          candidate.tokens.idTokenReceivedAt,
        );
        if (profile.subject && identity.sub !== profile.subject) {
          delete profile.pendingSignIn;
          this.writeStore(store);
          throw new Error('ChatGPT account identity changed');
        }
        profile.subject = identity.sub;
        if (typeof identity.email === 'string') profile.email = identity.email;
        candidate.tokens.pendingIdentity = false;
        profile.tokens = candidate.tokens;
        delete profile.pendingSignIn;
        this.writeStore(store);
      }
      if (
        !profile.tokens ||
        profile.tokens.tokenType !== 'Bearer' ||
        !hasRequiredScopes(profile.tokens.scopes)
      ) {
        throw new Error('ChatGPT plan access is not authorized');
      }
      if (
        profile.tokens.pendingIdentity &&
        profile.tokens.expiresAt > Date.now() + ACCESS_REFRESH_SKEW_MS
      ) {
        const identity = await this.validateIdentity(
          profile.tokens.idToken,
          profile.clientId,
          profile.pendingNonce,
          signal,
          profile.tokens.idTokenReceivedAt,
        );
        if (profile.subject && identity.sub !== profile.subject)
          throw new Error('ChatGPT account identity changed');
        if (!profile.subject) profile.subject = identity.sub;
        if (typeof identity.email === 'string') profile.email = identity.email;
        profile.tokens.pendingIdentity = false;
        delete profile.pendingNonce;
        this.writeStore(store);
      }
      if (
        Number.isFinite(profile.tokens.expiresAt) &&
        profile.tokens.expiresAt > Date.now() + ACCESS_REFRESH_SKEW_MS
      ) {
        return profile.tokens.accessToken;
      }
      const token = await this.exchange(
        {
          grant_type: 'refresh_token',
          client_id: profile.clientId,
          refresh_token: profile.tokens.refreshToken,
          resource: RESOURCE,
        },
        signal,
      );
      const receivedAt = Date.now();
      const rotated = {
        receivedAt,
        idTokenReceivedAt: safeString(token.id_token)
          ? receivedAt
          : profile.tokens.idTokenReceivedAt,
        accessToken: safeString(token.access_token) ? token.access_token : '',
        refreshToken: safeString(token.refresh_token)
          ? token.refresh_token
          : profile.tokens.refreshToken,
        idToken: safeString(token.id_token) ? token.id_token : profile.tokens.idToken,
        tokenType:
          typeof token.token_type === 'string' ? token.token_type : profile.tokens.tokenType,
        scopes: parseScopes(token.scope).length ? parseScopes(token.scope) : profile.tokens.scopes,
        expiresAt:
          typeof token.expires_in === 'number' && Number.isFinite(token.expires_in)
            ? Date.now() + token.expires_in * 1000
            : 0,
        pendingIdentity: safeString(token.id_token) || profile.tokens.pendingIdentity,
      } satisfies TokenSet;
      // A refresh token may be single-use: checkpoint every rotated field before
      // any identity/JWKS validation that can fail, and never retry the old token.
      profile.tokens = rotated;
      if (safeString(token.id_token)) delete profile.pendingNonce;
      this.writeStore(store);
      if (
        !rotated.accessToken ||
        !rotated.refreshToken ||
        rotated.tokenType !== 'Bearer' ||
        !hasRequiredScopes(rotated.scopes) ||
        !Number.isFinite(rotated.expiresAt) ||
        rotated.expiresAt <= Date.now()
      ) {
        throw new Error('ChatGPT plan access is not authorized');
      }
      if (rotated.pendingIdentity) {
        const identity = await this.validateIdentity(
          rotated.idToken,
          profile.clientId,
          profile.pendingNonce,
          signal,
          rotated.idTokenReceivedAt,
        );
        if (profile.subject && identity.sub !== profile.subject)
          throw new Error('ChatGPT account identity changed');
        if (!profile.subject) profile.subject = identity.sub;
        if (typeof identity.email === 'string') profile.email = identity.email;
        profile.tokens.pendingIdentity = false;
        delete profile.pendingNonce;
        this.writeStore(store);
      }
      return rotated.accessToken;
    }, signal);
  }

  async listModels(signal?: AbortSignal): Promise<ChatGPTModel[]> {
    const token = await this.accessToken(signal);
    let response: Response;
    try {
      response = await this.request(
        MODEL_URL,
        { headers: { Authorization: `Bearer ${token}` } },
        signal,
      );
    } catch {
      throw new Error(SAFE_ERROR);
    }
    if (!response.ok) throw new Error(SAFE_ERROR);
    let body: { models?: unknown };
    try {
      body = (await response.json()) as { models?: unknown };
    } catch {
      throw new Error(SAFE_ERROR);
    }
    if (!Array.isArray(body.models)) throw new Error(SAFE_ERROR);
    return body.models.flatMap((item: unknown) => {
      if (!item || typeof item !== 'object') return [];
      const model = item as {
        visibility?: unknown;
        slug?: unknown;
        display_name?: unknown;
        supported_reasoning_levels?: unknown;
        default_reasoning_level?: unknown;
      };
      if (
        model.visibility !== 'list' ||
        typeof model.slug !== 'string' ||
        typeof model.display_name !== 'string'
      )
        return [];
      const supportedReasoningLevels = Array.isArray(model.supported_reasoning_levels)
        ? [
            ...new Set(
              model.supported_reasoning_levels.flatMap((item) => {
                const effort = parseChatGPTReasoningLevel(item);
                return effort === undefined ? [] : [effort];
              }),
            ),
          ]
        : undefined;
      const defaultReasoningLevel = isChatGPTReasoningLevel(model.default_reasoning_level)
        ? model.default_reasoning_level
        : undefined;
      return [
        {
          slug: model.slug,
          displayName: model.display_name,
          ...(supportedReasoningLevels === undefined ? {} : { supportedReasoningLevels }),
          ...(defaultReasoningLevel === undefined ? {} : { defaultReasoningLevel }),
        },
      ];
    });
  }

  async disconnect(): Promise<{ remoteRevoked: boolean }> {
    return this.withRefreshLock(async () => {
      const store = this.readStore();
      const profile = store.profiles.find((item) => item.id === store.activeProfileId);
      if (!profile?.tokens) return { remoteRevoked: false };
      let confirmed = false;
      try {
        const metadata = await this.discovery();
        const response = await this.request(metadata.revocationEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            token: profile.tokens.refreshToken,
            token_type_hint: 'refresh_token',
            client_id: profile.clientId,
          }),
        });
        confirmed = response.status === 200;
      } catch {
        /* clear locally even if remote revocation cannot be confirmed */
      }
      profile.tokens = null;
      delete profile.pendingSignIn;
      delete profile.pendingNonce;
      store.activeProfileId = null;
      this.writeStore(store);
      return { remoteRevoked: confirmed };
    });
  }

  private readStore(): Store {
    this.ensureStorage();
    if (!existsSync(this.file)) {
      const store = emptyStore();
      let fd: number | undefined;
      try {
        fd = openSync(this.file, 'wx', 0o600);
        writeFileSync(fd, `${JSON.stringify(store)}\n`, 'utf8');
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        const dirFd = openSync(dirname(this.file), 'r');
        try {
          fsyncSync(dirFd);
        } finally {
          closeSync(dirFd);
        }
        tightenPrivateFile(this.file);
        return store;
      } catch (error) {
        if (fd !== undefined) closeSync(fd);
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'))
          throw new Error('ChatGPT credential file is unsafe');
      }
    }
    const st = lstatSync(this.file);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error('ChatGPT credential file is unsafe');
    tightenPrivateFile(this.file);
    try {
      const value: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!isStore(value)) throw new Error('invalid');
      return value;
    } catch {
      throw new Error('ChatGPT credential file is invalid');
    }
  }

  private writeStore(store: Store): void {
    this.ensureStorage();
    if (existsSync(this.file)) {
      const st = lstatSync(this.file);
      if (!st.isFile() || st.isSymbolicLink()) throw new Error('ChatGPT credential file is unsafe');
    }
    const temp = `${this.file}.${randomId()}.tmp`;
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
    if (!ensurePrivateDir(join(resolve(this.file), '..')))
      throw new Error('ChatGPT credential directory is unsafe');
    const lockStat = lstatSync(this.lockFile, { throwIfNoEntry: false });
    if (lockStat && (!lockStat.isFile() || lockStat.isSymbolicLink())) {
      throw new Error('ChatGPT credential lock is unsafe');
    }
  }

  private async exchange(
    form: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    abortIfNeeded(signal);
    let response: Response;
    try {
      response = await this.request(
        TOKEN_URL,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(form),
        },
        signal,
      );
    } catch {
      throw new Error(SAFE_ERROR);
    }
    if (!response.ok) throw new Error(SAFE_ERROR);
    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new Error(SAFE_ERROR);
    }
    if (!result || typeof result !== 'object') throw new Error(SAFE_ERROR);
    return result as Record<string, unknown>;
  }

  private async validateIdentity(
    idToken: string,
    clientId: string,
    nonce?: string,
    signal?: AbortSignal,
    receivedAt = Date.now(),
  ): Promise<JWTPayload & { sub: string }> {
    abortIfNeeded(signal);
    let jwksResponse: Response;
    try {
      const metadata = await this.discovery(signal);
      jwksResponse = await this.request(metadata.jwksUri, {}, signal);
    } catch {
      throw new Error('ChatGPT identity validation unavailable');
    }
    if (!jwksResponse.ok) throw new Error('ChatGPT identity validation unavailable');
    let jwks: JSONWebKeySet;
    try {
      jwks = (await jwksResponse.json()) as JSONWebKeySet;
    } catch {
      throw new Error(SAFE_ERROR);
    }
    if (!Array.isArray(jwks.keys)) throw new Error(SAFE_ERROR);
    let payload: JWTPayload;
    try {
      const result = await jwtVerify(idToken, createLocalJWKSet(jwks), {
        issuer: AUTH_ORIGIN,
        audience: clientId,
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'iat', 'sub', ...(nonce ? ['nonce'] : [])],
        currentDate: new Date(receivedAt),
      });
      payload = result.payload;
      if (nonce !== undefined && payload.nonce !== nonce) throw new Error('nonce');
      const aud = payload.aud;
      if (payload.azp !== undefined && payload.azp !== clientId) throw new Error('azp');
      if (Array.isArray(aud) && aud.length > 1 && payload.azp !== clientId) throw new Error('azp');
    } catch {
      throw new Error('ChatGPT identity validation failed');
    }
    if (!safeString(payload.sub, 4_096)) throw new Error('ChatGPT identity validation failed');
    return payload as JWTPayload & { sub: string };
  }

  private async discovery(
    signal?: AbortSignal,
  ): Promise<{ jwksUri: string; revocationEndpoint: string }> {
    const response = await this.request(DISCOVERY_URL, {}, signal);
    if (!response.ok) throw new Error('ChatGPT identity validation unavailable');
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new Error(SAFE_ERROR);
    }
    if (!value || typeof value !== 'object') throw new Error(SAFE_ERROR);
    const metadata = value as Record<string, unknown>;
    if (
      metadata.issuer !== AUTH_ORIGIN ||
      metadata.authorization_endpoint !== AUTHORIZE_URL ||
      metadata.token_endpoint !== TOKEN_URL ||
      typeof metadata.jwks_uri !== 'string' ||
      typeof metadata.revocation_endpoint !== 'string'
    )
      throw new Error(SAFE_ERROR);
    const jwks = new URL(metadata.jwks_uri);
    const revocation = new URL(metadata.revocation_endpoint);
    if (
      jwks.protocol !== 'https:' ||
      jwks.origin !== AUTH_ORIGIN ||
      jwks.username ||
      jwks.password ||
      jwks.search ||
      jwks.hash ||
      revocation.href !== `${AUTH_ORIGIN}/api/accounts/oauth/revoke`
    )
      throw new Error(SAFE_ERROR);
    return { jwksUri: jwks.href, revocationEndpoint: revocation.href };
  }

  private request(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(NETWORK_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return this.fetchImpl(url, { ...init, redirect: 'error', signal: combined });
  }

  private async withRefreshLock<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const key = this.lockFile;
    const previous = this.localLocks.get(key) ?? Promise.resolve();
    let releaseLocal!: () => void;
    const current = new Promise<void>((resolvePromise) => {
      releaseLocal = resolvePromise;
    });
    const tail = previous.then(() => current);
    this.localLocks.set(key, tail);
    await previous;
    let db: Database.Database | undefined;
    try {
      this.ensureStorage();
      db = new Database(this.lockFile, { timeout: 0 });
      db.pragma('busy_timeout = 0');
      tightenPrivateDb(this.lockFile);
      const deadline = Date.now() + 30_000;
      for (;;) {
        abortIfNeeded(signal);
        try {
          db.exec('BEGIN IMMEDIATE');
          break;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !/locked|busy/i.test(error.message) ||
            Date.now() >= deadline
          )
            throw new Error('ChatGPT credential lock unavailable');
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
      db?.close();
      releaseLocal();
      if (this.localLocks.get(key) === tail) this.localLocks.delete(key);
    }
  }
}
