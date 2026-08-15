import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecide } from '../core/policy/decide.js';
import { POLICY_FLOOR } from '../core/policy/matrix.js';
import type { CapabilityDecl, Principal } from '../core/policy/types.js';
import { SessionStore } from '../core/session/store.js';
import { TurnStore } from '../core/turns/store.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import type { AttributeValue, SpanHandle, SpanName, Tracer } from '../core/tracing/types.js';
import { runTurn, type LoopDeps, type RegisteredTool } from './loop.js';
import { CONSERVATIVE, type Profile, type RecoveryStrategy } from './profiles/profile.js';
import { OpenAICompatProvider } from './providers/openai-compat.js';
import { ProviderError, type ChatCall, type ChatResult, type Provider } from './providers/types.js';

/** A provider that replays a script, so the loop is tested and not the model. */
class ScriptedProvider implements Provider {
  readonly kind = 'openai-compat' as const;
  calls = 0;
  readonly seen: ChatCall[] = [];
  constructor(private readonly script: (ChatResult | ProviderError)[]) {}
  async chat(_request?: ChatCall): Promise<ChatResult> {
    // A snapshot of the messages, not the live array. `compactToolResults`
    // returns the caller's own array unchanged when nothing needs clearing
    // (`agent/context/compact.ts`), so every recorded call aliased ONE growing
    // conversation: `seen[0].messages` showed what the *last* request sent, and
    // any assertion about what the loop said on attempt N silently read attempt
    // last. The loop only ever appends, so a copy of the list is enough.
    if (_request) this.seen.push({ ..._request, messages: [..._request.messages] });
    const next = this.script[this.calls++] ?? answer('fine script');
    if (next instanceof ProviderError) throw next;
    return next;
  }
}

const answer = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  stopReason: 'end',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'test',
});

const callTool = (name: string, args: unknown = {}): ChatResult => ({
  text: null,
  toolCalls: [{ id: `t${Math.random().toString(36).slice(2, 8)}`, name, args }],
  stopReason: 'tool_use',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'test',
});

/** A turn with nothing in it: no text, no call. The cascade's own trigger. */
const nothing = (): ChatResult => ({
  text: null,
  toolCalls: [],
  stopReason: 'end',
  usage: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'test',
});

/** What the loop said to the model last, in the request it sent. */
const lastSaid = (call: ChatCall): string => {
  const last = call.messages[call.messages.length - 1];
  return (last?.content ?? [])
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('\n')
    .trim();
};

const decls: CapabilityDecl[] = [
  { id: 'demo.read', risk: 'low', reversible: 'yes', rerunnable: true, resourceKind: 'none', policyArgs: [], hostOnly: false },
  { id: 'demo.write', risk: 'medium', reversible: 'no', rerunnable: false, resourceKind: 'none', policyArgs: [], hostOnly: true },
];

function deps(script: (ChatResult | ProviderError)[], overrides: Partial<LoopDeps> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-loop-'));
  const calls: string[] = [];
  const tools: RegisteredTool[] = [
    {
      capability: 'demo.read',
      spec: { name: 'demo_read', description: 'read', inputSchema: { type: 'object', properties: {} } },
      // `tier: 0` on the fakes in this file, deliberately: these tools exist to
      // exercise sequencing, caps and recovery, and a tier they do not need
      // would make every one of those tests also a taint test by accident.
      // `demo_web` below is the one that carries provenance, because that is
      // what it is for.
      handler: (args) => {
        calls.push(`demo_read:${JSON.stringify(args)}`);
        return { content: 'letto', tier: 0 as const };
      },
    },
    {
      capability: 'demo.read',
      spec: { name: 'demo_web', description: 'fetch', inputSchema: { type: 'object', properties: {} } },
      handler: () => ({ content: 'contenuto dal web', tier: 3 as const }),
    },
    {
      capability: 'demo.write',
      spec: { name: 'demo_write', description: 'write', inputSchema: { type: 'object', properties: {} } },
      handler: () => {
        calls.push('demo_write');
        return { content: 'scritto', tier: 0 as const };
      },
    },
    {
      capability: 'demo.read',
      spec: { name: 'demo_boom', description: 'throws', inputSchema: { type: 'object', properties: {} } },
      handler: () => {
        throw new Error('il tool è esploso');
      },
    },
  ];

  const store = new SessionStore(home);
  const turns = new TurnStore(new DatabaseCtor(':memory:'));
  const base: LoopDeps = {
    provider: new ScriptedProvider(script),
    profile: CONSERVATIVE,
    model: 'test-model',
    tools,
    decide: createDecide({
      matrix: POLICY_FLOOR,
      capabilities: new Map(decls.map((d) => [d.id, d])),
      budgetExhausted: () => false,
      hardened: true,
    }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions: store,
    turns,
    budgetExhausted: () => false,
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite in un gruppo.' },
    ...overrides,
  };
  return { deps: base, store, turns, home, calls };
}

const input = (store: SessionStore, principal: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' }) => ({
  principal,
  tenant: principal.kind === 'member' ? principal.tenantId : 'host',
  surface: 'cli',
  session: store.open('t1'),
  text: 'fai la cosa',
});

