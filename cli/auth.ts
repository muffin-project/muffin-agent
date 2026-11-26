import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { verifyInferenceRoute } from '../agent/providers/verify.js';
import {
  AuthProfileError,
  type KeyAuthProfile,
  type KeyProviderId,
  keySecretName,
  listKeyProfiles,
  selectKeyProfile,
} from '../core/config/auth-profile.js';
import { ChatGPTConnection, type ChatGPTProfile } from '../core/config/chatgpt-oauth.js';
import {
  type Config,
  type InferenceLane,
  type InferenceProviderConfig,
  inferenceProvider,
  loadConfig,
  locateSecret,
  saveConfig,
  withInferenceProvider,
} from '../core/config/config.js';
import { clearChainPauses } from '../core/config/provider-chain.js';
import { PROVIDERS, providerFor } from '../core/config/providers.js';
import {
  fetchXaiEmail,
  XAI_OAUTH_REF,
  XaiOAuthConnection,
  type XaiOAuthStatus,
} from '../core/config/xai-oauth.js';
import { cmdChatGPT } from './chatgpt.js';
import {
  obtainOpenRouterAuthorization,
  openRouterAuthMode,
  probeSavedRoute,
  safeLine,
  storeOpenRouterKey,
} from './openrouter-connect.js';
import { obtainXaiAuthorization, xaiAuthMode } from './xai-connect.js';

export const AUTH_USAGE = `usage:
  muffin auth status
  muffin auth list
  muffin auth login openrouter [--new [id]] [--code|--browser]
  muffin auth login chatgpt [profile-id | --new]
  muffin auth login xai [--browser|--code|--device]
  muffin auth logout <xai|chatgpt>
  muffin auth switch <openrouter|anthropic|xai|chatgpt> <profile-id>
`;

const REFUSED_OAUTH =
  'Anthropic accepts a Console/API key only (including Max/Ultra API credits). No claude.ai login.';

export type AuthCommandDeps = {
  out: (line: string) => void;
  obtain?: typeof obtainOpenRouterAuthorization;
  verify?: typeof verifyInferenceRoute;
  chatgpt?: Pick<
    ChatGPTConnection,
    'signIn' | 'session' | 'profiles' | 'select' | 'disconnect' | 'listModels'
  >;
  openBrowser?: (url: string) => Promise<void>;
  ssh?: boolean;
  stdinIsTTY?: boolean;
  xai?: Pick<XaiOAuthConnection, 'save' | 'status' | 'disconnect'>;
  obtainXai?: typeof obtainXaiAuthorization;
  /** Network for the post-login probe and account label (tests inject it). */
  fetch?: typeof fetch;
};

export async function cmdAuth(
  home: string,
  argv: string[],
  deps: AuthCommandDeps,
): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'status' || command === 'list') {
    if (rest.length > 0) {
      deps.out(AUTH_USAGE.trim());
      return 2;
    }
    return printProfiles(home, deps);
  }
  if (command === 'switch') return switchProfile(home, rest, deps);
  if (command === 'logout') return logout(home, rest, deps);
  if (command === 'login') return login(home, rest, deps);
  deps.out(AUTH_USAGE.trim());
  return 2;
}

