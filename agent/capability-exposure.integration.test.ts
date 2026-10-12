import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecide } from '../core/policy/decide.js';
import { POLICY_FLOOR } from '../core/policy/matrix.js';
import type { CapabilityDecl, Principal } from '../core/policy/types.js';
import { JobStore } from '../core/scheduler/jobs.js';
import { SessionStore } from '../core/session/store.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { TurnStore } from '../core/turns/store.js';
import { TodoStore } from '../core/turns/todo.js';
import { type LoopDeps, type RegisteredTool, runTurn } from './loop.js';
import { CAPABILITY_DISCOVERY_GUIDANCE } from './capability-exposure.js';
import { CONSERVATIVE } from './profiles/profile.js';
import { makeScheduleTool, scheduleCapability } from './tools/schedule.js';
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

class SchemaDriven implements Provider {
  readonly kind = 'openai-compat' as const;
  readonly seen: ChatCall[] = [];
  private searched = false;
  private executed = false;

  async chat(call: ChatCall): Promise<ChatResult> {
    this.seen.push(call);
    const names = new Set(call.tools?.map((tool) => tool.name) ?? []);

    if (names.has('event_watch_create') && !this.executed) {
      this.executed = true;
      return toolCall('hidden-auto', 'event_watch_create', {});
    }
    if (names.has('capability_search') && !this.searched) {
      this.searched = true;
      return toolCall('search-auto', 'capability_search', {
        query: 'durable external event trigger',
        max_results: 1,
      });
    }
    return answer(this.executed ? 'done' : 'capability unavailable');
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
      text: 'sorveglia una condizione remota e reagisci quando cambia',
    });

    expect(result.stopped).toBe('answered');
    expect(hiddenCalls).toBe(1);
    expect(provider.seen).toHaveLength(3);

    const firstNames = provider.seen[0]?.tools?.map((tool) => tool.name) ?? [];
    expect(firstNames).toContain('capability_search');
    expect(JSON.stringify(provider.seen[0]?.messages ?? [])).toContain(
      CAPABILITY_DISCOVERY_GUIDANCE,
    );
    expect(firstNames).not.toContain('event_watch_create');
    expect(firstNames.length).toBeLessThanOrEqual(6);

    const secondNames = provider.seen[1]?.tools?.map((tool) => tool.name) ?? [];
    expect(secondNames).toContain('capability_search');
    expect(secondNames).toContain('event_watch_create');
    expect(secondNames.length).toBeLessThanOrEqual(6);
  });
  it('keeps forbidden tools out of discovery while direct guesses still meet the kernel', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-capability-authority-'));
    const db = new DatabaseCtor(':memory:');
    const allowed = [
      inertTool('fs_read'),
      inertTool('fs_list'),
      inertTool('memory_search'),
      inertTool('http_get'),
      inertTool('todo'),
    ];
    let forbiddenCalls = 0;
    const forbiddenDecl = declaration('host.secret_write', true);
    const forbidden: RegisteredTool = {
      capability: forbiddenDecl.id,
      spec: {
        name: 'forbidden_host_write',
        description: 'Write a host-only secret.',
        inputSchema: { type: 'object' },
      },
      throwTier: 0,
      handler: () => {
        forbiddenCalls += 1;
        return { content: 'should never run', tier: 0 };
      },
    };
    const search = makeCapabilitySearchTool();
    const tools = [...allowed.map((entry) => entry.tool), forbidden, search];
    const capabilities = new Map<string, CapabilityDecl>([
      ...allowed.map((entry) => [entry.decl.id, entry.decl] as const),
      [forbiddenDecl.id, forbiddenDecl],
      [capabilityDiscoveryCapability.id, capabilityDiscoveryCapability],
    ]);
    const provider = new Scripted([
      toolCall('search-forbidden', 'capability_search', {
        query: 'host secret write',
        max_results: 3,
      }),
      // Deliberately guess the hidden name anyway. Discovery is not the
      // authority gate: the canonical kernel must refuse this call.
      toolCall('guess-forbidden', 'forbidden_host_write', {}),
      answer('denied'),
    ]);
    const sessions = new SessionStore(home);
    const deps: LoopDeps = {
      provider,
      profile: { ...CONSERVATIVE, maxToolsExposed: 4, recovery: [] },
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
    const member: Principal = {
      kind: 'member',
      connector: 'telegram',
      tenantId: 'group:test',
      externalId: 'u1',
    };

    const result = await runTurn(deps, {
      principal: member,
      tenant: 'group:test',
      surface: 'telegram',
      session: sessions.open('capability-authority'),
      text: 'scrivi un segreto host',
    });

    expect(result.stopped).toBe('answered');
    expect(forbiddenCalls).toBe(0);
    expect(provider.seen).toHaveLength(3);
    for (const call of provider.seen) {
      expect(call.tools?.map((tool) => tool.name) ?? []).not.toContain('forbidden_host_write');
    }

    // The search response must not disclose the forbidden tool or capability.
    const discoveryReply = provider.seen[1]?.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === 'tool_result' && block.toolCallId === 'search-forbidden');
    expect(discoveryReply?.type).toBe('tool_result');
    if (discoveryReply?.type !== 'tool_result') throw new Error('discovery reply missing');
    expect(discoveryReply.content).not.toContain('forbidden_host_write');
    expect(discoveryReply.content).not.toContain('host.secret_write');

    // The guessed tool name is resolved from the full registry and must
    // produce the canonical kernel denial, NOT an unknown-tool refusal.
    // This pins the exact defence-in-depth branch, not merely a handler count.
    const guessedReply = provider.seen[2]?.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === 'tool_result' && block.toolCallId === 'guess-forbidden');
    expect(guessedReply?.type).toBe('tool_result');
    if (guessedReply?.type !== 'tool_result') throw new Error('kernel reply missing');
    expect(guessedReply.isError).toBe(true);
    expect(guessedReply.content).toContain('principal_forbidden');
    expect(guessedReply.content).not.toContain('non esiste');
  });


  it('system@scheduler never discovers kernel-forbidden schedule or namespace tools, even under preload pressure', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-capability-scheduler-authority-'));
    const db = new DatabaseCtor(':memory:');
    const basic = [
      inertTool('fs_read'),
      inertTool('memory_search'),
      inertTool('http_get'),
      inertTool('todo'),
      inertTool('skill_read'),
    ];
    const schedule = makeScheduleTool({
      jobs: new JobStore(db),
      defaultTimezone: 'Europe/Rome',
      defaultChannel: 'cli',
    });
    let scheduleCalls = 0;
    const scheduleObserved: RegisteredTool = {
      ...schedule,
      handler: (args, ctx) => {
        scheduleCalls += 1;
        return schedule.handler(args, ctx);
      },
    };
    // The sealed policy prohibits outward.* namespaces, including new future
    // siblings not explicitly listed by name in POLICY_FLOOR.
    const outwardDecl = declaration('outward.email.send');
    let outwardCalls = 0;
    const outward: RegisteredTool = {
      capability: outwardDecl.id,
      spec: {
        name: 'outward_email_send',
        description: 'Send recurring email update outside the tenant.',
        inputSchema: { type: 'object' },
      },
      throwTier: 0,
      handler: () => {
        outwardCalls += 1;
        return { content: 'should never send', tier: 0 };
      },
    };
    const allowedDecl = declaration('event.watch');
    const allowed: RegisteredTool = {
      capability: allowedDecl.id,
      spec: {
        name: 'event_watch_create',
        description: 'Create a durable trigger on an external event condition.',
        inputSchema: { type: 'object' },
      },
      throwTier: 0,
      handler: () => ({ content: 'watch ok', tier: 0 }),
    };
    const search = makeCapabilitySearchTool();
    const tools = [
      ...basic.map((entry) => entry.tool),
      scheduleObserved,
      outward,
      allowed,
      search,
    ];
    const capabilities = new Map<string, CapabilityDecl>([
      ...basic.map((entry) => [entry.decl.id, entry.decl] as const),
      [scheduleCapability.id, scheduleCapability],
      [outwardDecl.id, outwardDecl],
      [allowedDecl.id, allowedDecl],
      [capabilityDiscoveryCapability.id, capabilityDiscoveryCapability],
    ]);
    const provider = new Scripted([
      toolCall('scheduler-search', 'capability_search', {
        query: 'schedule recurring reminder and send outward email',
        max_results: 5,
      }),
      // An unsupported tool name can still be emitted by a model. It must
      // meet the regular kernel, not bypass it or turn into "unknown tool".
      toolCall('scheduler-guess', 'schedule_recurring', {
        cron: '0 9 * * *',
        goal: 'repeat tomorrow',
      }),
      toolCall('scheduler-authorized-search', 'capability_search', {
        query: 'durable trigger on an external event condition',
        max_results: 3,
      }),
      answer('done'),
    ]);
    const sessions = new SessionStore(home);
    const deps: LoopDeps = {
      provider,
      profile: { ...CONSERVATIVE, maxToolsExposed: 4, recovery: [] },
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
      principal: { kind: 'system', source: 'scheduler' },
      tenant: 'host',
      surface: 'cli',
      session: sessions.open('capability-scheduler-deny'),
      text: 'schedule a recurring reminder and send an outward email',
    });

    expect(result.stopped).toBe('answered');
    expect(scheduleCalls).toBe(0);
    expect(outwardCalls).toBe(0);
    expect(provider.seen).toHaveLength(4);

    // Static principal denials must happen BEFORE initial text preload.
    // They must stay excluded from every round, even if the prompt and
    // search terms explicitly select their names and descriptions.
    for (const request of provider.seen) {
      const visible = request.tools?.map((tool) => tool.name) ?? [];
      expect(visible).not.toContain('schedule_recurring');
      expect(visible).not.toContain('outward_email_send');
      expect(visible.length).toBeLessThanOrEqual(4);
    }
    const forbiddenDiscovery = provider.seen[1]?.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === 'tool_result' && block.toolCallId === 'scheduler-search');
    expect(forbiddenDiscovery?.type).toBe('tool_result');
    if (forbiddenDiscovery?.type !== 'tool_result') throw new Error('scheduler discovery result missing');
    expect(forbiddenDiscovery.content).not.toContain('schedule_recurring');
    expect(forbiddenDiscovery.content).not.toContain('jobs.schedule');
    expect(forbiddenDiscovery.content).not.toContain('outward_email_send');
    expect(forbiddenDiscovery.content).not.toContain('outward.email.send');

    const guessedReply = provider.seen[2]?.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === 'tool_result' && block.toolCallId === 'scheduler-guess');
    expect(guessedReply?.type).toBe('tool_result');
    if (guessedReply?.type !== 'tool_result') throw new Error('scheduler kernel result missing');
    expect(guessedReply.isError).toBe(true);
    expect(guessedReply.content).toContain('principal_forbidden');

    // Filtering forbidden tools must not silently disable legitimate hidden
    // capabilities. Search still returns an authorized external-event tool.
    const allowedDiscovery = provider.seen[3]?.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === 'tool_result' && block.toolCallId === 'scheduler-authorized-search');
    expect(allowedDiscovery?.type).toBe('tool_result');
    if (allowedDiscovery?.type !== 'tool_result') throw new Error('authorized discovery result missing');
    expect(allowedDiscovery.content).toContain('event_watch_create');
    expect(provider.seen[3]?.tools?.map((tool) => tool.name)).toContain('event_watch_create');
  });

  it('load-bearing mutation: removing the discovery door makes the beyond-cap task unrecoverable', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-capability-mutation-'));
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

    // Deliberate mutation of the runtime wiring: the hidden authorized tool
    // remains registered, but the #469 discovery door + declaration are
    // removed. A schema-driven provider can no longer discover its name.
    const tools = [...core.map((entry) => entry.tool), hidden];
    const capabilities = new Map<string, CapabilityDecl>([
      ...core.map((entry) => [entry.decl.id, entry.decl] as const),
      [hiddenDecl.id, hiddenDecl],
    ]);
    const provider = new SchemaDriven();
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

    await expect(
      runTurn(deps, {
        principal: owner,
        tenant: 'host',
        surface: 'cli',
        session: sessions.open('capability-mutation'),
        text: 'crea un trigger su un evento esterno',
      }),
    ).rejects.toThrow(
      'capability_search is required when the authorized catalogue exceeds maxToolsExposed',
    );

    // The expected failure is at the production projection boundary itself:
    // without the discovery door the runtime refuses to silently fall back to
    // registration-order truncation. No provider call and no hidden handler
    // execution occur.
    expect(hiddenCalls).toBe(0);
    expect(provider.seen).toHaveLength(0);
  });


  it('keeps the under-cap fast path free of discovery schema and guidance', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-capability-fast-path-'));
    const db = new DatabaseCtor(':memory:');
    const core = [inertTool('fs_read'), inertTool('fs_list')];
    const search = makeCapabilitySearchTool();
    const tools = [...core.map((entry) => entry.tool), search];
    const capabilities = new Map<string, CapabilityDecl>([
      ...core.map((entry) => [entry.decl.id, entry.decl] as const),
      [capabilityDiscoveryCapability.id, capabilityDiscoveryCapability],
    ]);
    const provider = new Scripted([answer('ok')]);
    const sessions = new SessionStore(home);
    const deps: LoopDeps = {
      provider,
      profile: { ...CONSERVATIVE, maxToolsExposed: 10, recovery: [] },
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
      session: sessions.open('capability-fast-path'),
      text: 'ciao',
    });

    expect(result.stopped).toBe('answered');
    expect(provider.seen).toHaveLength(1);
    expect(provider.seen[0]?.tools?.map((tool) => tool.name) ?? []).not.toContain(
      'capability_search',
    );
    expect(JSON.stringify(provider.seen[0]?.messages ?? [])).not.toContain(
      CAPABILITY_DISCOVERY_GUIDANCE,
    );
  });

});
