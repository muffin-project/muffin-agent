import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { z } from 'zod';
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

/**
 * The vocabulary of the cascade. What each step *does* is in `./recovery.ts`,
 * beside this file and inside the same removable boundary.
 *
 * The list is **executed as declared, in order**: attempt N runs strategy N.
 * It used to be a length — `recoveriesLeft` counted down from `recovery.length`
 * while the loop consulted only `includes('nudge')`, so `consumer-local`'s four
 * declared steps ran as four identical nudges and the other three names bought
 * attempts they never spent.
 */
export type RecoveryStrategy =
  /** Empty or narrated turn: an open corrective, the gentlest rung. */
  | 'nudge'
  /** Lost track of the menu: the tool names restated inline, at the tail. */
  | 'reinjectTools'
  /** Transient garbage from the model: ask again, adding nothing. */
  | 'retryOnce'
  /** Prose where a call was needed: a two-option contract, no third shape. */
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

/**
 * Parsed, not cast (PRACTICES §4) — and the history is why. `recovery` used to
 * be inert data: a typo added 1 to a counter and nothing else. Once the cascade
 * executed as declared, an unknown name became a TypeError thrown at the one
 * moment a turn was already failing — a latent bomb armed precisely when the
 * recovery it names was needed. Profiles are a documented extension point, so
 * the boundary has to refuse what the switch cannot honor, out loud.
 */
const ProfileSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  match: z.array(z.string().min(1)).min(1),
  maxToolsExposed: z.number().int().positive(),
  maxToolCallsPerTurn: z.number().int().positive(),
  thinking: z.enum(['off', 'allowed']),
  recovery: z.array(z.enum(['nudge', 'reinjectTools', 'retryOnce', 'strictJson'])),
  notes: z.string().default(''),
});

export function loadProfiles(dir?: string, onProblem?: (line: string) => void): Profile[] {
  const base = dir ?? join(dirname(fileURLToPath(import.meta.url)));
  if (!existsSync(base)) return [];
  const out: Profile[] = [];
  for (const f of readdirSync(base).filter((n) => n.endsWith('.json')).sort()) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(base, f), 'utf8'));
    } catch (error) {
      onProblem?.(`profilo ${f} illeggibile: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const parsed = ProfileSchema.safeParse(raw);
    if (!parsed.success) {
      // Dropped and said, never half-loaded: a profile with one bad strategy
      // name would otherwise select normally and detonate mid-recovery.
      onProblem?.(`profilo ${f} scartato: ${parsed.error.issues[0]?.message ?? 'schema non valido'}`);
      continue;
    }
    out.push(parsed.data);
  }
  return out;
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
