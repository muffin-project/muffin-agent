import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  attachEventIntelligence,
  createMuffinEventIntelligence,
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
