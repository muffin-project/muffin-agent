import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecide } from '../../core/policy/decide.js';
import { POLICY_FLOOR } from '../../core/policy/matrix.js';
import type { Principal } from '../../core/policy/types.js';
import { SessionStore } from '../../core/session/store.js';
import { JsonlExporter, SimpleTracer } from '../../core/tracing/tracer.js';
import { TurnStore } from '../../core/turns/store.js';
import { TodoStore } from '../../core/turns/todo.js';
import { CONSERVATIVE, DEFAULT_EXECUTION, type Profile } from '../profiles/profile.js';
import type { ChatCall, ChatResult, Provider } from '../providers/types.js';
import { runTurn } from './entry.js';
import type { LoopDeps, TurnEvent, TurnInput } from './types.js';

const owner: Principal = {
  kind: 'owner',
  connector: 'cli',
  externalId: 'local',
};

function answer(text: string): ChatResult {
  return {
    text,
    toolCalls: [],
    stopReason: 'end',
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    model: 'test',
  };
}

function harness(provider: Provider, profile: Profile = CONSERVATIVE) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-execution-runtime-'));
  const db = new DatabaseCtor(':memory:');
  const sessions = new SessionStore(home);
  const capabilities = new Map();

  const deps: LoopDeps = {
    provider,
    profile,
    model: 'test-model',
    tools: [],
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
    systemPrompts: {
      owner: 'Sei Muffin.',
      group: 'Sei Muffin, ospite in un gruppo.',
    },
  };

  return { deps, sessions };
}

function input(sessions: SessionStore): TurnInput {
  return {
    principal: owner,
    tenant: 'host',
    surface: 'cli',
    session: sessions.open('t1'),
    text: 'ciao',
  };
}

function modelStatuses(events: TurnEvent[]) {
  return events
    .filter(
      (event): event is Extract<TurnEvent, { type: 'model_status' }> =>
        event.type === 'model_status',
    )
    .map((event) => event.status);
}

describe('execution runtime integration', () => {
  it('uses DEFAULT_EXECUTION for a programmatic legacy profile with no execution block', async () => {
    const previous = DEFAULT_EXECUTION.activeModelBudgetMs;
    let chatCalls = 0;

    const provider: Provider = {
      kind: 'openai-compat',
      async chat(_call: ChatCall) {
        chatCalls += 1;
        return answer('non deve partire');
      },
    };

    const profile: Profile = {
      ...CONSERVATIVE,
      execution: undefined,
    };

    DEFAULT_EXECUTION.activeModelBudgetMs = 0;

    try {
      const h = harness(provider, profile);
      const result = await runTurn(h.deps, input(h.sessions));

      expect(chatCalls).toBe(0);
      expect(result.stopped).toBe('error');
      expect(result.reason).toBe('active_model_budget_exhausted');
    } finally {
      DEFAULT_EXECUTION.activeModelBudgetMs = previous;
    }
  });

  it('wires streamed semantic activity through the real round into model_status', async () => {
    let streamCalls = 0;

    const provider: Provider = {
      kind: 'openai-compat',

      async chat(_call: ChatCall) {
        throw new Error('non-streaming path reached');
      },

      async *chatStream(_call: ChatCall) {
        streamCalls += 1;
        yield { type: 'thinking_delta' as const, text: 'hmm' };
        yield { type: 'text_delta' as const, text: 'ciao' };
        yield { type: 'done' as const, result: answer('ciao') };
      },
    };

    const h = harness(provider);
    const events: TurnEvent[] = [];

    const result = await runTurn(h.deps, {
      ...input(h.sessions),
      onDelta: () => undefined,
      onProgress: (event) => events.push(event),
    });

    expect(streamCalls).toBe(1);
    expect(result).toMatchObject({
      stopped: 'answered',
      text: 'ciao',
    });
    expect(modelStatuses(events)).toEqual([
      'waiting_for_model',
      'thinking',
      'receiving',
    ]);
  });
});
