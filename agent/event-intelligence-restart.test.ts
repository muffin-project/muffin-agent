import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMuffinEventIntelligence, type EventWakePort } from './event-intelligence.js';
import { toolContext } from './fixtures/tool-context.js';
import type { TurnInput } from './loop.js';

/**
 * #851 restart boundary: the wake's durable Turn identity survives, but
 * WakeOwnerBindings is deliberately volatile. Do not accidentally infer owner
 * mutation authority from a resumed system turn or present owner-read access
 * after restart as a guaranteed feature.
 */
describe('EI owner association across a process restart', () => {
  it('preserves owner management, drops ephemeral system read association, and still denies autonomous mutation', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-ei-owner-reopen-'));
    const owner = { kind: 'owner', connector: 'cli', externalId: 'local' } as const;
    const source = {
      id: 'source-owner-turn',
      tenant: 'host',
      surface: 'cli',
      sessionId: 'owner',
      replyTo: { channel: 'cli' },
      principal: owner,
    };
    const existing = new Set<string>();
    const queued: TurnInput[] = [];
    const port: EventWakePort = {
      source: (id) => (id === source.id ? source : null),
      has: (id) => existing.has(id),
      openSession: (id) => ({ id, file: join(home, `${id}.jsonl`) }),
      enqueue: (input) => {
        if (!input.id) throw new Error('EI receipt id missing');
        existing.add(input.id);
        queued.push(input);
        return input.id;
      },
    };
    let eventsDelivered = false;
    const connection = {
      connectionId: 'demo',
      serverId: 'demo',
      getCapabilities: () => ({ extensions: { 'io.modelcontextprotocol/events': {} } }),
      request: async (method: string) => {
        if (method === 'events/list') {
          return {
            events: [{
              name: 'demo.ready',
              description: 'demo event',
              delivery: ['poll'],
              inputSchema: { type: 'object' },
              payloadSchema: { type: 'object', properties: { value: { type: 'number' } } },
            }],
            nextCursor: null,
          };
        }
        if (method === 'events/poll') {
          if (!eventsDelivered) {
            eventsDelivered = true;
            return {
              events: [{
                eventId: 'restart-event',
                name: 'demo.ready',
                timestamp: '2026-10-08T15:00:00.000Z',
                data: { value: 42 },
              }],
              cursor: 'after-restart-event',
              hasMore: false,
              nextPollMs: 60_000,
            };
          }
          return {
            events: [], cursor: 'after-restart-event', hasMore: false, nextPollMs: 60_000,
          };
        }
        throw new Error(`unexpected Events method ${method}`);
      },
      pollIntervalMs: 60_000,
    };

    const first = await createMuffinEventIntelligence([connection], home, port);
    let closed = false;
    try {
      const create = first.toolCatalog.get('event_watch_create');
      if (!create) throw new Error('missing watch creation');
      const created = await create.execute({
        trigger_id: 'restart-watch',
        events: [{ event: 'demo.ready', where: [{ path: 'value', op: 'gt', value: 10 }] }],
        instruction: 'Inspect demo.ready.',
        one_shot: false,
      }, toolContext({ turnId: source.id }));
      expect(created.ok).toBe(true);

      await first.host.runtime.mcpEventsClient.pollAll();
      expect(queued).toHaveLength(1);
      const wakeId = queued[0]?.id;
      if (!wakeId) throw new Error('missing durable wake id');
      const autonomousContext = toolContext({
        turnId: wakeId,
        principal: { kind: 'system', source: 'automation' },
      });

      const initialList = first.toolCatalog.get('event_watch_list');
      if (!initialList) throw new Error('missing watch list');
      expect((await initialList.execute({ limit: 10 }, autonomousContext)).ok).toBe(true);

      await first.close();
      closed = true;
      const reopened = await createMuffinEventIntelligence([connection], home, port);
      try {
        const list = reopened.toolCatalog.get('event_watch_list');
        const pause = reopened.toolCatalog.get('event_watch_pause');
        if (!list || !pause) throw new Error('missing reopened watch tools');

        // The persisted watch still belongs to the same authenticated owner.
        const ownerList = await list.execute({ limit: 10 }, toolContext({ turnId: source.id }));
        expect(ownerList.ok).toBe(true);
        expect(JSON.stringify(ownerList.data)).toContain('restart-watch');

        // WakeOwnerBindings has no durable projection. Resumed autonomous work
        // cannot recover owner read context by presenting the old receipt id.
        const lostReadScope = await list.execute({ limit: 10 }, autonomousContext);
        expect(lostReadScope.ok).toBe(false);

        // No emergency authority fallback: mutation remains owner-only.
        const denied = await pause.execute(
          { trigger_id: 'restart-watch', version: '1' },
          autonomousContext,
        );
        expect(denied.ok).toBe(false);
        expect(denied.error?.code).toBe('EVENT_WATCH_OWNER_REQUIRED');
      } finally {
        await reopened.close();
      }
    } finally {
      if (!closed) await first.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