async function login(home: string, rest: string[], deps: AuthCommandDeps): Promise<number> {
  const [provider, ...tail] = rest;
  if (provider === 'anthropic') {
    deps.out(REFUSED_OAUTH);
    return 2;
  }
  if (provider === 'xai' || provider === 'grok') {
    return loginXai(home, tail, {
      ...deps,
      ssh: deps.ssh ?? Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY),
      stdinIsTTY: deps.stdinIsTTY ?? process.stdin.isTTY === true,
    });
  }
  if (provider === 'chatgpt') return loginChatGPT(home, tail, deps);
  if (provider !== 'openrouter') {
    deps.out(AUTH_USAGE.trim());
    return 2;
  }
  const parsed = parseOpenRouterLogin(tail);
  if (!parsed.ok) {
    deps.out(AUTH_USAGE.trim());
    return 2;
  }
  try {
    loadConfig(home);
  } catch {
    deps.out('Run `muffin init` before `muffin auth login openrouter`.');
    return 1;
  }
  const mode = openRouterAuthMode({
    explicit: parsed.mode,
    ssh: deps.ssh ?? Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY),
    stdinIsTTY: deps.stdinIsTTY ?? process.stdin.isTTY === true,
  });
  if (mode === 'unavailable') {
    deps.out('OpenRouter OAuth needs a terminal. Headless key: echo -n "$KEY" | muffin init');
    return 1;
  }
  let target: { id: string; secretName: string };
  try {
    target = resolveOpenRouterTarget(home, parsed);
  } catch (error) {
    deps.out(
      safeLine(error instanceof Error ? error.message : 'OpenRouter profile is unavailable'),
    );
    return 1;
  }
  let key: string;
  try {
    key = await (deps.obtain ?? obtainOpenRouterAuthorization)({
      mode,
      out: deps.out,
      ...(deps.openBrowser ? { openBrowser: deps.openBrowser } : {}),
    });
  } catch (error) {
    deps.out(safeLine(error instanceof Error ? error.message : 'OpenRouter authorization failed'));
    return 1;
  }
  storeOpenRouterKey(home, target.secretName, key, 'oauth-pkce');
  applyOpenRouterMain(home, target.secretName);
  const saved = loadConfig(home);
  const configuredModel = saved.models.main;
  const probeModel = configuredModel.includes('/') ? configuredModel : 'openrouter/free';
  deps.out(
    `OpenRouter key stored at secret://${target.secretName} (profile ${target.id}, not printed).`,
  );
  deps.out(`Main provider set to openai-compat ${PROVIDERS.openrouter.baseUrl}.`);
  const extra =
    probeModel === configuredModel
      ? undefined
      : `Saved main model "${configuredModel}" is not an OpenRouter id. The capability probe used ${probeModel}. Choose a model with \`muffin model main --provider openrouter\`.`;
  const code = await probeSavedRoute(home, deps.out, {
    ...(deps.verify ? { verify: deps.verify } : {}),
    model: probeModel,
    style: 'en',
    ...(extra ? { extra } : {}),
  });
  if (code !== 0) {
    deps.out('The key and provider are saved. Re-probe with `muffin doctor --online`.');
  }
  return code;
}

function resolveOpenRouterTarget(
  home: string,
  parsed: { profileId?: string; newProfile: boolean },
): { id: string; secretName: string } {
  if (parsed.newProfile) {
    const id = parsed.profileId ?? randomBytes(4).toString('hex');
    if (id === 'default') throw new AuthProfileError('Use --new with an id other than default.');
    keySecretName('openrouter', id);
    const taken = listKeyProfiles(home).some(
      (item) => item.provider === 'openrouter' && item.id === id,
    );
    if (taken) throw new AuthProfileError(`OpenRouter profile ${id} already exists.`);
    return { id, secretName: keySecretName('openrouter', id) };
  }
  if (parsed.profileId) {
    const found = listKeyProfiles(home).find(
      (item) => item.provider === 'openrouter' && item.id === parsed.profileId,
    );
    if (!found && parsed.profileId !== 'default') {
      throw new AuthProfileError('OpenRouter profile is unavailable.');
    }
    return {
      id: parsed.profileId,
      secretName: found?.secretName ?? keySecretName('openrouter', parsed.profileId),
    };
  }
  const profiles = listKeyProfiles(home).filter((item) => item.provider === 'openrouter');
  const current =
    profiles.find((item) => item.lanes.includes('main')) ??
    profiles.find((item) => item.selected) ??
    profiles.find((item) => item.id === 'default');
  if (current) return { id: current.id, secretName: current.secretName };
  return { id: 'default', secretName: keySecretName('openrouter', 'default') };
}

function applyOpenRouterMain(home: string, secretName: string): void {
  const config = loadConfig(home);
  const current = inferenceProvider(config, 'main');
  const already = providerFor(current)?.id === 'openrouter';
  const next: InferenceProviderConfig = already
    ? {
        ...current,
        kind: 'openai-compat',
        baseUrl: PROVIDERS.openrouter.baseUrl,
        apiKeyRef: `secret://${secretName}`,
      }
    : {
        kind: 'openai-compat',
        baseUrl: PROVIDERS.openrouter.baseUrl,
        apiKeyRef: `secret://${secretName}`,
      };
  saveConfig(withInferenceProvider(config, 'main', next), home);
}

async function loginChatGPT(home: string, tail: string[], deps: AuthCommandDeps): Promise<number> {
  if (tail.length > 1 || (tail[0]?.startsWith('--') && tail[0] !== '--new')) {
    deps.out(AUTH_USAGE.trim());
    return 2;
  }
  return cmdChatGPT(home, ['login', ...tail], {
    out: deps.out,
    ...(deps.chatgpt ? { connection: deps.chatgpt } : {}),
    ...(deps.openBrowser ? { openBrowser: deps.openBrowser } : {}),
  });
}