describe('agent loop', () => {
  it('answers without touching a tool when none is needed', async () => {
    const { deps: d, store } = deps([answer('ecco la risposta')]);
    const result = await runTurn(d, input(store));
    expect(result).toMatchObject({ stopped: 'answered', text: 'ecco la risposta', iterations: 1 });
  });

  it('runs a tool, feeds the result back, and closes on the next turn', async () => {
    const { deps: d, store, calls } = deps([callTool('demo_read', { q: 1 }), answer('ho letto')]);
    const result = await runTurn(d, input(store));
    expect(calls).toEqual(['demo_read:{"q":1}']);
    expect(result).toMatchObject({ stopped: 'answered', text: 'ho letto', iterations: 2 });
  });

  it('tells the model a tool does not exist instead of throwing', async () => {
    const { deps: d, store } = deps([callTool('non_esiste'), answer('ok, ho capito')]);
    const result = await runTurn(d, input(store));
    // The turn survives and the model gets a chance to correct itself.
    expect(result.stopped).toBe('answered');
    expect(result.iterations).toBe(2);
  });

  it('hands a thrown tool error back as content, not as a crash', async () => {
    const { deps: d, store } = deps([callTool('demo_boom'), answer('me ne faccio una ragione')]);
    await expect(runTurn(d, input(store))).resolves.toMatchObject({ stopped: 'answered' });
  });

  it('refuses a host-only tool to a group member', async () => {
    const member: Principal = {
      kind: 'member',
      connector: 'telegram',
      tenantId: 'group:telegram:9',
      externalId: 'u9',
    };
    const { deps: d, store, calls } = deps([callTool('demo_write'), answer('non ho potuto')]);
    await runTurn(d, input(store, member));
    expect(calls).not.toContain('demo_write'); // the handler never ran
  });

  it('filters before it caps, so host-only tools cannot crowd a member out of the window', async () => {
    // Unobservable on a stock registry (9 tools, smallest cap 10) — this
    // fixture is what makes the order testable: cap 2, and the two hostOnly
    // tools registered FIRST. Cap-then-filter hands a member an empty menu
    // while their usable tool sits outside the window; the moment MCP attaches
    // (hostOnly, appended last) that stops being hypothetical on consumer
    // profiles. The judge's mutation reversing the order survived 546 tests;
    // this is the test that was missing.
    const member: Principal = {
      kind: 'member',
      connector: 'telegram',
      tenantId: 'group:telegram:9',
      externalId: 'u9',
    };
    const hostDecl = (id: string): CapabilityDecl => ({
      id, risk: 'low', reversible: 'yes', rerunnable: true, resourceKind: 'none', policyArgs: [], hostOnly: true,
    });
    const openDecl = (id: string): CapabilityDecl => ({
      id, risk: 'low', reversible: 'yes', rerunnable: true, resourceKind: 'none', policyArgs: [], hostOnly: false,
    });
    const tool = (name: string, capability: string): RegisteredTool => ({
      capability,
      spec: { name, description: name, inputSchema: { type: 'object', properties: {} } },
      handler: () => ({ content: 'ok', tier: 0 as const }),
    });
    const provider = new ScriptedProvider([answer('ciao')]);
    const { deps: d, store } = deps([], {
      provider,
      profile: { ...CONSERVATIVE, maxToolsExposed: 2 },
      tools: [tool('host_a', 'cap.a'), tool('host_b', 'cap.b'), tool('open_c', 'cap.c')],
      capabilities: new Map([
        ['cap.a', hostDecl('cap.a')],
        ['cap.b', hostDecl('cap.b')],
        ['cap.c', openDecl('cap.c')],
      ]),
    });
    await runTurn(d, input(store, member));

    const sent = provider.seen[0]?.tools?.map((t) => t.name) ?? [];
    expect(sent).toEqual(['open_c']);
  });

  it('closes a medium-risk tool once a web result raised the taint', async () => {
    // fetch-then-act: the same write is fine before the fetch and refused after.
    const { deps: d, store, calls } = deps([
      callTool('demo_web'),
      callTool('demo_write'),
      answer('mi sono fermato'),
    ]);
    await runTurn(d, input(store));
    expect(calls).not.toContain('demo_write');
  });

  it('stops at the cap instead of looping forever', async () => {
    const script = Array.from({ length: 40 }, () => callTool('demo_read'));
    const { deps: d, store } = deps(script, { profile: { ...CONSERVATIVE, maxToolCallsPerTurn: 5 } as Profile });
    const result = await runTurn(d, input(store));
    expect(result).toMatchObject({ stopped: 'cap', iterations: 5 });
  });

  it('stops when the budget is gone, before spending more', async () => {
    const { deps: d, store } = deps([answer('non ci arrivo')], { budgetExhausted: () => true });
    const result = await runTurn(d, input(store));
    expect(result.stopped).toBe('budget');
    expect(result.iterations).toBe(0);
  });

  it('retries a transient provider failure, then gives up rather than pretending', async () => {
    const { deps: d, store } = deps([new ProviderError('502 upstream', true), answer('ripreso')]);
    await expect(runTurn(d, input(store))).resolves.toMatchObject({ stopped: 'answered', text: 'ripreso' });

    const fatal = deps([new ProviderError('401 unauthorized', false)]);
    await expect(runTurn(fatal.deps, input(fatal.store))).rejects.toThrow(/401/);
  });

  it('writes the exchange to the transcript so a restart keeps it', async () => {
    const { deps: d, store } = deps([callTool('demo_read'), answer('finito')]);
    const session = store.open('t1');
    await runTurn(d, { ...input(store), session });
    const roles = store.read(session).map((m) => m.role);
    expect(roles).toEqual(['user', 'tool', 'assistant']);
  });

  it('bills every model call — the caps are decorative if nobody records', async () => {
    // The budget engine, its two caps and its five tests all existed while
    // `record()` had no caller in production: `exhausted()` answered false for
    // ever and `/spend` would have said $0.00 after a night of looping.
    const billed: { model: string; tenant: string; reads: number; writes: number }[] = [];
    const withCache = (r: ChatResult): ChatResult => ({
      ...r,
      usage: { ...r.usage, cacheReadTokens: 200, cacheWriteTokens: 150 },
    });
    const { deps: d, store } = deps([withCache(callTool('demo_read')), withCache(answer('fatto'))], {
      recordSpend: (entry) => {
        billed.push({
          model: entry.model,
          tenant: entry.tenant,
          reads: entry.cacheReadTokens,
          writes: entry.cacheWriteTokens,
        });
        return 0.01;
      },
    });
    await runTurn(d, input(store));
    // Two model calls in this turn, two billing records, both with the tenant.
    expect(billed).toHaveLength(2);
    expect(billed.every((b) => b.tenant === 'host')).toBe(true);
    // And the cache fields ride along. The premium's formula was pinned while
    // the line CARRYING the number to it was not: zeroing the spend entry's
    // cacheWriteTokens killed nothing, so the premium was one edit from being
    // dead in production with a green suite — F1's shape, one layer over. The
    // read side had been unpinned since it shipped; same fix, same breath.
    expect(billed.every((b) => b.reads === 200 && b.writes === 150)).toBe(true);
  });

  it('marks the system prompt as the cacheable prefix, or the breakpoint has nothing to mark', async () => {
    // The adapter half is well tested — against fixtures that set the marker by
    // hand. The one production line that actually sets it could be deleted with
    // the whole suite green: every turn would pay full price, and the telemetry
    // that would show it only moves if the marker was there. Two correct
    // halves, an untested join — the house archetype, on this slice's own
    // guarantee.
    const provider = new ScriptedProvider([answer('ok')]);
    const { deps: d, store } = deps([], { provider });
    await runTurn(d, input(store));
    expect(provider.seen[0]?.system[0]).toMatchObject({ cache: 'stable' });
  });

  it('carries cache writes to the surface, so a write is distinguishable from no cache', async () => {
    // The adapter read `cache_write_tokens` off the wire and the loop dropped
    // it one layer up: the accumulator had no field, the span attribute had a
    // definition and zero writers, and the telemetry could not say a cache
    // write ever happened — which is exactly how the missing breakpoints
    // stayed invisible for the feature's whole life.
    const withCache = (r: ChatResult): ChatResult => ({
      ...r,
      usage: { ...r.usage, cacheReadTokens: 200, cacheWriteTokens: 150 },
    });
    const { deps: d, store } = deps([withCache(callTool('demo_read')), withCache(answer('fatto'))]);

    const result = await runTurn(d, input(store));

    // Two calls, both counted: the sum, not the last value.
    expect(result.usage.cacheWriteTokens).toBe(300);
    expect(result.usage.cacheReadTokens).toBe(400);
  });

  it('does not let a cached allow outlive the budget that permitted it', async () => {
    // The taint invalidates the decision cache for itself; the budget is the
    // other input the kernel reads, and it can run out mid-turn.
    let exhausted = false;
    const { deps: d, store, calls } = deps(
      [callTool('demo_read'), callTool('demo_read'), callTool('demo_read'), answer('fine')],
      {
        budgetExhausted: () => exhausted,
        recordSpend: () => {
          exhausted = true; // the first call empties the budget
          return 99;
        },
      },
    );
    await runTurn(d, input(store));
    // One tool ran before the budget went; nothing after it, despite the same
    // capability and the same arguments hitting the cache.
    expect(calls.length).toBeLessThanOrEqual(1);
  });

  it('clears old tool payloads out of the request but not out of the record', async () => {
    // Measured elsewhere at -48% peak context with no behaviour lost. The part
    // that has to hold here: every tool_use keeps its tool_result, or the
    // provider refuses the whole request.
    const seen: string[] = [];
    class Capturing extends ScriptedProvider {
      override async chat(request?: ChatCall): Promise<ChatResult> {
        for (const m of request?.messages ?? []) {
          for (const b of m.content) if (b.type === 'tool_result') seen.push(b.content);
        }
        return super.chat(request);
      }
    }
    const home = mkdtempSync(join(tmpdir(), 'muffin-compact-'));
    const store = new SessionStore(home);
    const provider = new Capturing([
      callTool('demo_read'),
      callTool('demo_read'),
      callTool('demo_read'),
      answer('finito'),
    ]);
    const big = 'x'.repeat(40_000);
    const d: LoopDeps = {
      provider,
      profile: CONSERVATIVE,
      model: 'test',
      tools: [
        {
          capability: 'demo.read',
          spec: { name: 'demo_read', description: 'r', inputSchema: { type: 'object', properties: {} } },
          handler: () => ({ content: big, tier: 0 as const }),
        },
      ],
      decide: createDecide({
        matrix: POLICY_FLOOR,
        capabilities: new Map(decls.map((x) => [x.id, x])),
        budgetExhausted: () => false,
        hardened: false,
      }),
      tracer: new SimpleTracer(new JsonlExporter(home)),
      sessions: store,
      turns: new TurnStore(new DatabaseCtor(':memory:')),
      budgetExhausted: () => false,
      systemPrompts: { owner: 'test', group: 'test in gruppo' },
    };
    const session = store.open('compact');
    await runTurn(d, {
      principal: { kind: 'owner', connector: 'cli', externalId: 'local' } as Principal,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'leggi tre volte',
    });

    // Three payloads of 40k would be 120k characters; the budget is 60k.
    expect(seen.some((s) => s.includes('rimosso dal contesto'))).toBe(true);
    // And the transcript still has the real thing: what we sent is not what we
    // recorded.
    const tool = store.read(session).filter((m) => m.role === 'tool');
    expect(tool.every((m) => m.content === big)).toBe(true);
  });

  it('nudges once when the answer narrates a call it never made', async () => {
    const { deps: d, store, calls } = deps([
      answer('[Eseguo `demo_write`] Fatto, ho scritto il file.'),
      callTool('demo_write'),
      answer('scritto per davvero'),
    ]);
    const result = await runTurn(d, input(store));
    // The nudge got a real call out of it instead of a story about one.
    expect(calls).toContain('demo_write');
    expect(result.text).toBe('scritto per davvero');
  });

  it('lets the answer stand after one nudge rather than editing it', async () => {
    // Rewriting what the agent said would be a second dishonesty on top of the
    // first. The turn records the fact and returns the model's own words.
    const { deps: d, store } = deps([
      answer('[Eseguo `demo_write`] fatto'),
      answer('[Eseguo `demo_write`] fatto davvero, giuro'),
    ]);
    const result = await runTurn(d, input(store));
    expect(result.stopped).toBe('answered');
    expect(result.text).toContain('giuro');
  });

  it('stops with a question rather than inventing a refusal, when nobody can be asked', async () => {
    // `ask` was one of four kernel verdicts and no surface could carry it: the
    // loop turned it into a tool error claiming it could not ask, which is a
    // failure the tool never had. Headless now exits on it, so a script can act.
    const asking: CapabilityDecl[] = [
      { id: 'demo.ask', risk: 'high', reversible: 'no', rerunnable: false, resourceKind: 'none', policyArgs: [], hostOnly: true },
    ];
    const ran: string[] = [];
    const { deps: d, store } = deps([callTool('demo_ask'), answer('mai')], {
      decide: createDecide({
        matrix: POLICY_FLOOR,
        capabilities: new Map(asking.map((c) => [c.id, c])),
        budgetExhausted: () => false,
        hardened: false, // single-user: high risk is ask, never a silent allow
      }),
      tools: [
        {
          capability: 'demo.ask',
          spec: { name: 'demo_ask', description: 'a', inputSchema: { type: 'object', properties: {} } },
          handler: () => {
            ran.push('demo_ask');
            return { content: 'fatto', tier: 0 as const };
          },
        },
      ],
    });
    const result = await runTurn(d, input(store));
    expect(result.stopped).toBe('ask');
    expect(result.pending?.capability).toBe('demo.ask');
    expect(ran).toEqual([]);
  });

  it('runs the tool when the surface can ask and the owner says yes', async () => {
    const asking: CapabilityDecl[] = [
      { id: 'demo.ask', risk: 'high', reversible: 'no', rerunnable: false, resourceKind: 'none', policyArgs: [], hostOnly: true },
    ];
    const asked: string[] = [];
    const ran: string[] = [];
    const make = (verdict: 'allow' | 'deny') =>
      deps([callTool('demo_ask'), answer('ok')], {
        approve: async (req) => {
          asked.push(req.capability);
          return verdict;
        },
        decide: createDecide({
          matrix: POLICY_FLOOR,
          capabilities: new Map(asking.map((c) => [c.id, c])),
          budgetExhausted: () => false,
          hardened: false,
        }),
        tools: [
          {
            capability: 'demo.ask',
            spec: { name: 'demo_ask', description: 'a', inputSchema: { type: 'object', properties: {} } },
            handler: () => {
              ran.push('demo_ask');
              return { content: 'fatto', tier: 0 as const };
            },
          },
        ],
      });

    const yes = make('allow');
    await runTurn(yes.deps, input(yes.store));
    expect(asked).toEqual(['demo.ask']);
    expect(ran).toEqual(['demo_ask']);

    // And a no is a no: the tool does not run, and the model is told not to push.
    ran.length = 0;
    const no = make('deny');
    const denied = await runTurn(no.deps, input(no.store));
    expect(ran).toEqual([]);
    expect(denied.stopped).toBe('answered');
  });

  it('refuses a draft instead of executing it as an allow', async () => {
    // `fs.write` is medium risk and undoable, so the kernel answers `draft`.
    // The loop had no branch for it and fell through to the handler: the write
    // happened immediately, with no undo journal and no window.
    const undoable: CapabilityDecl[] = [
      { id: 'demo.draft', risk: 'medium', reversible: 'undoable', rerunnable: true, resourceKind: 'none', policyArgs: [], hostOnly: true },
    ];
    const ran: string[] = [];
    const { deps: d, store } = deps([callTool('demo_draft'), answer('ok')], {
      decide: createDecide({
        matrix: POLICY_FLOOR,
        capabilities: new Map(undoable.map((c) => [c.id, c])),
        budgetExhausted: () => false,
        hardened: false,
      }),
      tools: [
        {
          capability: 'demo.draft',
          spec: { name: 'demo_draft', description: 'd', inputSchema: { type: 'object', properties: {} } },
          handler: () => {
            ran.push('demo_draft');
            return { content: 'scritto davvero', tier: 0 as const };
          },
        },
      ],
    });
    await runTurn(d, input(store));
    expect(ran).toEqual([]);
  });

  it('refuses a policy verdict it does not recognise, instead of falling through to execution', async () => {
    // Same shape as the `draft` bug just above, one union member further out.
    // `runTool`'s gate used to be a chain of `if`s for the effects that must
    // NOT run the tool (deny/draft/ask); whatever was left fell through to
    // the handler. That "whatever is left" was `allow` in practice, but the
    // chain never checked for `allow` — it only checked for the other three —
    // so the fall-through really meant "anything I do not have a branch for",
    // and `draft` was that exact fall-through once (ADR-0022's undo model
    // landed after this file did). The union can grow again without every
    // caller growing with it: `decide` is dependency-injected (`LoopDeps`),
    // so a kernel and a loop built from different commits — a rolling
    // deploy, or a decision replayed from a persisted record after a schema
    // change — can disagree about its members without either side lying.
    // The cast through `unknown` below stands in for that disagreement.
    //
    // `runTool` now switches exhaustively and refuses via `assertNever` in
    // `default`, so the turn throws instead of executing — asserted here as
    // a rejection, not a quiet return, because a caller that swallowed this
    // throw would recreate the exact bug the switch exists to prevent.
    const ran: string[] = [];
    const { deps: d, store } = deps([callTool('demo_unknown'), answer('ok')], {
      decide: (() => ({ effect: 'quarantine' })) as unknown as LoopDeps['decide'],
      tools: [
        {
          capability: 'demo.unknown',
          spec: { name: 'demo_unknown', description: 'u', inputSchema: { type: 'object', properties: {} } },
          handler: () => {
            ran.push('demo_unknown');
            return { content: 'eseguito', tier: 0 as const };
          },
        },
      ],
    });
    await expect(runTurn(d, input(store))).rejects.toThrow(/unreachable/);
    expect(ran).toEqual([]);
  });
});

