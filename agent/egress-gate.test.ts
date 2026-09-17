import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecide } from '../core/policy/decide.js';
import { POLICY_FLOOR } from '../core/policy/matrix.js';
import type { CapabilityDecl, Principal } from '../core/policy/types.js';
import DatabaseCtor from 'better-sqlite3';
import { SessionStore } from '../core/session/store.js';
import { TurnStore } from '../core/turns/store.js';
import { TodoStore } from '../core/turns/todo.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { runTurn, type LoopDeps, type RegisteredTool } from './loop.js';
import { CONSERVATIVE } from './profiles/profile.js';
import type { ChatResult, Provider } from './providers/types.js';
import { httpCapability } from './tools/http.js';
import { searchCapability } from './tools/search.js';

/**
 * The egress branches have to be reached by a real tool call — for both
 * shapes of URL resource the kernel knows.
 *
 * Originally a regression test for a defect that had every part working and no
 * part connected: `decide.ts` gated URLs on `resource.kind === 'url'`, its unit
 * tests passed such a resource directly and went green, and the loop built the
 * resource from `args['path']` alone — so every tool call reached the kernel as
 * `{kind:'none'}` and the egress branch never once ran in production.
 *
 * ADR-0066 split that one branch into two: `url-read` (reading — `sys.http`,
 * GET-only) never consults the allowlist at all, by decision; `url` (acting —
 * no shipped capability yet, stood in here) still does, unchanged. Both need
 * the same wiring proof this file always existed for: a real turn, the real
 * loop deriving the resource, and an assertion on whether the tool body
 * executed — never a `decide()` call built by hand, which is exactly what let
 * the original defect ship green.
 */

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  /** Tool results the model was handed — where a kernel refusal actually lands. */
  seen: string[] = [];
  private i = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(call: {
    messages: { content: { type: string; content?: string }[] }[];
  }): Promise<ChatResult> {
    for (const m of call.messages) {
      for (const b of m.content) {
        if (b.type === 'tool_result' && b.content) this.seen.push(b.content);
      }
    }
    return this.script[this.i++] ?? {
      text: 'fine',
      toolCalls: [],
      stopReason: 'end',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: 'test',
    };
  }
}

const callTool = (name: string, args: unknown): ChatResult => ({
  text: null,
  toolCalls: [{ id: 'c1', name, args }],
  stopReason: 'tool_use',
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'test',
});

const decls: CapabilityDecl[] = [httpCapability];

function harness(allowHost: boolean, script: ChatResult[] = [callTool('http_get', { url: 'https://evil.example.com/steal' })]) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-egress-gate-'));
  const fetched: string[] = [];

  const tools: RegisteredTool[] = [
    {
      capability: httpCapability.id,
      spec: {
        name: 'http_get',
        description: 'fetch',
        inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      },
      // Records instead of fetching: the question is whether the kernel let the
      // body run at all, not what the network said.
      handler: (args) => {
        fetched.push(String((args as { url: string }).url));
        return { content: 'body', tier: 3 as const };
      },
      throwTier: 0,
    },
  ];

  const deps: LoopDeps = {
    provider: new Scripted(script),
    profile: CONSERVATIVE,
    model: 'test',
    tools,
    // The loop derives the resource from these, so the harness must hand them
    // over exactly as buildRuntime does — a harness that skips this tests a
    // loop that production does not run.
    capabilities: new Map(decls.map((d) => [d.id, d])),
    decide: createDecide({
      matrix: POLICY_FLOOR,
      capabilities: new Map(decls.map((d) => [d.id, d])),
      budgetExhausted: () => false,
      hardened: true,
      // `allowHost` is passed through for the record, but `sys.http` is
      // `url-read` now: this predicate is never even called for it. The
      // parametrised test below proves exactly that — same result either way.
      egressAllowed: () => allowHost,
    }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions: new SessionStore(home),
    turns: new TurnStore(new DatabaseCtor(':memory:')),
    todos: new TodoStore(new DatabaseCtor(':memory:')),
    budgetExhausted: () => false,
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite in un gruppo.' },
  };
  return { deps, fetched, provider: deps.provider as Scripted };
}

// A group member: taint 2. Before ADR-0066 the egress branch refused this
// outright rather than asking, for a host-holding `url` resource. `url-read`
// has no such refusal to prove any more — the point of the tests below is
// that a member reads exactly as freely as the owner does.
const member: Principal = {
  kind: 'member',
  connector: 'telegram',
  tenantId: 'group:telegram:42',
  externalId: 'u1',
};

describe('reading is open, through a real turn (ADR-0066)', () => {
  it.each([true, false])(
    'fetches regardless of the allowlist predicate (egressAllowed → %s) — url-read never consults it',
    async (allowHost) => {
      const h = harness(allowHost);
      await runTurn(h.deps, {
        principal: member,
        tenant: 'group:telegram:42',
        surface: 'telegram',
        session: h.deps.sessions.open(`s-read-${String(allowHost)}`),
        text: 'leggi https://evil.example.com/steal',
      });

      // The assertion that matters, unchanged since before this slice: the
      // loop really did lift `url` into the kernel's resource (the original
      // defect this file exists for) — and now that a real resource reached
      // it, the kernel's own decision for `url-read` is "no allowlist to
      // consult", so the body runs regardless of `allowHost`.
      expect(h.fetched).toEqual(['https://evil.example.com/steal']);
    },
  );

  it('a junk path argument cannot shadow the url — resourceFor reads policyArgs, not argument order', async () => {
    // Historical exploit, kept as a regression probe even though its outcome
    // changed twice: `http_get({url, path:'x'})` used to matter because a hardcoded
    // loop checked `path` before `url`. `resourceFor` (agent/loop.ts) reads
    // `decl.policyArgs` — `['url']` for `sys.http` — so an unrelated extra key
    // was already inert before ADR-0066. Since slice/url-path-gate a member's
    // *composed* URL denies, the probe uses a quoted one: the junk key must
    // not change what is fetched, and quoting must still open it.
    const h = harness(false, [
      callTool('http_get', { url: 'https://evil.example.com/steal', path: 'anything' }),
    ]);

    await runTurn(h.deps, {
      principal: member,
      tenant: 'group:telegram:42',
      surface: 'telegram',
      session: h.deps.sessions.open('s-read-junk'),
      text: 'leggi https://evil.example.com/steal',
    });

    expect(h.fetched).toEqual(['https://evil.example.com/steal']);
  });
});

