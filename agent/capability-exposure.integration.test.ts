import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { runInit } from '../cli/init.js';
import { ApprovalStore } from '../core/approvals/store.js';
import { paths } from '../core/config/config.js';
import { createDecide } from '../core/policy/decide.js';
import { POLICY_FLOOR } from '../core/policy/matrix.js';
import type { CapabilityDecl, Principal } from '../core/policy/types.js';
import { seal } from '../core/rot/verify.js';
import { JobStore } from '../core/scheduler/jobs.js';
import { SessionStore } from '../core/session/store.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { TurnStore } from '../core/turns/store.js';
import { TodoStore } from '../core/turns/todo.js';
import { CAPABILITY_DISCOVERY_GUIDANCE } from './capability-exposure.js';
import { type LoopDeps, type RegisteredTool, resumeTurn, runTurn } from './loop.js';
import { CONSERVATIVE } from './profiles/profile.js';
import type { ChatCall, ChatResult, Provider } from './providers/types.js';
import { buildRuntime } from './runtime.js';
import {
  capabilityDiscoveryCapability,
  makeCapabilitySearchTool,
} from './tools/capability-search.js';
import { makeScheduleTool, scheduleCapability } from './tools/schedule.js';
import { shellWriteCapability } from './tools/shell.js';
import { makeWaitTool, waitCapability } from './tools/wait.js';

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
  return toolBatch({ id, name, args });
}

