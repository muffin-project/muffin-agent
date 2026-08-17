import { describe, expect, it } from 'vitest';
import { createDecide, type PolicyContext } from './decide.js';
import { POLICY_FLOOR } from './matrix.js';
import type { CapabilityDecl, CapabilityId, Principal } from './types.js';

const decls: CapabilityDecl[] = [
  { id: 'memory.read', risk: 'low', reversible: 'yes', rerunnable: true, resourceKind: 'tenant', policyArgs: [], hostOnly: false },
  { id: 'fs.write', risk: 'medium', reversible: 'undoable', rerunnable: true, resourceKind: 'path', policyArgs: ['path'], hostOnly: true },
  { id: 'sys.shell', risk: 'high', reversible: 'no', rerunnable: false, resourceKind: 'none', policyArgs: ['command'], hostOnly: true },
  { id: 'sys.http', risk: 'medium', reversible: 'yes', rerunnable: true, maxTaint: 3, resourceKind: 'url', policyArgs: ['url'], hostOnly: false },
  { id: 'sys.search', risk: 'medium', reversible: 'yes', rerunnable: true, maxTaint: 3, resourceKind: 'query', policyArgs: ['query'], hostOnly: true },
  { id: 'outward.send', risk: 'high', reversible: 'no', rerunnable: false, resourceKind: 'url', policyArgs: ['to'], hostOnly: false },
  { id: 'rot.write', risk: 'high', reversible: 'no', rerunnable: false, resourceKind: 'path', policyArgs: [], hostOnly: true },
];

function kernel(overrides: Partial<PolicyContext> = {}) {
  return createDecide({
    capabilities: new Map(decls.map((d) => [d.id, d])),
    matrix: POLICY_FLOOR,
    budgetExhausted: () => false,
    hardened: true,
    ...overrides,
  });
}

const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };
const member: Principal = { kind: 'member', connector: 'telegram', tenantId: 'group:telegram:42', externalId: 'u1' };
const scheduler: Principal = { kind: 'system', source: 'scheduler' };

const req = (p: Principal, tenant: string, capability: CapabilityId, taint: 0 | 1 | 2 | 3) => ({
  principal: p,
  tenant,
  capability,
  resource: { kind: 'none' } as const,
  args: {},
  taint,
});

