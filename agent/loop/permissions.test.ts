import { describe, expect, it, vi } from 'vitest';
import type { CapabilityDecl, Decide, DecisionRequest, Decision, Principal, TenantId } from '../../core/policy/types.js';
import type { TurnInput } from './types.js';
import { denyText, initialTaint, makeSnapshot, resourceFor, spendeIlBudget } from './permissions.js';

const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };
const member: Principal = { kind: 'member', connector: 'telegram', tenantId: 'group:telegram:g1', externalId: 'u1' };

const baseInput = (overrides: Partial<TurnInput> = {}): TurnInput => ({
  principal: owner,
  tenant: 'host' as TenantId,
  surface: 'cli',
  session: { id: 't1', file: '/dev/null' },
  text: 'ciao',
  ...overrides,
});

describe('spendeIlBudget', () => {
  it('spends the budget only on a resume that was not woken from a wait/approval', () => {
    expect(spendeIlBudget(true, false)).toBe(true);
    expect(spendeIlBudget(true, true)).toBe(false);
    expect(spendeIlBudget(false, false)).toBe(false);
    expect(spendeIlBudget(false, true)).toBe(false);
  });
});

describe('initialTaint', () => {
  it("is the principal's own tier when no contentTaint is given", () => {
    expect(initialTaint(baseInput({ principal: owner }))).toBe(0);
    expect(initialTaint(baseInput({ principal: member }))).toBe(2);
  });

  it('is the max of the tier and contentTaint, in either direction', () => {
    expect(initialTaint(baseInput({ principal: owner, contentTaint: 3 }))).toBe(3);
    expect(initialTaint(baseInput({ principal: member, contentTaint: 0 }))).toBe(2);
  });
});

describe('denyText', () => {
  it('names taint_exceeded specially — no approval unblocks it', () => {
    const text = denyText({ effect: 'deny', code: 'taint_exceeded', detail: 'il turno ha letto il web' });
    expect(text).toContain('taint_exceeded');
    expect(text).toContain('il turno ha letto il web');
    expect(text).toContain('Nessuna approvazione');
  });

  it('every other deny code gets the generic refusal, naming the code', () => {
    const text = denyText({ effect: 'deny', code: 'resource_denied' });
    expect(text).toBe("Rifiutato dal kernel dei permessi (resource_denied). Non insistere: serve una decisione dell'owner.");
  });
});

describe('resourceFor', () => {
  const declOf = (over: Partial<CapabilityDecl>): CapabilityDecl => ({
    id: 'demo.cap',
    effect: 'context',
    risk: 'medium',
    reversible: 'yes' as CapabilityDecl['reversible'],
    rerunnable: true,
    resourceKind: 'path',
    policyArgs: ['path'],
    hostOnly: false,
    ...over,
  });

  it('is none when there is no declaration', () => {
    expect(resourceFor(undefined, { path: '/tmp/x' })).toEqual({ kind: 'none' });
  });

  it('is none for a resourceKind the kernel does not resolve from args (e.g. none/tenant)', () => {
    expect(resourceFor(declOf({ resourceKind: 'none', policyArgs: [] }), { path: '/tmp/x' })).toEqual({
      kind: 'none',
    });
  });

  it('reads the value from the first policyArg present as a string, for path/url/url-read/query', () => {
    expect(resourceFor(declOf({ resourceKind: 'path', policyArgs: ['path'] }), { path: '/tmp/x' })).toEqual({
      kind: 'path',
      value: '/tmp/x',
    });
    expect(resourceFor(declOf({ resourceKind: 'url', policyArgs: ['url'] }), { url: 'https://x' })).toEqual({
      kind: 'url',
      value: 'https://x',
    });
    expect(resourceFor(declOf({ resourceKind: 'url-read', policyArgs: ['url'] }), { url: 'https://x' })).toEqual({
      kind: 'url-read',
      value: 'https://x',
    });
    expect(resourceFor(declOf({ resourceKind: 'query', policyArgs: ['q'] }), { q: 'ricerca' })).toEqual({
      kind: 'query',
      value: 'ricerca',
    });
  });

  it('checks policyArgs in order and skips a non-string value', () => {
    expect(
      resourceFor(declOf({ resourceKind: 'path', policyArgs: ['missing', 'path'] }), { missing: 42, path: '/ok' }),
    ).toEqual({ kind: 'path', value: '/ok' });
  });

  it('is none when the declared arg is absent — declared but missing is not guessed', () => {
    expect(resourceFor(declOf({ resourceKind: 'path', policyArgs: ['path'] }), {})).toEqual({ kind: 'none' });
  });
});