async function switchProfile(home: string, rest: string[], deps: AuthCommandDeps): Promise<number> {
  const [provider, id, extra] = rest;
  if (!provider || !id || extra !== undefined) {
    deps.out(AUTH_USAGE.trim());
    return 2;
  }
  if (provider === 'chatgpt') {
    return cmdChatGPT(home, ['select', id], {
      out: deps.out,
      ...(deps.chatgpt ? { connection: deps.chatgpt } : {}),
    });
  }
  if (provider !== 'openrouter' && provider !== 'anthropic' && provider !== 'xai') {
    deps.out(AUTH_USAGE.trim());
    return 2;
  }
  if (provider === 'xai' && id === 'oauth') {
    deps.out('The xAI login is chosen per chain link: `muffin fallback add xai <model>`.');
    return 2;
  }
  let profile: KeyAuthProfile;
  try {
    profile = selectKeyProfile(home, provider, id);
  } catch (error) {
    deps.out(safeLine(error instanceof Error ? error.message : 'Profile is unavailable'));
    return 1;
  }
  let touched: InferenceLane[] = [];
  try {
    touched = retargetLanes(home, provider, profile.secretName);
  } catch (error) {
    deps.out(safeLine(error instanceof Error ? error.message : 'Could not update the lane'));
    return 1;
  }
  deps.out(
    touched.length === 0
      ? `Selected ${provider} profile ${id}. No lane currently uses it.`
      : `Selected ${provider} profile ${id} on ${touched.join(', ')}.`,
  );
  return 0;
}

function retargetLanes(home: string, provider: KeyProviderId, secretName: string): InferenceLane[] {
  const config = loadConfig(home);
  let next = config;
  const touched: InferenceLane[] = [];
  for (const lane of ['main', 'light'] as const) {
    const current = inferenceProvider(next, lane);
    if (providerFor(current)?.id !== provider) continue;
    next = withInferenceProvider(next, lane, {
      ...current,
      apiKeyRef: `secret://${secretName}`,
    });
    touched.push(lane);
  }
  if (touched.length > 0) saveConfig(next, home);
  return touched;
}

async function printProfiles(home: string, deps: AuthCommandDeps): Promise<number> {
  try {
    for (const profile of listKeyProfiles(home)) {
      const where =
        profile.lanes.length > 0
          ? `active: ${profile.lanes.join(',')}`
          : profile.selected
            ? 'selected'
            : 'inactive';
      const present = profile.secretPresent ? '' : ' secret-missing';
      deps.out(
        `${profile.provider} ${profile.id} ${profile.method} secret://${profile.secretName} ${where}${present}`,
      );
    }
  } catch (error) {
    deps.out(safeLine(error instanceof Error ? error.message : 'Auth profile index is invalid'));
    return 1;
  }
  printXaiLogin(home, deps);
  for (const profile of await chatgptProfiles(home, deps)) {
    const where = profile.active ? 'active' : 'inactive';
    const email = profile.email ? ` ${profile.email}` : '';
    deps.out(`chatgpt ${profile.profileId} chatgpt-plan secret://chatgpt ${where}${email}`);
  }
  return 0;
}

async function chatgptProfiles(home: string, deps: AuthCommandDeps): Promise<ChatGPTProfile[]> {
  if (deps.chatgpt) {
    try {
      return await deps.chatgpt.profiles();
    } catch (error) {
      deps.out(
        safeLine(error instanceof Error ? error.message : 'ChatGPT profiles are unavailable'),
      );
      return [];
    }
  }
  if (!existsSync(join(resolve(home), 'secrets', 'chatgpt'))) return [];
  try {
    return new ChatGPTConnection(home).profiles();
  } catch (error) {
    deps.out(safeLine(error instanceof Error ? error.message : 'ChatGPT profiles are unavailable'));
    return [];
  }
}

function parseOpenRouterLogin(tail: string[]): {
  ok: boolean;
  profileId?: string;
  newProfile: boolean;
  mode?: 'browser' | 'code';
} {
  let profileId: string | undefined;
  let newProfile = false;
  let mode: 'browser' | 'code' | undefined;
  for (let i = 0; i < tail.length; i += 1) {
    const token = tail[i];
    if (token === undefined) continue;
    if (token === '--code' || token === '--browser') {
      const next = token === '--code' ? 'code' : 'browser';
      if (mode && mode !== next) return { ok: false, newProfile };
      mode = next;
      continue;
    }
    if (token === '--new') {
      newProfile = true;
      const following = tail[i + 1];
      if (following && !following.startsWith('--')) {
        if (profileId) return { ok: false, newProfile };
        profileId = following;
        i += 1;
      }
      continue;
    }
    if (token.startsWith('--') || profileId) return { ok: false, newProfile };
    profileId = token;
  }
  if (newProfile && profileId === 'default') return { ok: false, newProfile };
  return { ok: true, newProfile, ...(profileId ? { profileId } : {}), ...(mode ? { mode } : {}) };
}