describe('policy kernel', () => {
  it("lets a declaration's maxTaint both narrow and widen the class default", () => {
    // Pinning the real semantics, because a comment here asserted the opposite
    // ("may narrow it, never widen it") while a shipped declaration widened:
    // sys.http is medium, whose default ceiling is 1, and declares 3 on
    // purpose — read-only on an allowlist is what the threat model permits at
    // taint 2/3. Without this test the next reader has to choose between
    // believing the prose and believing the code.
    const decide = kernel({ egressAllowed: () => true });

    // Widened: medium default is 1, sys.http declares 3. Asked with a real url
    // resource, because a url capability handed anything else is now refused
    // outright — the gate no longer depends on its caller to supply the
    // precondition.
    expect(
      decide({
        principal: owner, tenant: 'host', capability: 'sys.http',
        resource: { kind: 'url', value: 'https://api.example.com/v1' },
        args: {}, taint: 3,
      }).effect,
    ).not.toBe('deny');
    // Narrowed: fs.write is medium and declares nothing, so 1 is the ceiling.
    expect(decide(req(owner, 'host', 'fs.write', 2))).toMatchObject({
      effect: 'deny',
      code: 'taint_exceeded',
    });
  });

  it('denies everything above low risk in safe mode', () => {
    // The CLI has always told the user this happens. Until the flag reached the
    // kernel, it did not — the only place in the system where the code asserted
    // a guarantee it was not providing.
    const degraded = createDecide({
      capabilities: new Map(decls.map((d) => [d.id, d])),
      matrix: POLICY_FLOOR,
      budgetExhausted: () => false,
      hardened: false,
      safeMode: true,
    });
    const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };
    expect(degraded({ principal: owner, tenant: 'host', capability: 'fs.write', resource: { kind: 'none' }, args: {}, taint: 0 }))
      .toMatchObject({ effect: 'deny', code: 'safe_mode' });
    // Reading still works: a degraded agent that cannot answer at all is one
    // you turn off, and then the divergence goes uninvestigated.
    expect(degraded({ principal: owner, tenant: 'host', capability: 'memory.read', resource: { kind: 'tenant', value: 'host' }, args: {}, taint: 0 }))
      .toMatchObject({ effect: 'allow' });
  });

  it('refuses a capability that was never declared', () => {
    expect(kernel()(req(owner, 'host', 'tool.invented', 0))).toMatchObject({
      effect: 'deny',
      code: 'no_capability',
    });
  });

  it('has no runtime write path to the root of trust, even for the owner', () => {
    expect(kernel()(req(owner, 'host', 'rot.write', 0))).toMatchObject({
      effect: 'deny',
      code: 'rot_violation',
    });
  });

  it('keeps a group member out of host-only capabilities', () => {
    expect(kernel()(req(member, 'group:telegram:42', 'sys.shell', 2))).toMatchObject({
      effect: 'deny',
      code: 'principal_forbidden',
    });
  });

  it('rejects a request whose tenant contradicts its principal', () => {
    expect(kernel()(req(member, 'host', 'memory.read', 2))).toMatchObject({
      effect: 'deny',
      code: 'tenant_mismatch',
    });
  });

  it('denies a medium-risk capability once the context carries untrusted content', () => {
    // The same call is fine at taint 0 and refused at taint 2: this is the
    // fetch-then-act path, and it must close as the taint rises mid-turn.
    expect(kernel()(req(owner, 'host', 'fs.write', 0))).toMatchObject({ effect: 'draft' });
    expect(kernel()(req(owner, 'host', 'fs.write', 2))).toMatchObject({
      effect: 'deny',
      code: 'taint_exceeded',
    });
  });

  it('never lets an autonomous principal auto-approve what a human would be asked for', () => {
    // Nobody is awake at 3am: the job queues, it does not grant itself the call.
    expect(kernel()(req(scheduler, 'host', 'sys.shell', 0))).toMatchObject({ effect: 'ask' });
  });

  it('keeps outward actions away from the scheduler at any taint', () => {
    expect(kernel()(req(scheduler, 'host', 'outward.send', 0))).toMatchObject({
      effect: 'deny',
      code: 'principal_forbidden',
    });
  });

  it('keeps the whole outward namespace away from autonomous principals, not one id', () => {
    // Threat model 03 §3: *"Le capability `outward.*` e `config.ratchet` sono
    // escluse del tutto da `system@scheduler` a qualunque taint."* The
    // namespace, with the star, is what the guarantee says.
    //
    // The lookup was `Set.has(capability)` against two exact strings, so the
    // sentence was true of precisely the one id somebody had thought to list.
    // `outward.send` does not exist as a declaration yet — the deny protected
    // a capability nobody had built — and the first real one to ship under
    // that prefix would have arrived unguarded, silently, because the deny it
    // was supposed to inherit was spelled as its sibling's name.
    //
    // Measured before the fix: `outward.publish` for the scheduler → `ask`
    // (queued for the owner), not `deny`. An ASK is not a DENY: it is a
    // request the owner can approve at 2am for an action the threat model says
    // must never be available to an autonomous principal at all.
    const withSiblings = createDecide({
      capabilities: new Map(
        [
          ...decls,
          { id: 'outward.publish', risk: 'high', reversible: 'no', rerunnable: false, resourceKind: 'none', policyArgs: [], hostOnly: false },
          { id: 'outward.email.send', risk: 'medium', reversible: 'no', rerunnable: false, resourceKind: 'none', policyArgs: [], hostOnly: false },
        ].map((d) => [d.id, d as CapabilityDecl]),
      ),
      matrix: POLICY_FLOOR,
      budgetExhausted: () => false,
      hardened: true,
    });

    for (const capability of ['outward.send', 'outward.publish', 'outward.email.send']) {
      for (const taint of [0, 1, 2, 3] as const) {
        expect(withSiblings(req(scheduler, 'host', capability, taint)), `${capability} @ taint ${taint}`).toMatchObject({
          effect: 'deny',
          code: 'principal_forbidden',
        });
      }
    }

    // And the namespace is a namespace, not a prefix match on the string: a
    // capability that merely starts with the same letters is not covered.
    expect(withSiblings(req(scheduler, 'host', 'memory.read', 0)).effect).not.toBe('deny');
  });

  it('asks before shell when the root of trust is only detected, not prevented', () => {
    expect(kernel({ hardened: true })(req(owner, 'host', 'sys.shell', 0))).toMatchObject({ effect: 'allow' });
    expect(kernel({ hardened: false })(req(owner, 'host', 'sys.shell', 0))).toMatchObject({ effect: 'ask' });
  });

  it('asks the budget about the turnic tenant, not just about the wallet', () => {
    // The gate used to be nullary — `budgetExhausted()` — so the per-tenant
    // daily cap was not merely unwired, it was **unaskable** through this
    // interface. It was sealed in rot/budgets.json, loaded, unit-tested, and
    // reported by `doctor` as an active ceiling, and no caller could reach it.
    // A group could therefore spend the entire monthly pool at forty times its
    // own stated limit, starving the owner for the rest of the month — which is
    // the documented $47-in-twenty-minutes echo loop `budget.ts` was written
    // against.
    //
    // Asserting the tenant *arrives* rather than asserting a number: the
    // arithmetic has its own tests, and what broke here was the plumbing.
    const seen: string[] = [];
    const perTenant = kernel({
      budgetExhausted: (tenant: string) => {
        seen.push(tenant);
        return tenant === 'group:telegram:42';
      },
    });

    // `sys.http` because a member can reach it (not `hostOnly`) and it is
    // medium risk, so it passes the principal and taint gates and arrives at
    // the budget — which is checked before the egress branch, so this is the
    // budget's verdict and not the allowlist's.
    expect(perTenant(req(member, 'group:telegram:42', 'sys.http', 0))).toMatchObject({
      effect: 'deny',
      code: 'budget_exhausted',
    });
    expect(perTenant(req(owner, 'host', 'fs.write', 0))).not.toMatchObject({ code: 'budget_exhausted' });
    expect(seen).toContain('group:telegram:42');
    expect(seen).toContain('host');
  });

  it('stops spending before the action, not after', () => {
    const broke = kernel({ budgetExhausted: () => true });
    expect(broke(req(owner, 'host', 'fs.write', 0))).toMatchObject({
      effect: 'deny',
      code: 'budget_exhausted',
    });
    // Reading memory is free and stays available, so the agent can still explain itself.
    expect(broke(req(owner, 'host', 'memory.read', 0))).toMatchObject({ effect: 'allow' });
  });
});

