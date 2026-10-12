import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHostConformance } from 'mcp-event-intelligence/conformance';
import type { EventIntelligenceObservabilityEvent } from 'mcp-event-intelligence/observability';
import { describe, expect, it } from 'vitest';
import { createMuffinEventIntelligence, type EventWakePort } from './event-intelligence.js';
import { toolContext } from './fixtures/tool-context.js';
import type { TurnInput } from './loop.js';

function requiredTurnId(input: TurnInput): string {
  if (!input.id) throw new Error('conformance wake requires a deterministic turn id');
  return input.id;
}

describe('Muffin Event Intelligence host conformance', () => {
  it('passes the public EI v0.11 management host contract through Muffin tools', async () => {
    const adapter = {
      name: 'muffin-agent',

      async createHarness({
        observability,
      }: {
        observability: (event: EventIntelligenceObservabilityEvent) => void;
        profile: 'core' | 'management';
      }) {
        const home = mkdtempSync(join(tmpdir(), 'muffin-ei-conformance-'));
        const deliveries: Array<{
          triggerId: string;
          wakeId: string;
          runtimeReceiptId: string;
        }> = [];
        const persistedReceipts = new Set<string>();
        let embedded: Awaited<ReturnType<typeof createMuffinEventIntelligence>> | null = null;
        let eventClock = Date.parse('2026-10-05T06:00:00.000Z');

        const connection = {
          connectionId: 'conformance',
          serverId: 'conformance',
          getCapabilities: () => ({
            extensions: { 'io.modelcontextprotocol/events': {} },
          }),
          request: async (method: string) => {
            if (method === 'events/list') {
              return {
                events: [
                  {
                    name: 'conformance.value.changed',
                    description: 'Synthetic value change used only by host conformance.',
                    delivery: ['poll'],
                    inputSchema: { type: 'object' },
                    payloadSchema: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['value'],
                      properties: {
                        value: { type: 'number' },
                        secretProbe: { type: 'string' },
                      },
                    },
                  },
                ],
                nextCursor: null,
              };
            }
            if (method === 'events/poll') {
              return {
                events: [],
                cursor: null,
                hasMore: false,
                nextPollMs: 60_000,
              };
            }
            throw new Error(`unexpected conformance MCP method ${method}`);
          },
          pollIntervalMs: 60_000,
        };

        const port: EventWakePort = {
          source: (turnId) => ({
            id: turnId,
            tenant: 'host',
            surface: 'cli',
            sessionId: `conformance:${turnId}`,
            replyTo: { conformanceTriggerId: turnId },
            principal: { kind: 'owner', connector: 'cli', externalId: 'local' } as const,
          }),
          has: (receiptId) => persistedReceipts.has(receiptId),
          openSession: (sessionId) => ({
            id: sessionId,
            file: join(home, `${sessionId.replaceAll(':', '_')}.jsonl`),
          }),
          enqueue: (input) => {
            const runtimeReceiptId = requiredTurnId(input);
            persistedReceipts.add(runtimeReceiptId);
            const replyTo = input.replyTo;
            if (
              !replyTo ||
              typeof replyTo !== 'object' ||
              !('conformanceTriggerId' in replyTo) ||
              typeof replyTo.conformanceTriggerId !== 'string'
            ) {
              throw new Error('conformance delivery lost its Muffin source turn');
            }
            deliveries.push({
              triggerId: replyTo.conformanceTriggerId,
              wakeId: runtimeReceiptId,
              runtimeReceiptId,
            });
            return runtimeReceiptId;
          },
        };

        const start = async () => {
          embedded = await createMuffinEventIntelligence([connection], home, port, observability);
        };

        await start();

        const executePortable = async (
          name: string,
          args: Record<string, unknown>,
          turnId: string,
        ) => {
          const current = embedded;
          if (!current) throw new Error('Event Intelligence conformance host is closed');
          const tool = current.toolCatalog.get(name);
          if (!tool) throw new Error(`${name} unavailable`);
          const result = await tool.execute(
            args,
            toolContext({
              turnId,
              sessionId: `conformance:${turnId}`,
            }),
          );
          if (!result.ok) {
            throw new Error(result.error?.message ?? `${name} failed`);
          }
          return result.data ?? {};
        };

        const currentTriggerVersion = async (triggerId: string) => {
          const listed = await executePortable(
            'event_watch_list',
            { trigger_id: triggerId, limit: 200 },
            `list:${triggerId}`,
          );
          const entries = Array.isArray(listed.triggers) ? listed.triggers : [];
          const current =
            entries.find(
              (entry: { status?: string }) =>
                entry.status === 'active' || entry.status === 'paused',
            ) ?? entries.at(-1);
          if (!current?.version) {
            throw new Error(`No owned Event Intelligence trigger ${triggerId}`);
          }
          return String(current.version);
        };

        return {
          async createTrigger({
            triggerId,
            threshold,
            oneShot,
            maxFirings,
          }: {
            triggerId: string;
            threshold: number;
            oneShot: boolean;
            maxFirings?: number;
          }) {
            await executePortable(
              'event_watch_create',
              {
                trigger_id: triggerId,
                events: [
                  {
                    event: 'conformance.value.changed',
                    serverId: 'conformance',
                    where: [{ path: 'value', op: 'gt', value: threshold }],
                  },
                ],
                instruction: 'Continue the isolated EI host conformance scenario.',
                one_shot: oneShot,
                ...(maxFirings === undefined ? {} : { max_firings: maxFirings }),
              },
              triggerId,
            );
          },

          async emitEvent({
            eventId,
            value,
            secretProbe,
          }: {
            eventId: string;
            value: number;
            secretProbe?: string;
          }) {
            eventClock += 1_000;
            await embedded?.host.runtime.compositeEventConsumer.ingestCorrelatable({
              traceId: `muffin-conformance:${eventId}`,
              sourceEventId: eventId,
              name: 'conformance.value.changed',
              serverId: 'conformance',
              provider: 'conformance',
              occurredAt: new Date(eventClock).toISOString(),
              data: {
                value,
                ...(secretProbe ? { secretProbe } : {}),
              },
            });
          },

          deliveries() {
            return [...deliveries];
          },

          async restart() {
            await embedded?.close();
            embedded = null;
            await start();
          },

          async listTriggers() {
            const listed = await executePortable('event_watch_list', {}, 'list-all');
            return Array.isArray(listed.triggers) ? listed.triggers : [];
          },

          async inspectTrigger(triggerId: string) {
            const version = await currentTriggerVersion(triggerId);
            const inspected = await executePortable(
              'event_watch_inspect',
              { trigger_id: triggerId, version },
              `inspect:${triggerId}`,
            );
            return {
              ...(inspected.lifecycle ?? {}),
              version: inspected.trigger?.version ?? version,
            };
          },

          async pauseTrigger(triggerId: string) {
            await executePortable(
              'event_watch_pause',
              { trigger_id: triggerId },
              `pause:${triggerId}`,
            );
          },

          async resumeTrigger(triggerId: string) {
            await executePortable(
              'event_watch_resume',
              { trigger_id: triggerId },
              `resume:${triggerId}`,
            );
          },

          async updateTrigger({ triggerId, threshold }: { triggerId: string; threshold: number }) {
            await executePortable(
              'event_watch_update',
              {
                trigger_id: triggerId,
                events: [
                  {
                    event: 'conformance.value.changed',
                    serverId: 'conformance',
                    where: [{ path: 'value', op: 'gt', value: threshold }],
                  },
                ],
                instruction: 'Continue the isolated EI host conformance scenario.',
                one_shot: false,
                max_firings: 5,
              },
              `update:${triggerId}`,
            );
          },

          async deleteTrigger(triggerId: string) {
            await executePortable(
              'event_watch_delete',
              { trigger_id: triggerId },
              `delete:${triggerId}`,
            );
          },

          async close() {
            await embedded?.close();
            embedded = null;
            rmSync(home, { recursive: true, force: true });
          },
        };
      },
    };

    const report = await runHostConformance(adapter, { profile: 'management' });
    expect(report.passed, JSON.stringify(report, null, 2)).toBe(true);
    expect(report.adapter).toBe('muffin-agent');
    expect(report.profile).toBe('management');
    expect(report.summary.failed).toBe(0);
    expect(report.observability.eventNames).toContain('ei.trigger.created');
    expect(report.observability.eventNames).toContain('ei.match.matched');
    expect(report.observability.eventNames).toContain('ei.wake.delivered');
  });
});
