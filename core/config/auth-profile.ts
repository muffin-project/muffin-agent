import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  type InferenceLane,
  loadConfig,
  locateSecret,
  SECRET_BACKENDS,
  secretDir,
} from './config.js';
import { ensurePrivateDir, tightenPrivateFile } from './private-fs.js';
import { PROVIDERS, providerFor } from './providers.js';

/**
 * Account list for providers that authenticate with a stored key.
 *
 * ChatGPT profiles stay inside the ChatGPT credential file. This index never
 * stores a key, a code, or a verifier — only which secret name belongs to
 * which account. Lanes keep their own `apiKeyRef` (ADR-0099); the index does
 * not replace that.
 */

export type KeyProviderId = 'openrouter' | 'anthropic';
export type KeyAuthMethod = 'oauth-pkce' | 'api-key';

export type KeyAuthProfile = {
  id: string;
  provider: KeyProviderId;
  method: KeyAuthMethod;
  secretName: string;
};

export type KeyAuthProfileView = KeyAuthProfile & {
  secretPresent: boolean;
  lanes: InferenceLane[];
  /** Chosen when no lane currently points at this provider. */
  selected: boolean;
};

type Index = {
  version: 1;
  profiles: KeyAuthProfile[];
  selected: Partial<Record<KeyProviderId, string>>;
};

const KEY_PROVIDERS: readonly KeyProviderId[] = ['openrouter', 'anthropic'];
const ID_PATTERN = /^[a-z0-9]{1,32}$/;

export class AuthProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthProfileError';
  }
}

export function authProfilePath(home: string): string {
  return join(home, 'auth-profiles.json');
}

export function keySecretName(provider: KeyProviderId, id: string): string {
  const base = PROVIDERS[provider].secretName;
  if (id === 'default') return base;
  if (!ID_PATTERN.test(id)) {
    throw new AuthProfileError('Profile id must be "default" or lowercase letters and digits.');
  }
  return `${base}_${id}`;
}

/** `null` when this secret name is not one of the managed per-account names. */
export function managedProfileId(provider: KeyProviderId, secretName: string): string | null {
  const base = PROVIDERS[provider].secretName;
  if (secretName === base) return 'default';
  const prefix = `${base}_`;
  if (!secretName.startsWith(prefix)) return null;
  const id = secretName.slice(prefix.length);
  return ID_PATTERN.test(id) ? id : null;
}

export function listKeyProfiles(home: string): KeyAuthProfileView[] {
  const index = readIndex(home);
  const config = readConfig(home);
  const views: KeyAuthProfileView[] = [];
  for (const provider of KEY_PROVIDERS) {
    const bySecret = new Map<string, KeyAuthProfile>();
    for (const profile of index.profiles) {
      if (profile.provider === provider) bySecret.set(profile.secretName, profile);
    }
    for (const found of discover(home, provider)) {
      if (!bySecret.has(found.secretName)) bySecret.set(found.secretName, found);
    }
    const selectedId = index.selected[provider];
    for (const profile of bySecret.values()) {
      const lanes = lanesUsing(config, provider, profile.secretName);
      views.push({
        ...profile,
        secretPresent: locateSecret(`secret://${profile.secretName}`, home) !== null,
        lanes,
        selected: lanes.length === 0 && selectedId === profile.id,
      });
    }
  }
  views.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
  return views;
}

export function rememberKeyProfile(home: string, profile: KeyAuthProfile): void {
  const expected = keySecretName(profile.provider, profile.id);
  if (profile.secretName !== expected) {
    throw new AuthProfileError('Profile secret name does not match its id.');
  }
  const index = readIndex(home);
  const next = index.profiles.filter(
    (item) => !(item.provider === profile.provider && item.secretName === profile.secretName),
  );
  next.push(profile);
  writeIndex(home, {
    ...index,
    profiles: next,
    selected: { ...index.selected, [profile.provider]: profile.id },
  });
}