describe('egress branch — the allowlist in the root of trust speaks for URLs', () => {
  const urlReq = (p: Principal, tenant: string, url: string, taint: 0 | 1 | 2 | 3) => ({
    principal: p,
    tenant,
    capability: 'sys.http' as CapabilityId,
    resource: { kind: 'url', value: url } as const,
    args: { url },
    taint,
  });
  const withList = () => kernel({ egressAllowed: (host) => host === 'api.example.com' });

  it('on the list, owner, clean context: the declared risk class speaks (medium → allow)', () => {
    expect(withList()(urlReq(owner, 'host', 'https://api.example.com/v1', 0))).toMatchObject({
      effect: 'allow',
    });
  });

  it('off the list, owner, clean context: ask — never a silent allow', () => {
    const d = withList()(urlReq(owner, 'host', 'https://elsewhere.net/x', 0));
    expect(d.effect).toBe('ask');
    if (d.effect === 'ask') expect(d.ask.prompt).toContain('elsewhere.net');
  });

  it('off the list in a tainted turn: deny — a poisoned context cannot nominate the endpoint', () => {
    expect(withList()(urlReq(owner, 'host', 'https://exfil.attacker.net/', 2))).toMatchObject({
      effect: 'deny',
      code: 'resource_denied',
    });
  });

  it('a group member reads the public allowlist and nothing else', () => {
    const list = withList();
    expect(list(urlReq(member, 'group:telegram:42', 'https://api.example.com/', 2))).toMatchObject({
      effect: 'allow',
    });
    expect(list(urlReq(member, 'group:telegram:42', 'https://elsewhere.net/', 2))).toMatchObject({
      effect: 'deny',
      code: 'resource_denied',
    });
  });

  it('a runtime that forgets to wire the allowlist gets ask-for-everything, not allow', () => {
    // kernel() has no egressAllowed: absent must mean "nothing is allowed".
    const d = kernel()(urlReq(owner, 'host', 'https://api.example.com/v1', 0));
    expect(d.effect).toBe('ask');
  });

  it('refuses a url capability that was handed no url at all', () => {
    // The fail-closed half. A gate whose precondition is supplied by its caller
    // is not a gate: before this branch existed, a loop that produced anything
    // other than a url resource skipped the allowlist entirely and fell through
    // to the risk class, which for medium/reversible is `allow`. That is how a
    // junk `path` argument fetched an off-allowlist host for a group member.
    // Asserted on the *reason*, not just the effect, and that is the whole
    // point: without this branch the request is still denied — `hostOf` throws
    // on a missing value and falls into the unparseable-url path — so the
    // outcome alone cannot tell the two apart. What the branch buys is that a
    // caller which forgot to supply the declared resource is told exactly that,
    // instead of being sent to look at a URL that was never the problem.
    for (const resource of [{ kind: 'none' } as const, { kind: 'path', value: '/tmp/x' } as const]) {
      const d = withList()({
        principal: owner, tenant: 'host', capability: 'sys.http', resource, args: {}, taint: 0,
      });
      expect(d).toMatchObject({ effect: 'deny', code: 'resource_denied' });
      expect(d.effect === 'deny' && d.detail).toMatch(/declares a url resource but received/);
    }
  });

  it('an unparseable or non-http url is refused outright', () => {
    expect(withList()(urlReq(owner, 'host', 'file:///etc/passwd', 0))).toMatchObject({
      effect: 'deny',
      code: 'resource_denied',
    });
    expect(withList()(urlReq(owner, 'host', 'not a url', 0))).toMatchObject({
      effect: 'deny',
      code: 'resource_denied',
    });
  });
});

