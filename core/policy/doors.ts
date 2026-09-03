import type { CapabilityDecl } from './types.js';

/**
 * The two doors the runtime walks through on its own, without a tool.
 *
 * Until ADR-0055 neither existed for the kernel. The reply left through
 * `SurfaceRegistry.deliver` with no decision taken, and the episode was written
 * straight from `agent/loop.ts` and merely *stamped* with `intrinsicTaint()`.
 * The threat model's matrix had a row for each — "Reply sul canale di origine:
 * ALLOW · ALLOW · ALLOW", "Scrittura memoria: ALLOW · ALLOW nel tenant · ALLOW"
 * — and the kernel executed the rows for every capability but the two the
 * matrix was written for. The 2026-09-02 memo measured the consequence: at
 * taint 2 the model could not attach a file it had read but could copy its
 * content into the text, and the eval seam could not even name the difference
 * (`docs/evidence/decision-memo-taint-2026-09-02.md` §1.3, §7.3).
 *
 * Declaring them changes what is **observable and tunable**, not what is
 * permitted: both rows allow at every taint in the shipped floor, and the
 * kernel's answer is `allow` wherever it was silence before. What the owner
 * gains is a sealed `rot/policy.json` that can tighten either row
 * (`matrix.ts`, `tighterRows`) and a `muffin.policy_decision` span on every
 * reply and every episode. What the eval seam gains is two real declarations
 * to put sink scenes on.
 *
 * `risk: 'low'` on both, deliberately: the risk switch in `decide.ts` turns
 * `medium` + `undoable` into a `draft` and `high` into an `ask`, and neither
 * verdict has a meaning for "may this turn answer" — a draft of a reply is a
 * reply, and an approval prompt that is itself a reply cannot gate replies.
 * The only knob that means something on these rows is the row's own
 * `denyAbove`, and `low` is the class that reaches it without inventing a
 * verdict on the way.
 */
export const replyCapability: CapabilityDecl = {
  id: 'surface.reply',
  effect: 'reply',
  risk: 'low',
  // Bytes on the wire cannot be recalled, and a second delivery is a second
  // message — the same two answers `surface.send_file` gives, one row up in
  // the same matrix.
  reversible: 'no',
  rerunnable: false,
  resourceKind: 'none',
  policyArgs: [],
  // A group's own turn replies into that group: the row says ALLOW for every
  // principal, and host-only would deny a member the one effect the matrix
  // grants them unconditionally.
  hostOnly: false,
};

export const memoryWriteCapability: CapabilityDecl = {
  id: 'memory.write',
  effect: 'memory',
  risk: 'low',
  // An episode row can be deleted, and consolidation rewrites what it derives
  // from — but nothing today journals the write or offers `undo` for it, and
  // declaring `undoable` would be the kernel promising a checkpoint the loop
  // does not take (the exact shape ADR-0022's `draft` path refuses).
  reversible: 'no',
  // Writing the same episode twice is two rows, and recall would find both.
  rerunnable: false,
  // Scoped like `memory.read`: the tenant of the turn, never one the caller
  // names.
  resourceKind: 'tenant',
  policyArgs: [],
  hostOnly: false,
};

/**
 * Both, for the kernel that owns them (`decide.ts` consults this as the
 * fallback under whatever a caller declared) and the tests that assert their
 * rows. No runtime registers them, deliberately: a runtime that had to
 * remember would answer `no_capability` on every reply the day it forgot.
 */
export const DOORS: readonly CapabilityDecl[] = [replyCapability, memoryWriteCapability];
