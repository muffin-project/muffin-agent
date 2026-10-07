import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecide } from '../core/policy/decide.js';
import { POLICY_FLOOR } from '../core/policy/matrix.js';
import type { CapabilityDecl, Principal } from '../core/policy/types.js';
import { SessionStore } from '../core/session/store.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { TurnStore } from '../core/turns/store.js';
import { TodoStore } from '../core/turns/todo.js';
import { type LoopDeps, type RegisteredTool, runTurn } from './loop.js';
import { CONSERVATIVE } from './profiles/profile.js';
import type { ChatCall, ChatResult, Provider } from './providers/types.js';
import {
  capabilityDiscoveryCapability,
  makeCapabilitySearchTool,
} from './tools/capability-search.js';

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };

function declaration(id: string, hostOnly = false): CapabilityDecl {
  return {
    id,
    effect: 'context',
    risk: 'low',
    reversible: 'yes',
    rerunnable: true,
    resourceKind: 'none',
    policyArgs: [],
    hostOnly,
  };
}

function inertTool(name: string): { tool: RegisteredTool; decl: CapabilityDecl } {
  const decl = declaration('test.' + name);
  return {
    decl,
    tool: {
      capability: decl.id,
      spec: { name, description: 'Test capability ' + name, inputSchema: { type: 'object' } },
      throwTier: 0,
      handler: () => ({ content: 'ok', tier: 0 }),
    },
  };
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ChatResult {
  return {
    text: null,
    toolCalls: [{ id, name, args }],
    stopReason: 'tool_use',
    usage,
    model: 'test-model',
  };
}

function answer(text: string): ChatResult {
  return { text, toolCalls: [], stopReason: 'end', usage, model: 'test-model' };
}

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  readonly seen: ChatCall[] = [];
  private index = 0;

  constructor(private readonly replies: ChatResult[]) {}

  async chat(call: ChatCall): Promise<ChatResult> {
    this.seen.push(call);
    const result = this.replies[this.index++];
    if (!result) throw new Error('script exhausted');
    return result;
  }
}

describe('#469 production-path capability discovery', () => {
  it('loads an authorized beyond-cap tool into the next model round and executes it normally', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-capability-discovery-'));
    const db = new DatabaseCtor(':memory:');
    const core = [
      inertTool('fs_read'),
      inertTool('fs_list'),
      inertTool('fs_search'),
      inertTool('memory_search'),
      inertTool('skill_read'),
      inertTool('http_get'),
      inertTool('todo'),
    ];
    let hiddenCalls = 0;
    const hiddenDecl = declaration('event.watch');
    const hidden: RegisteredTool = {
      capability: hiddenDecl.id,
      spec: {
        name: 'event_watch_create',
        description: 'Create a durable external event trigger when a condition matches.',
        inputSchema: { type: 'object' },
      },
      throwTier: 0,
      handler: () => {
        hiddenCalls += 1;
        return { content: 'watch created', tier: 0 };
      },
    };
    const search = makeCapabilitySearchTool();
    const tools = [...core.map((entry) => entry.tool), hidden, search];
    const capabilities = new Map<string, CapabilityDecl>([
      ...core.map((entry) => [entry.decl.id, entry.decl] as const),
      [hiddenDecl.id, hiddenDecl],
      [capabilityDiscoveryCapability.id, capabilityDiscoveryCapability],
    ]);
    const provider = new Scripted([
      toolCall('search-1', 'capability_search', {
        query: 'durable external event trigger',
        max_results: 1,
      }),
      toolCall('hidden-1', 'event_watch_create', {}),
      answer('done'),
    ]);
    const sessions = new SessionStore(home);
    const deps: LoopDeps = {
      provider,
      profile: { ...CONSERVATIVE, maxToolsExposed: 6, recovery: [] },
      model: 'test-model',
      tools,
      capabilities,
      decide: createDecide({
        matrix: POLICY_FLOOR,
        capabilities,
        budgetExhausted: () => false,
        hardened: true,
      }),
      tracer: new SimpleTracer(new JsonlExporter(home)),
      sessions,
      turns: new TurnStore(db),
      todos: new TodoStore(db),
      budgetExhausted: () => false,
      systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite.' },
    };

    const result = await runTurn(deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session: sessions.open('capability-discovery'),
      text: 'crea un trigger su un evento esterno',
    });

    expect(result.stopped).toBe('answered');
    expect(hiddenCalls).toBe(1);
    expect(provider.seen).toHaveLength(3);

    const firstNames = provider.seen[0]?.tools?.map((tool) => tool.name) ?? [];
    expect(firstNames).toContain('capability_search');
    expect(firstNames).not.toContain('event_watch_create');
    expect(firstNames.length).toBeLessThanOrEqual(6);

    const secondNames = provider.seen[1]?.tools?.map((tool) => tool.name) ?? [];
    expect(secondNames).toContain('capability_search');
    expect(secondNames).toContain('event_watch_create');
    expect(secondNames.length).toBeLessThanOrEqual(6);
  });
});
