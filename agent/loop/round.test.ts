import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createDecide } from '../../core/policy/decide.js';
import { replyCapability } from '../../core/policy/doors.js';
import { POLICY_FLOOR } from '../../core/policy/matrix.js';
import type {
  CapabilityDecl,
  CapabilityId,
  Decision,
  DecisionRequest,
  Principal,
} from '../../core/policy/types.js';
import { SessionStore } from '../../core/session/store.js';
import { JsonlExporter, SimpleTracer } from '../../core/tracing/tracer.js';
import type { AttributeValue, SpanHandle } from '../../core/tracing/types.js';
import { TurnStore } from '../../core/turns/store.js';
import { TodoStore } from '../../core/turns/todo.js';
import { CONSERVATIVE, type Profile } from '../profiles/profile.js';
import {
  type ChatCall,
  type ChatResult,
  type Message,
  type Provider,
  ProviderError,
  ProviderStreamError,
  type StreamEvent,
} from '../providers/types.js';
import { searchCapability, searchSpec } from '../tools/search.js';
import { makeSnapshot } from './permissions.js';
import { type RoundScope, recover, runRounds } from './round.js';
import { TurnRun } from './run-state.js';
import { ExecutionBudget } from './execution-budget.js';
import {
  assertNever,
  type LoopDeps,
  type RegisteredTool,
  type ToolContext,
  type TurnDelta,
  type TurnInput,
} from './types.js';

/**
 * Twin test for the `agent/loop/round.ts` extraction (Fase A, fetta 8): the
 * paid path — the reply door, the model call, the stream and its single
 * fallback, the transport-retry budget, the completion gate and the tool-call
 * batch under the per-turn cap — moved out of `guidaIlTurno`'s closure into a
 * module that receives a `RoundScope`.
 *
 * Three properties are measured, and they are the three the design names for
 * this slice (§4 inv. 7 and §3 row 8):
 *
 *  - **The reply door is asked before the model call.** Not "a door is asked":
 *    the *order* is the property, because a round's text streams out of the
 *    model call as it is generated, so a decision taken afterwards would be
 *    taken about bytes already on the owner's screen. Measured as a single
 *    ordered log of both events, so moving the `door(...)` call one line below
 *    `requestChatResult()` is red here regardless of what the policy answers.
 *  - **One fallback, never a second stream.** A broken stream falls back to a
 *    single plain `chat()` for this attempt; a *second* `chatStream` inside one
 *    attempt is the mutation, and it is caught by counting calls per method
 *    rather than by counting calls in total.
 *  - **The cap counts calls, not iterations**, and a refused call still gets a
 *    `tool_result` — a hole in the batch is a protocol error every provider
 *    rejects. The refusal text is asserted verbatim (§4 inv. 9).
 *
 * The bench is a real `TurnStore` row claimed the way `drive` claims one: every
 * exit from `runRounds` goes through a fenced write, so a fake store would let
 * a turn "end" without ending anything.
 */

const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };

function recordingSpan(traceId: string): SpanHandle & { attrs: Record<string, AttributeValue> } {
  const attrs: Record<string, AttributeValue> = {};
  return {
    traceId,
    spanId: '0'.repeat(16),
    attrs,
    setAttributes(next) {
      Object.assign(attrs, next);
    },
    end() {
      /* the bench reads attributes, not lifetimes */
    },
  };
}

function freshCounters() {
  return {
    iterations: 0,
    recoveriesUsed: 0,
    transportRetriesLeft: 2,
    toolCallsMade: 0,
    nudgedForCompletion: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    spentUsd: 0,
    resumes: 0,
    contextBuilt: true,
  };
}

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

function reply(text: string): ChatResult {
  return { text, toolCalls: [], stopReason: 'end', usage, model: 'test' };
}

function calls(...names: string[]): ChatResult {
  return {
    text: null,
    toolCalls: names.map((name, i) => ({ id: `c${i}`, name, args: {} })),
    stopReason: 'tool_use',
    usage,
    model: 'test',
  };
}