describe('makeSnapshot / citato', () => {
  const allow: Decision = { effect: 'allow' };
  const deny: Decision = { effect: 'deny', code: 'resource_denied' };

  it('taint starts at `from` and only ever rises, for both raiseTaint and raiseCeiling', () => {
    const snapshot = makeSnapshot(() => allow, owner, 'host', 0);
    expect(snapshot.currentTaint()).toBe(0);
    snapshot.raiseTaint(2);
    expect(snapshot.currentTaint()).toBe(2);
    snapshot.raiseTaint(1); // lower: no effect
    expect(snapshot.currentTaint()).toBe(2);
    snapshot.raiseCeiling(3);
    expect(snapshot.currentTaint()).toBe(3);
  });

  it('raiseCeiling never raises intrinsicTaint; raiseTaint does', () => {
    const snapshot = makeSnapshot(() => allow, owner, 'host', 0);
    snapshot.raiseCeiling(3);
    expect(snapshot.intrinsicTaint()).toBe(0);
    snapshot.raiseTaint(2);
    expect(snapshot.intrinsicTaint()).toBe(2);
  });

  it('MUTATION: citato() is a literal, case-sensitive substring match — normalizing it must go red', () => {
    const decide: Decide = vi.fn((req: DecisionRequest) => (req.quoted ? deny : allow));
    const snapshot = makeSnapshot(decide, owner, 'host', 0);
    snapshot.recordInput('Contains MixedCase token, not the lowercase one');
    // A resource whose value differs only by case from what actually arrived:
    // a literal comparison must NOT consider this "quoted" (it never appeared
    // byte-for-byte), so the decision must be `allow`, not `deny`.
    const decision = snapshot.check('demo.cap', { kind: 'path', value: 'mixedcase' }, {});
    expect(decision).toEqual(allow);
  });

  it('a byte-identical substring IS recognised as quoted', () => {
    const decide: Decide = vi.fn((req: DecisionRequest) => (req.quoted ? deny : allow));
    const snapshot = makeSnapshot(decide, owner, 'host', 0);
    snapshot.recordInput('here is https://exact.example/path in the message');
    const decision = snapshot.check('demo.cap', { kind: 'url', value: 'https://exact.example/path' }, {});
    expect(decision).toEqual(deny);
  });

  it('an empty recorded input is never "quoted" by an empty resource value', () => {
    const decide: Decide = vi.fn((req: DecisionRequest) => (req.quoted ? deny : allow));
    const snapshot = makeSnapshot(decide, owner, 'host', 0);
    snapshot.recordInput('');
    const decision = snapshot.check('demo.cap', { kind: 'path', value: '' }, {});
    expect(decision).toEqual(allow);
  });

  it('MUTATION: a cached decision does not survive a taint raise — it must go red if it did', () => {
    const decide: Decide = vi.fn(() => allow);
    const snapshot = makeSnapshot(decide, owner, 'host', 0);
    const resource = { kind: 'path' as const, value: '/tmp/x' };
    snapshot.check('demo.cap', resource, {});
    snapshot.check('demo.cap', resource, {});
    expect(decide).toHaveBeenCalledTimes(1); // second call served from cache

    snapshot.raiseTaint(2);
    snapshot.check('demo.cap', resource, {});
    expect(decide).toHaveBeenCalledTimes(2); // the raise must have cleared the cache
  });

  it('invalidate() clears the cache directly, without a taint raise', () => {
    const decide: Decide = vi.fn(() => allow);
    const snapshot = makeSnapshot(decide, owner, 'host', 0);
    const resource = { kind: 'path' as const, value: '/tmp/x' };
    snapshot.check('demo.cap', resource, {});
    snapshot.invalidate();
    snapshot.check('demo.cap', resource, {});
    expect(decide).toHaveBeenCalledTimes(2);
  });
});
