import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Consolidator, readConsolidation } from '../core/memory/consolidator.js';
import { createDecide } from '../core/policy/decide.js';
import { POLICY_FLOOR } from '../core/policy/matrix.js';
import type { CapabilityDecl } from '../core/policy/types.js';
import { SessionStore } from '../core/session/store.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { TurnStore } from '../core/turns/store.js';
import { TodoStore } from '../core/turns/todo.js';
import { type LoopDeps, resumeTurn, runTurn } from './loop.js';
import { CONSERVATIVE } from './profiles/profile.js';
import { lightLane } from './providers/light-lane.js';
import type { ChatResult, Provider } from './providers/types.js';
import { makeLaneRunner } from './turn-lane.js';

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const answer = (text = 'complete'): ChatResult => ({
  text,
  toolCalls: [],
  stopReason: 'end',
  usage,
  model: 'test',
});
const call = (id: string): ChatResult => ({
  text: null,
  toolCalls: [{ id, name: 'demo_read', args: {} }],
  stopReason: 'tool_use',
  usage,
  model: 'test',
});
const empty = (): ChatResult => ({
  text: null,
  toolCalls: [],
  stopReason: 'error',
  usage: { ...usage, inputTokens: 0, outputTokens: 0 },
  model: 'test',
});

function harness(
  provider: Provider,
  opts: { modelCalls?: number; toolCalls?: number; handler?: () => Promise<void> } = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-activity-continuity-'));
  const db = new DatabaseCtor(':memory:');
  const turns = new TurnStore(db);
  let effects = 0;
  const decl: CapabilityDecl = {
    id: 'demo.read',
    effect: 'context',
    risk: 'low',
    reversible: 'yes',
    rerunnable: true,
    maxTaint: 3,
    resourceKind: 'none',
    policyArgs: [],
    hostOnly: false,
  };
  const capabilities = new Map([[decl.id, decl]]);
  const profile = {
    ...CONSERVATIVE,
    activity: {
      maxModelCalls: opts.modelCalls ?? 128,
      maxToolCalls: opts.toolCalls ?? 256,
      maxAutomaticContinuations: 3,
    },
    execution: {
      modelCallDeadlineMs: 120000,
      turnWallDeadlineMs: 300000,
      activeModelBudgetMs: 240000,
      stallTimeoutMs: 25000,
      heartbeatIntervalMs: 15000,
    },
  };
  const deps: LoopDeps = {
    provider,
    model: 'test',
    profile,
    tools: [
      {
        capability: decl.id,
        spec: {
          name: 'demo_read',
          description: 'Read fixture',
          inputSchema: { type: 'object', properties: {} },
        },
        throwTier: 0,
        handler: async () => {
          effects++;
          await opts.handler?.();
          writeFileSync(join(home, 'effects'), String(effects));
          return { content: 'fixture read', tier: 0 };
        },
      },
    ],
    capabilities,
    decide: createDecide({
      matrix: POLICY_FLOOR,
      capabilities,
      budgetExhausted: () => false,
      hardened: true,
    }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions: new SessionStore(home),
    turns,
    todos: new TodoStore(db),
    budgetExhausted: () => false,
    systemPrompts: { owner: 'You are Muffin.', group: 'You are a guest.' },
  };
  const input = {
    principal: { kind: 'owner' as const, connector: 'cli', externalId: 'local' },
    tenant: 'host',
    surface: 'cli',
    session: deps.sessions.open('activity'),
    text: 'Read the fixture and complete this task.',
  };
  return { deps, input, turns, db, home, effects: () => effects };
}

afterEach(() => vi.useRealTimers());

describe('authorized activity on the production loop', () => {
  it('passes fifteen minutes of healthy model/tool work without renewal or elapsed cap', async () => {
    vi.useFakeTimers();
    let requests = 0;
    const h = harness(
      {
        kind: 'openai-compat',
        chat: async () => {
          await vi.advanceTimersByTimeAsync(100000);
          return requests++ < 10 ? call(`read-${requests}`) : answer();
        },
      },
      {
        handler: async () => {
          await vi.advanceTimersByTimeAsync(10000);
        },
      },
    );
    const start = Date.now();
    const result = await runTurn(h.deps, h.input);
    expect(Date.now() - start).toBe(1200000);
    expect(result.stopped).toBe('answered');
    expect(h.turns.get(result.turnId)?.leaseIndex).toBe(0);
    expect(h.turns.activityAllowance(result.turnId)).toMatchObject({
      modelCallsUsed: 11,
      toolCallsUsed: 10,
      automaticContinuationsUsed: 0,
    });
    expect(readFileSync(join(h.home, 'effects'), 'utf8')).toBe('10');
  });

  it('uses the granted cumulative tool capacity rather than the old per-lease ceiling', async () => {
    let requests = 0;
    const h = harness({
      kind: 'openai-compat',
      chat: async () => (requests++ < 37 ? call(`read-${requests}`) : answer()),
    });
    const result = await runTurn(h.deps, h.input);
    expect(result.stopped).toBe('answered');
    expect(readFileSync(join(h.home, 'effects'), 'utf8')).toBe('37');
    expect(h.turns.activityAllowance(result.turnId)).toMatchObject({
      modelCallsUsed: 38,
      toolCallsUsed: 37,
    });
    expect(h.turns.get(result.turnId)?.leaseIndex).toBe(0);
  });

  it('bounds total requests without a task-time limit and retains the checkpoint', async () => {
    let requests = 0;
    const h = harness(
      {
        kind: 'openai-compat',
        chat: async () => {
          requests++;
          return call(`read-${requests}`);
        },
      },
      { modelCalls: 2 },
    );
    const result = await runTurn(h.deps, h.input);
    expect(result.stopped).toBe('continuable');
    expect(h.turns.get(result.turnId)?.continuableReason?.class).toBe('activity_budget');
    expect(requests).toBe(2);
    expect(h.effects()).toBe(2);
    expect(h.turns.due()).toEqual([]);
    const row = h.turns.get(result.turnId)!;
    expect(row.providerLease.checkpoint).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'assistant' })]),
    );
  });

  it('continues recoverable failure internally and replays a recorded effect once', async () => {
    vi.useFakeTimers();
    const script = [
      call('read-once'),
      empty(),
      empty(),
      empty(),
      empty(),
      call('read-once'),
      answer(),
    ];
    let requests = 0;
    const h = harness({ kind: 'openai-compat', chat: async () => script[requests++]! });
    const running = runTurn(h.deps, h.input);
    await vi.runAllTimersAsync();
    const result = await running;
    expect(result.stopped).toBe('answered');
    expect(requests).toBe(7);
    expect(h.turns.get(result.turnId)?.leaseIndex).toBe(1);
    expect(h.turns.activityAllowance(result.turnId)).toMatchObject({
      modelCallsUsed: 7,
      toolCallsUsed: 1,
      automaticContinuationsUsed: 1,
    });
    expect(
      h.db.prepare('SELECT count(*) AS n FROM turn_tool_calls WHERE turn_id=?').get(result.turnId),
    ).toEqual({ n: 1 });
    expect(readFileSync(join(h.home, 'effects'), 'utf8')).toBe('1');
    const history = readFileSync(h.input.session.file, 'utf8');
    expect(history).not.toContain('runtime continuation');
    expect(history).not.toContain('riprendi');
  });

  it('counts physical light requests inside a tool against the same durable grant', async () => {
    let main = 0,
      light = 0;
    const helper = lightLane(
      {
        kind: 'openai-compat',
        chat: async () => {
          light++;
          return answer('light');
        },
      },
      { profile: CONSERVATIVE },
    );
    const h = harness(
      {
        kind: 'openai-compat',
        chat: async () => {
          main++;
          return call('read');
        },
      },
      {
        modelCalls: 2,
        handler: async () => {
          await helper.chat({
            model: 'light',
            system: [],
            messages: [],
            maxOutputTokens: 10,
            stream: false,
          });
        },
      },
    );
    const result = await runTurn(h.deps, h.input);
    expect(result.stopped).toBe('continuable');
    expect([main, light]).toEqual([1, 1]);
    expect(h.turns.activityAllowance(result.turnId)?.modelCallsUsed).toBe(2);
  });

  it('the lane recovers owner work after a crash before renewal without refreshing its allowance', async () => {
    vi.useFakeTimers();
    const script = [call('read-once'), empty(), empty(), empty(), empty()];
    let requests = 0;
    const h = harness({ kind: 'openai-compat', chat: async () => script[requests++]! });
    const grant = vi.spyOn(h.turns, 'grantContinuation').mockImplementationOnce(() => {
      throw new Error('crash before renewal');
    });
    const running = runTurn(h.deps, h.input).then(
      () => null,
      (error: Error) => error.message,
    );
    await vi.runAllTimersAsync();
    expect(await running).toBe('crash before renewal');
    grant.mockRestore();
    const pending = h.turns.due()[0];
    expect(pending?.status).toBe('continuable');
    const reopened = new TurnStore(h.db);
    let after = 0;
    const deps = {
      ...h.deps,
      turns: reopened,
      profile: {
        ...h.deps.profile,
        activity: { maxModelCalls: 999, maxToolCalls: 999, maxAutomaticContinuations: 99 },
      },
      provider: {
        kind: 'openai-compat' as const,
        chat: async () => (after++ === 0 ? call('read-once') : answer()),
      },
    };
    const events: unknown[] = [];
    const lane = makeLaneRunner(deps, undefined, (event) => events.push(event));
    expect(await lane(pending!.id)).toMatchObject({ stopped: 'answered' });
    expect(reopened.activityAllowance(pending!.id)).toMatchObject({
      maxModelCalls: 128,
      maxToolCalls: 256,
      modelCallsUsed: 7,
      toolCallsUsed: 1,
      automaticContinuationsUsed: 1,
    });
    expect(readFileSync(join(h.home, 'effects'), 'utf8')).toBe('1');
    expect(events).toHaveLength(1);
  });

  it.each(['idle', 'ceiling'] as const)(
    'keeps %s post-turn consolidation outside the completed activity allowance',
    async (mode) => {
      vi.useFakeTimers();
      let lightCalls = 0;
      const helper = lightLane(
        {
          kind: 'openai-compat',
          chat: async () => {
            lightCalls++;
            return answer('light');
          },
        },
        { profile: CONSERVATIVE },
      );
      const h = harness({ kind: 'openai-compat', chat: async () => answer() }, { modelCalls: 1 });
      const consolidation = new Consolidator({
        db: h.db,
        idleMs: 10,
        ceiling: mode === 'ceiling' ? 1 : 12,
        budgetExhausted: () => false,
        log: () => {},
        ingest: async () => {
          await helper.chat({
            model: 'light',
            system: [],
            messages: [],
            maxOutputTokens: 10,
            stream: false,
          });
          return {
            tenantId: 'host',
            fetched: 0,
            marked: 0,
            episodes: 0,
            factsAdded: 0,
            rejected: 0,
            superseded: 0,
            skippedAgentOutput: 0,
            skippedDocuments: 0,
            skippedEmpty: 0,
            indexed: 0,
            forgottenRequestChunks: 0,
            busy: false,
            needsReview: [],
            errors: [],
            judgeUnavailable: [],
          };
        },
      });
      h.deps.onTurnEnd = ({ tenant }) => consolidation.notify(tenant);
      const result = await runTurn(h.deps, h.input);
      expect(result.stopped).toBe('answered');
      await vi.advanceTimersByTimeAsync(10);
      await consolidation.settled();
      consolidation.stop();
      expect(lightCalls).toBe(1);
      expect(readConsolidation(h.db)?.last?.errors).toBe(0);
      expect(h.turns.activityAllowance(result.turnId)?.modelCallsUsed).toBe(1);
    },
  );

  it('isolates concurrent activities sharing the same light provider', async () => {
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const helper = lightLane(
      {
        kind: 'openai-compat',
        chat: async () => {
          if (++arrived === 2) release();
          await barrier;
          return answer('light');
        },
      },
      { profile: CONSERVATIVE },
    );
    const build = () => {
      let requests = 0;
      return harness(
        { kind: 'openai-compat', chat: async () => (requests++ === 0 ? call('read') : answer()) },
        {
          modelCalls: 3,
          handler: async () => {
            await helper.chat({
              model: 'light',
              system: [],
              messages: [],
              maxOutputTokens: 10,
              stream: false,
            });
          },
        },
      );
    };
    const a = build(),
      b = build();
    const results = await Promise.all([runTurn(a.deps, a.input), runTurn(b.deps, b.input)]);
    expect(results.map((r) => r.stopped)).toEqual(['answered', 'answered']);
    expect(a.turns.activityAllowance(results[0]!.turnId)?.modelCallsUsed).toBe(3);
    expect(b.turns.activityAllowance(results[1]!.turnId)?.modelCallsUsed).toBe(3);
  });

  it('refuses tool dispatches beyond the cumulative allowance inside a single batch', async () => {
    let requests = 0;
    const h = harness(
      {
        kind: 'openai-compat',
        chat: async () => {
          requests++;
          return {
            ...call('one'),
            toolCalls: [
              call('one').toolCalls[0]!,
              call('two').toolCalls[0]!,
              call('three').toolCalls[0]!,
            ],
          };
        },
      },
      { toolCalls: 1 },
    );
    const result = await runTurn(h.deps, h.input);
    expect(result.stopped).toBe('continuable');
    expect(requests).toBe(1);
    expect(h.effects()).toBe(1);
    expect(h.turns.activityAllowance(result.turnId)?.toolCallsUsed).toBe(1);
  });

  it('honors owner cancellation without automatic resurrection', async () => {
    const controller = new AbortController();
    let requests = 0;
    const h = harness({
      kind: 'openai-compat',
      chat: async () => {
        requests++;
        controller.abort('user_stop');
        return call('read');
      },
    });
    const result = await runTurn(h.deps, { ...h.input, signal: controller.signal });
    expect(result.stopped).toBe('aborted');
    expect(requests).toBe(1);
    expect(h.effects()).toBe(0);
    expect(h.turns.due()).toEqual([]);
  });

  it('does not retrofit a new grant onto external input or an ordinary resume', async () => {
    const h = harness({ kind: 'openai-compat', chat: async () => answer() });
    const result = await runTurn(h.deps, { ...h.input, inputOrigin: 'external' });
    expect(h.turns.activityAllowance(result.turnId)).toBeNull();
    expect(await resumeTurn(h.deps, result.turnId)).toMatchObject({ why: 'finished' });
  });
});