function parseXaiLogin(tail: string[]): { ok: boolean; mode?: 'browser' | 'code' | 'device' } {
  let mode: 'browser' | 'code' | 'device' | undefined;
  for (const token of tail) {
    const next =
      token === '--browser'
        ? 'browser'
        : token === '--code'
          ? 'code'
          : token === '--device'
            ? 'device'
            : undefined;
    if (next === undefined || (mode !== undefined && mode !== next)) return { ok: false };
    mode = next;
  }
  return { ok: true, ...(mode ? { mode } : {}) };
}

/** Where the xAI login is used: lanes and chain positions, as `muffin fallback` prints them. */
function xaiLoginUses(config: Config): string[] {
  const uses: string[] = [];
  for (const lane of ['main', 'light'] as const) {
    if (inferenceProvider(config, lane).apiKeyRef === XAI_OAUTH_REF) uses.push(`${lane} 1`);
    (config.fallbacks?.[lane] ?? []).forEach((link, index) => {
      if (link.provider.apiKeyRef === XAI_OAUTH_REF) uses.push(`${lane} ${index + 2}`);
    });
  }
  return uses;
}

/**
 * xAI connections that name the default key while no key exists cannot work;
 * after a login they use it. A connection with a key, or with another
 * account's key, is the owner's explicit choice and stays as it is.
 */
function useXaiLoginWhereKeyMissing(home: string): string[] {
  const keyRef = `secret://${PROVIDERS.xai.secretName}`;
  if (locateSecret(keyRef, home) !== null) return [];
  const config = loadConfig(home);
  const broken = (provider: InferenceProviderConfig): boolean =>
    providerFor(provider)?.id === 'xai' && provider.apiKeyRef === keyRef;
  let next = config;
  const changed: string[] = [];
  for (const lane of ['main', 'light'] as const) {
    const current = inferenceProvider(next, lane);
    if (broken(current)) {
      next = withInferenceProvider(next, lane, { ...current, apiKeyRef: XAI_OAUTH_REF });
      changed.push(`${lane} 1`);
    }
    const links = next.fallbacks?.[lane];
    if (links?.some((link) => broken(link.provider))) {
      next = {
        ...next,
        fallbacks: {
          ...next.fallbacks,
          [lane]: links.map((link, index) => {
            if (!broken(link.provider)) return link;
            changed.push(`${lane} ${index + 2}`);
            return { ...link, provider: { ...link.provider, apiKeyRef: XAI_OAUTH_REF } };
          }),
        },
      };
    }
  }
  if (changed.length > 0) saveConfig(next, home);
  return changed;
}