/** A tool that always succeeds, declared so the kernel floor lets it through. */
function okTool(name: string): { tool: RegisteredTool; decl: CapabilityDecl } {
  const decl: CapabilityDecl = {
    ...searchCapability,
    id: `sys.${name}` as CapabilityId,
    hostOnly: false,
  };
  return {
    decl,
    tool: {
      capability: decl.id,
      spec: { ...searchSpec, name },
      handler: () => ({ content: 'fatto', tier: 0 }),
      throwTier: 0,
    },
  };
}

/**
 * A provider whose two doors are counted **separately**.
 *
 * `chat` and `chatStream` scripts are consumed independently: a fallback is
 * "one stream attempt, then one plain call", and a mutation that streams twice
 * shows up as a second `chatStream` entry, never as a longer total.
 */
function scriptedProvider(script: {
  stream?: (StreamEvent | Error)[][];
  chat?: (Error | ChatResult)[];
  log?: string[];
}): Provider & { streamCalls: ChatCall[]; chatCalls: ChatCall[] } {
  const streamQueue = [...(script.stream ?? [])];
  const chatQueue = [...(script.chat ?? [])];
  const streamCalls: ChatCall[] = [];
  const chatCalls: ChatCall[] = [];
  const provider = {
    name: 'scripted',
    streamCalls,
    chatCalls,
    async chat(call: ChatCall): Promise<ChatResult> {
      chatCalls.push(call);
      script.log?.push('chat');
      const next = chatQueue.shift();
      if (next === undefined) throw new Error('script esaurito: chat');
      if (next instanceof Error) throw next;
      return next;
    },
    async *chatStream(call: ChatCall): AsyncIterable<StreamEvent> {
      streamCalls.push(call);
      script.log?.push('chatStream');
      const next = streamQueue.shift();
      if (next === undefined) throw new Error('script esaurito: chatStream');
      // Un `Error` in coda si lancia **dopo** gli eventi che lo precedono: uno
      // stream che muore a metà ha già mostrato qualcosa, ed è l'unico caso in
      // cui il confine `superseded` ha un testo da chiudere.
      for (const event of next) {
        if (event instanceof Error) throw event;
        yield event;
      }
    },
  };
  return provider as unknown as Provider & { streamCalls: ChatCall[]; chatCalls: ChatCall[] };
}