/**
 * Which context a turn was given is a security-relevant fact about that turn,
 * and until the class existed there was nothing to record. Neither the session
 * file nor the memory row carries it, so the trace is the only place an
 * incident can be answered from afterwards — which makes an attribute nobody
 * asserts exactly the wrong kind of record to keep.
 */
class RecordingTracer implements Tracer {
  readonly spans: { name: string; attributes: Record<string, AttributeValue> }[] = [];
  start(name: SpanName, attributes: Record<string, AttributeValue> = {}): SpanHandle {
    const span = { name: String(name), attributes: { ...attributes } };
    this.spans.push(span);
    return {
      traceId: 'trace',
      spanId: `span-${this.spans.length}`,
      setAttributes: (next) => {
        span.attributes = { ...span.attributes, ...next };
      },
      end: () => {},
    };
  }
}

describe('the context a turn is given', () => {
  const MEMBER: Principal = {
    kind: 'member',
    connector: 'telegram',
    tenantId: 'group:telegram:-1',
    externalId: '7',
  };

  it('records the class and the size of the tool menu on the turn span', async () => {
    const tracer = new RecordingTracer();
    const { deps: d, store } = deps([answer('ok')], {
      tracer,
      capabilities: new Map(decls.map((x) => [x.id, x])),
    });
    await runTurn(d, input(store, MEMBER));

    const turn = tracer.spans.find((s) => s.name === 'muffin.turn');
    expect(turn?.attributes['muffin.context.class']).toBe('group');
    // `demo_write` is the host-only one of the four; three survive the filter.
    expect(turn?.attributes['muffin.context.tools_exposed']).toBe(3);
  });

  it('gives the owner the owner class and the whole menu on the same fixture', async () => {
    const tracer = new RecordingTracer();
    const { deps: d, store } = deps([answer('ok')], {
      tracer,
      capabilities: new Map(decls.map((x) => [x.id, x])),
    });
    await runTurn(d, input(store));

    const turn = tracer.spans.find((s) => s.name === 'muffin.turn');
    expect(turn?.attributes['muffin.context.class']).toBe('owner');
    expect(turn?.attributes['muffin.context.tools_exposed']).toBe(4);
  });

  it('hands the model the prompt of its class and only its tools', async () => {
    const { deps: d, store } = deps([answer('ok')], {
      capabilities: new Map(decls.map((x) => [x.id, x])),
    });
    const provider = d.provider as ScriptedProvider;

    await runTurn(d, input(store, MEMBER));
    const call = provider.seen[0]!;
    expect(call.system[0]!.type === 'text' && call.system[0]!.text).toBe(d.systemPrompts.group);
    expect(call.tools?.map((t) => t.name)).toEqual(['demo_read', 'demo_web', 'demo_boom']);
  });
});

