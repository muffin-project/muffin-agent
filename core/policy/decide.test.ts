import { describe, expect, it } from 'vitest';
import { createDecide, type PolicyContext } from './decide.js';
import type { CapabilityDecl, CapabilityId, Principal } from './types.js';

const decls: CapabilityDecl[] = [
  { id: 'memory.read', risk: 'low', reversible: 'yes', resourceKind: 'tenant', policyArgs: [], hostOnly: false },
  { id: 'fs.write', risk: 'medium', reversible: 'undoable', resourceKind: 'path', policyArgs: ['path'], hostOnly: true },
  { id: 'sys.shell', risk: 'high', reversible: 'no', resourceKind: 'none', policyArgs: ['command'], hostOnly: true },
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

const owner: Principal = { kind: 'owner', connector: 'cli' };
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