function harness(options: {
  provider: Provider;
  profile?: Profile;
  tools?: RegisteredTool[];
  decls?: CapabilityDecl[];
  denyReply?: boolean;
  onDelta?: (delta: TurnDelta) => void;
  log?: string[];
  messages?: Message[];
  execution?: ExecutionBudget;
}) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-round-'));
  const decls = options.decls ?? [];
  const tools = options.tools ?? [];
  const db = new DatabaseCtor(':memory:');
  const turns = new TurnStore(db);
  const profile = options.profile ?? CONSERVATIVE;
  const deps: LoopDeps = {
    provider: options.provider,
    profile,
    model: 'test',
    tools,
    capabilities: new Map(decls.map((d) => [d.id, d])),
    decide: createDecide({
      matrix: POLICY_FLOOR,
      capabilities: new Map(decls.map((d) => [d.id, d])),
      budgetExhausted: () => false,
      hardened: true,
    }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions: new SessionStore(home),
    turns,
    todos: new TodoStore(new DatabaseCtor(':memory:')),
    budgetExhausted: () => false,
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite in un gruppo.' },
  };

  const id = 'b'.repeat(32);
  turns.enqueue({
    id,
    principal: owner,
    tenant: 'host',
    surface: 'cli',
    sessionId: 's1',
    model: 'test',
    messages: options.messages ?? [{ role: 'user', content: [{ type: 'text', text: 'ciao' }] }],
    taint: 0,
    counters: freshCounters(),
  });
  const record = turns.claim(id);
  if (record === null) throw new Error('claim fallita');

  const span = recordingSpan(id);
  const run = new TurnRun(record, { resumed: false, wokenFromWait: false });
  const snapshot = makeSnapshot(deps.decide, owner, 'host', 0);
  const input: TurnInput = {
    principal: owner,
    tenant: 'host',
    surface: 'cli',
    session: { id: 's1', file: join(home, 's1.jsonl') },
    text: 'ciao',
    ...(options.onDelta ? { onDelta: options.onDelta } : {}),
  };
  const toolContext: ToolContext = {
    tenant: 'host',
    principal: owner,
    turnId: record.id,
    sessionId: 's1',
    taint: () => snapshot.currentTaint(),
    intrinsicTaint: () => snapshot.intrinsicTaint(),
    suspend: (spec) => {
      run.barrier = spec;
    },
  };
  /**
   * The pre-loop's own door closures, rebuilt here exactly as `guidaIlTurno`
   * builds them — plus one line that appends to the shared log, which is what
   * makes "asked before the model call" an assertion instead of a sentence.
   */
  const door = (capability: CapabilityId, resource: DecisionRequest['resource']): Decision => {
    options.log?.push(`door:${capability}`);
    if (options.denyReply === true && capability === replyCapability.id) {
      return { effect: 'deny', code: 'taint_exceeded' };
    }
    return snapshot.check(capability, resource, {});
  };
  const doorRefusal = (decision: Decision): Exclude<Decision, { effect: 'allow' }> | undefined => {
    switch (decision.effect) {
      case 'allow':
        return undefined;
      case 'deny':
      case 'ask':
      case 'draft':
        return decision;
      default:
        return assertNever(decision);
    }
  };
  const scope: RoundScope = {
    deps,
    record,
    turn: span,
    input,
    run,
    snapshot,
    recupero: [],
    exposed: tools,
    toolContext,
    noteSensitiveResourceEcho: () => undefined,
    turnClass: 'owner',
    now: () => new Date('2026-09-05T12:00:00.000Z'),
    door,
    doorRefusal,
    refusalLabel: (refusal) => (refusal.effect === 'deny' ? refusal.code : refusal.effect),
    memoryDoorOpen: () => true,
    execution: options.execution ?? new ExecutionBudget({ modelCallDeadlineMs: 90_000, turnWallDeadlineMs: 180_000 }),
  };
  return { scope, deps, turns, record, span, run, id };
}

describe('la porta di risposta è chiesta prima della chiamata al modello', () => {
  /**
   * Inv. 7, as an order and not as a presence. The log interleaves both events
   * from the *same* array, so a `door(replyCapability.id, …)` moved below
   * `requestChatResult()` reverses two entries and this fails — even though the
   * policy floor answers `allow` and the turn ends identically.
   */
  it('su ogni giro, e prima anche del secondo', async () => {
    const log: string[] = [];
    const { tool, decl } = okTool('noop');
    const h = harness({
      provider: scriptedProvider({ chat: [calls('noop'), reply('fatto')], log }),
      tools: [tool],
      decls: [decl],
      log,
    });

    const result = await runRounds(h.scope);

    expect(result.stopped).toBe('answered');
    expect(log.filter((e) => e === 'chat' || e === `door:${replyCapability.id}`)).toEqual([
      `door:${replyCapability.id}`,
      'chat',
      `door:${replyCapability.id}`,
      'chat',
    ]);
  });

  /**
   * The other half of the same property: when the row refuses, the model is
   * never called at all — which is only true if the question came first. The
   * text is the kernel's own sentence, byte-identical (§4 inv. 9).
   */
  it('e quando rifiuta, il modello non viene chiamato affatto', async () => {
    const provider = scriptedProvider({ chat: [reply('non deve uscire')] });
    const h = harness({ provider, denyReply: true });

    const result = await runRounds(h.scope);

    expect(provider.chatCalls).toHaveLength(0);
    expect(provider.streamCalls).toHaveLength(0);
    expect(result.stopped).toBe('answered');
    expect(result.text).toBe(
      'La risposta è stata trattenuta dal kernel dei permessi (taint_exceeded). Una conversazione nuova riparte con il contesto pulito.',
    );
    expect(h.span.attrs['muffin.reply.refused']).toBe('taint_exceeded');
  });
});

