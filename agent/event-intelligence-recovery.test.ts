import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../cli/init.js';
import { buildRuntime } from './runtime.js';
import {
  attachEventIntelligence,
  getAttachedEventIntelligence,
} from './event-intelligence.js';
import { toolContext } from './fixtures/tool-context.js';
import { resumeTurn } from './loop.js';
import type { ChatCall, ChatResult, Provider } from './providers/types.js';

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

const owner = { kind: 'owner', connector: 'cli', externalId: 'local' } as const;

function openingCounters() {
  return {
    iterations: 0,
    recoveriesUsed: 0,
    transportRetriesLeft: 10,
    truncationsUsed: 0,
    toolCallsMade: 0,
    nudgedForCompletion: false,
    usage: { ...usage },
    spentUsd: 0,
    resumes: 0,
    contextBuilt: true,
    activeModelMs: 0,
  };
}

describe('Event Intelligence receipt recovery across restart', () => {
  it('reuses the committed receipt and keeps an external URL unquoted through resumed policy', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-ei-recovery-home-'));
    const workspace = mkdtempSync(join(tmpdir(), 'muffin-ei-recovery-workspace-'));
    runInit({ home, apiKey: 'sk-ei-recovery-never-used' });
    let runtime = buildRuntime(home, workspace);
    let runtimeOpen = true;
    const sourceId = 'source-turn-crash-window';
    const source = runtime.deps.turns.create({
      id: sourceId,
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      sessionId: 'owner',
      providerLease: {
        model: runtime.deps.model,
        checkpoint: [{ role: 'user', origin: 'owner', content: [{ type: 'text', text: 'watch demo.ready' }] }],
      },
      taint: 0,
      counters: openingCounters(),
      replyTo: { channel: 'cli' },
    });

    let pollCount = 0;
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
              payloadSchema: {
                type: 'object',
                properties: { value: { type: 'number' }, url: { type: 'string' } },
              },
            }],
            nextCursor: null,
          };
        }
        if (method === 'events/poll') {
          pollCount += 1;
          return pollCount === 1
            ? {
                events: [{
                  eventId: 'crash-window-event',
                  name: 'demo.ready',
                  timestamp: '2026-10-09T10:00:00.000Z',
                  data: { value: 42, url: 'https://event.example/path?source=untrusted' },
                }],
                cursor: 'after-crash-window-event',
                hasMore: false,
                nextPollMs: 60_000,
              }
            : { events: [], cursor: 'after-crash-window-event', hasMore: false, nextPollMs: 60_000 };
        }
        throw new Error(`unexpected Events method ${method}`);
      },
      pollIntervalMs: 60_000,
    };

    try {
      await attachEventIntelligence(runtime, [connection], home);
      const create = runtime.deps.tools.find((tool) => tool.spec.name === 'event_watch_create');
      if (!create) throw new Error('event_watch_create was not registered');
      const armed = await create.handler(
        {
          trigger_id: 'crash-window-watch',
          events: [{ event: 'demo.ready', where: [{ path: 'value', op: 'gt', value: 10 }] }],
          instruction: 'Read the URL from the matched event evidence.',
          one_shot: false,
        },
        toolContext({ turnId: source.id }),
      );
      expect(armed.isError).not.toBe(true);

      const firstEI = getAttachedEventIntelligence(runtime);
      if (!firstEI) throw new Error('Event Intelligence was not attached');
      const firstScope = await firstEI.host.runtime.scope();
      const eventStore = firstScope.store as {
        completeWakeDelivery: (...args: unknown[]) => Promise<unknown>;
        failWakeDelivery: (...args: unknown[]) => Promise<unknown>;
      };
      const complete = eventStore.completeWakeDelivery.bind(eventStore);
      const fail = eventStore.failWakeDelivery.bind(eventStore);
      eventStore.completeWakeDelivery = async () => {
        throw new Error('simulated process loss after Turn commit');
      };
      eventStore.failWakeDelivery = async () => {
        throw new Error('simulated process loss before retry state commit');
      };

      let enqueueCount = 0;
      const firstTurnStore = runtime.deps.turns;
      const firstEnqueue = firstTurnStore.enqueue.bind(firstTurnStore);
      firstTurnStore.enqueue = ((input: Parameters<typeof firstTurnStore.enqueue>[0]) => {
        enqueueCount += 1;
        return firstEnqueue(input);
      }) as typeof firstTurnStore.enqueue;

      // Delivery commits its deterministic Turn receipt, then the injected
      // process-loss prevents EI's durable delivery acknowledgement.
      try {
        await firstEI.host.runtime.mcpEventsClient.pollAll();
      } catch {
        // The injected boundary intentionally escapes the delivery handler.
      }
      expect(enqueueCount).toBe(1);
      const wakeRows = firstTurnStore
        .due(new Date('2026-10-09T10:01:00.000Z'), 20)
        .filter((row) => row.id !== source.id);
      expect(wakeRows).toHaveLength(1);
      const receiptTurnId = wakeRows[0]!.id;
      expect(firstTurnStore.get(receiptTurnId)?.principal).toEqual({ kind: 'system', source: 'automation' });
      const afterLease = new Date(Date.now() + 60_000).toISOString();
      const pendingDeliveries = await firstScope.store.listDueWakeDeliveries(afterLease);
      expect(pendingDeliveries).toHaveLength(1);
      const eventWakeId = pendingDeliveries[0]!.wakeId;
      expect(await firstScope.store.getWakeDelivery(eventWakeId)).toMatchObject({ status: 'claimed' });

      eventStore.completeWakeDelivery = complete;
      eventStore.failWakeDelivery = fail;
      await runtime.close();
      runtimeOpen = false;

      // A new runtime opens the same isolated Muffin Home and EI store. Move
      // only the test clock past the durable lease; no production policy or
      // retry behavior is changed.
      runtime = buildRuntime(home, workspace);
      runtimeOpen = true;
      await attachEventIntelligence(runtime, [connection], home);
      const reopenedEI = getAttachedEventIntelligence(runtime);
      if (!reopenedEI) throw new Error('reopened Event Intelligence was not attached');
      const reopenedScope = await reopenedEI.host.runtime.scope();
      reopenedScope.wakeRetryScheduler.stop();
      const futureClock = new Date(Date.now() + 60_000);
      reopenedScope.wakeRetryScheduler.now = () => futureClock;
      reopenedScope.wakeCoordinator.now = () => futureClock;

      let replayEnqueueCount = 0;
      const reopenedTurnStore = runtime.deps.turns;
      const reopenedEnqueue = reopenedTurnStore.enqueue.bind(reopenedTurnStore);
      reopenedTurnStore.enqueue = ((input: Parameters<typeof reopenedTurnStore.enqueue>[0]) => {
        replayEnqueueCount += 1;
        return reopenedEnqueue(input);
      }) as typeof reopenedTurnStore.enqueue;

      const outcomes = await reopenedScope.wakeRetryScheduler.runDue();
      expect(outcomes).toEqual([expect.objectContaining({ status: 'wake_delivered' })]);
      expect(replayEnqueueCount).toBe(0);
      expect(reopenedTurnStore.get(receiptTurnId)?.principal).toEqual({ kind: 'system', source: 'automation' });
      expect(await reopenedScope.store.getWakeDelivery(eventWakeId)).toMatchObject({ status: 'delivered' });

      const modelCalls: ChatCall[] = [];
      const url = 'https://event.example/path?source=untrusted';
      let httpHandlerCalled = false;
      const httpTool = runtime.deps.tools.find((tool) => tool.spec.name === 'http_get');
      if (!httpTool) throw new Error('http_get was not registered');
      // Keep the real loop and kernel path, but make any accidental allow
      // incapable of reaching the network during this recovery test.
      httpTool.handler = async () => {
        httpHandlerCalled = true;
        return { content: 'mock public response', tier: 3 };
      };

      const decisions: import('../core/policy/types.js').DecisionRequest[] = [];
      const decide = runtime.deps.decide;
      runtime.deps.decide = (request) => {
        if (request.capability === 'sys.http') decisions.push(request);
        return decide(request);
      };
      const provider: Provider = {
        kind: 'openai-compat',
        chat: async (call) => {
          modelCalls.push(call);
          if (modelCalls.length === 1) {
            return {
              text: null,
              toolCalls: [{ id: 'fetch-event-url', name: 'http_get', args: { url } }],
              stopReason: 'tool_use',
              usage,
              model: runtime.deps.model,
            } satisfies ChatResult;
          }
          return {
            text: 'Reviewed the event.',
            toolCalls: [],
            stopReason: 'end',
            usage,
            model: runtime.deps.model,
          } satisfies ChatResult;
        },
      };
      const result = await resumeTurn(
        {
          ...runtime.deps,
          provider,
          profile: { ...runtime.deps.profile, maxToolsExposed: 10, recovery: [] },
        },
        receiptTurnId,
      );
      expect(result).toMatchObject({ stopped: 'answered' });
      expect(modelCalls).toHaveLength(2);
      const wakeMessage = modelCalls[0]?.messages.find((message) =>
        message.content.some((block) =>
          block.type === 'text' && block.text.includes('Read the URL from the matched event evidence.'),
        ),
      );
      expect(wakeMessage?.origin).toBe('external');
      expect(wakeMessage?.content.some((block) => block.type === 'text' && block.text.includes(url))).toBe(true);
      const urlDecision = decisions.filter((request) => request.resource.kind === 'url-read');
      expect(urlDecision).toHaveLength(1);
      expect(urlDecision[0]).toMatchObject({
        capability: 'sys.http',
        resource: { kind: 'url-read', value: url },
        quoted: false,
      });
      expect(httpHandlerCalled).toBe(false);
    } finally {
      if (runtimeOpen) await runtime.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