/** Does api.x.ai accept this login? Status only; the token never leaves this call. */
async function probeXaiApi(
  token: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; models: number } | { ok: false; status?: number }> {
  try {
    const response = await fetchImpl(`${PROVIDERS.xai.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { ok: false, status: response.status };
    const body = (await response.json().catch(() => null)) as { data?: unknown } | null;
    return { ok: true, models: Array.isArray(body?.data) ? body.data.length : 0 };
  } catch {
    return { ok: false };
  }
}

async function loginXai(home: string, tail: string[], deps: AuthCommandDeps): Promise<number> {
  const parsed = parseXaiLogin(tail);
  if (!parsed.ok) {
    deps.out(AUTH_USAGE.trim());
    return 2;
  }
  try {
    loadConfig(home);
  } catch {
    deps.out('Run `muffin init` before `muffin auth login xai`.');
    return 1;
  }
  const mode = xaiAuthMode({
    explicit: parsed.mode,
    ssh: deps.ssh ?? false,
    stdinIsTTY: deps.stdinIsTTY ?? false,
  });
  if (mode === 'unavailable') {
    deps.out(
      'xAI login needs a terminal. Headless: echo -n "$KEY" | muffin secret set xai_api_key',
    );
    return 1;
  }
  const connection = deps.xai ?? new XaiOAuthConnection(home);
  const fetchImpl = deps.fetch ?? fetch;
  let token: string;
  try {
    const result = await (deps.obtainXai ?? obtainXaiAuthorization)({
      mode,
      out: deps.out,
      ...(deps.openBrowser ? { openBrowser: deps.openBrowser } : {}),
    });
    const email = await fetchXaiEmail(result.token.accessToken, fetchImpl);
    await connection.save(result.token, result.method, email);
    token = result.token.accessToken;
    deps.out(
      `xAI login saved at ${XAI_OAUTH_REF}${email ? ` for ${safeLine(email)}` : ''} (tokens not printed, renewed automatically).`,
    );
  } catch (error) {
    deps.out(safeLine(error instanceof Error ? error.message : 'xAI login failed'));
    return 1;
  }
  // A new login is the owner fixing the account: paused links that use it
  // are tried again from the next message (ADR-0110).
  try {
    clearChainPauses(home, { apiKeyRef: XAI_OAUTH_REF });
  } catch {
    // advisory state
  }
  const changed = useXaiLoginWhereKeyMissing(home);
  if (changed.length > 0) {
    deps.out(`xAI connections without a key now use the login: ${changed.join(', ')}.`);
  }
  const uses = xaiLoginUses(loadConfig(home));
  deps.out(
    uses.length > 0
      ? `Used by: ${uses.join(', ')} (see \`muffin fallback\`).`
      : 'Add it to a chain: `muffin fallback add xai grok-4.7` (or `--light`).',
  );
  const probe = await probeXaiApi(token, fetchImpl);
  if (probe.ok) {
    deps.out(`api.x.ai accepts this login (${probe.models} models visible).`);
    return 0;
  }
  if (probe.status === 401 || probe.status === 403) {
    deps.out(
      `api.x.ai refused this login (HTTP ${probe.status}). xAI decides per plan which accounts get API access; ` +
        'if it persists, use a console.x.ai key: `muffin secret set xai_api_key` and `muffin fallback add xai <model> --account default`.',
    );
    return 1;
  }
  deps.out(
    `Could not check api.x.ai now${probe.status ? ` (HTTP ${probe.status})` : ''}. Re-check with \`muffin doctor --online\`.`,
  );
  return 0;
}

async function logout(home: string, rest: string[], deps: AuthCommandDeps): Promise<number> {
  const [provider, extra] = rest;
  if (extra !== undefined) {
    deps.out(AUTH_USAGE.trim());
    return 2;
  }
  if (provider === 'chatgpt') {
    return cmdChatGPT(home, ['logout'], {
      out: deps.out,
      ...(deps.chatgpt ? { connection: deps.chatgpt } : {}),
    });
  }
  if (provider !== 'xai' && provider !== 'grok') {
    deps.out(AUTH_USAGE.trim());
    return 2;
  }
  let result: { removed: boolean; remoteRevoked: boolean };
  try {
    result = await (deps.xai ?? new XaiOAuthConnection(home)).disconnect();
  } catch (error) {
    deps.out(safeLine(error instanceof Error ? error.message : 'xAI logout failed'));
    return 1;
  }
  if (!result.removed) {
    deps.out('xAI is not logged in.');
    return 0;
  }
  deps.out(
    result.remoteRevoked
      ? 'Signed out of xAI; the renewable session was revoked.'
      : 'Signed out locally; xAI did not confirm revocation. Remove Muffin from your xAI account settings.',
  );
  let uses: string[] = [];
  try {
    uses = xaiLoginUses(loadConfig(home));
  } catch {
    // no config: nothing references the login
  }
  if (uses.length > 0) {
    deps.out(
      `Still configured to use it: ${uses.join(', ')}. Log in again or remove them with \`muffin fallback remove\`.`,
    );
  }
  return 0;
}

function describeXaiStatus(status: XaiOAuthStatus): string {
  if (status.needsLogin) return 'needs-login';
  if (status.usable) return 'ok';
  return 'refresh-on-next-use';
}

function printXaiLogin(home: string, deps: AuthCommandDeps): void {
  let status: XaiOAuthStatus;
  try {
    status = (deps.xai ?? new XaiOAuthConnection(home)).status();
  } catch (error) {
    deps.out(safeLine(error instanceof Error ? error.message : 'xAI login store is invalid'));
    return;
  }
  if (!status.connected) return;
  let uses: string[] = [];
  try {
    uses = xaiLoginUses(loadConfig(home));
  } catch {
    // no config yet
  }
  const where = uses.length > 0 ? `active: ${uses.join(',')}` : 'inactive';
  const email = status.email ? ` ${safeLine(status.email)}` : '';
  deps.out(
    `xai login ${status.method ?? 'oauth'} ${XAI_OAUTH_REF} ${where} ${describeXaiStatus(status)}${email}`,
  );
}
