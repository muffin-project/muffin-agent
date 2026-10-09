import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../cli/init.js';
import { buildRuntime } from './runtime.js';
import {
  attachEventIntelligence,
  createMuffinEventIntelligence,
  getAttachedEventIntelligence,
  type EventWakePort,
} from './event-intelligence.js';
import { toolContext } from './fixtures/tool-context.js';
import type { LoopDeps, RegisteredTool, TurnInput } from './loop.js';

function requiredTurnId(input: TurnInput): string {
  if (!input.id) throw new Error('wake Turn must have a deterministic id');
  return input.id;
}

describe('embedded EI on Muffin-owned MCP sessions', () => {
  it('discovers an Events-capable MCP and registers the complete watch lifecycle', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-ei-'));
    const registered: RegisteredTool[] = [];
    const closeHooks: Array<() => Promise<void>> = [];

    const runtime = {
      deps: {
        turns: { get: () => null },
        sessions: { open: (id: string) => ({ id, file: join(home, `${id}.jsonl`) }) },
      } as unknown as LoopDeps,
      register: (tool: RegisteredTool) => registered.push(tool),
      onClose: (hook: () => Promise<void>) => closeHooks.push(hook),
    };

    try {
      const report = await attachEventIntelligence(
        runtime,
        [
          {
            connectionId: 'demo',
            serverId: 'demo',
            getCapabilities: () => ({ extensions: { 'io.modelcontextprotocol/events': {} } }),
            request: async (method) => {
              if (method === 'events/list') {
                return {
                  events: [{
                    name: 'demo.ready',
                    description: 'A demo item became ready.',
                    delivery: ['poll'],
                    inputSchema: { type: 'object' },
                    payloadSchema: { type: 'object', properties: { value: { type: 'number' } } },
                  }],
                  nextCursor: null,
                };
              }
              if (method === 'events/poll') {
                return { events: [], cursor: null, hasMore: false, nextPollMs: 60_000 };
              }
              throw new Error(`unexpected method ${method}`);
            },
            pollIntervalMs: 60_000,
          },
        ],
        home,
      );

      expect(report.join('\n')).toContain('1 Events-capable');
      expect(registered.map((tool) => tool.spec.name)).toEqual(
        expect.arrayContaining([
          'event_watch_sources',
          'event_watch_create',
          'event_watch_list',
          'event_watch_inspect',
          'event_watch_pause',
          'event_watch_resume',
          'event_watch_delete',
          'event_watch_update',
        ]),
      );

      const create = registered.find((tool) => tool.spec.name === 'event_watch_create');
      if (!create) throw new Error('event_watch_create was not registered');
      const created = await create.handler(
        {
          trigger_id: 'demo-watch',
          events: [{ event: 'demo.ready', where: [{ path: 'value', op: 'gt', value: 10 }] }],
          instruction: 'Tell me the demo is ready.',
          one_shot: true,
        },
        toolContext({ turnId: 'source-turn' }),
      );
      expect(created.isError).not.toBe(true);
      expect(created.content).toContain('event watch create: demo-watch');
    } finally {
      for (const close of closeHooks) await close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('MCP event -> EI match -> canonical automation wake', () => {
  it('wakes one system automation Turn with fenced external evidence', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-ei-e2e-'));
    const queued: TurnInput[] = [];
    const existing = new Set<string>();
    const source = {
      id: 'source-turn',
      tenant: 'host',
      surface: 'telegram',
      sessionId: 'owner',
      replyTo: { chatId: '42' },
      principal: { kind: 'owner', connector: 'cli', externalId: 'local' } as const,
    };
    const port: EventWakePort = {
      source: (id) => (id === source.id ? source : null),
      has: (id) => existing.has(id),
      openSession: (id) => ({ id, file: join(home, `${id}.jsonl`) }),
      enqueue: (input) => {
        queued.push(input);
        const id = requiredTurnId(input);
        existing.add(id);
        return id;
      },
    };

    let delivered = false;
    const connection = {
      connectionId: 'demo',
      serverId: 'demo',
      getCapabilities: () => ({ extensions: { 'io.modelcontextprotocol/events': {} } }),
      request: async (method: string) => {
        if (method === 'events/list') {
          return {
            events: [{
              name: 'demo.ready',
              description: 'A demo item became ready.',
              delivery: ['poll'],
              inputSchema: { type: 'object' },
              payloadSchema: { type: 'object', properties: { value: { type: 'number' } } },
            }],
            nextCursor: null,
          };
        }
        if (method === 'events/poll') {
          if (!delivered) {
            delivered = true;
            return {
              events: [{ eventId: 'event-1', name: 'demo.ready', timestamp: '2026-10-02T20:00:00.000Z', data: { value: 42 } }],
              cursor: 'done',
              hasMore: false,
              nextPollMs: 60_000,
            };
          }
          return { events: [], cursor: 'done', hasMore: false, nextPollMs: 60_000 };
        }
        throw new Error(`unexpected method ${method}`);
      },
      pollIntervalMs: 60_000,
    };

    const embedded = await createMuffinEventIntelligence([connection], home, port);
    try {
      const create = embedded.toolCatalog.get('event_watch_create');
      if (!create) throw new Error('event_watch_create was not registered');
      const armed = await create.execute(
        {
          trigger_id: 'wake-readable-watch',
          events: [{ event: 'demo.ready', where: [{ path: 'value', op: 'gt', value: 10 }] }],
          instruction: 'Inspect the matched demo event.',
          one_shot: false,
        },
        toolContext({ turnId: source.id }),
      );
      expect(armed.ok).toBe(true);
      expect(queued).toEqual([]);

      await embedded.host.runtime.mcpEventsClient.pollAll();
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        principal: { kind: 'system', source: 'automation' },
        tenant: 'host',
        surface: 'telegram',
        replyTo: { chatId: '42' },
        contentTaint: 3,
      });
      expect(queued[0]?.text).toContain('Inspect the matched demo event.');
      expect(queued[0]?.text).toContain('"value": 42');

      const wakeInput = queued[0];
      if (!wakeInput) throw new Error('EI wake turn was not queued');
      const wakeContext = toolContext({
        turnId: requiredTurnId(wakeInput),
        principal: { kind: 'system', source: 'automation' },
      });
      const list = embedded.toolCatalog.get('event_watch_list');
      const pause = embedded.toolCatalog.get('event_watch_pause');
      if (!list || !pause) throw new Error('EI lifecycle tools were not registered');

      const wakeList = await list.execute({ trigger_id: 'wake-readable-watch', limit: 10 }, wakeContext);
      expect(wakeList.ok).toBe(true);

      const deniedMutation = await pause.execute(
        { trigger_id: 'wake-readable-watch', version: '1' },
        wakeContext,
      );
      expect(deniedMutation.ok).toBe(false);
      expect(deniedMutation.error?.code).toBe('EVENT_WATCH_OWNER_REQUIRED');

      await embedded.host.runtime.mcpEventsClient.pollAll();
      expect(queued).toHaveLength(1);
    } finally {
      await embedded.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});


describe('EI wake -> real Muffin TurnStore', () => {
  it('persists one canonical system:automation Turn instead of impersonating the owner', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-ei-real-store-'));
    const workspace = mkdtempSync(join(tmpdir(), 'muffin-ei-real-ws-'));
    runInit({ home, apiKey: 'sk-ei-test-never-used' });
    const runtime = buildRuntime(home, workspace);

    const counters = {
      iterations: 0,
      recoveriesUsed: 0,
      transportRetriesLeft: 10,
      truncationsUsed: 0,
      toolCallsMade: 0,
      nudgedForCompletion: false,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      spentUsd: 0,
      resumes: 0,
      contextBuilt: true,
      activeModelMs: 0,
    };

    const source = runtime.deps.turns.create(
      {
        id: 'source-turn-real-store',
        principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
        tenant: 'host',
        surface: 'cli',
        sessionId: 'owner',
        providerLease: {
          model: runtime.deps.model,
          checkpoint: [
            {
              role: 'user',
              origin: 'owner',
              content: [{ type: 'text', text: 'watch demo.ready' }],
            },
          ],
        },
        taint: 0,
        counters,
        replyTo: { channel: 'cli' },
      },
      process.pid,
    );

    let pollCount = 0;
    const connection = {
      connectionId: 'demo',
      serverId: 'demo',
      getCapabilities: () => ({
        extensions: { 'io.modelcontextprotocol/events': {} },
      }),
      request: async (method: string) => {
        if (method === 'events/list') {
          return {
            events: [
              {
                name: 'demo.ready',
                description: 'A demo item became ready.',
                delivery: ['poll'],
                inputSchema: { type: 'object' },
                payloadSchema: {
                  type: 'object',
                  properties: { value: { type: 'number' } },
                },
              },
            ],
            nextCursor: null,
          };
        }
        if (method === 'events/poll') {
          pollCount += 1;
          if (pollCount <= 2) {
            return {
              // The second poll deliberately replays the SAME occurrence.
              // EI + Muffin receipt identity must not mint a second Work.
              events: [
                {
                  eventId: 'real-store-event-1',
                  name: 'demo.ready',
                  timestamp: '2026-10-07T10:00:00.000Z',
                  data: { value: 42 },
                },
              ],
              cursor: `replay-${pollCount}`,
              hasMore: false,
              nextPollMs: 60_000,
            };
          }
          return { events: [], cursor: 'done', hasMore: false, nextPollMs: 60_000 };
        }
        throw new Error(`unexpected method ${method}`);
      },
      pollIntervalMs: 60_000,
    };

    try {
      const report = await attachEventIntelligence(runtime, [connection], home);
      expect(report.join('\n')).toContain('1 Events-capable');

      const create = runtime.deps.tools.find((tool) => tool.spec.name === 'event_watch_create');
      if (!create) throw new Error('event_watch_create was not registered');
      const armed = await create.handler(
        {
          trigger_id: 'real-store-watch',
          events: [
            {
              event: 'demo.ready',
              where: [{ path: 'value', op: 'gt', value: 10 }],
            },
          ],
          instruction: 'Inspect the matched demo event.',
          one_shot: false,
        },
        toolContext({ turnId: source.id }),
      );
      expect(armed.isError).not.toBe(true);

      const embedded = getAttachedEventIntelligence(runtime);
      if (!embedded) throw new Error('Event Intelligence was not attached');
      await embedded.host.runtime.mcpEventsClient.pollAll();

      const runnable = runtime.deps.turns
        .due(new Date('2026-10-07T10:01:00.000Z'), 20)
        .filter((row) => row.id !== source.id);
      expect(runnable).toHaveLength(1);

      const wake = runnable[0]!;
      expect(wake.status).toBe('runnable');
      expect(wake.principal).toEqual({ kind: 'system', source: 'automation' });
      expect(wake.tenant).toBe('host');
      expect(wake.taint).toBe(3);
      expect(wake.inputText).toContain('Inspect the matched demo event.');
      expect(wake.inputText).toContain('"value": 42');

      // The source row remains owner-authored; the wake is a separate system
      // work item with its own durable identity.
      expect(runtime.deps.turns.get(source.id)?.principal).toEqual({
        kind: 'owner',
        connector: 'cli',
        externalId: 'local',
      });

      // Replay the exact same external occurrence. The deterministic wake
      // receipt is also the Turn id, so this must remain one durable row.
      await embedded.host.runtime.mcpEventsClient.pollAll();
      const secondPass = runtime.deps.turns
        .due(new Date('2026-10-07T10:02:00.000Z'), 20)
        .filter((row) => row.id !== source.id);
      expect(secondPass).toHaveLength(1);
      expect(secondPass[0]?.id).toBe(wake.id);
    } finally {
      await runtime.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
