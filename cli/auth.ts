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
  type InferenceLane,
  type InferenceProviderConfig,
  inferenceProvider,
  loadConfig,
  saveConfig,
  withInferenceProvider,
} from '../core/config/config.js';
import { PROVIDERS, providerFor } from '../core/config/providers.js';
import { cmdChatGPT } from './chatgpt.js';
import {
  obtainOpenRouterAuthorization,
  openRouterAuthMode,
  probeSavedRoute,
  safeLine,
  storeOpenRouterKey,
} from './openrouter-connect.js';

export const AUTH_USAGE = `usage:
  muffin auth status
  muffin auth list
  muffin auth login openrouter [--new [id]] [--code|--browser]
  muffin auth login chatgpt [profile-id | --new]
  muffin auth switch <openrouter|anthropic|chatgpt> <profile-id>
`;

const REFUSED_OAUTH =
  'Anthropic accepts a Console/API key only (including Max/Ultra API credits). No claude.ai login.';
const REFUSED_XAI = 'This slice does not connect xAI/Grok. No OAuth client is included.';

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
    deps.out(REFUSED_XAI);
    return 2;
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
  if (provider === 'xai' || provider === 'grok') {
    deps.out(REFUSED_XAI);
    return 2;
  }
  if (provider === 'chatgpt') {
    return cmdChatGPT(home, ['select', id], {
      out: deps.out,
      ...(deps.chatgpt ? { connection: deps.chatgpt } : {}),
    });
  }
  if (provider !== 'openrouter' && provider !== 'anthropic') {
    deps.out(AUTH_USAGE.trim());
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