/**
 * The cascade a profile declares is the cascade that runs.
 *
 * `RecoveryStrategy` has always had four members and the loop consulted one:
 * `recoveriesLeft` counted down from `recovery.length` while the only branch
 * ever taken was `includes('nudge')`. On `consumer-local` — the profile written
 * for the weak model, the one that needs the crutches — `[nudge,
 * reinjectTools, retryOnce, strictJson]` executed as four identical nudges, and
 * the count made the lie load-bearing: three names in a JSON were buying
 * attempts they did not spend.
 */
describe('the recovery cascade', () => {
  const cascade = (recovery: RecoveryStrategy[]): Profile => ({ ...CONSERVATIVE, recovery });

  it('runs attempt N with strategy N, in the order the profile declared', async () => {
    const { deps: d, store } = deps([nothing(), nothing(), nothing(), nothing(), answer('finalmente')], {
      profile: cascade(['nudge', 'reinjectTools', 'retryOnce', 'strictJson']),
    });
    const provider = d.provider as ScriptedProvider;

    const result = await runTurn(d, input(store));
    expect(result).toMatchObject({ stopped: 'answered', text: 'finalmente' });
    expect(provider.seen).toHaveLength(5);

    const [, first, second, third, fourth] = provider.seen as ChatCall[];
    // 1 — nudge: the corrective turn that already existed, unchanged.
    expect(lastSaid(first!)).toBe('Non ho ricevuto risposta. Continua, oppure dimmi che hai finito.');
    // 2 — reinjectTools: the names of this turn's tools, inline at the tail.
    expect(lastSaid(second!)).toContain('demo_read');
    expect(lastSaid(second!)).toContain('demo_boom');
    expect(lastSaid(second!)).not.toBe(lastSaid(first!));
    // 3 — retryOnce: the same request again. It adds nothing to the context,
    // which is the whole reason it is worth a slot on a small model.
    expect(third!.messages).toHaveLength(second!.messages.length);
    expect(lastSaid(third!)).toBe(lastSaid(second!));
    // 4 — strictJson: the hard constraint, two admissible shapes and no third.
    expect(lastSaid(fourth!)).not.toBe(lastSaid(second!));
    expect(lastSaid(fourth!)).toMatch(/JSON/);
  });

  it('takes its order from the profile and not from a sequence written in the loop', async () => {
    const { deps: d, store } = deps([nothing(), nothing(), answer('ok')], {
      profile: cascade(['strictJson', 'nudge']),
    });
    const provider = d.provider as ScriptedProvider;

    await runTurn(d, input(store));
    // Declared first, so it runs first: the loop walks the list, it does not
    // know that a nudge is the gentle one.
    expect(lastSaid(provider.seen[1]!)).toMatch(/JSON/);
    expect(lastSaid(provider.seen[2]!)).toBe('Non ho ricevuto risposta. Continua, oppure dimmi che hai finito.');
  });

  it('stops when the declared cascade is spent instead of repeating its last step', async () => {
    const { deps: d, store } = deps([nothing(), nothing(), nothing()], { profile: cascade(['nudge']) });
    const provider = d.provider as ScriptedProvider;

    const result = await runTurn(d, input(store));
    expect(result.stopped).toBe('error');
    // One declared attempt: the first call, one recovery, and no third.
    expect(provider.calls).toBe(2);
  });

  it('answers unparseable tool arguments with the cascade, not with a backoff', async () => {
    // `malformed tool arguments` is thrown by the adapter with retryable:true,
    // so it used to arrive at the loop's catch indistinguishable from a 429 and
    // was answered by waiting. Waiting cannot improve JSON the model already
    // emitted; the cascade can, and the wording says what actually broke.
    const { deps: d, store } = deps(
      [new ProviderError('malformed tool arguments from demo_read', true, undefined, 'output'), answer('ok')],
      { profile: cascade(['nudge']) },
    );
    const provider = d.provider as ScriptedProvider;

    await runTurn(d, input(store));
    expect(provider.seen).toHaveLength(2);
    // The transport path pushes no message at all, so a new corrective turn is
    // the proof this went through the profile instead.
    expect(provider.seen[1]!.messages.length).toBe(provider.seen[0]!.messages.length + 1);
    expect(lastSaid(provider.seen[1]!)).not.toBe('Non ho ricevuto risposta. Continua, oppure dimmi che hai finito.');
  });

  it('does not spend a cascade step on a transport failure', async () => {
    // One shared counter meant a 502 ate the profile's only nudge and the empty
    // turn that followed had nothing left. Two failures, two budgets.
    const { deps: d, store } = deps([new ProviderError('502 upstream', true), nothing(), answer('ripreso')], {
      profile: cascade(['nudge']),
    });
    const result = await runTurn(d, input(store));
    expect(result).toMatchObject({ stopped: 'answered', text: 'ripreso' });
  });

  it('names the tools this turn exposed, never the whole registry', async () => {
    // Same rule as the invented-tool message: a member who is handed the host
    // inventory learns the names of everything the kernel is going to refuse.
    const member: Principal = {
      kind: 'member',
      connector: 'telegram',
      tenantId: 'group:telegram:9',
      externalId: 'u9',
    };
    const { deps: d, store } = deps([nothing(), answer('ok')], {
      profile: cascade(['reinjectTools']),
      capabilities: new Map(decls.map((x) => [x.id, x])),
    });
    const provider = d.provider as ScriptedProvider;

    await runTurn(d, input(store, member));
    const said = lastSaid(provider.seen[1]!);
    expect(said).toContain('demo_read');
    expect(said).not.toContain('demo_write'); // hostOnly: filtered before the model
  });

  it('runs with a neutral profile: no strategy declared, nothing left behind in the core', async () => {
    // The honesty test of 07 §3. A profile with every crutch off must still be
    // a working profile — if something breaks, an impalcatura has leaked into
    // the loop and that is an architectural bug, not a missing feature.
    const neutral = cascade([]);

    const empty = deps([nothing()], { profile: neutral });
    const gaveUp = await runTurn(empty.deps, input(empty.store));
    expect(gaveUp.stopped).toBe('error');
    expect((empty.deps.provider as ScriptedProvider).calls).toBe(1);

    // And the transport retry survives the neutral profile, because a 429 is a
    // property of the endpoint and never was a crutch for a weak model.
    const flaky = deps([new ProviderError('502 upstream', true), answer('ripreso')], { profile: neutral });
    await expect(runTurn(flaky.deps, input(flaky.store))).resolves.toMatchObject({ text: 'ripreso' });
  });

  it('keeps the completion nudge out of the cascade, on a profile that declares none', async () => {
    // Two nudges, two mechanisms. The completion gate is durable (it answers a
    // measured false-success rate on every model) and is not a step a profile
    // may decline; the cascade is scaffolding a profile declares. Deleting the
    // cascade must not delete the gate.
    const { deps: d, store, calls } = deps(
      [answer('[Eseguo `demo_write`] Fatto.'), callTool('demo_write'), answer('scritto per davvero')],
      { profile: cascade([]) },
    );
    const result = await runTurn(d, input(store));
    expect(calls).toContain('demo_write');
    expect(result.text).toBe('scritto per davvero');
  });

  it('routes a real adapter\'s malformed output to the cascade, from the wire up', async () => {
    // The join, and it was the one thing the rest of this block could not see.
    // Mutation: deleting `'output'` from the adapter's throw
    // (`agent/providers/openai-compat.ts`) left every other test here green —
    // the loop's branch was pinned against a ProviderError built by hand, and
    // nothing proved the adapter ever produces one. That is the house defect
    // exactly (two correct halves, an untested join), so the fixture starts at
    // the bytes: a server that answers with a truncated `arguments` string, a
    // real `OpenAICompatProvider`, and the assertion that the corrective turn
    // reaches the *next request body* instead of the loop sleeping on a backoff.
    const bodies: { messages: { role: string; content: unknown }[] }[] = [];
    let served = 0;
    const usage = { prompt_tokens: 10, completion_tokens: 5 };
    const fetchFake = async (_url: unknown, init?: { body?: string }): Promise<Response> => {
      bodies.push(JSON.parse(init?.body ?? '{}'));
      served += 1;
      const body =
        served === 1
          ? {
              id: 'x',
              model: 'qwen3-local',
              usage,
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    content: null,
                    // Truncated mid-object: the shape a small model emits when
                    // it runs out of tokens or loses the brace.
                    tool_calls: [
                      { id: 'c1', type: 'function', function: { name: 'demo_read', arguments: '{"q": ' } },
                    ],
                  },
                },
              ],
            }
          : {
              id: 'x',
              model: 'qwen3-local',
              usage,
              choices: [{ finish_reason: 'stop', message: { content: 'ok, ripreso', tool_calls: [] } }],
            };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const { deps: d, store } = deps([], {
      provider: new OpenAICompatProvider('sk-test', 'http://localhost:11434/v1', {}, { fetch: fetchFake as never }),
      profile: cascade(['nudge']),
    });

    const result = await runTurn(d, input(store));
    expect(result).toMatchObject({ stopped: 'answered', text: 'ok, ripreso' });
    expect(bodies).toHaveLength(2);

    const retried = bodies[1]!.messages;
    expect(retried[retried.length - 1]).toMatchObject({
      role: 'user',
      content: 'La tua ultima tool call non era leggibile: gli argomenti non erano JSON valido. Rifalla per intero.',
    });
  });

  it('records which strategy ran, so a cascade that fires is visible on the trace', async () => {
    const tracer = new RecordingTracer();
    const { deps: d, store } = deps([nothing(), nothing(), answer('ok')], {
      tracer,
      profile: cascade(['nudge', 'strictJson']),
    });
    await runTurn(d, input(store));

    const turn = tracer.spans.find((s) => s.name === 'muffin.turn');
    expect(turn?.attributes['muffin.recovery.attempt']).toBe(2);
    expect(turn?.attributes['muffin.recovery.strategy']).toBe('strictJson');
    expect(turn?.attributes['muffin.recovery.failure']).toBe('empty');
  });
});

