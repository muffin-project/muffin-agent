/**
 * Policy kernel contracts.
 *
 * This file is part of the Root of Trust (code tier): nothing at runtime writes
 * here, and changing it requires a build and a restart. See docs/adr/0003, 0013.
 *
 * Normative source: docs/blueprint/09-contratti-m0-m1.md §1 in the blueprint repo.
 */

/** Who is acting. Never inferred from message content — resolved before the loop. */
export type Principal =
  /**
   * `externalId` is not optional, deliberately. It used to be absent, and the
   * Telegram connector filled the gap by comparing the *chat* id — the room —
   * so anyone speaking in a chat that carried the owner's id arrived as the
   * owner. A type that permits an anonymous owner is a type that invites the
   * check to be made out of whatever is nearby. On the CLI the value is
   * `'local'`: authentication there is having a shell on the machine, and
   * saying so is better than leaving the field off.
   */
  | { kind: 'owner'; connector: ConnectorId; externalId: string }
  | { kind: 'member'; connector: ConnectorId; tenantId: TenantId; externalId: string }
  | { kind: 'system'; source: 'scheduler' | 'consolidation' | 'ratchet' }
  | { kind: 'agent'; role: 'dev' };

/** 'host' | `group:${connector}:${externalId}` | `community:${slug}` */
export type TenantId = string;
export type ConnectorId = string;

/**
 * Provenance tier of a piece of evidence, and — as the max over everything
 * currently in context — the taint of a turn. One scale for both data and
 * policy, deliberately (see blueprint 10-risoluzioni §2, rejected C2-#5).
 */
export type TrustTier = 0 | 1 | 2 | 3;

/** Dotted, stable, versioned with the repo. e.g. 'fs.write', 'sys.shell'. */
export type CapabilityId = string;

export type Resource =
  | { kind: 'path'; value: string } // absolute, normalized, symlinks resolved
  | { kind: 'url'; value: string }
  | { kind: 'tenant'; value: TenantId }
  | { kind: 'none' };

export type DenyCode =
  | 'no_capability'
  | 'taint_exceeded'
  | 'tenant_mismatch'
  | 'budget_exhausted'
  | 'rot_violation'
  | 'safe_mode'
  | 'resource_denied'
  | 'principal_forbidden';

export type Decision =
  | { effect: 'allow' }
  | { effect: 'ask'; ask: { audience: 'owner'; prompt: string } }
  | { effect: 'draft'; undo: { capability: CapabilityId; windowSeconds: number } }
  | { effect: 'deny'; code: DenyCode; detail?: string };

export type DecisionRequest = {
  principal: Principal;
  tenant: TenantId;
  capability: CapabilityId;
  resource: Resource;
  /** Already validated against the tool's input schema — never raw model output. */
  args: Readonly<Record<string, unknown>>;
  /** Recomputed at every call, never frozen for the turn (blueprint 03 §2). */
  taint: TrustTier;
};

export type RiskClass = 'low' | 'medium' | 'high';
export type Reversibility = 'yes' | 'undoable' | 'no';

/**
 * A tool without one of these does not exist for the runtime.
 * Lives next to the tool in its feature folder; core/policy only owns the type.
 */
export type CapabilityDecl = {
  readonly id: CapabilityId;
  readonly risk: RiskClass;
  readonly reversible: Reversibility;
  /**
   * May this call be made a second time when nobody can say whether the first
   * one landed?
   *
   * **Not the same question as `reversible`, and the two axes are independent.**
   * `fs.write` is `undoable` and re-running it is harmless — writing the same
   * bytes twice gives the same file. Sending a message is neither reversible
   * nor re-runnable — it gives two messages. A design that reused `reversible`
   * to decide would refuse a resume that was safe, and would have nothing at
   * all to say about an `outward.send` someone later declared `undoable`.
   *
   * Required, not optional, and that is the point: a tool arriving without an
   * answer breaks the build instead of inheriting a default that is wrong half
   * the time. Adding this after five MCP servers are attached means auditing
   * every one of them — the design (`research/turno-sospendibile.md` §Domanda 6)
   * rates it among the two most expensive things to get wrong here.
   *
   * The consumer is a resume: a call with an intent row and no outcome row is
   * re-executed only when this says so. Nothing resumes yet — the declaration
   * is made now because it is the half that cannot be added cheaply later.
   */
  readonly rerunnable: boolean;
  /** Omitted when it equals the default for the risk class. */
  readonly maxTaint?: TrustTier;
  readonly resourceKind: Resource['kind'];
  /** Which fields of args the kernel is allowed to inspect. */
  readonly policyArgs: readonly string[];
  /** Never reachable from a remote tenant, by construction. */
  readonly hostOnly: boolean;
  readonly timeoutMs?: number;
};

/**
 * Synchronous and pure: no I/O, no network, no await. Reads only the policy
 * already loaded at boot, so a decision is always explainable from a snapshot.
 */
export type Decide = (req: DecisionRequest) => Decision;

/**
 * Per-turn permission view. principal/tenant are fixed for the turn; taint is
 * not — a tier-3 tool result raises it for every decision that follows.
 */
export interface PermissionSnapshot {
  readonly principal: Principal;
  readonly tenant: TenantId;
  currentTaint(): TrustTier;
  raiseTaint(tier: TrustTier): void;
  /**
   * Throws away memoised decisions. The taint does this for itself; the budget
   * is the other input the kernel reads and it can change mid-turn, in which
   * case a cached `allow` from before the cap was reached would outlive the
   * condition that produced it.
   */
  invalidate(): void;
  check(capability: CapabilityId, resource: Resource, args: Readonly<Record<string, unknown>>): Decision;
}
