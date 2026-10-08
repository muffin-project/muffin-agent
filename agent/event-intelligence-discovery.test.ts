import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../cli/init.js';
import { createCapabilityExposure, CAPABILITY_SEARCH_TOOL_NAME } from './capability-exposure.js';
import { visibleTools } from './context/assemble.js';
import { attachEventIntelligence } from './event-intelligence.js';
import { toolContext } from './fixtures/tool-context.js';
import { buildRuntime } from './runtime.js';

const WATCH_TOOLS = [
  'event_watch_sources',
  'event_watch_create',
  'event_watch_list',
  'event_watch_inspect',
  'event_watch_pause',
  'event_watch_resume',
  'event_watch_delete',
  'event_watch_update',
] as const;

/**
 * #605 + #469 integration: real embedded EI tools must flow through the same
 * authority-filtered catalogue / context ceiling / normal execution path as
 * any other registered Muffin capability. No EI-only discovery escape hatch.
 */
describe('embedded Event Intelligence composed with capability discovery', () => {
  it('discovers all eight late-registered watch tools beyond the cap without exposing them to members', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-ei-discovery-'));
    const workspace = mkdtempSync(join(tmpdir(), 'muffin-ei-discovery-ws-'));
    runInit({ home, apiKey: 'sk-ei-discovery-never-used' });
    const runtime = buildRuntime(home, workspace);
    const owner = { kind: 'owner', connector: 'cli', externalId: 'local' } as const;
    const member = {
      kind: 'member',
      connector: 'telegram',
      externalId: 'guest',
      tenantId: 'group:telegram:guest',
    } as const;

    try {
      const report = await attachEventIntelligence(
        runtime,
        [
          {
            connectionId: 'demo',
            serverId: 'demo',
            getCapabilities: () => ({
              extensions: { 'io.modelcontextprotocol/events': {} },
            }),
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
                return { events: [], cursor: null, hasMore: false, nextPollMs: 60_000 };
              }
              throw new Error(`unexpected Events method ${method}`);
            },
            pollIntervalMs: 60_000,
          },
        ],
        home,
      );

      expect(report.join('\n')).toContain('1 Events-capable');
      const registered = runtime.deps.tools.map((tool) => tool.spec.name);
      expect(registered).toEqual(expect.arrayContaining([...WATCH_TOOLS]));
      expect(runtime.recomputeExposure()).toEqual([]);

      const eligible = visibleTools(
        runtime.deps.tools,
        owner,
        runtime.deps.capabilities,
        runtime.deps.grants?.get('host'),
      );
      const discoveryTool = eligible.find((tool) => tool.spec.name === CAPABILITY_SEARCH_TOOL_NAME);
      expect(discoveryTool).toBeDefined();

      const ceiling = 10;
      const projection = createCapabilityExposure({
        eligible,
        maxToolsExposed: ceiling,
        ...(discoveryTool ? { discoveryTool } : {}),
      });
      expect(projection.pressured).toBe(true);
      expect(projection.exposed.map((tool) => tool.spec.name)).toContain(
        CAPABILITY_SEARCH_TOOL_NAME,
      );
      expect(projection.exposed.map((tool) => tool.spec.name)).not.toContain(
        'event_watch_create',
      );

      for (const name of WATCH_TOOLS) {
        const found = projection.discovery?.searchAndLoad(name, 1);
        expect(found?.loaded.map((tool) => tool.name)).toContain(name);
        projection.discovery?.activatePending();
        expect(projection.exposed.map((tool) => tool.spec.name)).toContain(name);
        expect(projection.exposed.length).toBeLessThanOrEqual(ceiling);
      }

      // The real portable EI handler, not a substitute, is reachable through
      // the projection and can create a persisted owner watch.
      projection.discovery?.searchAndLoad('event_watch_create', 1);
      projection.discovery?.activatePending();
      const create = projection.exposed.find((tool) => tool.spec.name === 'event_watch_create');
      expect(create).toBeDefined();
      const result = await create!.handler(
        {
          trigger_id: 'discovery-watch',
          events: [{ event: 'demo.ready', where: [{ path: 'value', op: 'gt', value: 10 }] }],
          instruction: 'Tell me when the demo is ready.',
          one_shot: true,
        },
        toolContext({ turnId: 'discovery-turn' }),
      );
      expect(result.isError).not.toBe(true);
      expect(result.content).toContain('event watch create: discovery-watch');

      const guestEligible = visibleTools(
        runtime.deps.tools,
        member,
        runtime.deps.capabilities,
        runtime.deps.grants?.get(member.tenantId),
      );
      expect(guestEligible.map((tool) => tool.spec.name)).not.toEqual(
        expect.arrayContaining([...WATCH_TOOLS]),
      );
      for (const name of WATCH_TOOLS) {
        expect(guestEligible.some((tool) => tool.spec.name === name)).toBe(false);
      }
    } finally {
      await runtime.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