describe('un solo fallback, mai un secondo tentativo in streaming', () => {
  /**
   * The mutation this case exists for: a stream that breaks retried *as a
   * stream*. Counted per method, so the second `chatStream` is visible even
   * though the turn still answers and the total number of provider calls is
   * the same.
   */
  it('uno stream rotto ricade su chat() una volta sola, e chatStream non è richiamato', async () => {
    const deltas: TurnDelta[] = [];
    const provider = scriptedProvider({
      stream: [
        [{ type: 'text_delta', text: 'mezza ri' }, new ProviderStreamError('SSE troncato', true)],
      ],
      chat: [reply('la risposta intera')],
    });
    const h = harness({ provider, onDelta: (d) => deltas.push(d) });

    const result = await runRounds(h.scope);

    expect(provider.streamCalls).toHaveLength(1);
    expect(provider.chatCalls).toHaveLength(1);
    expect(provider.chatCalls[0]?.stream).toBe(false);
    expect(result.text).toBe('la risposta intera');
    // Il testo del tentativo fallito è chiuso come superato, e quello nuovo
    // arriva intero: senza questa consegna la superficie resterebbe con la
    // bozza superata sullo schermo.
    expect(deltas).toEqual([
      { type: 'text', text: 'mezza ri' },
      { type: 'boundary', reason: 'superseded' },
      { type: 'text', text: 'la risposta intera' },
    ]);
  });

  /**
   * A transport failure is the *other* budget, and it does re-stream — on a
   * later iteration, which rebuilds `call` and opens its own span. That is not
   * the thing the case above forbids, and pinning it here is what keeps the
   * fix for one from silently deleting the other.
   */
  it('un guasto di trasporto invece ritenta, e il ritentativo è un giro nuovo', async () => {
    const provider = scriptedProvider({
      stream: [
        [new ProviderError('429', true, 429, 'transport')],
        [{ type: 'done', result: reply('alla seconda') }],
      ],
    });
    const h = harness({ provider, onDelta: () => undefined });

    const result = await runRounds(h.scope);

    expect(provider.streamCalls).toHaveLength(2);
    expect(provider.chatCalls).toHaveLength(0);
    expect(result.text).toBe('alla seconda');
    expect(h.run.transportRetriesLeft).toBe(1);
    expect(result.iterations).toBe(2);
  });
});

describe('il tetto conta le chiamate, non i giri', () => {
  /**
   * One completion carrying more `tool_use` blocks than the profile allows.
   * The refused ones still get a `tool_result` — a hole in the batch is a
   * protocol error every provider rejects — and the sentence is the one the
   * owner's model reads, asserted verbatim.
   */
  it('rifiuta le chiamate oltre il tetto e risponde comunque a ognuna', async () => {
    const { tool, decl } = okTool('noop');
    const provider = scriptedProvider({ chat: [calls('noop', 'noop', 'noop'), reply('ok')] });
    const h = harness({
      provider,
      profile: { ...CONSERVATIVE, maxToolCallsPerTurn: 2 },
      tools: [tool],
      decls: [decl],
    });

    const result = await runRounds(h.scope);

    expect(result.stopped).toBe('answered');
    expect(h.run.toolCallsMade).toBe(2);
    const batch = h.run.messages.find(
      (m) =>
        m.role === 'user' &&
        m.content.some((b) => b.type === 'tool_result' && b.toolCallId === 'c2'),
    );
    const refused = batch?.content.find((b) => b.type === 'tool_result' && b.toolCallId === 'c2');
    expect(refused).toEqual({
      type: 'tool_result',
      toolCallId: 'c2',
      content:
        'Tetto di 2 tool call per turno raggiunto: chiamata non eseguita. ' +
        "Chiudi il turno con quello che hai, o dì all'owner cosa resta da fare.",
      isError: true,
    });
    // Ogni blocco `tool_use` ha il suo `tool_result`: nessun buco nel batch.
    expect(batch?.content).toHaveLength(3);
  });
});