/**
 * `url` (acting) is untouched by ADR-0066: no shipped capability declares it
 * today (`sys.http` moved to `url-read`), so this stands in with a minimal
 * capability of the same shape — same `resourceKind`, same `policyArgs` — to
 * prove the *mechanism* a real turn still reaches it exactly as before.
 */
const urlActCapability: CapabilityDecl = {
  id: 'demo.url-act',
  effect: 'egress',
  risk: 'medium',
  reversible: 'yes',
  rerunnable: true,
  resourceKind: 'url',
  policyArgs: ['url'],
  hostOnly: false,
};

function actHarness(allowHost: boolean, script: ChatResult[]) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-egress-gate-act-'));
  const acted: string[] = [];
  const actDecls: CapabilityDecl[] = [urlActCapability];

  const tools: RegisteredTool[] = [
    {
      capability: urlActCapability.id,
      spec: {
        name: 'url_act',
        description: 'stands in for a future url-acting capability',
        inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      },
      handler: (args) => {
        acted.push(String((args as { url: string }).url));
        return { content: 'done', tier: 0 as const };
      },
      throwTier: 0,
    },
  ];

  const deps: LoopDeps = {
    provider: new Scripted(script),
    profile: CONSERVATIVE,
    model: 'test',
    tools,
    capabilities: new Map(actDecls.map((d) => [d.id, d])),
    decide: createDecide({
      matrix: POLICY_FLOOR,
      capabilities: new Map(actDecls.map((d) => [d.id, d])),
      budgetExhausted: () => false,
      hardened: true,
      egressAllowed: () => allowHost,
    }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions: new SessionStore(home),
    turns: new TurnStore(new DatabaseCtor(':memory:')),
    todos: new TodoStore(new DatabaseCtor(':memory:')),
    budgetExhausted: () => false,
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite in un gruppo.' },
  };
  return { deps, acted, provider: deps.provider as Scripted };
}

describe('acting is still gated, through a real turn — ADR-0066 opened reading, not the allowlist', () => {
  it('never runs the body when the host is off the allowlist', async () => {
    const h = actHarness(false, [callTool('url_act', { url: 'https://evil.example.com/steal' })]);
    await runTurn(h.deps, {
      principal: member,
      tenant: 'group:telegram:42',
      surface: 'telegram',
      session: h.deps.sessions.open('s-act-1'),
      text: 'agisci su https://evil.example.com/steal',
    });

    expect(h.acted).toEqual([]);
    expect(h.provider.seen.join('\n')).toMatch(/Rifiutato dal kernel.*resource_denied/s);
  });

  it('runs it when the host is allowlisted, so the gate is a gate and not a wall', async () => {
    const h = actHarness(true, [callTool('url_act', { url: 'https://evil.example.com/steal' })]);
    await runTurn(h.deps, {
      principal: member,
      tenant: 'group:telegram:42',
      surface: 'telegram',
      session: h.deps.sessions.open('s-act-2'),
      text: 'agisci su https://evil.example.com/steal',
    });

    expect(h.acted).toEqual(['https://evil.example.com/steal']);
  });

  it('a junk path argument still cannot shadow the url and skip the allowlist', async () => {
    const h = actHarness(false, [
      callTool('url_act', { url: 'https://evil.example.com/steal', path: 'anything' }),
    ]);

    await runTurn(h.deps, {
      principal: member,
      tenant: 'group:telegram:42',
      surface: 'telegram',
      session: h.deps.sessions.open('s-act-3'),
      text: 'agisci',
    });

    expect(h.acted).toEqual([]);
  });
});

describe('every capability that reaches the network declares an inspectable resource', () => {
  // The mutation this guards against: `resourceKind: 'none'` skips every
  // branch in `decide.ts` that inspects a resource at all and falls straight
  // to the risk-class switch — a silent allow for a medium/reversible
  // capability, at ANY taint. `sys.search` shipped exactly this way (audit
  // 2026-08-16, P04-2): the query left with zero kernel inspection because
  // nothing here caught a network-reaching tool declaring the one
  // resourceKind the kernel cannot gate. `mcp.*` is deliberately not on this
  // list: its destination is a pinned, approved server chosen at attach time,
  // not a per-call model argument — a different shape, already narrowed by
  // `hostOnly` plus its inherited taint ceiling (`agent/tools/mcp.ts`), and
  // out of this slice's scope (mandato inv. 7).
  it('sys.http declares a resourceKind the kernel can inspect', () => {
    expect(httpCapability.resourceKind).not.toBe('none');
  });

  it('sys.search declares a resourceKind the kernel can inspect', () => {
    expect(searchCapability.resourceKind).not.toBe('none');
  });
});
