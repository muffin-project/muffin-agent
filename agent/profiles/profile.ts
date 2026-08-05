import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Per-model profiles.
 *
 * The harness is built for the weakest model we intend to support, not for the
 * strongest one available — otherwise every capability quietly assumes a
 * frontier model and the local option becomes a label. What a weaker model
 * needs (fewer tools in front of it, a shorter horizon, retries, stricter
 * output) lives here as data, never as `if (model === ...)` in the loop.
 *
 * That is what makes it scaffolding you can remove: when a model stops needing
 * the crutches, you delete a profile, not a code path. See docs/adr/0022 and
 * the durable-vs-scaffolding split in the blueprint.
 */

export type RecoveryStrategy =
  /** Re-ask for a continuation when the model returned nothing usable. */
  | 'nudge'
  /** Re-list the valid tools after a call to a name that does not exist. */
  | 'reinjectTools'
  /** One more attempt, for transient provider failures. */
  | 'retryOnce'
  /** Restate the output contract when the shape came back wrong. */
  | 'strictJson';

export type Profile = {
  schemaVersion: 1;
  name: string;
  /** Glob patterns on the model id. First match wins. */
  match: string[];
  maxToolsExposed: number;
  maxToolCallsPerTurn: number;
  thinking: 'allowed' | 'off';
  recovery: RecoveryStrategy[];
  notes: string;
};

/** Applies when nothing matches. Deliberately the cautious one. */
export const CONSERVATIVE: Profile = {
  schemaVersion: 1,
  name: 'conservative',
  match: ['*'],
  maxToolsExposed: 10,
  maxToolCallsPerTurn: 15,
  thinking: 'off',
  recovery: ['nudge', 'reinjectTools', 'retryOnce', 'strictJson'],
  notes: 'Unknown model: the capability floor, with every crutch enabled.',
};

/** The hard ceiling. Not a profile setting: no profile may raise it. */
export const MAX_ITERATIONS_HARD_CAP = 40;

export function loadProfiles(dir?: string): Profile[] {
  const base = dir ?? join(dirname(fileURLToPath(import.meta.url)));
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(base, f), 'utf8')) as Profile)
    .filter((p) => p.schemaVersion === 1);
}

export function selectProfile(model: string, profiles: Profile[]): Profile {
  for (const profile of profiles) {
    if (profile.match.some((pattern) => globMatch(pattern, model))) return profile;
  }
  return CONSERVATIVE;
}

/** Enough glob for model ids: `*` stands for any run of characters. */
function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

/** The effective ceiling: the profile can lower it, never raise it. */
export function iterationCap(profile: Profile): number {
  return Math.min(profile.maxToolCallsPerTurn, MAX_ITERATIONS_HARD_CAP);
}
