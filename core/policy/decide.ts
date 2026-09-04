import { denyListCovers, type PolicyMatrix } from './matrix.js';
import { DOORS } from './doors.js';
import type {
  CapabilityDecl,
  CapabilityId,
  Decide,
  Decision,
  DecisionRequest,
  Principal,
  TrustTier,
} from './types.js';

/**
 * The policy kernel: one place, deterministic, in code.
 *
 * Every capability request passes through here — tools, scheduled jobs, the
 * dev capability, rendering. A capability without a declaration does not exist
 * for the runtime. See docs/decisions/0013-kernel-permessi-unificato.md.
 */

export type PolicyContext = {
  capabilities: ReadonlyMap<CapabilityId, CapabilityDecl>;
  /**
   * The permission matrix, loaded from `rot/policy.json` where this context is
   * built (`agent/runtime.ts`) — never from here, so a decision stays pure and
   * synchronous and is explainable from a snapshot.
   *
   * Required, not optional with a default. Every one of these numbers used to
   * be a `const` in this file, and a matrix that quietly reappears when the
   * wiring is forgotten is how the file it comes from went unread for months.
   * Tests pass `POLICY_FLOOR`, which is those same constants under their own
   * name; production that forgets does not compile.
   *
   * On the ceiling: it comes from `matrix.rows[decl.effect]`, and a
   * declaration's own `maxTaint` may only narrow it (ADR-0053). The paragraph
   * that stood here until 2026-09-02 described the opposite arrangement — a
   * class default a declaration could widen in both directions — and that
   * arrangement is exactly what let the kernel and the threat model's printed
   * matrix disagree, one capability at a time, for a month. `defaultMaxTaint`
   * is still on `PolicyMatrix` and is read by nothing here.
   */
  matrix: PolicyMatrix;
  /**
   * Budget check, injected so the kernel stays pure and synchronous.
   *
   * It takes the tenant because there are two caps and the kernel has to be
   * able to ask about both. The nullary version could only ever ask the global
   * one, which meant a group tenant's daily ceiling was unreachable from here —
   * not unwired, *unaskable*, which is the version of this defect that survives
   * someone noticing it.
   */
  budgetExhausted: (tenant: string) => boolean;
  /**
   * In single-user mode the Root of Trust is detection, not prevention, so
   * shell can never be a silent allow. See docs/decisions/0003-root-of-trust.md (revision).
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
   *
   * Consulted only for a `url` resource — reaching a host to **act**. A
   * `url-read` resource (`sys.http`, GET-only) never calls this: ADR-0065
   * decided that fetching a public page is not the same authority as acting
   * on one, and left it open. This predicate's absence is still fail-closed
   * for the capability it does govern.
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
  /**
   * The kernel's own vocabulary, consulted **under** whatever the runtime
   * declared — a fallback, never a merge.
   *
   * The two doors (`doors.ts`) are not tools a feature registers: they are the
   * acts the loop performs by itself — answering, remembering — and the kernel
   * has to be able to rule on them wherever it is built, a test harness with
   * three declarations included. A runtime that had to remember to register
   * them would answer `no_capability` on every reply the day it forgot; a
   * kernel that owns them cannot forget. A caller's own declaration under the
   * same id still wins, so a harness can tighten a door on purpose.
   *
   * **`ctx.capabilities` is read live, on every request, and copying it is a
   * defect.** `agent/runtime.ts` hands the same `Map` to `createDecide` and to
   * `Runtime.register`, which mutates it: every MCP tool, and every tool a
   * test registers after boot, is declared *after* this function ran. A
   * snapshot taken here makes the kernel answer `no_capability` to all of
   * them — which is what the first draft of this door did, and what
   * `agent/todo-wiring.test.ts` and `agent/crash-resume.test.ts` caught.
   */
  const doors = new Map<CapabilityId, CapabilityDecl>(DOORS.map((d) => [d.id, d]));
  return function decide(req: DecisionRequest): Decision {
    const { principal, tenant, capability, resource, taint } = req;

    const decl = ctx.capabilities.get(capability) ?? doors.get(capability);
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

    if (denyListCovers(ctx.matrix.neverAtRuntime, capability)) {
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

    if (principal.kind === 'system' && denyListCovers(ctx.matrix.forbiddenForSystem, capability)) {
      return { effect: 'deny', code: 'principal_forbidden', detail: 'not available to autonomous principals' };
    }

    // The ceiling comes from the capability's **effect row** — where the bytes
    // land — and not from its risk class. ADR-0053: the risk class default was
    // a per-capability knob, and widening it one capability at a time is how
    // the kernel and the threat model's printed matrix stopped agreeing on the
    // row that reads `ASK` at taint 2. A declaration may still tighten its own
    // row and never widen it; `core/policy/effect-rows.test.ts` asserts every
    // shipped cell against the document.
    const row = ctx.matrix.rows[decl.effect];
    const ceiling = Math.min(row.denyAbove, decl.maxTaint ?? 3);
    if (taint > ceiling) {
      return {
        effect: 'deny',
        code: 'taint_exceeded',
        detail: `context taint ${taint} exceeds ${ceiling} for ${capability} (${decl.effect})`,
      };
    }

    if (decl.risk !== 'low' && ctx.budgetExhausted(tenant)) {
      return { effect: 'deny', code: 'budget_exhausted' };
    }

    // Egress. ADR-0065 splits what used to be one branch into two authorities
    // over the same shape of resource: `url` is reaching a host to **act** —
    // write, execute, send — and answers to the allowlist in the root of trust
    // (03 §3, riga egress) exactly as before. `url-read` is fetching bytes from
    // a public page — `sys.http` is GET-only by construction — and reading is
    // not the same authority as acting: the owner decided the allowlist should
    // not gate it at all. Both still answer to `paramsMaxTaint` below, because
    // the bytes the model puts in a query string are exactly as chosen either
    // way, and both still fail closed on a resource mismatch, for the same
    // reason the single branch used to: a caller that produced anything else
    // used to skip the gate entirely and fall through to the risk class —
    // measured as `http_get({url, path:'x'})` fetching an off-allowlist host
    // for a taint-2 group member, deny without the extra key, allow with it.
    if (decl.resourceKind === 'url' || decl.resourceKind === 'url-read') {
      if (resource.kind !== decl.resourceKind) {
        return {
          effect: 'deny',
          code: 'resource_denied',
          detail: `${capability} declares a ${decl.resourceKind} resource but received ${resource.kind} — refusing rather than skipping the gate`,
        };
      }
      const host = hostOf(resource.value);
      if (host === null) {
        return { effect: 'deny', code: 'resource_denied', detail: `unparseable url` };
      }
      // The allowlist speaks only for `url` — reaching a host to act on it.
      // Off the list, the owner in a clean context gets asked, everyone and
      // everything else is refused: a tainted turn must not be able to
      // *nominate* the exfiltration endpoint, which is exactly what
      // ask-then-approve would let a poisoned context do at 2am. `url-read`
      // never reaches this: there is no list to be off of, by decision — the
      // SSRF floor under it (`core/net/egress.ts#isForbiddenAddress`, DNS-
      // resolved, enforced by the tool on every hop) is what stands between an
      // open read and the machine's own network.
      if (decl.resourceKind === 'url') {
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
      // The allowlist (or, for `url-read`, the open destination) only ever
      // says something about the HOST, so a turn that had read tier-2+
      // content could still put those bytes in the query string or fragment
      // and nothing here noticed (audit 2026-08-16, P04-1). A clean
      // destination is not the same claim as a clean request: the model chose
      // everything after it.
      if (hasParams(resource.value)) {
        const gated = gateParams(
          principal,
          taint,
          ctx.matrix.paramsMaxTaint,
          decl.resourceKind === 'url-read'
            ? `lettura con parametri scelti dal contenuto: ${resource.value}`
            : `egress con parametri verso host allowlisted: ${resource.value}`,
        );
        if (gated) return gated;
      }
    }

    // `sys.search`'s destination is a constant checked once at registration —
    // there is no host here for the allowlist above to hold against — but the
    // query text is exactly as model-controlled as a URL's query string, and
    // until now it never reached this file at all: `resourceKind: 'none'`
    // meant the egress branch above never even ran (audit 2026-08-16, P04-2).
    // Same threshold as the url branch's params check, because it is the same
    // question: did this turn's taint just choose these bytes?
    if (decl.resourceKind === 'query') {
      if (resource.kind !== 'query') {
        return {
          effect: 'deny',
          code: 'resource_denied',
          detail: `${capability} declares a query resource but received ${resource.kind} — refusing rather than skipping the check`,
        };
      }
      const gated = gateParams(principal, taint, ctx.matrix.paramsMaxTaint, `ricerca: "${resource.value}"`);
      if (gated) return gated;
    }

    // Autonomous principals never auto-approve what a human would be asked for:
    // the job queues and waits instead. Fail-safe is the mandated direction.
    if (principal.kind === 'system' || principal.kind === 'agent') {
      if (decl.risk === 'high') return ask(`queued: ${capability} requested by ${principal.kind}`);
    }

    const byRisk = ((): Decision => {
      switch (decl.risk) {
        case 'low':
          return { effect: 'allow' };
        case 'medium':
          return decl.reversible === 'undoable'
            ? { effect: 'draft', undo: { capability, windowSeconds: 300 } }
            : { effect: 'allow' };
        case 'high': {
          // Without OS-level prevention of RoT tampering, a high-risk capability
          // is never a silent allow — see docs/decisions/0003-root-of-trust.md (revision).
          if (ctx.hardened && isOwnerPrincipal(principal) && taint === 0) return { effect: 'allow' };
          // The owner reads this prompt with nothing else on screen: naming
          // *why* it always asks is cheaper here than in a doc he is not
          // reading mid-approval. Gated strictly on `!ctx.hardened` — a
          // hardened install still asking here is asking for a different
          // reason (a non-owner principal, or taint above 0), and must not
          // borrow this one.
          const because = ctx.hardened ? '' : ' — chiede sempre finché il blocco non è reale (`muffin rot harden`)';
          return ask(`${describe(capability, resource)}${because}`);
        }
      }
    })();

    // The row's second threshold, and the half a ceiling alone cannot express.
    // The matrix says `ASK` at taint 2 for the host row: not "reachable", but
    // "reachable **and never unattended**". Without this a `draft` — which
    // executes, journalled but unasked — would satisfy the ceiling and
    // contradict the cell. It only ever tightens: an `ask` stays an `ask`, a
    // `deny` was already returned above.
    if (taint > row.askAbove && byRisk.effect !== 'ask') {
      return ask(describe(capability, resource));
    }
    return byRisk;
  };
}

/**
 * The sentence the owner reads before deciding.
 *
 * A capability with `resourceKind: 'none'` used to render as `sys.shell on
 * (no resource)` — a placeholder that is true here (the kernel genuinely has
 * no resource for it) and useless there (a person is being asked to approve
 * something). Worse, once `agent/loop.ts` learned to derive the concrete
 * action from the call's own arguments (D12-min), the two lines contradicted
 * each other on screen:
 *
 *     ⚠ sys.shell on (no resource)
 *        su: command: ls -1 *.md
 *
 * So the kernel now says only what it knows. It names the capability, and it
 * names the resource when it has one; the surface supplies the action.
 */
function describe(capability: string, resource: DecisionRequest['resource']): string {
  return resource.kind === 'none' ? capability : `${capability} on ${resource.kind}:${resource.value}`;
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

/**
 * Model-chosen bytes above a taint ceiling answer to one rule, whichever
 * capability carries them: the owner is ASKED and shown the exact bytes
 * (`prompt` carries them verbatim, so `ApprovalRequest.resource` — built from
 * this decision's `resource` in `agent/loop.ts` — can show them too); every
 * other principal is refused outright, same as `sys.shell` above its own
 * ceiling (ADR-0044 §revisione). Both callers below are the params gate found
 * missing by the 2026-08-16 audit: P04-1 (`http_get`'s query string was never
 * inspected once the host cleared the allowlist) and P04-2 (`sys.search`
 * never reached this file at all) — mandato inv. 7.
 *
 * Returns `null` for "no restriction from this gate", not "allow": the caller
 * still falls through to the risk-class switch below, exactly as the url
 * branch already did once the allowlist cleared.
 */
function gateParams(principal: Principal, taint: TrustTier, ceiling: TrustTier, prompt: string): Decision | null {
  if (taint <= ceiling) return null;
  if (isOwnerPrincipal(principal)) return ask(prompt);
  return {
    effect: 'deny',
    code: 'resource_denied',
    detail: `params blocked at taint ${taint} (ceiling ${ceiling})`,
  };
}

/**
 * True when a URL carries bytes beyond its host: a non-empty query or
 * fragment. Not the path: today's allowlist (`rot/egress.json`) is
 * hostname-only, with no notion of "the path the owner allowlisted", so there
 * is no "beyond the allowlisted path" to compare against yet — declared here
 * rather than silently assumed, and the smaller of the two forms named in the
 * mandate.
 */
function hasParams(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.search !== '' || parsed.hash !== '';
  } catch {
    return false; // unreachable here: hostOf() above already refused an unparseable url
  }
}
