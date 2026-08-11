import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { paths } from '../config/config.js';
import type { CapabilityId, RiskClass, TrustTier } from './types.js';

/**
 * The permission matrix, read from the root of trust — the first real reader of
 * `rot/policy.json`.
 *
 * The file shipped with the RoT scaffold, was hashed by `verify` from day one,
 * and called itself binding: *"Part of the Root of Trust: the agent loop cannot
 * change this at runtime."* Nothing opened it. The three values it declares
 * lived as `const`s in `decide.ts`, which meant the sentence was false in the
 * only direction that matters — the owner could not change what a group may do
 * without editing TypeScript, and a sealed file was making a promise about
 * behaviour it had no connection to. Fifth instance of the house defect
 * (blueprint 03 §4 lists the matrix as RoT item 2; egress was item 3 and got
 * its reader first).
 *
 * The load happens once, where the kernel's context is built. `decide` stays
 * pure and synchronous: a decision must be explainable from a snapshot, never
 * from whatever was on disk at the microsecond it ran (ADR-0013).
 */

/** 0..3 as a schema, so the parse and the type cannot drift (PRACTICES §4). */
const Tier = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);

const PolicyFileSchema = z.object({
  _comment: z.string().optional(),
  schemaVersion: z.literal(1),
  /**
   * Partial on purpose: a file that only wants to lower `low` says so and
   * inherits the rest. Every band it omits comes from the floor below.
   */
  defaultMaxTaint: z
    .object({ low: Tier.optional(), medium: Tier.optional(), high: Tier.optional() })
    .optional(),
  neverAtRuntime: z.array(z.string().min(1)).optional(),
  forbiddenForSystem: z.array(z.string().min(1)).optional(),
});

export type PolicyMatrix = {
  /** Ceiling by risk class, for declarations that state no `maxTaint` of their own. */
  readonly defaultMaxTaint: Readonly<Record<RiskClass, TrustTier>>;
  readonly neverAtRuntime: ReadonlySet<CapabilityId>;
  readonly forbiddenForSystem: ReadonlySet<CapabilityId>;
  /** Which of the two produced these numbers. Surfaced by `doctor`. */
  readonly source: 'sealed' | 'fallback';
  /** Why the fallback answered. `null` whenever the sealed file did. */
  readonly note: string | null;
};

/**
 * The compiled floor: the values `decide.ts` hardcoded, and the answer when the
 * sealed file cannot be used.
 *
 * **Why falling back here is fail-closed, stated exactly, because "it is the
 * strictest sensible" is a claim and not an axiom.**
 *
 * The two deny lists are *unioned* with whatever the file says, never replaced
 * (see `merge` below). So no file — corrupt, absent, or hostile — can shorten
 * them: `rot.write` stays unreachable at runtime and `outward.send` stays out
 * of reach of autonomous principals whatever `policy.json` contains. That is
 * ADR-0013's monotone confinement applied where it means something: the file
 * may add prohibitions, it may not remove them.
 *
 * `defaultMaxTaint` is not clamped, and that is deliberate rather than
 * overlooked. It is a *default* — consulted only for declarations that omit
 * `maxTaint` — and a declaration already overrides it in **both** directions on
 * purpose (`sys.http` is medium risk and declares 3; see the comment on
 * `PolicyContext.matrix`). Clamping the default while the declaration layer
 * roams free would be a guarantee only one of the two halves honours, which is
 * the shape of defect this repo keeps paying for.
 *
 * Refusing to boot instead of falling back was the other option and is worse: a
 * home installed before `policy.json` existed would be bricked by an upgrade,
 * and a bricked agent is one the owner switches off — after which nothing gets
 * investigated. `egress.json` took the same decision for the same reason
 * (`agent/runtime.ts`, the empty-allowlist path), and `decide.ts` takes it again
 * in safe mode by letting low-risk reads through.
 *
 * **The residual, named.** An owner who *tightened* a ceiling and then lost the
 * file gets the shipped ceiling back. The fallback does not cover that case —
 * the seal does: a file the manifest lists and disk no longer matches diverges,
 * which is safe mode in single-user and a refused boot in hardened, and safe
 * mode already denies everything above low risk. So the exposure is precisely
 * "low-risk capabilities, in a home that is already shouting that its root of
 * trust diverged", and `doctor` names the fallback in the same breath.
 */
export const POLICY_FLOOR: PolicyMatrix = {
  defaultMaxTaint: { low: 3, medium: 1, high: 1 },
  /** No principal may ever exercise these at runtime, whatever the taint. */
  neverAtRuntime: new Set<CapabilityId>(['rot.write']),
  /** Excluded from autonomous principals regardless of taint (blueprint 03 §3). */
  forbiddenForSystem: new Set<CapabilityId>(['outward.send', 'config.ratchet']),
  source: 'fallback',
  note: null,
};

const fallback = (note: string): PolicyMatrix => ({ ...POLICY_FLOOR, note });

export function loadPolicyMatrix(home: string): PolicyMatrix {
  const file = join(paths(home).rot, 'policy.json');
  if (!existsSync(file)) return fallback(`${file} assente`);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return fallback(`${file} non è JSON valido: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Version before schema, like the config loader: a file from a future build
  // fails validation for reasons that have nothing to do with the real problem.
  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (version !== 1) {
    return fallback(`schemaVersion ${String(version)}, questa build ne capisce 1`);
  }

  const parsed = PolicyFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fallback(`${file} non valido — ${issue?.path.join('.') ?? '(root)'}: ${issue?.message ?? 'illeggibile'}`);
  }
  return merge(parsed.data);
}

function merge(file: z.infer<typeof PolicyFileSchema>): PolicyMatrix {
  return {
    defaultMaxTaint: {
      low: file.defaultMaxTaint?.low ?? POLICY_FLOOR.defaultMaxTaint.low,
      medium: file.defaultMaxTaint?.medium ?? POLICY_FLOOR.defaultMaxTaint.medium,
      high: file.defaultMaxTaint?.high ?? POLICY_FLOOR.defaultMaxTaint.high,
    },
    // Union, never assignment. Drop the spread of the floor and an owner — or
    // anything that can write one line into a resealed file — deletes the
    // runtime's only prohibition against writing its own root of trust.
    neverAtRuntime: new Set([...POLICY_FLOOR.neverAtRuntime, ...(file.neverAtRuntime ?? [])]),
    forbiddenForSystem: new Set([
      ...POLICY_FLOOR.forbiddenForSystem,
      ...(file.forbiddenForSystem ?? []),
    ]),
    source: 'sealed',
    note: null,
  };
}
