import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FallbackLink, InferenceLane } from './config.js';
import { ensurePrivateDir, tightenPrivateFile } from './private-fs.js';
import { PROVIDERS, providerFor } from './providers.js';

/**
 * Identity, labels and persisted health of a lane's provider chain (ADR-0110).
 *
 * The chain itself runs in `agent/providers/chain.ts`. This module is the part
 * a reader without a runtime needs: `muffin doctor` and `muffin fallback` in
 * another process must say which link is serving and why, so the runtime
 * writes the transitions here and they read them back. Nothing secret is ever
 * written: a link is named by its endpoint, its secret *reference* and model.
 */

/** Why a link stopped serving. Content and tool errors never appear here. */
export type FailoverReason = 'quota' | 'auth' | 'rate_limit' | 'outage';

export type LinkCooldown = {
  /** Epoch ms after which the link is tried again first. */
  until: number;
  reason: FailoverReason;
  /** Epoch ms of the failure that started the cooldown. */
  at: number;
  /** Whether `until` came from the provider (reset time / Retry-After) rather than a default. */
  declared: boolean;
};

export type LaneChainState = {
  /** Id of the link that served the last successful call. */
  active: string;
  /** Epoch ms of the last change of `active`. */
  since: number;
  cooldowns: Record<string, LinkCooldown>;
  /**
   * The last fallback that refused the request itself (a 404 model, a 400)
   * while covering for an earlier link. Status and error class only, never
   * the provider's text.
   */
  lastFallbackError?: { link: string; at: number; status?: number; kind: string };
};

export type ChainState = {
  version: 1;
  lanes: Partial<Record<InferenceLane, LaneChainState>>;
};

const EMPTY: ChainState = { version: 1, lanes: {} };

export function chainStatePath(home: string): string {
  return join(home, 'provider-chain.json');
}

/** Stable, secret-free identity: two accounts on one endpoint differ by secret reference. */
export function linkId(link: FallbackLink): string {
  const p = link.provider;
  return [p.kind, p.baseUrl ?? '', p.apiKeyRef, link.model].join('|');
}

/** How the owner reads a link: catalog label (or host), model, and account when not the default. */
export function linkLabel(link: FallbackLink): string {
  const entry = providerFor(link.provider);
  let name: string = entry?.label ?? link.provider.kind;
  if (entry === null && link.provider.baseUrl !== undefined) {
    try {
      name = new URL(link.provider.baseUrl).host;
    } catch {
      // keep the kind
    }
  }
  const ref = link.provider.apiKeyRef.replace(/^secret:\/\//, '');
  const account =
    entry !== null && ref !== entry.secretName && ref !== 'provider_api_key' ? ` (${ref})` : '';
  return `${name}${account} · ${link.model}`;
}

export function readChainState(home: string): ChainState {
  const file = chainStatePath(home);
  if (!existsSync(file)) return structuredClone(EMPTY);
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ChainState>;
    if (raw.version !== 1 || raw.lanes === null || typeof raw.lanes !== 'object') {
      return structuredClone(EMPTY);
    }
    return { version: 1, lanes: raw.lanes };
  } catch {
    // Health is advisory: an unreadable file means "nothing known", never a failed turn.
    return structuredClone(EMPTY);
  }
}

/**
 * Replace one lane's record, keeping the other lane's as last read. The file
 * swap is atomic (temp file + rename), the read-modify-write is not: two
 * processes writing the same lane at once keep the last writer's record. That
 * is acceptable for advisory health — the gateway is the only routine writer,
 * and the worst case is one extra probe of a paused link.
 */
export function writeLaneChainState(
  home: string,
  lane: InferenceLane,
  state: LaneChainState,
): void {
  if (!ensurePrivateDir(home)) return;
  const current = readChainState(home);
  current.lanes[lane] = state;
  const file = chainStatePath(home);
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
    tightenPrivateFile(file);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing to clean
    }
  }
}

/** The catalog entries a link can be built from by name (`muffin fallback add <id>`). */
export function catalogLink(id: string, model: string, secretName?: string): FallbackLink | null {
  const entry = (PROVIDERS as Record<string, (typeof PROVIDERS)[keyof typeof PROVIDERS]>)[id];
  if (entry === undefined) return null;
  return {
    provider: {
      kind: entry.kind,
      baseUrl: entry.baseUrl,
      apiKeyRef: `secret://${entry.kind === 'openai-chatgpt' ? entry.secretName : (secretName ?? entry.secretName)}`,
    },
    model,
  };
}

/**
 * A reader for the runtime: returns the lane's record when the file changed
 * since the last call, `undefined` otherwise. One `stat` per model call.
 */
export function chainStateWatcher(
  home: string,
  lane: InferenceLane,
): () => LaneChainState | undefined {
  let seen = mtimeOf(chainStatePath(home));
  return () => {
    const now = mtimeOf(chainStatePath(home));
    if (now === seen) return undefined;
    seen = now;
    return readChainState(home).lanes[lane] ?? { active: '', since: 0, cooldowns: {} };
  };
}

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Clear pauses. With a secret reference, only the links that use it — called
 * when the owner signs in again or stores a new key, so a fixed account is
 * used again at once instead of after its cooldown. Without one, every pause
 * on the selected lanes (`muffin fallback reset`). Returns how many cleared.
 */
export function clearChainPauses(
  home: string,
  options: { apiKeyRef?: string; lanes?: InferenceLane[] } = {},
): number {
  if (!existsSync(chainStatePath(home))) return 0;
  const state = readChainState(home);
  let cleared = 0;
  for (const lane of options.lanes ?? (['main', 'light'] as const)) {
    const record = state.lanes[lane];
    if (record === undefined) continue;
    const before = Object.keys(record.cooldowns).length;
    const cooldowns = Object.fromEntries(
      Object.entries(record.cooldowns).filter(
        ([id]) => options.apiKeyRef !== undefined && id.split('|')[2] !== options.apiKeyRef,
      ),
    );
    const removed = before - Object.keys(cooldowns).length;
    const dropError =
      record.lastFallbackError !== undefined &&
      (options.apiKeyRef === undefined ||
        record.lastFallbackError.link.split('|')[2] === options.apiKeyRef);
    if (removed === 0 && !dropError) continue;
    cleared += removed;
    const { lastFallbackError, ...rest } = record;
    writeLaneChainState(home, lane, {
      ...rest,
      cooldowns,
      ...(dropError || lastFallbackError === undefined ? {} : { lastFallbackError }),
    });
  }
  return cleared;
}
