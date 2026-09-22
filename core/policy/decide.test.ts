import { describe, expect, it } from 'vitest';
import { createDecide, type PolicyContext } from './decide.js';
import { POLICY_FLOOR } from './matrix.js';
import type { CapabilityDecl, CapabilityId, Principal } from './types.js';

const decls: CapabilityDecl[] = [
  { id: 'memory.read', effect: 'context', risk: 'low', reversible: 'yes', rerunnable: true, resourceKind: 'tenant', policyArgs: [], hostOnly: false },
  // era il default della classe: la riga 'context' non lo eredita più
  { id: 'fs.write', effect: 'context', maxTaint: 1, risk: 'medium', reversible: 'undoable', rerunnable: true, resourceKind: 'path', policyArgs: ['path'], hostOnly: true },
  // era il default della classe: la riga 'context' non lo eredita più
  // effect: 'host', la riga vera della dichiarazione spedita
  // (agent/tools/shell.ts). Stava su 'context' con un maxTaint appuntato a
  // mano, che replicava il vecchio soffitto ma NON la riga: da ADR-0074 e' la
  // riga a dire se l'irreversibile chiede, quindi un finto su 'context'
  // proverebbe una capability che non esiste.
  { id: 'sys.shell', effect: 'host', risk: 'high', reversible: 'no', rerunnable: false, resourceKind: 'none', policyArgs: ['command'], hostOnly: true },
  { id: 'sys.http', effect: 'context', risk: 'medium', reversible: 'yes', rerunnable: true, maxTaint: 3, resourceKind: 'url', policyArgs: ['url'], hostOnly: false },
  { id: 'sys.search', effect: 'context', risk: 'medium', reversible: 'yes', rerunnable: true, maxTaint: 3, resourceKind: 'query', policyArgs: ['query'], hostOnly: true },
  // era il default della classe: la riga 'context' non lo eredita più
  { id: 'outward.send', effect: 'context', maxTaint: 1, risk: 'high', reversible: 'no', rerunnable: false, resourceKind: 'url', policyArgs: ['to'], hostOnly: false },
  // era il default della classe: la riga 'context' non lo eredita più
  { id: 'rot.write', effect: 'context', maxTaint: 1, risk: 'high', reversible: 'no', rerunnable: false, resourceKind: 'path', policyArgs: [], hostOnly: true },
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
          // era il default della classe: la riga 'context' non lo eredita più
          { id: 'outward.publish', effect: 'context', maxTaint: 1, risk: 'high', reversible: 'no', rerunnable: false, resourceKind: 'none', policyArgs: [], hostOnly: false },
          // era il default della classe: la riga 'context' non lo eredita più
          { id: 'outward.email.send', effect: 'context', maxTaint: 1, risk: 'medium', reversible: 'no', rerunnable: false, resourceKind: 'none', policyArgs: [], hostOnly: false },
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

  /**
   * **Riscritta da ADR-0074 punto 2.** Pinnava la scorciatoia
   * `hardened && owner && taint === 0 -> allow`: su un'installazione hardened
   * l'owner in una chat pulita eseguiva la shell senza che nessuno glielo
   * chiedesse. L'ADR la toglie e ne fa un falsificatore esplicito - *"su
   * un'installazione hardened, l'owner a taint 0 esegue `sys.process.kill`
   * senza un `ask`: allora la scorciatoia e' tornata"*.
   *
   * Il cambio non dice che hardened non valga: dice che `muffin rot harden`
   * parla di **chi puo' riscrivere le regole**, non di cosa un comando fa
   * alla macchina. Un `rm -rf` non diventa disfabile perche' la radice di
   * fiducia appartiene a un altro utente UNIX.
   */
  it('un comando che non si puo\' annullare chiede anche in hardened, anche a taint 0', () => {
    expect(kernel({ hardened: true })(req(owner, 'host', 'sys.shell', 0))).toMatchObject({ effect: 'ask' });
    expect(kernel({ hardened: false })(req(owner, 'host', 'sys.shell', 0))).toMatchObject({ effect: 'ask' });
    // E la risposta e' la stessa a ogni taint sotto il soffitto della riga
    // `host`: il taint non e' piu' la ragione, quindi non e' piu' una differenza.
    for (const taint of [0, 1, 2] as const) {
      expect(kernel({ hardened: true })(req(owner, 'host', 'sys.shell', taint)), `taint ${taint}`).toMatchObject({
        effect: 'ask',
      });
    }
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

  it('http_get: an allowlisted host with a query string is fine at taint <= paramsMaxTaint (ships 1)', () => {
    expect(withList()(paramsUrlReq(owner, 'host', 'https://allowed.example.com/?q=hello', 1))).toMatchObject({
      effect: 'allow',
    });
    // Lane #624 + #641: tier 2 is attacker-influenced disk content, not the
    // owner's own words — a composed query at taint 2 asks the owner and
    // shows the whole URL (reversing the 2026-08-17 "Ships 2" decision).
    expect(withList()(paramsUrlReq(owner, 'host', 'https://allowed.example.com/?q=hello', 2)).effect).toBe(
      'ask',
    );
  });

  it('http_get: a composed query at taint 2 shows the whole URL in the ask', () => {
    const d = withList()(paramsUrlReq(owner, 'host', 'https://allowed.example.com/?q=MUFFIN-SECRET', 2));
    expect(d.effect).toBe('ask');
    if (d.effect === 'ask') expect(d.ask.prompt).toContain('https://allowed.example.com/?q=MUFFIN-SECRET');
  });

  it('http_get: the same URL past the ceiling asks the owner and shows the whole URL', () => {
    const d = withList()(paramsUrlReq(owner, 'host', 'https://allowed.example.com/?q=MUFFIN-SECRET', 3));
    expect(d.effect).toBe('ask');
    if (d.effect === 'ask') expect(d.ask.prompt).toContain('https://allowed.example.com/?q=MUFFIN-SECRET');
  });

  it('http_get: the same URL past the ceiling refuses anyone but the owner outright', () => {
    expect(
      withList()(paramsUrlReq(member, 'group:telegram:42', 'https://allowed.example.com/?q=MUFFIN-SECRET', 3)),
    ).toMatchObject({ effect: 'deny', code: 'resource_denied' });
  });

  it('url with a composed pathname answers to the same gate as query/fragment (#624)', () => {
    // The pathname gap: before lane #624 + #641 only search/hash were
    // inspected, so a model-composed path on an allowlisted host never met
    // the gate at any taint. Now path, userinfo, query and fragment are one
    // predicate over the canonical parse.
    const pathReq = (p: Principal, taint: 0 | 1 | 2 | 3, quoted = false) => ({
      principal: p,
      tenant: 'host',
      capability: 'sys.http' as CapabilityId,
      resource: { kind: 'url', value: 'https://allowed.example.com/MUFFIN-SECRET' } as const,
      args: { url: 'https://allowed.example.com/MUFFIN-SECRET' },
      taint,
      quoted,
    });
    expect(withList()(pathReq(owner, 1)).effect).toBe('allow');
    expect(withList()(pathReq(owner, 2)).effect).toBe('ask');
    expect(withList()(pathReq(owner, 3)).effect).toBe('ask');
    // A non-owner never gets asked: composed path bytes are refused outright.
    expect(
      withList()({ ...pathReq(owner, 2), principal: member, tenant: 'group:telegram:42' }),
    ).toMatchObject({ effect: 'deny', code: 'resource_denied' });
    // The narrow exception is whole-URL and literal: quoted passes at any taint…
    expect(withList()(pathReq(owner, 3, true)).effect).toBe('allow');
    // …but quoting the host alone does not excuse composed components (F6):
    // a different whole URL is simply not quoted.
    expect(
      withList()({
        ...pathReq(owner, 2),
        resource: { kind: 'url', value: 'https://allowed.example.com/other?x=1' } as const,
        quoted: false,
      }).effect,
    ).toBe('ask');
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
    const d = withList()(paramsUrlReq(owner, 'host', 'https://allowed.example.com/#MUFFIN-SECRET', 3));
    expect(d.effect).toBe('ask');
  });

  it('sys.search: la ricerca non chiede a nessun taint — `searchMaxTaint` e\' 3 (ADR-0072)', () => {
    for (const taint of [0, 1, 2, 3] as const) {
      expect(kernel()(queryReq(owner, 'host', 'previsioni domani', taint))).toMatchObject({ effect: 'allow' });
    }
  });

  it("sys.search: il taint 3 e\' il caso che e\' cambiato — cerca, leggi, cerca ancora", () => {
    // Il giro piu\' normale che esista portava il turno a 3 dopo la prima
    // pagina, quindi il *secondo* `web_search` chiedeva sempre. Su un
    // processo headless quell'`ask` e\' un `exit 3`: un'approvazione che
    // nessuno puo\' dare e\' un divieto travestito.
    expect(kernel()(queryReq(owner, 'host', 'MUFFIN-SECRET-sk-live-9f3a7c21', 3))).toMatchObject({
      effect: 'allow',
    });
  });

  it('ma il numero e\' ancora un cancello: rimetterlo giu\' lo riaccende', () => {
    // La meta\' che impedisce a questa fetta di essere «il gate e\' stato
    // cancellato»: `searchMaxTaint` e\' una manopola che un `rot/policy.json`
    // sigillato puo\' abbassare, non una riga rimossa.
    const stretto = kernel({ matrix: { ...POLICY_FLOOR, searchMaxTaint: 2 } });
    const d = stretto(queryReq(owner, 'host', 'MUFFIN-SECRET-sk-live-9f3a7c21', 3));
    expect(d.effect).toBe('ask');
    if (d.effect === 'ask') expect(d.ask.prompt).toContain('MUFFIN-SECRET-sk-live-9f3a7c21');
  });

  it("e i parametri di un URL restano a 1: sono i due numeri separati da ADR-0072, con il primo abbassato dalla lane #624 + #641", () => {
    // Il confine che regge il rischio: il *dove* di una ricerca e\' una
    // costante allowlisted, quello di un URL lo sceglie il modello.
    expect(withList()(paramsUrlReq(owner, 'host', 'https://allowed.example.com/c?q=SEGRETO', 3)).effect).toBe(
      'ask',
    );
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

  it('a matrix with a higher ceiling still only moves the ask threshold — but the sealed file can no longer build one', () => {
    // Direct-matrix seam, not the file: since the HOLD resolution the sealed
    // policy is monotone (`tighter()` in `merge()`, pinned in
    // `matrix.test.ts`), so a ceiling of 2 here is a construction the kernel
    // answers, not a file an owner can reseal. What this still proves: a
    // raised ceiling never turns into a silent allow above itself — only ask
    // moves.
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

/**
 * Visto sulla macchina dell'owner durante il primo uso reale (RETURN):
 *
 *     ⚠ sys.shell on (no resource)
 *        su: command: ls -1 *.md
 *
 * Le due righe si contraddicono. `(no resource)` è un segnaposto interno —
 * vero al livello del kernel, che per una capability `resourceKind: 'none'`
 * non ha davvero niente — finito dentro una frase che una persona deve
 * leggere per decidere. La riga sotto, che il turno costruisce dagli
 * argomenti della call (D12-min), dice invece esattamente cosa sta per
 * succedere. Il kernel deve tacere su ciò che non sa, non affermarlo.
 */
describe('D12 — il prompt del kernel non annuncia la propria ignoranza', () => {
  it('una capability senza risorsa produce un prompt che nomina solo la capability', () => {
    const decl: CapabilityDecl = {
      id: 'sys.shell',
      // `'host'`, non `'context'`: da ADR-0074 è la riga che decide se
      // l'irreversibile chiede, quindi un finto sulla riga sbagliata non
      // arriverebbe mai a un `ask` e questo test proverebbe un prompt che
      // nessuno vede.
      effect: 'host',
      risk: 'high',
      reversible: 'no',
      rerunnable: false,
      maxTaint: 2,
      resourceKind: 'none',
      policyArgs: [],
      hostOnly: false,
    };
    const decide = createDecide({
      matrix: POLICY_FLOOR,
      capabilities: new Map([[decl.id, decl]]),
      budgetExhausted: () => false,
      hardened: false,
    });
    const decision = decide({
      principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
      tenant: 'host',
      capability: 'sys.shell',
      resource: { kind: 'none' },
      args: {},
      taint: 0,
    });

    expect(decision.effect).toBe('ask');
    if (decision.effect !== 'ask') return;
    expect(decision.ask.prompt).toContain('sys.shell');
    expect(decision.ask.prompt).not.toContain('no resource');
    expect(decision.ask.prompt).not.toMatch(/\bon\s*$/);
  });

  it('una capability CON risorsa continua a mostrarla', () => {
    const decl: CapabilityDecl = {
      id: 'fs.write',
      // Come sopra: la riga `host` è la sola che porta questo finto a un `ask`.
      // La `fs.write` **spedita** è `undoable` e da ADR-0074 non chiede mai —
      // qui la dichiarazione è finta apposta (`reversible: 'no'`), perché il
      // test riguarda il testo del prompt, non quale capability lo produce.
      effect: 'host',
      risk: 'high',
      reversible: 'no',
      rerunnable: false,
      maxTaint: 2,
      resourceKind: 'path',
      policyArgs: [],
      hostOnly: false,
    };
    const decide = createDecide({
      matrix: POLICY_FLOOR,
      capabilities: new Map([[decl.id, decl]]),
      budgetExhausted: () => false,
      hardened: false,
    });
    const decision = decide({
      principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
      tenant: 'host',
      capability: 'fs.write',
      resource: { kind: 'path', value: '/tmp/x' },
      args: {},
      taint: 0,
    });
    expect(decision.effect).toBe('ask');
    if (decision.effect !== 'ask') return;
    expect(decision.ask.prompt).toContain('/tmp/x');
  });
});

/**
 * **Riscritto da ADR-0074 punto 2.**
 *
 * Il blocco che stava qui pinnava la frase del 03/09: l'`ask` di
 * `sys.shell` in single-user aggiungeva *«chiede sempre finché il blocco non
 * è reale (`muffin rot harden`)»*, e un secondo test verificava che
 * un'installazione hardened **non** prendesse in prestito quella spiegazione,
 * perché lì la domanda nasceva dal taint.
 *
 * Entrambe le metà sono cadute con la loro causa. Il ramo `hardened` non
 * esiste più (la scorciatoia è sparita, quindi non c'è più una ragione
 * "single-user" da distinguere), e il taint non produce più `ask`, quindi non
 * c'è più una seconda ragione da non confondere con la prima. Ne resta una
 * sola, ed è quella che il prompt deve dire: **questa cosa non si annulla.**
 */
describe("il prompt dell'ask dice cosa non si può annullare — ADR-0074", () => {
  const decl: CapabilityDecl = {
    id: 'sys.shell',
    effect: 'host',
    risk: 'high',
    reversible: 'no',
    rerunnable: false,
    maxTaint: 2,
    resourceKind: 'none',
    policyArgs: [],
    hostOnly: false,
  };
  const base = { matrix: POLICY_FLOOR, capabilities: new Map([[decl.id, decl]]), budgetExhausted: () => false };
  const req0 = {
    principal: owner,
    tenant: 'host',
    capability: 'sys.shell' as const,
    resource: { kind: 'none' } as const,
    args: {},
    taint: 0 as const,
  };

  it('nomina la conseguenza irreversibile, non la modalità della radice di fiducia', () => {
    for (const hardened of [true, false]) {
      const decision = createDecide({ ...base, hardened })(req0);
      expect(decision.effect).toBe('ask');
      if (decision.effect !== 'ask') return;
      // Cosa non si può annullare, prima di tutto il resto.
      expect(decision.ask.prompt).toContain('non si torna indietro');
      expect(decision.ask.prompt).toContain('questa macchina');
      // E la capability resta nominata, perché D12 vuole sapere cosa si approva.
      expect(decision.ask.prompt).toContain('sys.shell');
      // La modalità della radice di fiducia non c'entra: `muffin rot harden`
      // decide **chi può riscrivere le regole**, non se un comando si disfa.
      expect(decision.ask.prompt).not.toContain('muffin rot harden');
    }
  });

  it('la frase non cambia col taint: il taint è contesto, non la causa', () => {
    const decide = createDecide({ ...base, hardened: false });
    const a = decide(req0);
    const b = decide({ ...req0, taint: 2 });
    expect(a).toEqual(b);
    // Il contesto («questo turno ha letto contenuto esterno») lo aggiungono le
    // superfici da `ApprovalRequest.taint` — `cli/repl.ts` e `cli/surface.ts`,
    // riga `contesto: turno a taint N` — proprio perché non è più una causa.
  });
});
