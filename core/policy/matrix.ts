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
  /** See `PolicyMatrix.paramsMaxTaint` below for what this gates. */
  paramsMaxTaint: Tier.optional(),
  neverAtRuntime: z.array(z.string().min(1)).optional(),
  forbiddenForSystem: z.array(z.string().min(1)).optional(),
});

export type PolicyMatrix = {
  /** Ceiling by risk class, for declarations that state no `maxTaint` of their own. */
  readonly defaultMaxTaint: Readonly<Record<RiskClass, TrustTier>>;
  /**
   * Ceiling for model-chosen bytes riding out in a resource the model
   * controls: a `url` resource's query/fragment once its host has already
   * cleared the egress allowlist, and the full text of a `query` resource
   * (`sys.search`). One scalar for both, because `decide.ts`'s `gateParams`
   * asks the identical question of each — is this turn's taint low enough
   * that a destination already fixed (by the allowlist, or by the search
   * endpoint's own registration) may also carry bytes the model chose? Above
   * the ceiling: `ask` for the owner, showing the exact bytes
   * (`ApprovalRequest.resource`, `agent/loop.ts`); `deny` for anyone else,
   * always — never a silent allow, the shape `sys.shell` already uses above
   * its own ceiling (ADR-0044 §revisione).
   *
   * Unlike `defaultMaxTaint`, the sealed file may RAISE this, not only lower
   * it (`merge()` reads it directly, no `tighter()` clamp). Deliberate, not
   * an oversight of the tighten-only rule one field up: `defaultMaxTaint` is
   * inherited by every capability that pins no `maxTaint` of its own, so one
   * widened number in a resealed file silently loosens capabilities nobody
   * reviewed for it (the `mcp.*` measurement in this file's docstring).
   * `paramsMaxTaint` has exactly two callers, both named above, and raising
   * it never grants anyone but the owner anything — it only moves the taint
   * value at which the owner starts being asked.
   *
   * **Ships 2** (decisione owner, 2026-08-17): tier 2 is the owner's own disk
   * and local data, and asking about every search that follows a file read
   * would make the ASK a reflex to dismiss rather than a decision — the
   * failure mode the mandate's §D12 names. Tier 3 is the outside world (web,
   * search results, MCP, forwarded content), and that is the taint at which
   * model-chosen bytes in a query stop being the owner's own words. Whichever
   * the value, a non-owner principal is refused, never asked.
   */
  readonly paramsMaxTaint: TrustTier;
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
 * `defaultMaxTaint` **is** clamped downward — the file lowers, never raises.
 * The first version of this file argued the opposite (a declaration overrides
 * the default in both directions anyway, so why constrain the file), and a
 * judge measured what that bought: `{"medium":3}` in a resealed policy.json
 * turned `mcp.*` from "a tainted turn cannot reach a third-party server at
 * all" into a silent `allow`, because that capability — like `fs.write` and
 * `sys.shell` — inherits the class default rather than pinning its own. The
 * declaration layer and the file are not the same trust domain: one is a
 * reviewed commit, the other is a write plus a reseal. So the file is a
 * tightening knob only, exactly like the deny lists below.
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
  paramsMaxTaint: 2,
  /** No principal may ever exercise these at runtime, whatever the taint. */
  neverAtRuntime: new Set<CapabilityId>(['rot.write', 'rot.*']),
  /** Excluded from autonomous principals regardless of taint (blueprint 03 §3). */
  forbiddenForSystem: new Set<CapabilityId>(['outward.send', 'outward.*', 'config.ratchet']),
  source: 'fallback',
  note: null,
};

/**
 * Does a deny list cover this capability? Exact id, or a namespace entry.
 *
 * Both lists are quotations from the threat model, and one of them was
 * mis-transcribed in the direction that matters. 03 §3 says *"le capability
 * `outward.*` … sono escluse del tutto da `system@scheduler` a qualunque
 * taint"* — the star is in the guarantee. The lists held bare ids and the
 * lookup was `Set.has`, so the sentence was true of exactly the one id someone
 * had thought to write down. Nothing was wrong today only because
 * `outward.send` does not exist yet: the deny was guarding an unbuilt
 * capability, and the first sibling to ship under that prefix
 * (`outward.publish`, `outward.email.send`) would have arrived as an `ask` the
 * owner can approve — for a class of action the threat model says an
 * autonomous principal must never reach at all.
 *
 * A namespace entry is `prefix.*`, matched on dotted segments and never on raw
 * string prefix: `outward.*` covers `outward.email.send` and does not cover a
 * capability that merely begins with the same letters. `rot.*` is here for the
 * same reason, one row up in the same table — *"Root of Trust | DENY a runtime
 * per chiunque"* — where `rot.write` alone would let a `rot.reseal` through.
 */
export function denyListCovers(list: ReadonlySet<CapabilityId>, capability: CapabilityId): boolean {
  if (list.has(capability)) return true;
  const parts = capability.split('.');
  for (let i = 1; i < parts.length; i += 1) {
    if (list.has(`${parts.slice(0, i).join('.')}.*`)) return true;
  }
  return false;
}

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

/** The stricter of the two, always — the file's only direction is down. */
function tighter(fromFile: TrustTier | undefined, floor: TrustTier): TrustTier {
  return fromFile !== undefined && fromFile < floor ? fromFile : floor;
}

function merge(file: z.infer<typeof PolicyFileSchema>): PolicyMatrix {
  return {
    // Clamped DOWNWARD, symmetric with the union below: the file may lower a
    // ceiling, never raise one. The first version left it unclamped, reasoning
    // that declarations already override in both directions — true, and a
    // different trust domain: a declaration change is a repo commit under
    // review, a policy.json change is a file write plus `muffin rot reseal`.
    // Measured on a real home before this line existed: `{"defaultMaxTaint":
    // {"medium":3}}` took `mcp.*` from "a tainted turn cannot reach a
    // third-party server at all" to a silent allow at taint 3, because
    // `mcpCapabilityFor`, `fs.write` and `sys.shell` all inherit the class
    // default instead of pinning one. Widening belongs in the declaration
    // layer, where it is reviewed; ADR-0013's monotone confinement is the rule
    // this restores.
    defaultMaxTaint: {
      low: tighter(file.defaultMaxTaint?.low, POLICY_FLOOR.defaultMaxTaint.low),
      medium: tighter(file.defaultMaxTaint?.medium, POLICY_FLOOR.defaultMaxTaint.medium),
      high: tighter(file.defaultMaxTaint?.high, POLICY_FLOOR.defaultMaxTaint.high),
    },
    // NOT `tighter()` — see the field's own doc comment on `PolicyMatrix` for
    // why this one threshold may move in both directions from the file.
    paramsMaxTaint: file.paramsMaxTaint ?? POLICY_FLOOR.paramsMaxTaint,
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
