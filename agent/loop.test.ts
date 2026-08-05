import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecide } from '../core/policy/decide.js';
import type { CapabilityDecl, Principal } from '../core/policy/types.js';
import { SessionStore } from '../core/session/store.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { runTurn, type LoopDeps, type RegisteredTool } from './loop.js';
import { CONSERVATIVE, type Profile } from './profiles/profile.js';
import { ProviderError, type ChatResult, type Provider } from './providers/types.js';

/** A provider that replays a script, so the loop is tested and not the model. */
class ScriptedProvider implements Provider {
  readonly kind = 'openai-compat' as const;
  calls = 0;
  constructor(private readonly script: (ChatResult | ProviderError)[]) {}
  async chat(): Promise<ChatResult> {
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

const decls: CapabilityDecl[] = [
  { id: 'demo.read', risk: 'low', reversible: 'yes', resourceKind: 'none', policyArgs: [], hostOnly: false },
  { id: 'demo.write', risk: 'medium', reversible: 'no', resourceKind: 'none', policyArgs: [], hostOnly: true },
];

function deps(script: (ChatResult | ProviderError)[], overrides: Partial<LoopDeps> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-loop-'));
  const calls: string[] = [];
  const tools: RegisteredTool[] = [
    {
      capability: 'demo.read',
      spec: { name: 'demo_read', description: 'read', inputSchema: { type: 'object', properties: {} } },
      handler: (args) => {
        calls.push(`demo_read:${JSON.stringify(args)}`);
        return { content: 'letto' };
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
        return { content: 'scritto' };
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
  const base: LoopDeps = {
    provider: new ScriptedProvider(script),
    profile: CONSERVATIVE,
    model: 'test-model',
    tools,
    decide: createDecide({
      capabilities: new Map(decls.map((d) => [d.id, d])),
      budgetExhausted: () => false,
      hardened: true,
    }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions: store,
    budgetExhausted: () => false,
    systemPrompt: 'Sei Muffin.',
    ...overrides,
  };
  return { deps: base, store, home, calls };
}

const input = (store: SessionStore, principal: Principal = { kind: 'owner', connector: 'cli' }) => ({
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
    const billed: { model: string; tenant: string }[] = [];
    const { deps: d, store } = deps([callTool('demo_read'), answer('fatto')], {
      recordSpend: (entry) => {
        billed.push({ model: entry.model, tenant: entry.tenant });
        return 0.01;
      },
    });
    await runTurn(d, input(store));
    // Two model calls in this turn, two billing records, both with the tenant.
    expect(billed).toHaveLength(2);
    expect(billed.every((b) => b.tenant === 'host')).toBe(true);
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

  it('refuses a draft instead of executing it as an allow', async () => {
    // `fs.write` is medium risk and undoable, so the kernel answers `draft`.
    // The loop had no branch for it and fell through to the handler: the write
    // happened immediately, with no undo journal and no window.
    const undoable: CapabilityDecl[] = [
      { id: 'demo.draft', risk: 'medium', reversible: 'undoable', resourceKind: 'none', policyArgs: [], hostOnly: true },
    ];
    const ran: string[] = [];
    const { deps: d, store } = deps([callTool('demo_draft'), answer('ok')], {
      decide: createDecide({
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
            return { content: 'scritto davvero' };
          },
        },
      ],
    });
    await runTurn(d, input(store));
    expect(ran).toEqual([]);
  });
});