/**
 * Reasoning continuity across a tool-use turn.
 *
 * Tested at `runTurn` and not only at the adapter on purpose: the adapter's half
 * was one filter and the loop's half was one array literal, and *each half is
 * plausible on its own*. This repo's list of "correct mechanism, reached by
 * nothing" is nine entries long, and the ninth was this feature's own
 * `thinking` flag. So the thing pinned here is the round trip a real turn makes.
 *
 * What the API says, and why silence is the failure mode: *"Required: within a
 * tool-use turn, pass thinking blocks back"* — but omitting them is not a 400.
 * The server *"may strip thinking blocks that would create an invalid turn
 * structure, or disable thinking when the conversation history is
 * incompatible"*. So nothing was ever going to break loudly, which is why this
 * needs a test and not a code review.
 */
describe('the loop hands the model its own reasoning back', () => {
  // U1 (judge, 2026-08-13): 20 characters, which used to be this fixture's
  // whole `thinking` string, makes any truncate-at-N mutation with N>=20 a
  // no-op against the "byte-identical" assertions below — the mutation would
  // still pass. Long enough that a truncation has somewhere to bite.
  const THINKING = {
    type: 'thinking' as const,
    thinking:
      'devo leggere il file di configurazione per capire quale profilo è stato selezionato, poi controllare se il nome del modello combacia con uno dei pattern dichiarati prima di decidere come procedere',
    signature: 'sig-abc',
  };
  const REDACTED = { type: 'redacted_thinking' as const, data: 'ENCRYPTED-PAYLOAD' };

  /** A tool call that arrived with reasoning in front of it, as the real thing does. */
  const thinkThenCall = (name: string, id = 'toolu_1'): ChatResult => ({
    text: 'ci penso',
    toolCalls: [{ id, name, args: {} }],
    thinking: [THINKING, REDACTED],
    stopReason: 'tool_use',
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    model: 'test',
  });

  it('echoes them into the next request, unmodified and ahead of the tool_use', async () => {
    const provider = new ScriptedProvider([thinkThenCall('demo_read'), answer('fatto')]);
    const { deps: d, store } = deps([], { provider });
    await runTurn(d, input(store));

    // The second request is the one that carries the tool result — the exact
    // moment the docs call Required.
    const assistant = provider.seen[1]!.messages.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    const blocks = assistant!.content;

    // Unmodified: deep equality against what the provider produced. A mutation
    // that blanks `signature`, re-serialises, or "normalises" the payload dies
    // here — and `signature` is the only thing that makes the block mean
    // anything to the server.
    expect(blocks[0]).toEqual(THINKING);
    // Both kinds. Filtering on `type === 'thinking'` alone is the failure the
    // docs name by hand; it would leave this index holding the text block.
    expect(blocks[1]).toEqual(REDACTED);

    // In front. "alongside the tool_use block it accompanied" — a mutation that
    // appends them after the calls, or interleaves them, dies here.
    const types = blocks.map((b) => b.type);
    expect(types).toEqual(['thinking', 'redacted_thinking', 'text', 'tool_use']);
  });

  it('keeps the head order at every assistant turn, not just the first', async () => {
    // U1 (judge, 2026-08-13): the test above reads `provider.seen[1]` only,
    // which exists once per turn — nothing pinned block order past iteration
    // 1. The judge's mutation (head placement correct on the first assistant
    // turn, tail thereafter) survived all 702 tests. Two tool-calling
    // iterations here, checked per-message rather than flattened: flattening
    // across messages (as the compaction test below already did) can hide a
    // block sitting in the wrong position *within* one message.
    const provider = new ScriptedProvider([
      thinkThenCall('demo_read', 'toolu_1'),
      thinkThenCall('demo_read', 'toolu_2'),
      answer('fatto'),
    ]);
    const { deps: d, store } = deps([], { provider });
    await runTurn(d, input(store));

    const third = provider.seen[2]!;
    const assistantTurns = third.messages.filter((m) => m.role === 'assistant');
    expect(assistantTurns).toHaveLength(2);
    for (const turn of assistantTurns) {
      expect(turn.content.map((b) => b.type)).toEqual(['thinking', 'redacted_thinking', 'text', 'tool_use']);
    }
  });

  it('sends the profile\'s thinking mode, instead of declaring it and passing nothing', async () => {
    // The defect this closes: every profile carried `thinking`, the adapter knew
    // how to spell it, and no request ever contained it.
    const provider = new ScriptedProvider([answer('ok')]);
    const { deps: d, store } = deps([], {
      provider,
      profile: { ...CONSERVATIVE, thinking: 'adaptive', sampling: 'model-default' },
    });
    await runTurn(d, input(store));

    expect(provider.seen[0]?.thinking).toBe('adaptive');
    // …and the sampling parameter the 5-series rejects is *absent*, not
    // undefined: `'temperature' in call` is the assertion, because a key
    // holding undefined is a key on the wire for some serialisers.
    expect(provider.seen[0]).not.toHaveProperty('temperature');
  });

  it('still sends temperature 0 where a profile asks for it', async () => {
    // The other direction of the same switch: a local model wanders without it,
    // and CONSERVATIVE is what an unrecognised model gets.
    const provider = new ScriptedProvider([answer('ok')]);
    const { deps: d, store } = deps([], { provider, profile: CONSERVATIVE });
    await runTurn(d, input(store));

    expect(provider.seen[0]?.temperature).toBe(0);
    expect(provider.seen[0]?.thinking).toBe('off');
  });

  it("omits thinking entirely for 'unset' — the ADR's own escape hatch, made reachable", async () => {
    // D2 (judge, 2026-08-13): ADR-0037's reversibility plan says "si spegne
    // il campo (`thinking` assente resta una forma valida e l'adapter la
    // supporta già)" — but until 'unset' existed, no profile value made this
    // line take that branch: `thinking: deps.profile.thinking` ran
    // unconditionally and `Profile.thinking` had no value that meant
    // "omit". This is the test that proves the documented remedy is
    // reachable, not merely described. It also closes D1's own hole: Claude
    // Fable 5 and Claude Mythos 5 reject `{type:'disabled'}` outright, so
    // 'off' is not a safe substitute for a profile that targets them.
    const provider = new ScriptedProvider([answer('ok')]);
    const { deps: d, store } = deps([], {
      provider,
      profile: { ...CONSERVATIVE, thinking: 'unset' },
    });
    await runTurn(d, input(store));

    expect(provider.seen[0]).not.toHaveProperty('thinking');
  });

  it('survives compaction: clearing a tool result must not touch the reasoning', async () => {
    // compactToolResults rewrites tool_result payloads in place. It walks every
    // block of every message, and a thinking block that came back edited is a
    // 400 — the one loud failure in this whole area. This is the test that says
    // the two features were asked what they do to each other (PRACTICES §11).
    const big = 'x'.repeat(200_000);
    const provider = new ScriptedProvider([
      thinkThenCall('demo_big'),
      { ...thinkThenCall('demo_big'), toolCalls: [{ id: 'toolu_2', name: 'demo_big', args: {} }] },
      answer('fatto'),
    ]);
    const { deps: d, store } = deps([], {
      provider,
      tools: [
        {
          capability: 'demo.read',
          spec: { name: 'demo_big', description: 'big', inputSchema: { type: 'object', properties: {} } },
          handler: () => ({ content: big, tier: 0 as const }),
        },
      ],
      capabilities: new Map([
        ['demo.read', { id: 'demo.read', risk: 'low', reversible: 'yes', rerunnable: true, resourceKind: 'none', policyArgs: [], hostOnly: false } as CapabilityDecl],
      ]),
    });
    await runTurn(d, input(store));

    const third = provider.seen[2]!;
    // Compaction actually fired — otherwise this test proves nothing.
    const cleared = third.messages.some((m) =>
      m.content.some((b) => b.type === 'tool_result' && b.content.includes('rimosso dal contesto')),
    );
    expect(cleared).toBe(true);
    // …and every reasoning block is byte-identical to what came out.
    const kept = third.messages.flatMap((m) => m.content).filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking');
    expect(kept).toEqual([THINKING, REDACTED, THINKING, REDACTED]);
  });
});