describe('params gate — model-chosen bytes above a ceiling, whichever tool carries them (mandato inv. 7)', () => {
  const paramsUrlReq = (p: Principal, tenant: string, url: string, taint: 0 | 1 | 2 | 3) => ({
    principal: p,
    tenant,
    capability: 'sys.http' as CapabilityId,
    resource: { kind: 'url', value: url } as const,
    args: { url },
    taint,
  });
  const queryReq = (p: Principal, tenant: string, query: string, taint: 0 | 1 | 2 | 3) => ({
    principal: p,
    tenant,
    capability: 'sys.search' as CapabilityId,
    resource: { kind: 'query', value: query } as const,
    args: { query },
    taint,
  });
  const withList = () => kernel({ egressAllowed: (host) => host === 'allowed.example.com' });

  it('http_get: an allowlisted host with a query string is fine at taint <= paramsMaxTaint (default 1)', () => {
    expect(withList()(paramsUrlReq(owner, 'host', 'https://allowed.example.com/?q=hello', 1))).toMatchObject({
      effect: 'allow',
    });
  });

  it('http_get: the same URL past the ceiling asks the owner and shows the whole URL', () => {
    const d = withList()(paramsUrlReq(owner, 'host', 'https://allowed.example.com/?q=MUFFIN-SECRET', 2));
    expect(d.effect).toBe('ask');
    if (d.effect === 'ask') expect(d.ask.prompt).toContain('https://allowed.example.com/?q=MUFFIN-SECRET');
  });

  it('http_get: the same URL past the ceiling refuses anyone but the owner outright', () => {
    expect(
      withList()(paramsUrlReq(member, 'group:telegram:42', 'https://allowed.example.com/?q=MUFFIN-SECRET', 2)),
    ).toMatchObject({ effect: 'deny', code: 'resource_denied' });
  });

  it('http_get: an allowlisted host with NO params is unaffected by the ceiling, at any taint', () => {
    expect(withList()(paramsUrlReq(owner, 'host', 'https://allowed.example.com/', 3))).toMatchObject({
      effect: 'allow',
    });
    expect(withList()(paramsUrlReq(member, 'group:telegram:42', 'https://allowed.example.com/', 2))).toMatchObject({
      effect: 'allow',
    });
  });

  it('http_get: a fragment alone counts as params too', () => {
    const d = withList()(paramsUrlReq(owner, 'host', 'https://allowed.example.com/#MUFFIN-SECRET', 2));
    expect(d.effect).toBe('ask');
  });

  it('sys.search: the query text is fine at taint <= paramsMaxTaint', () => {
    expect(kernel()(queryReq(owner, 'host', 'previsioni domani', 0))).toMatchObject({ effect: 'allow' });
    expect(kernel()(queryReq(owner, 'host', 'previsioni domani', 1))).toMatchObject({ effect: 'allow' });
  });

  it('sys.search: past the ceiling asks the owner and shows the query', () => {
    const d = kernel()(queryReq(owner, 'host', 'MUFFIN-SECRET-sk-live-9f3a7c21', 3));
    expect(d.effect).toBe('ask');
    if (d.effect === 'ask') expect(d.ask.prompt).toContain('MUFFIN-SECRET-sk-live-9f3a7c21');
  });

  it('sys.search: a group member never reaches the params gate at all — host-only refuses first', () => {
    expect(kernel()(queryReq(member, 'group:telegram:42', 'qualsiasi cosa', 3))).toMatchObject({
      effect: 'deny',
      code: 'principal_forbidden',
    });
  });

  it('a query capability handed the wrong resource kind is refused, not skipped', () => {
    const d = kernel()({
      principal: owner,
      tenant: 'host',
      capability: 'sys.search',
      resource: { kind: 'none' },
      args: {},
      taint: 0,
    });
    expect(d).toMatchObject({ effect: 'deny', code: 'resource_denied' });
    expect(d.effect === 'deny' && d.detail).toMatch(/declares a query resource but received/);
  });

  it('the owner can raise the ceiling from the sealed policy file, and it only moves the ask threshold', () => {
    // Owner decision open per the mandate (1 vs 2): whichever way it lands,
    // the raised ceiling must never turn into a silent allow above it — only
    // ask moves.
    const raised = kernel({
      matrix: { ...POLICY_FLOOR, paramsMaxTaint: 2 },
      egressAllowed: (host) => host === 'allowed.example.com',
    });
    expect(raised(paramsUrlReq(owner, 'host', 'https://allowed.example.com/?q=x', 2))).toMatchObject({
      effect: 'allow',
    });
    expect(raised(paramsUrlReq(owner, 'host', 'https://allowed.example.com/?q=x', 3)).effect).toBe('ask');
  });

  it('the owner can lower the ceiling from the sealed policy file too', () => {
    const lowered = kernel({
      matrix: { ...POLICY_FLOOR, paramsMaxTaint: 0 },
      egressAllowed: (host) => host === 'allowed.example.com',
    });
    expect(lowered(paramsUrlReq(owner, 'host', 'https://allowed.example.com/?q=x', 1)).effect).toBe('ask');
  });
});
