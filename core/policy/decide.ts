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

/**
 * Default ceiling on context taint, by risk class, used when a declaration does
 * not state one.
 *
 * A declaration's own `maxTaint` is authoritative in **both** directions — it
 * may narrow the default and it may widen it. This comment used to claim the
 * opposite ("may narrow it, never widen it"), which was never true of the code
 * below and was already contradicted by a shipped declaration: `sys.http` is
 * medium risk, whose default ceiling is 1, and deliberately declares 3.
 *
 * That declaration is the correct one, which is why the comment moved rather
 * than the code. The threat model's taint-2/3 row reads "solo read-only su
 * allowlist pubblica": having read a web page, the agent may read another one.
 * What the ceiling exists to stop is a tainted context reaching a capability
 * that *acts* — and those declare a low ceiling explicitly (`sys.process` and
 * the skill reader both pin 1).
 *
 * Widening is therefore a deliberate, reviewable act per capability, not an
 * accident the type system prevents. Keep it that way: a declaration that
 * widens without a comment saying why is the thing to catch in review.
 */
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
  /**
   * The root of trust diverged and we are running degraded. Everything above
   * low risk is refused until the owner reseals — which is what the CLI has
   * always told the user, and until now was the only claim in this system that
   * the code did not back.
   */
  safeMode?: boolean;
  /**
   * The egress allowlist from `rot/egress.json`, as a predicate. Optional in
   * the type so tests can build a minimal context — but ABSENT means nothing
   * is allowed, not everything: a runtime that forgets to wire it gets a
   * kernel that asks for every URL, which is the failure mode you notice.
   */
  egressAllowed?: (host: string) => boolean;
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

    // Before anything else that could allow: a diverged root of trust means the
    // rules themselves are in question, so this is not the moment to apply them
    // generously.
    if (ctx.safeMode === true && decl.risk !== 'low') {
      return {
        effect: 'deny',
        code: 'safe_mode',
        detail: `root of trust diverged: "${capability}" is ${decl.risk} risk — \`muffin rot verify\``,
      };
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

    // host-only excludes *remote tenants*, not autonomous local principals: the
    // scheduler runs on the host. Denying it here would have hidden the queueing
    // rule below behind a wrong refusal.
    if (decl.hostOnly && principal.kind === 'member') {
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

    // Egress: a URL-holding capability answers to the allowlist in the root of
    // trust (03 §3, riga egress). On the list → the declared risk class speaks.
    // Off the list → the owner in a clean context gets asked, everyone and
    // everything else is refused: a tainted turn must not be able to *nominate*
    // the exfiltration endpoint, which is exactly what ask-then-approve would
    // let a poisoned context do at 2am.
    if (decl.resourceKind === 'url') {
      // Fail closed when the caller did not hand us the URL it declared.
      //
      // This branch used to be `resourceKind === 'url' && resource.kind ===
      // 'url'`, so a caller that produced anything else skipped the allowlist
      // entirely and fell through to the risk class — which for a medium,
      // reversible capability is `allow`. That is not hypothetical: the loop
      // derived the resource from argument *names*, checking `path` before
      // `url`, so `http_get({url, path:'x'})` produced a path resource and
      // fetched an off-allowlist host for a taint-2 group member. Measured:
      // deny without the extra key, allow with it.
      //
      // A gate whose precondition is supplied by its caller is not a gate. Now
      // a caller that forgets produces a refusal, loudly, instead of an
      // unguarded allow — and the next URL-holding capability (`outward.send`,
      // declared with `policyArgs: ['to']`) cannot ship with a silent no-op.
      if (resource.kind !== 'url') {
        return {
          effect: 'deny',
          code: 'resource_denied',
          detail: `${capability} declares a url resource but received ${resource.kind} — refusing rather than skipping the allowlist`,
        };
      }
      const host = hostOf(resource.value);
      if (host === null) {
        return { effect: 'deny', code: 'resource_denied', detail: `unparseable url` };
      }
      const allowed = ctx.egressAllowed?.(host) ?? false;
      if (!allowed) {
        if (isOwnerPrincipal(principal) && taint <= 1) {
          return ask(`egress fuori allowlist: ${host}`);
        }
        return {
          effect: 'deny',
          code: 'resource_denied',
          detail: `${host} is not in the egress allowlist (taint ${taint})`,
        };
      }
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

/** Pure: URL parsing only, no I/O. `null` for anything that is not http(s). */
function hostOf(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname;
  } catch {
    return null;
  }
}
