import { describe, expect, it } from 'vitest';
import { createDecide, type PolicyContext } from './decide.js';
import type { CapabilityDecl, CapabilityId, Principal } from './types.js';

const decls: CapabilityDecl[] = [
  { id: 'memory.read', risk: 'low', reversible: 'yes', resourceKind: 'tenant', policyArgs: [], hostOnly: false },
  { id: 'fs.write', risk: 'medium', reversible: 'undoable', resourceKind: 'path', policyArgs: ['path'], hostOnly: true },
  { id: 'sys.shell', risk: 'high', reversible: 'no', resourceKind: 'none', policyArgs: ['command'], hostOnly: true },
  { id: 'sys.http', risk: 'medium', reversible: 'yes', maxTaint: 3, resourceKind: 'url', policyArgs: ['url'], hostOnly: false },
  { id: 'outward.send', risk: 'high', reversible: 'no', resourceKind: 'url', policyArgs: ['to'], hostOnly: false },
  { id: 'rot.write', risk: 'high', reversible: 'no', resourceKind: 'path', policyArgs: [], hostOnly: true },
];

function kernel(overrides: Partial<PolicyContext> = {}) {
  return createDecide({
    capabilities: new Map(decls.map((d) => [d.id, d])),
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

  it('asks before shell when the root of trust is only detected, not prevented', () => {
    expect(kernel({ hardened: true })(req(owner, 'host', 'sys.shell', 0))).toMatchObject({ effect: 'allow' });
    expect(kernel({ hardened: false })(req(owner, 'host', 'sys.shell', 0))).toMatchObject({ effect: 'ask' });
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