describe('recover cammina la cascata del profilo, un passo per tentativo', () => {
  it('nell ordine dichiarato, e si ferma quando è esaurita', () => {
    const h = harness({
      provider: scriptedProvider({}),
      profile: { ...CONSERVATIVE, recovery: ['nudge', 'retryOnce'] },
    });

    expect(recover(h.scope, 'empty')).toBe(true);
    expect(h.span.attrs['muffin.recovery.strategy']).toBe('nudge');
    expect(recover(h.scope, 'empty')).toBe(true);
    expect(h.span.attrs['muffin.recovery.strategy']).toBe('retryOnce');
    expect(recover(h.scope, 'empty')).toBe(false);
    expect(h.run.recoveriesUsed).toBe(2);
  });

  /** Un profilo senza stampelle è una modifica di JSON, non un ramo di codice. */
  it('un profilo con recovery vuota non recupera mai', () => {
    const h = harness({
      provider: scriptedProvider({}),
      profile: { ...CONSERVATIVE, recovery: [] },
    });
    expect(recover(h.scope, 'malformed')).toBe(false);
  });
});

describe('il gate di completezza spinge una volta sola', () => {
  it('e la seconda volta la risposta resta, dichiarata sullo span', async () => {
    const { tool, decl } = okTool('fs_write');
    const provider = scriptedProvider({
      chat: [reply('Ho usato fs_write per salvarlo.'), reply('Ho usato fs_write, davvero.')],
    });
    const h = harness({ provider, tools: [tool], decls: [decl] });

    const result = await runRounds(h.scope);

    expect(provider.chatCalls).toHaveLength(2);
    expect(h.run.nudgedForCompletion).toBe(true);
    expect(h.span.attrs['muffin.completion.unresolved']).toBe(true);
    expect(result.text).toBe('Ho usato fs_write, davvero.');
  });
});

describe('execution budget', () => {
  it('does not invoke the provider when the cumulative model budget is already spent', async () => {
    let calls = 0;
    const provider: Provider = {
      kind: 'openai-compat',
      async chat() {
        calls += 1;
        return reply('non dovrebbe partire');
      },
    };
    const h = harness({
      provider,
      execution: new ExecutionBudget({ modelCallDeadlineMs: 100, turnWallDeadlineMs: 200, activeModelBudgetMs: 0 }),
    });

    const result = await runRounds(h.scope);

    expect(calls).toBe(0);
    expect(result.stopped).toBe('error');
    expect(result.reason).toBe('active_model_budget_exhausted');
  });

  it('aborta una model call lunga senza trasformarla in un transport retry', async () => {
    let calls = 0;
    const provider: Provider = {
      kind: 'openai-compat',
      async chat(call) {
        calls += 1;
        await new Promise<never>((_, reject) => {
          call.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
        throw new Error('unreachable');
      },
    };
    const h = harness({
      provider,
      profile: { ...CONSERVATIVE, recovery: ['retryOnce'] },
      execution: new ExecutionBudget({ modelCallDeadlineMs: 100, turnWallDeadlineMs: 200, firstActivityTimeoutMs: 10, stallTimeoutMs: 20 }),
    });

    const result = await runRounds(h.scope);

    expect(calls).toBe(1);
    expect(result.stopped).toBe('error');
    expect(result.reason).toBe('model_first_activity_timeout');
    expect(h.span.attrs['muffin.turn.stop_reason']).toBe('model_first_activity_timeout');
  });
});