function toolBatch(...toolCalls: ChatResult['toolCalls']): ChatResult {
  return {
    text: null,
    toolCalls,
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
  it('discovers a hidden effect after a visible tool covers only part of the requested task', async () => {
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
      toolCall('read-1', 'fs_read', {}),
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
      text: 'Read the project notes and make their shared instruction recur automatically.',
    });

    expect(result.stopped).toBe('answered');
    expect(hiddenCalls).toBe(1);
    expect(provider.seen).toHaveLength(4);

    const firstNames = provider.seen[0]?.tools?.map((tool) => tool.name) ?? [];
    expect(firstNames).toContain('fs_read');
    expect(firstNames).toContain('capability_search');
    expect(JSON.stringify(provider.seen[0]?.messages ?? [])).toContain(
      CAPABILITY_DISCOVERY_GUIDANCE,
    );
    expect(firstNames).not.toContain('event_watch_create');

    const secondNames = provider.seen[1]?.tools?.map((tool) => tool.name) ?? [];
    expect(secondNames).toContain('capability_search');

    const thirdNames = provider.seen[2]?.tools?.map((tool) => tool.name) ?? [];
    expect(thirdNames).toContain('event_watch_create');
    expect(thirdNames).toContain('capability_search');
    expect(JSON.stringify(provider.seen[0]?.messages ?? [])).toContain(
      'Valuta separatamente ogni azione ed effetto richiesto',
    );
  });

  it.each(['process exit', 'interrupted claim', 'revoked tool'] as const)(
    'rebuilds the approval menu through current policy after %s',
    async (resume) => {
      const home = mkdtempSync(join(tmpdir(), 'muffin-capability-approval-'));
      const db = new DatabaseCtor(':memory:');
      const missingPid = 999_999_999;
      const afterCrash = resume === 'interrupted claim';
      const turns = new TurnStore(db);
      const approvals = new ApprovalStore(db);
      const sessions = new SessionStore(home);
      const write = {
        id: 'initial-write',
        name: 'shell_run_write',
        args: { command: 'printf 42' },
      };
      const wait = {
        id: 'wait-for-exit',
        name: 'wait',
        args: { seconds: 600, until_process_exits: missingPid },
      };
      const provider = new Scripted([
        toolCall('discover', 'capability_search', { query: write.name, max_results: 1 }),
        toolBatch(write, ...(!afterCrash ? [wait] : [])),
        toolCall('repeat-write', write.name, write.args),
        answer('done'),
      ]);
      const capabilities = new Map(
        [capabilityDiscoveryCapability, shellWriteCapability, waitCapability].map((capability) => [
          capability.id,
          capability,
        ]),
      );
      const decide = createDecide({
        matrix: POLICY_FLOOR,
        capabilities,
        budgetExhausted: () => false,
        hardened: false,
      });
      let executions = 0;
      let revoked = false;
      const deps: LoopDeps = {
        provider,
        profile: { ...CONSERVATIVE, recovery: [] },
        model: 'test-model',
        capabilities,
        decide: (request) =>
          revoked && request.capability === shellWriteCapability.id
            ? { effect: 'deny', code: 'principal_forbidden', detail: 'fixture revoked' }
            : decide(request),
        tracer: new SimpleTracer(new JsonlExporter(home)),
        sessions,
        turns,
        todos: new TodoStore(db),
        approvals,
        approve: async () => 'asked',
        tools: [
          {
            ...inertTool(write.name).tool,
            capability: shellWriteCapability.id,
            handler: () => {
              executions += 1;
              return { content: 'printed 42', tier: 0 };
            },
          },
          makeCapabilitySearchTool(),
          makeWaitTool(turns),
        ],
        budgetExhausted: () => false,
        systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite.' },
      };

      try {
        const initial = await runTurn(deps, {
          principal: owner,
          tenant: 'host',
          surface: 'cli',
          session: sessions.open('approval-resume'),
          text: 'Somma 27 e 16.',
        });
        expect(initial.stopped).toBe('suspended');
        expect(provider.seen[0]?.tools?.map((tool) => tool.name)).not.toContain(write.name);
        expect(provider.seen[1]?.tools?.map((tool) => tool.name)).toContain(write.name);
        const grant = approvals.open(initial.turnId);
        expect(grant).not.toBeNull();
        expect(turns.get(initial.turnId)?.waitFor).toBe(
          afterCrash ? `approval:${grant?.id}` : `process_exit:${missingPid}`,
        );
        expect(approvals.decide(grant?.id ?? '', 'allow', new Date())).toBe('ok');
        expect(turns.wake(initial.turnId, new Date())).toBe(true);
        if (afterCrash) {
          const claimed = turns.claim(initial.turnId, missingPid);
          expect(claimed?.waitFor).toBeNull();
          expect(turns.reclaim().map((turn) => turn.id)).toEqual([initial.turnId]);
        }
        revoked = resume === 'revoked tool';
        await resumeTurn(deps, initial.turnId);
        const resumedNames = provider.seen[2]?.tools?.map((tool) => tool.name) ?? [];
        expect(resumedNames.includes(write.name)).toBe(!revoked);
        expect(executions).toBe(revoked ? 0 : 1);
      } finally {
        db.close();
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it.each([false, true])('unions all discoveries in a batch (trailing miss: %s)', async (miss) => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-capability-batch-'));
    const db = new DatabaseCtor(':memory:');
    const catalogue = [
      inertTool('fs_read'),
      inertTool('inventory_lookup'),
      inertTool('translate_document'),
      inertTool('calibrate_sensor'),
    ];
    const discoveries = [
      { id: 'find-inventory', name: 'capability_search', args: { query: 'inventory_lookup' } },
      { id: 'find-translation', name: 'capability_search', args: { query: 'translate_document' } },
      { id: 'find-inventory-again', name: 'capability_search', args: { query: 'inventory' } },
    ];
    if (miss)
      discoveries.push({ id: 'miss', name: 'capability_search', args: { query: 'zzzzzz' } });
    const provider = new Scripted([
      toolBatch(...discoveries),
      toolCall('find-calibration', 'capability_search', { query: 'calibrate_sensor' }),
      answer('done'),
    ]);
    const sessions = new SessionStore(home);
    const capabilities = new Map(catalogue.map(({ decl }) => [decl.id, decl]));
    capabilities.set(capabilityDiscoveryCapability.id, capabilityDiscoveryCapability);

    try {
      const result = await runTurn(
        {
          provider,
          profile: { ...CONSERVATIVE, recovery: [] },
          model: 'test-model',
          tools: [...catalogue.map(({ tool }) => tool), makeCapabilitySearchTool()],
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
        },
        {
          principal: owner,
          tenant: 'host',
          surface: 'cli',
          session: sessions.open('capability-batch'),
          text: 'Begin.',
        },
      );

      expect(result.stopped).toBe('answered');
      if (miss) {
        expect(provider.seen[1]?.messages.flatMap((message) => message.content)).toContainEqual(
          expect.objectContaining({
            type: 'tool_result',
            toolCallId: 'miss',
            content: 'No authorized hidden capability matched that query.',
          }),
        );
      }
      expect(provider.seen.map((request) => request.tools?.map(({ name }) => name))).toEqual([
        ['fs_read', 'capability_search'],
        ['fs_read', 'capability_search', 'inventory_lookup', 'translate_document'],
        // A later discovery adds to what the turn already loaded.
        [
          'fs_read',
          'capability_search',
          'inventory_lookup',
          'translate_document',
          'calibrate_sensor',
        ],
      ]);
    } finally {
      db.close();
    }
  });

  it.each(['deferred', 'flat'] as const)(
    'applies categorical owner denials to the %s catalogue without treating resource checks as eligibility',
    async (mode) => {
      const home = mkdtempSync(join(tmpdir(), 'muffin-capability-owner-authority-'));
      const db = new DatabaseCtor(':memory:');
      const core = inertTool('fs_read');
      const sealed = inertTool('sealed_setting');
      const high = inertTool('high_risk');
      const undeclared = inertTool('undeclared_tool');
      const url = inertTool('public_url');
      const deferred = mode === 'deferred';
      const sessions = new SessionStore(home);
      const invoked = vi.fn(url.tool.handler);
      const forbidden = vi.fn(sealed.tool.handler);
      const capabilities = new Map([
        [core.decl.id, core.decl],
        [sealed.decl.id, sealed.decl],
        [high.decl.id, { ...high.decl, risk: 'high' as const }],
        [url.decl.id, { ...url.decl, resourceKind: 'url-read' as const, policyArgs: ['url'] }],
      ]);
      if (deferred)
        capabilities.set(capabilityDiscoveryCapability.id, capabilityDiscoveryCapability);
      const provider = new Scripted([
        ...(deferred
          ? [
              toolCall('search-sealed', 'capability_search', { query: 'sealed_setting' }),
              toolCall('search-url', 'capability_search', { query: 'public_url' }),
            ]
          : []),
        toolCall('read-url', 'public_url', { url: 'https://public.example/' }),
        toolCall('guess-sealed', 'sealed_setting', {}),
        answer('done'),
      ]);

      try {
        const result = await runTurn(
          {
            provider,
            profile: { ...CONSERVATIVE, recovery: [] },
            model: 'test-model',
            tools: [
              core.tool,
              { ...sealed.tool, handler: forbidden },
              high.tool,
              undeclared.tool,
              { ...url.tool, handler: invoked },
              ...(deferred ? [makeCapabilitySearchTool()] : []),
            ],
            capabilities,
            decide: createDecide({
              matrix: {
                ...POLICY_FLOOR,
                neverAtRuntime: new Set([...POLICY_FLOOR.neverAtRuntime, sealed.decl.id]),
              },
              capabilities,
              safeMode: true,
              budgetExhausted: () => false,
              hardened: true,
            }),
            tracer: new SimpleTracer(new JsonlExporter(home)),
            sessions,
            turns: new TurnStore(db),
            todos: new TodoStore(db),
            budgetExhausted: () => false,
            systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite.' },
          },
          {
            principal: owner,
            tenant: 'host',
            surface: 'cli',
            session: sessions.open('capability-owner-authority'),
            text: 'sealed_setting high_risk undeclared_tool',
          },
        );

        expect(result.stopped).toBe('answered');
        expect(invoked).toHaveBeenCalledOnce();
        expect(forbidden).not.toHaveBeenCalled();
        const menus = provider.seen.map((request) => request.tools?.map(({ name }) => name));
        expect(menus).toEqual(
          deferred
            ? [
                ['fs_read', 'capability_search'],
                ['fs_read', 'capability_search'],
                ['fs_read', 'capability_search', 'public_url'],
                ['fs_read', 'capability_search', 'public_url'],
                ['fs_read', 'capability_search', 'public_url'],
              ]
            : Array.from({ length: 3 }, () => ['fs_read', 'public_url']),
        );
        const results = provider.seen.at(-1)?.messages.flatMap((message) => message.content);
        if (deferred) {
          expect(results).toContainEqual(
            expect.objectContaining({
              type: 'tool_result',
              toolCallId: 'search-sealed',
              content: 'No authorized hidden capability matched that query.',
            }),
          );
        }
        expect(results).toContainEqual(
          expect.objectContaining({
            type: 'tool_result',
            toolCallId: 'guess-sealed',
            isError: true,
            content: expect.stringContaining('rot_violation'),
          }),
        );
      } finally {
        db.close();
      }
    },
  );

  it.each([false, true])(
    'uses full eligible projection whenever discovery is denied by taint (already tainted: %s)',
    async (alreadyTainted) => {
      const home = mkdtempSync(join(tmpdir(), 'muffin-capability-discovery-taint-'));
      const db = new DatabaseCtor(':memory:');
      const reader = inertTool('fs_read');
      const available = inertTool('host_inspect_probe');
      const sealed = inertTool('sealed_setting');
      const invoked = vi.fn(available.tool.handler);
      const capabilities = new Map<string, CapabilityDecl>([
        [reader.decl.id, reader.decl],
        [available.decl.id, { ...available.decl, effect: 'host' }],
        [sealed.decl.id, sealed.decl],
        [capabilityDiscoveryCapability.id, capabilityDiscoveryCapability],
      ]);
      const provider = new Scripted([
        ...(alreadyTainted ? [] : [toolCall('read', 'fs_read', {})]),
        toolCall('host', 'host_inspect_probe', {}),
        toolCall('guess-search', 'capability_search', { query: 'host_inspect_probe' }),
        answer('done'),
      ]);
      const sessions = new SessionStore(home);

      try {
        const result = await runTurn(
          {
            provider,
            profile: { ...CONSERVATIVE, recovery: [] },
            model: 'test-model',
            tools: [
              { ...reader.tool, handler: () => ({ content: 'Untrusted source.', tier: 2 }) },
              { ...available.tool, handler: invoked },
              sealed.tool,
              makeCapabilitySearchTool(),
            ],
            capabilities,
            decide: createDecide({
              matrix: {
                ...POLICY_FLOOR,
                neverAtRuntime: new Set([...POLICY_FLOOR.neverAtRuntime, sealed.decl.id]),
                rows: {
                  ...POLICY_FLOOR.rows,
                  context: { ...POLICY_FLOOR.rows.context, denyAbove: 1 },
                },
              },
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
          },
          {
            principal: owner,
            tenant: 'host',
            surface: 'cli',
            session: sessions.open('capability-discovery-taint'),
            text: 'Begin.',
            ...(alreadyTainted ? { contentTaint: 2 } : {}),
          },
        );

        expect(result.stopped).toBe('answered');
        expect(invoked).toHaveBeenCalledOnce();
        const [first, ...remaining] = provider.seen;
        if (!alreadyTainted) {
          expect(first?.tools?.map(({ name }) => name)).toEqual(['fs_read', 'capability_search']);
          expect(JSON.stringify(first?.messages)).toContain(CAPABILITY_DISCOVERY_GUIDANCE);
        }
        for (const request of alreadyTainted ? provider.seen : remaining) {
          expect(request.tools?.map(({ name }) => name)).toEqual(['fs_read', 'host_inspect_probe']);
          expect(JSON.stringify(request.messages)).not.toContain(CAPABILITY_DISCOVERY_GUIDANCE);
        }
        expect(provider.seen.at(-1)?.messages.flatMap((message) => message.content)).toContainEqual(
          expect.objectContaining({
            type: 'tool_result',
            toolCallId: 'guess-search',
            isError: true,
            content: expect.stringContaining('taint_exceeded'),
          }),
        );
      } finally {
        db.close();
      }
    },
  );

  it('reports the actual flat menu in sys_inspect when sealed policy denies discovery', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-capability-inspect-'));
    const workspace = mkdtempSync(join(tmpdir(), 'muffin-capability-inspect-ws-'));
    runInit({ home, apiKey: 'sk-never-called' });
    writeFileSync(
      join(paths(home).rot, 'policy.json'),
      JSON.stringify({ schemaVersion: 1, neverAtRuntime: [capabilityDiscoveryCapability.id] }),
    );
    seal(home, '1', new Date());
    const runtime = buildRuntime(home, workspace);
    const provider = new Scripted([toolCall('inspect', 'sys_inspect', {}), answer('done')]);

    try {
      const result = await runTurn(
        { ...runtime.deps, provider, prepareTurn: undefined, memory: undefined },
        {
          principal: owner,
          tenant: 'host',
          surface: 'cli',
          session: runtime.deps.sessions.open('capability-inspect'),
          text: 'Inspect the current tool menu.',
        },
      );

      expect(result.stopped).toBe('answered');
      const exposed = provider.seen[0]?.tools?.map(({ name }) => name) ?? [];
      expect(exposed).toContain('sys_inspect');
      expect(exposed).not.toContain('capability_search');
      const report = provider.seen[1]?.messages
        .flatMap(({ content }) => content)
        .find((block) => block.type === 'tool_result' && block.toolCallId === 'inspect');
      if (report?.type !== 'tool_result') throw new Error('sys_inspect result missing');
      expect(report.isError).not.toBe(true);
      expect(report.content.split('\n')).toContain(
        `capability esposte: ${exposed.sort().join(', ')}`,
      );
      expect(report.content).not.toContain('catalogo discoverable');
      expect(report.content).toContain(
        "Senza la ricerca, il modello vede l'intero catalogo consentito.",
      );
    } finally {
      runtime.close();
    }
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
    const tools = [...basic.map((entry) => entry.tool), scheduleObserved, outward, allowed, search];
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
    }
    const forbiddenDiscovery = provider.seen[1]?.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === 'tool_result' && block.toolCallId === 'scheduler-search');
    expect(forbiddenDiscovery?.type).toBe('tool_result');
    if (forbiddenDiscovery?.type !== 'tool_result')
      throw new Error('scheduler discovery result missing');
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
      .find(
        (block) =>
          block.type === 'tool_result' && block.toolCallId === 'scheduler-authorized-search',
      );
    expect(allowedDiscovery?.type).toBe('tool_result');
    if (allowedDiscovery?.type !== 'tool_result')
      throw new Error('authorized discovery result missing');
    expect(allowedDiscovery.content).toContain('event_watch_create');
    expect(provider.seen[3]?.tools?.map((tool) => tool.name)).toContain('event_watch_create');
  });

  it('without the discovery door an authorized tool stays on the request', async () => {
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

    await runTurn(deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session: sessions.open('capability-mutation'),
      text: 'crea un trigger su un evento esterno',
    });

    // Without the discovery door the authorized tool is on the first request.
    // Dropping it because a count was exceeded is the failure this replaces.
    expect(provider.seen[0]?.tools?.map((tool) => tool.name)).toContain('event_watch_create');
    expect(hiddenCalls).toBe(1);
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
