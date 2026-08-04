import type {
  CapabilityDecl,
  CapabilityId,
  Decide,
  Decision,
  DecisionRequest,
  Principal,
  RiskClass,
  TrustTier,
} from './types.js';

/**
 * The policy kernel: one place, deterministic, in code.
 *
 * Every capability request passes through here — tools, scheduled jobs, the
 * dev capability, rendering. A capability without a declaration does not exist
 * for the runtime. See docs/adr/0013.
 */

/** Default ceiling on context taint, by risk class. A decl may narrow it, never widen it. */
const DEFAULT_MAX_TAINT: Record<RiskClass, TrustTier> = {
  low: 3,
  medium: 1,
  high: 1,
};

/** Capabilities no principal may ever exercise at runtime, whatever the taint. */
const NEVER_AT_RUNTIME: ReadonlySet<CapabilityId> = new Set(['rot.write']);

/** Capabilities excluded from autonomous principals regardless of taint (blueprint 03 §3). */
const FORBIDDEN_FOR_SYSTEM: ReadonlySet<CapabilityId> = new Set([
  'outward.send',
  'config.ratchet',
]);

export type PolicyContext = {
  capabilities: ReadonlyMap<CapabilityId, CapabilityDecl>;
  /** Budget check, injected so the kernel stays pure and synchronous. */
  budgetExhausted: () => boolean;
  /**
   * In single-user mode the Root of Trust is detection, not prevention, so
   * shell can never be a silent allow. See docs/adr/0003 (revision).
   */
  hardened: boolean;
};

function isOwnerPrincipal(p: Principal): boolean {
  return p.kind === 'owner';
}

function tenantOf(p: Principal): string | null {
  if (p.kind === 'member') return p.tenantId;
  if (p.kind === 'owner' || p.kind === 'agent') return 'host';
  return null; // system principals act within the tenant they were armed for
}

function ask(prompt: string): Decision {
  return { effect: 'ask', ask: { audience: 'owner', prompt } };
}

export function createDecide(ctx: PolicyContext): Decide {
  return function decide(req: DecisionRequest): Decision {
    const { principal, tenant, capability, resource, taint } = req;

    const decl = ctx.capabilities.get(capability);
    if (!decl) {
      return { effect: 'deny', code: 'no_capability', detail: `undeclared capability: ${capability}` };
    }

    if (NEVER_AT_RUNTIME.has(capability)) {
      return {
        effect: 'deny',
        code: 'rot_violation',
        detail: 'the root of trust has no runtime write path; change it via repo and restart',
      };
    }

    // Guard against a caller assembling an incoherent request.
    const expected = tenantOf(principal);
    if (expected !== null && expected !== tenant) {
      return { effect: 'deny', code: 'tenant_mismatch', detail: `${expected} != ${tenant}` };
    }

    if (decl.hostOnly && !isOwnerPrincipal(principal) && principal.kind !== 'agent') {
      return { effect: 'deny', code: 'principal_forbidden', detail: 'host-only capability' };
    }

    if (principal.kind === 'system' && FORBIDDEN_FOR_SYSTEM.has(capability)) {
      return { effect: 'deny', code: 'principal_forbidden', detail: 'not available to autonomous principals' };
    }

    const ceiling = decl.maxTaint ?? DEFAULT_MAX_TAINT[decl.risk];
    if (taint > ceiling) {
      return {
        effect: 'deny',
        code: 'taint_exceeded',
        detail: `context taint ${taint} exceeds ${ceiling} for ${capability}`,
      };
    }

    if (decl.risk !== 'low' && ctx.budgetExhausted()) {
      return { effect: 'deny', code: 'budget_exhausted' };
    }

    // Autonomous principals never auto-approve what a human would be asked for:
    // the job queues and waits instead. Fail-safe is the mandated direction.
    if (principal.kind === 'system' || principal.kind === 'agent') {
      if (decl.risk === 'high') return ask(`queued: ${capability} requested by ${principal.kind}`);
    }

    switch (decl.risk) {
      case 'low':
        return { effect: 'allow' };
      case 'medium':
        return decl.reversible === 'undoable'
          ? { effect: 'draft', undo: { capability, windowSeconds: 300 } }
          : { effect: 'allow' };
      case 'high':
        // Without OS-level prevention of RoT tampering, a high-risk capability
        // is never a silent allow — see docs/adr/0003 (revision).
        return ctx.hardened && isOwnerPrincipal(principal) && taint === 0
          ? { effect: 'allow' }
          : ask(`${capability} on ${describe(resource)}`);
    }
  };
}

function describe(resource: DecisionRequest['resource']): string {
  return resource.kind === 'none' ? '(no resource)' : `${resource.kind}:${resource.value}`;
}