export function selectKeyProfile(
  home: string,
  provider: KeyProviderId,
  id: string,
): KeyAuthProfile {
  const profiles = listKeyProfiles(home).filter((item) => item.provider === provider);
  const profile = profiles.find((item) => item.id === id);
  if (!profile) throw new AuthProfileError(`${provider} profile is unavailable.`);
  const index = readIndex(home);
  const stored = index.profiles.some(
    (item) => item.provider === provider && item.secretName === profile.secretName,
  );
  const profilesNext = stored
    ? index.profiles
    : [
        ...index.profiles,
        {
          id: profile.id,
          provider: profile.provider,
          method: profile.method,
          secretName: profile.secretName,
        },
      ];
  writeIndex(home, {
    ...index,
    profiles: profilesNext,
    selected: { ...index.selected, [provider]: id },
  });
  return profile;
}

function discover(home: string, provider: KeyProviderId): KeyAuthProfile[] {
  const found = new Map<string, KeyAuthProfile>();
  for (const backend of SECRET_BACKENDS) {
    const dir = secretDir(backend, home);
    if (!existsSync(dir)) continue;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.includes('.') || name.includes('/')) continue;
      const id = managedProfileId(provider, name);
      if (id === null) continue;
      let st: ReturnType<typeof lstatSync> | undefined;
      try {
        st = lstatSync(join(dir, name));
      } catch {
        continue;
      }
      if (!st.isFile() || st.isSymbolicLink()) continue;
      found.set(name, { id, provider, method: 'api-key', secretName: name });
    }
  }
  return [...found.values()];
}

function lanesUsing(
  config: ReturnType<typeof readConfig>,
  provider: KeyProviderId,
  secretName: string,
): InferenceLane[] {
  if (config === null) return [];
  const lanes: InferenceLane[] = [];
  for (const lane of ['main', 'light'] as const) {
    const connection =
      lane === 'light' ? (config.lightProvider ?? config.provider) : config.provider;
    const id = providerFor(connection)?.id;
    if (id === provider && connection.apiKeyRef === `secret://${secretName}`) lanes.push(lane);
  }
  return lanes;
}

function readConfig(home: string): ReturnType<typeof loadConfig> | null {
  if (!existsSync(join(home, 'config.json'))) return null;
  try {
    return loadConfig(home);
  } catch {
    return null;
  }
}

function emptyIndex(): Index {
  return { version: 1, profiles: [], selected: {} };
}

function readIndex(home: string): Index {
  const file = authProfilePath(home);
  if (!existsSync(file)) return emptyIndex();
  const st = lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink())
    throw new AuthProfileError('Auth profile index is unsafe.');
  tightenPrivateFile(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new AuthProfileError('Auth profile index is invalid.');
  }
  if (!isIndex(parsed)) throw new AuthProfileError('Auth profile index is invalid.');
  return parsed;
}

function writeIndex(home: string, index: Index): void {
  const file = authProfilePath(home);
  if (!ensurePrivateDir(home)) throw new AuthProfileError('Auth profile directory is unsafe.');
  const existing = lstatSync(file, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new AuthProfileError('Auth profile index is unsafe.');
  }
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
    tightenPrivateFile(file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* already moved */
    }
    throw error;
  }
}

function isIndex(value: unknown): value is Index {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Index>;
  if (candidate.version !== 1 || !Array.isArray(candidate.profiles)) return false;
  if (!candidate.selected || typeof candidate.selected !== 'object') return false;
  for (const profile of candidate.profiles) {
    if (!isProfile(profile)) return false;
  }
  for (const provider of KEY_PROVIDERS) {
    const selected = candidate.selected[provider];
    if (selected !== undefined && selected !== 'default' && !ID_PATTERN.test(selected))
      return false;
  }
  return true;
}

function isProfile(value: unknown): value is KeyAuthProfile {
  if (!value || typeof value !== 'object') return false;
  const profile = value as Partial<KeyAuthProfile>;
  if (profile.provider !== 'openrouter' && profile.provider !== 'anthropic') return false;
  if (profile.method !== 'oauth-pkce' && profile.method !== 'api-key') return false;
  if (typeof profile.id !== 'string' || typeof profile.secretName !== 'string') return false;
  if (profile.id !== 'default' && !ID_PATTERN.test(profile.id)) return false;
  return profile.secretName === keySecretName(profile.provider, profile.id);
}
