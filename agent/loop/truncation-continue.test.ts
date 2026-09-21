import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createDecide } from '../../core/policy/decide.js';
import { POLICY_FLOOR } from '../../core/policy/matrix.js';
import type { CapabilityDecl, Principal } from '../../core/policy/types.js';
import type { Embedder } from '../../core/memory/embed.js';
import { MemoryStore } from '../../core/memory/store.js';
import { VectorIndex } from '../../core/memory/vectors.js';
import { SessionStore } from '../../core/session/store.js';
import { JsonlExporter, SimpleTracer } from '../../core/tracing/tracer.js';
import { TurnStore } from '../../core/turns/store.js';
import { TodoStore } from '../../core/turns/todo.js';
import { continueTurn, resumeTurn, runTurn, type LoopDeps } from '../loop.js';
import { CONSERVATIVE } from '../profiles/profile.js';
import type { ChatCall, ChatResult, Message, Provider } from '../providers/types.js';
import { searchCapability, searchSpec } from '../tools/search.js';
import { harnessMessage, partialMessage } from './message-origin.js';
import { MAX_TRANSPORT_RETRIES, MAX_TRUNCATION_CONTINUATIONS, type TurnDelta } from './types.js';

/**
 * #615 — max_tokens with partial text must continue the SAME logical
 * answer, never settle as answered.
 *
 * Structural rules under test:
 * - a truncation partial has EXPLICIT identity (origin `partial`); reinjected
 *   session history (legacy absent origin) and tool-use messages can never be
 *   mistaken for it;
 * - continuation spends a DEDICATED durable budget (`truncationsUsed`), never
 *   transport retries;
 * - a verbatim repeated chunk is no-progress: stop, do not duplicate, do not
 *   burn budget;
 * - final Session/Memory holds ONE complete assistant answer.
 */

const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };
const NOW = () => new Date('2026-09-20T12:00:00.000Z');
const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

class FakeEmbedder implements Embedder {
  readonly id = 'fake:v1';
  readonly dimensions = 4;
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => Float32Array.from([1, 0, 0, 0]));
  }
}

const truncatedPartial = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  stopReason: 'max_tokens',
  finishReason: 'length',
  usage: { ...usage, outputTokens: 4096 },
  model: 'test-model',
});

const finalAnswer = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  stopReason: 'end',
  usage,
  model: 'test-model',
});

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  readonly seen: ChatCall[] = [];
  private i = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(request: ChatCall): Promise<ChatResult> {
    this.seen.push({ ...request, messages: [...request.messages] });
    const next = this.script[this.i++];
    if (next === undefined) throw new Error('script esaurito: chat');
    return next;
  }
}

function toolDecl(): CapabilityDecl {
  return { ...searchCapability, id: 'sys.leggi' as CapabilityDecl['id'], hostOnly: false };
}

function world(script: ChatResult[], opts: { withMemory?: boolean; withTool?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-615-'));
  const db = new DatabaseCtor(':memory:');
  const memDb = new DatabaseCtor(':memory:');
  const turns = new TurnStore(db);
  const sessions = new SessionStore(home);
  const capabilities = new Map<CapabilityDecl['id'], CapabilityDecl>();
  const tools: LoopDeps['tools'] = [];
  if (opts.withTool === true) {
    const decl = toolDecl();
    capabilities.set(decl.id, decl);
    tools.push({
      capability: decl.id,
      spec: { ...searchSpec, name: 'leggi' },
      handler: () => ({ content: 'contenuto letto', tier: 0 as const }),
      throwTier: 0,
    });
  }
  const provider = new Scripted(script);
  const memStore = new MemoryStore(memDb);
  const vectors = new VectorIndex(memDb, new FakeEmbedder());
  const deps: LoopDeps = {
    provider,
    profile: CONSERVATIVE,
    model: 'test-model',
    tools,
    capabilities,
    decide: createDecide({ matrix: POLICY_FLOOR, capabilities, budgetExhausted: () => false, hardened: true }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions,
    turns,
    todos: new TodoStore(db),
    budgetExhausted: () => false,
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite.' },
    now: NOW,
    ...(opts.withMemory === true ? { memory: { store: memStore, recall: { store: memStore, vectors } } } : {}),
  };
  return { deps, turns, sessions, provider, home, memStore };
}

/** Turn-span attributes out of the exported JSONL trace (see round.test.ts). */
function turnSpanAttrs(home: string): Record<string, unknown>[] {
  const dir = join(home, 'traces');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n'))
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { name: string; attributes: Record<string, unknown> })
    .filter((r) => r.name === 'muffin.turn')
    .map((r) => r.attributes);
}

const toolCall = (name: string, id: string, args: unknown = {}): ChatResult => ({
  text: null,
  toolCalls: [{ id, name, args }],
  stopReason: 'tool_use',
  usage,
  model: 'test-model',
});

describe('#615 history can never poison the current answer', () => {
  it('old assistant answers + tool history + A,A2(max_tokens) + B(end) => exactly A+A2+B', async () => {
    const FULL = 'PARTE-A-PARTE-A2-PARTE-B';
    const w = world(
      [
        finalAnswer('vecchia risposta uno'),
        toolCall('leggi', 'c1', { query: 'storia', path: 'storia.txt' }),
        finalAnswer('vecchia risposta due'),
        finalAnswer('vecchia risposta tre'),
        truncatedPartial('PARTE-A-'),
        truncatedPartial('PARTE-A2-'),
        finalAnswer('PARTE-B'),
      ],
      { withMemory: true, withTool: true },
    );
    const session = w.sessions.open('owner');
    const mkInput = (text: string) => ({ principal: owner, tenant: 'host', surface: 'cli', session, text });

    await runTurn(w.deps, mkInput('prima domanda'));
    await runTurn(w.deps, mkInput('seconda domanda con tool'));
    await runTurn(w.deps, mkInput('terza domanda'));
    expect(sessionsRead(w, session, 'assistant')).toHaveLength(3);

    const r = await runTurn(w.deps, mkInput('quarta domanda lunga'));

    // Exactly the current chunks — no old assistant history may appear.
    expect(r.stopped).toBe('answered');
    expect(r.text).toBe(FULL);
    expect(r.text).not.toContain('vecchia');
    // Exactly one NEW assistant Session row, with the complete answer.
    const after = sessionsRead(w, session, 'assistant');
    expect(after).toHaveLength(4);
    expect(after[3]).toBe(FULL);
    // Current Memory episode contains exactly the full answer, once.
    const agents = w.memStore.pendingEpisodes('host', 1, 30).filter((e) => e.role === 'agent');
    expect(agents.filter((e) => e.content === FULL)).toHaveLength(1);
    expect(agents.some((e) => (e.content ?? '').includes('vecchia') && (e.content ?? '').includes('PARTE'))).toBe(false);
    // Structural identity: transcript partials carry origin `partial`;
    // reinjected history never does.
    const row = w.turns.get(r.turnId);
    const partials = (row?.messages ?? []).filter((m) => m.origin === 'partial');
    expect(partials.map((m) => m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')).join('')).toBe(
      'PARTE-A-PARTE-A2-',
    );
    // seen[4]=A call (no partial yet), seen[5]=A2 call carries exactly chunk A.
    const secondCallPartials = w.provider.seen[5]!.messages.filter((m) => m.origin === 'partial');
    expect(secondCallPartials).toHaveLength(1);
    expect(w.provider.seen[5]!.messages.some((m) => m.origin === undefined && m.role === 'assistant')).toBe(true);
    // Diagnostics count only current partials: after A (8 chars), not history.
    const spans = turnSpanAttrs(w.home);
    const truncating = spans.filter((a) => a['muffin.truncation.continuation'] === true);
    expect(truncating.length).toBeGreaterThan(0);
    expect(truncating.at(-1)!['muffin.truncation.prefix_chars']).toBe('PARTE-A-'.length);
    // Dedicated budget spent twice; transport untouched.
    expect(row?.counters.truncationsUsed).toBe(2);
    expect(row?.counters.transportRetriesLeft).toBe(MAX_TRANSPORT_RETRIES);
  });

  function sessionsRead(w: ReturnType<typeof world>, session: { id: string; file: string }, role: string): string[] {
    return w.sessions.read(session).filter((m) => m.role === role).map((m) => m.content);
  }
});

describe('#615 non-streaming partial continues same logical answer', () => {
  it('appends continuation, single Session row, never settles partial as answered', async () => {
    const w = world([truncatedPartial('prima parte…'), finalAnswer('seconda parte')]);
    const session = w.sessions.open('owner');

    const r = await runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'raccontami una storia lunga',
    });

    expect(w.provider.seen).toHaveLength(2);
    expect(r.stopped).toBe('answered');
    expect(r.text).toBe('prima parte…seconda parte');

    const secondWire = JSON.stringify(w.provider.seen[1]!.messages);
    expect(secondWire).toContain('prima parte…');

    const transcript = w.sessions.read(session);
    const assistantRows = transcript.filter((m) => m.role === 'assistant');
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]!.content).toBe('prima parte…seconda parte');

    const row = w.turns.get(r.turnId);
    expect(row?.status).toBe('done');
    expect(row?.outcome).toBe('answered');
    expect(row?.counters.truncationsUsed).toBe(1);
    expect(row?.counters.transportRetriesLeft).toBe(MAX_TRANSPORT_RETRIES);
  });

  it('streaming prefix stays valid, continuation appends once, no superseded', async () => {
    const deltas: TurnDelta[] = [];
    const streamingProvider: Provider = {
      kind: 'openai-compat',
      async chat(): Promise<ChatResult> {
        throw new Error('unreachable: streaming test uses chatStream');
      },
      async *chatStream(call: ChatCall) {
        if (call.messages.some((m) => JSON.stringify(m).includes('prima parte…'))) {
          yield { type: 'text_delta', text: 'seconda parte' };
          yield { type: 'done', result: finalAnswer('seconda parte') };
        } else {
          yield { type: 'text_delta', text: 'prima parte…' };
          yield { type: 'done', result: truncatedPartial('prima parte…') };
        }
      },
    };
    const home = mkdtempSync(join(tmpdir(), 'muffin-615-stream-'));
    const db = new DatabaseCtor(':memory:');
    const turns = new TurnStore(db);
    const sessions = new SessionStore(home);
    const capabilities = new Map();
    const deps: LoopDeps = {
      provider: streamingProvider,
      profile: CONSERVATIVE,
      model: 'test-model',
      tools: [],
      capabilities,
      decide: createDecide({ matrix: POLICY_FLOOR, capabilities, budgetExhausted: () => false, hardened: true }),
      tracer: new SimpleTracer(new JsonlExporter(home)),
      sessions,
      turns,
      todos: new TodoStore(db),
      budgetExhausted: () => false,
      systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite.' },
      now: NOW,
    };
    const session = sessions.open('owner');
    const r = await runTurn(deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'raccontami una storia lunga',
      onDelta: (d) => deltas.push(d),
    });

    expect(r.stopped).toBe('answered');
    expect(r.text).toBe('prima parte…seconda parte');
    const texts = deltas.filter((d) => d.type === 'text').map((d) => (d as { text: string }).text).join('');
    expect(texts).toBe('prima parte…seconda parte');
    expect(deltas.filter((d) => d.type === 'boundary' && (d as { reason: string }).reason === 'superseded')).toHaveLength(0);
    const transcript = sessions.read(session);
    const assistantRows = transcript.filter((m) => m.role === 'assistant');
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]!.content).toBe('prima parte…seconda parte');
  });

  it('streaming with history appends only current chunks, never duplicates', async () => {
    const deltas: TurnDelta[] = [];
    const streamingProvider: Provider = {
      kind: 'openai-compat',
      async chat(): Promise<ChatResult> {
        throw new Error('unreachable');
      },
      async *chatStream(call: ChatCall) {
        if (call.messages.some((m) => JSON.stringify(m).includes('PARTE-A-'))) {
          yield { type: 'text_delta', text: 'PARTE-B' };
          yield { type: 'done', result: finalAnswer('PARTE-B') };
        } else {
          yield { type: 'text_delta', text: 'PARTE-A-' };
          yield { type: 'done', result: truncatedPartial('PARTE-A-') };
        }
      },
    };
    const w = world([finalAnswer('vecchia risposta uno')]);
    const session = w.sessions.open('owner');
    await runTurn(w.deps, { principal: owner, tenant: 'host', surface: 'cli', session, text: 'prima' });
    // Swap in the streaming provider for the truncated turn.
    (w.deps as { provider: Provider }).provider = streamingProvider;
    const r = await runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'seconda lunga',
      onDelta: (d) => deltas.push(d),
    });
    expect(r.text).toBe('PARTE-A-PARTE-B');
    const texts = deltas.filter((d) => d.type === 'text').map((d) => (d as { text: string }).text).join('');
    expect(texts).toBe('PARTE-A-PARTE-B');
    expect(deltas.filter((d) => d.type === 'boundary')).toHaveLength(0);
  });
});

describe('#615 bounds, restart, no-progress, unchanged paths', () => {
  it('C: repeated max_tokens exhausts the DEDICATED budget, transport untouched', async () => {
    const script = Array.from({ length: MAX_TRUNCATION_CONTINUATIONS + 5 }, (_, i) => truncatedPartial(`pezzo${i}…`));
    const w = world(script);
    const session = w.sessions.open('owner');
    const r = await runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'storia lunghissima',
    });
    expect(r.stopped).toBe('continuable');
    expect(r.reason).toBe('truncated');
    expect(w.provider.seen).toHaveLength(MAX_TRUNCATION_CONTINUATIONS + 1);
    expect(r.text).toContain('parziale');
    expect(r.text).toContain('riprendi');
    const row = w.turns.get(r.turnId);
    expect(row?.status).toBe('continuable');
    expect(row?.continuableReason?.class).toBe('truncated');
    expect(row?.counters.truncationsUsed).toBe(MAX_TRUNCATION_CONTINUATIONS + 1);
    expect(row?.counters.transportRetriesLeft).toBe(MAX_TRANSPORT_RETRIES);
    expect(w.sessions.read(session).filter((m) => m.role === 'assistant')).toHaveLength(0);
  });

  it('D: crash after accepted prefix resumes same logical answer without duplication', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-615-resume-'));
    const db = new DatabaseCtor(':memory:');
    const turns = new TurnStore(db);
    const sessions = new SessionStore(home);
    const capabilities = new Map();
    const provider = new Scripted([finalAnswer('seconda parte')]);
    const deps: LoopDeps = {
      provider,
      profile: CONSERVATIVE,
      model: 'test-model',
      tools: [],
      capabilities,
      decide: createDecide({ matrix: POLICY_FLOOR, capabilities, budgetExhausted: () => false, hardened: true }),
      tracer: new SimpleTracer(new JsonlExporter(home)),
      sessions,
      turns,
      todos: new TodoStore(db),
      budgetExhausted: () => false,
      systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite.' },
      now: NOW,
    };
    const created = turns.create(
      {
        id: 'resume615',
        principal: owner,
        tenant: 'host',
        surface: 'cli',
        sessionId: 'owner',
        model: 'test-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'raccontami una storia lunga' }] }],
        taint: 0,
        counters: {
          iterations: 1,
          recoveriesUsed: 0,
          transportRetriesLeft: MAX_TRANSPORT_RETRIES,
          truncationsUsed: 0,
          toolCallsMade: 0,
          nudgedForCompletion: false,
          usage: { inputTokens: 10, outputTokens: 4096, cacheReadTokens: 0, cacheWriteTokens: 0 },
          spentUsd: 0,
          resumes: 0,
          contextBuilt: true,
          activeModelMs: 0,
        },
      },
      4242,
    );
    const prefixMessages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'raccontami una storia lunga' }] },
      partialMessage([{ type: 'text', text: 'prima parte…' }]),
      harnessMessage('user', [{ type: 'text', text: 'La risposta precedente si è interrotta per limite di output.' }]),
    ];
    expect(
      turns.checkpoint(
        'resume615',
        {
          messages: prefixMessages,
          taint: 0,
          counters: { ...created.counters, iterations: 1, truncationsUsed: 1 },
        },
        created.claimToken,
      ),
    ).toBe(true);
    db.prepare(`UPDATE turns SET status = 'interrupted', claimed_by = NULL, claim_token = NULL WHERE id = 'resume615'`).run();

    const resumed = await resumeTurn(deps, 'resume615');
    if ('why' in resumed) throw new Error(`resume refused: ${resumed.why}`);
    expect(resumed.stopped).toBe('answered');
    expect(resumed.text).toBe('prima parte…seconda parte');
    const wire = JSON.stringify(provider.seen[0]!.messages);
    expect(wire.match(/prima parte…/g)).toHaveLength(1);
    const transcript = sessions.read(sessions.open('owner'));
    const assistantRows = transcript.filter((m) => m.role === 'assistant');
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]!.content).toBe('prima parte…seconda parte');
    expect(turns.get('resume615')?.counters.truncationsUsed).toBe(1);
  });

  it('D2: continuable prefix continues on owner grant without duplicating', async () => {
    const script = Array.from({ length: MAX_TRUNCATION_CONTINUATIONS + 1 }, (_, i) => truncatedPartial(`pezzo${i}…`));
    script.push(finalAnswer('finale.'));
    const w = world(script);
    const session = w.sessions.open('owner');
    const first = await runTurn(w.deps, { principal: owner, tenant: 'host', surface: 'cli', session, text: 'storia lunghissima' });
    expect(first.stopped).toBe('continuable');

    const second = await continueTurn(w.deps, first.turnId, {
      message: { role: 'user', content: [{ type: 'text', text: 'riprendi' }] },
      session: w.sessions.open('owner'),
    });
    if ('why' in second) throw new Error(`continuation refused: ${second.why}`);
    expect(second.turnId).toBe(first.turnId);
    expect(second.stopped).toBe('answered');
    expect(second.text.startsWith('pezzo0…')).toBe(true);
    expect(second.text.endsWith('finale.')).toBe(true);
    expect(second.text).not.toContain('pezzo0…pezzo0…');
    // One Turn, one logical Session answer across both leases.
    expect(w.sessions.read(session).filter((m) => m.role === 'assistant')).toHaveLength(1);
  });

  it('H: verbatim repeated chunk is no-progress — stop after 2 calls, no duplicate, no budget burn', async () => {
    const w = world([truncatedPartial('STESSO-PEZZO'), truncatedPartial('STESSO-PEZZO'), finalAnswer('MAI')]);
    const session = w.sessions.open('owner');
    const r = await runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'dimmi qualcosa',
    });
    expect(r.stopped).toBe('continuable');
    expect(r.reason).toBe('truncated');
    expect(w.provider.seen).toHaveLength(2);
    const row = w.turns.get(r.turnId);
    // Second chunk dropped, not appended: single partial, single budget unit.
    expect(row?.counters.truncationsUsed).toBe(1);
    expect(row?.counters.transportRetriesLeft).toBe(MAX_TRANSPORT_RETRIES);
    expect((row?.messages ?? []).filter((m) => m.origin === 'partial')).toHaveLength(1);
    expect(w.sessions.read(session).filter((m) => m.role === 'assistant')).toHaveLength(0);
  });

  it('E: normal non-truncated answer follows current path byte-for-byte', async () => {
    const w = world([finalAnswer('risposta completa')]);
    const session = w.sessions.open('owner');
    const r = await runTurn(w.deps, { principal: owner, tenant: 'host', surface: 'cli', session, text: 'ciao' });
    expect(r.stopped).toBe('answered');
    expect(r.text).toBe('risposta completa');
    expect(w.provider.seen).toHaveLength(1);
    expect(w.provider.seen[0]!.maxOutputTokens).toBe(4096);
    const row = w.turns.get(r.turnId);
    expect(row?.counters.transportRetriesLeft).toBe(MAX_TRANSPORT_RETRIES);
    expect(row?.counters.truncationsUsed).toBe(0);
    expect(w.sessions.read(session).filter((m) => m.role === 'assistant')).toHaveLength(1);
  });

  it('F: zero-output max_tokens stays continuable truncated', async () => {
    const zeroUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const emptyTruncated: ChatResult = {
      text: null,
      toolCalls: [],
      stopReason: 'max_tokens',
      finishReason: 'length',
      usage: zeroUsage,
      model: 'test-model',
    };
    const w = world([emptyTruncated, emptyTruncated, emptyTruncated, emptyTruncated, emptyTruncated]);
    const session = w.sessions.open('owner');
    const r = await runTurn(w.deps, { principal: owner, tenant: 'host', surface: 'cli', session, text: 'ciao' });
    expect(r.stopped).toBe('continuable');
    expect(r.reason).toBe('truncated');
    expect(r.text).toContain('limite di output');
    expect(r.text).toContain('senza produrre contenuto');
    expect(w.turns.get(r.turnId)?.counters.truncationsUsed).toBe(0);
  });

  it('G: Session and Memory end with ONE complete assistant answer', async () => {
    const w = world([truncatedPartial('prima parte…'), finalAnswer('seconda parte')], { withMemory: true });
    const session = w.sessions.open('owner');
    const r = await runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'raccontami una storia lunga',
    });
    expect(r.stopped).toBe('answered');
    expect(r.text).toBe('prima parte…seconda parte');
    const transcript = w.sessions.read(session);
    const assistantRows = transcript.filter((m) => m.role === 'assistant');
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]!.content).toBe('prima parte…seconda parte');
    const all = w.memStore.pendingEpisodes('host', 1, 10);
    const agentEpisodes = all.filter((e) => e.role === 'agent');
    expect(agentEpisodes).toHaveLength(1);
    expect(agentEpisodes[0]!.content).toBe('prima parte…seconda parte');
  });
});

/**
 * Streaming no-progress divergence blocker: the live `onDelta` path and the
 * durable partial path compute the SAME exact-prefix rule — one
 * incrementally (`continuationDedup`), one at result time
 * (`stripRepeatedPrefix`) — so visible and durable can never disagree.
 */
function streamingWorld() {
  const home = mkdtempSync(join(tmpdir(), 'muffin-615-sb-'));
  const db = new DatabaseCtor(':memory:');
  const turns = new TurnStore(db);
  const sessions = new SessionStore(home);
  const capabilities = new Map();
  const deps: LoopDeps = {
    provider: undefined as never,
    profile: CONSERVATIVE,
    model: 'test-model',
    tools: [],
    capabilities,
    decide: createDecide({ matrix: POLICY_FLOOR, capabilities, budgetExhausted: () => false, hardened: true }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions,
    turns,
    todos: new TodoStore(db),
    budgetExhausted: () => false,
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite.' },
    now: NOW,
  };
  return { deps, turns, sessions, home };
}

function visibleText(deltas: TurnDelta[]): string {
  return deltas.filter((d) => d.type === 'text').map((d) => (d as { text: string }).text).join('');
}

function durablePartials(deps: LoopDeps, turnId: string): string {
  const store = deps.turns;
  const row = store.get(turnId);
  return (row?.messages ?? [])
    .filter((m) => m.origin === 'partial')
    .flatMap((m) => m.content)
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

describe('#615 streaming continuation: visible == durable, never duplicated', () => {
  it('A: A then B streams exactly once on both sides', async () => {
    const deltas: TurnDelta[] = [];
    let n = 0;
    const provider: Provider = {
      kind: 'openai-compat',
      async chat(): Promise<ChatResult> {
        throw new Error('unreachable');
      },
      async *chatStream() {
        n += 1;
        if (n === 1) {
          yield { type: 'text_delta', text: 'PRIMA-' };
          yield { type: 'done', result: truncatedPartial('PRIMA-') };
        } else {
          yield { type: 'text_delta', text: 'SECONDA' };
          yield { type: 'done', result: finalAnswer('SECONDA') };
        }
      },
    };
    const w = streamingWorld();
    (w.deps as { provider: Provider }).provider = provider;
    const session = w.sessions.open('owner');
    const r = await runTurn(w.deps, {
      principal: owner, tenant: 'host', surface: 'cli', session, text: 'vai', onDelta: (d) => deltas.push(d),
    });
    expect(r.stopped).toBe('answered');
    expect(r.text).toBe('PRIMA-SECONDA');
    expect(visibleText(deltas)).toBe('PRIMA-SECONDA');
    expect(durablePartials(w.deps, r.turnId)).toBe('PRIMA-');
    expect(deltas.filter((d) => d.type === 'boundary')).toHaveLength(0);
    expect(w.sessions.read(session).filter((m) => m.role === 'assistant')).toHaveLength(1);
  });

  it('B: exact repeat A->A truncates: visible A once, durable A once, honestly continuable', async () => {
    const A = 'STESSO-PEZZO-';
    const deltas: TurnDelta[] = [];
    let n = 0;
    const provider: Provider = {
      kind: 'openai-compat',
      async chat(): Promise<ChatResult> {
        throw new Error('unreachable');
      },
      async *chatStream() {
        n += 1;
        yield { type: 'text_delta', text: A };
        yield { type: 'done', result: truncatedPartial(A) };
      },
    };
    const w = streamingWorld();
    (w.deps as { provider: Provider }).provider = provider;
    const session = w.sessions.open('owner');
    const r = await runTurn(w.deps, {
      principal: owner, tenant: 'host', surface: 'cli', session, text: 'dimmi', onDelta: (d) => deltas.push(d),
    });
    expect(r.stopped).toBe('continuable');
    expect(r.reason).toBe('truncated');
    expect(visibleText(deltas)).toBe(A);
    expect(durablePartials(w.deps, r.turnId)).toBe(A);
    expect(deltas.filter((d) => d.type === 'boundary' && (d as { reason: string }).reason === 'superseded')).toHaveLength(0);
    expect(w.sessions.read(session).filter((m) => m.role === 'assistant')).toHaveLength(0);
    const row = w.turns.get(r.turnId);
    expect(row?.counters.truncationsUsed).toBe(1);
    expect(row?.counters.transportRetriesLeft).toBe(MAX_TRANSPORT_RETRIES);
  });

  it('C: repeat-then-progress A->A+B->C never becomes A+A+B anywhere', async () => {
    const deltas: TurnDelta[] = [];
    let n = 0;
    const provider: Provider = {
      kind: 'openai-compat',
      async chat(): Promise<ChatResult> {
        throw new Error('unreachable');
      },
      async *chatStream() {
        n += 1;
        if (n === 1) {
          yield { type: 'text_delta', text: 'PARTE-A-' };
          yield { type: 'done', result: truncatedPartial('PARTE-A-') };
        } else if (n === 2) {
          yield { type: 'text_delta', text: 'PARTE-A-' };
          yield { type: 'text_delta', text: 'PARTE-B-' };
          yield { type: 'done', result: truncatedPartial('PARTE-A-PARTE-B-') };
        } else {
          yield { type: 'text_delta', text: 'PARTE-C' };
          yield { type: 'done', result: finalAnswer('PARTE-C') };
        }
      },
    };
    const w = streamingWorld();
    (w.deps as { provider: Provider }).provider = provider;
    const session = w.sessions.open('owner');
    const r = await runTurn(w.deps, {
      principal: owner, tenant: 'host', surface: 'cli', session, text: 'vai', onDelta: (d) => deltas.push(d),
    });
    expect(r.stopped).toBe('answered');
    expect(r.text).toBe('PARTE-A-PARTE-B-PARTE-C');
    expect(visibleText(deltas)).toBe('PARTE-A-PARTE-B-PARTE-C');
    expect(visibleText(deltas)).not.toContain('PARTE-A-PARTE-A-');
    expect(durablePartials(w.deps, r.turnId)).toBe('PARTE-A-PARTE-B-');
    expect(w.sessions.read(session).filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual([
      'PARTE-A-PARTE-B-PARTE-C',
    ]);
  });

  it('D1: repetition after crash/resume never duplicates on the new sink', async () => {
    const deltas: TurnDelta[] = [];
    let n = 0;
    const streamProvider: Provider = {
      kind: 'openai-compat',
      async chat(): Promise<ChatResult> {
        throw new Error('unreachable');
      },
      async *chatStream() {
        n += 1;
        if (n === 1) {
          yield { type: 'text_delta', text: 'PRIMA-' };
          yield { type: 'text_delta', text: 'SECONDA-' };
          yield { type: 'done', result: truncatedPartial('PRIMA-SECONDA-') };
        } else {
          yield { type: 'text_delta', text: 'TERZA' };
          yield { type: 'done', result: finalAnswer('TERZA') };
        }
      },
    };
    const home = mkdtempSync(join(tmpdir(), 'muffin-615-d1-'));
    const db = new DatabaseCtor(':memory:');
    const turns = new TurnStore(db);
    const sessions = new SessionStore(home);
    const capabilities = new Map();
    const deps: LoopDeps = {
      provider: streamProvider,
      profile: CONSERVATIVE,
      model: 'test-model',
      tools: [],
      capabilities,
      decide: createDecide({ matrix: POLICY_FLOOR, capabilities, budgetExhausted: () => false, hardened: true }),
      tracer: new SimpleTracer(new JsonlExporter(home)),
      sessions,
      turns,
      todos: new TodoStore(db),
      budgetExhausted: () => false,
      systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite.' },
      now: NOW,
    };
    const created = turns.create(
      {
        id: 'crashstream615',
        principal: owner,
        tenant: 'host',
        surface: 'cli',
        sessionId: 'owner',
        model: 'test-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'racconta' }] }],
        taint: 0,
        counters: {
          iterations: 1,
          recoveriesUsed: 0,
          transportRetriesLeft: MAX_TRANSPORT_RETRIES,
          truncationsUsed: 1,
          toolCallsMade: 0,
          nudgedForCompletion: false,
          usage: { inputTokens: 10, outputTokens: 4096, cacheReadTokens: 0, cacheWriteTokens: 0 },
          spentUsd: 0,
          resumes: 0,
          contextBuilt: true,
          activeModelMs: 0,
        },
      },
      4242,
    );
    const prefixMessages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'racconta' }] },
      partialMessage([{ type: 'text', text: 'PRIMA-' }]),
      harnessMessage('user', [{ type: 'text', text: 'La risposta precedente si è interrotta per limite di output.' }]),
    ];
    expect(
      turns.checkpoint('crashstream615', { messages: prefixMessages, taint: 0, counters: created.counters }, created.claimToken),
    ).toBe(true);
    db.prepare(`UPDATE turns SET status = 'interrupted', claimed_by = NULL, claim_token = NULL WHERE id = 'crashstream615'`).run();

    const resumed = await resumeTurn(deps, 'crashstream615', { onDelta: (d) => deltas.push(d) });
    if ('why' in resumed) throw new Error(`resume refused: ${resumed.why}`);
    expect(resumed.stopped).toBe('answered');
    expect(resumed.text).toBe('PRIMA-SECONDA-TERZA');
    // New sink shows only genuinely new bytes: the accepted prefix is not repeated.
    expect(visibleText(deltas)).toBe('SECONDA-TERZA');
    expect(visibleText(deltas)).not.toContain('PRIMA-PRIMA-');
    expect(durablePartials(deps, 'crashstream615')).toBe('PRIMA-SECONDA-');
  });

  it('D2: repetition on an owner-granted new lease obeys the same invariant', async () => {
    const deltas: TurnDelta[] = [];
    const w = world([truncatedPartial('RIP-'), truncatedPartial('RIP-')]);
    const session = w.sessions.open('owner');
    const first = await runTurn(w.deps, { principal: owner, tenant: 'host', surface: 'cli', session, text: 'dimmi' });
    expect(first.stopped).toBe('continuable');

    let n = 0;
    const streamProvider: Provider = {
      kind: 'openai-compat',
      async chat(): Promise<ChatResult> {
        throw new Error('unreachable');
      },
      async *chatStream() {
        n += 1;
        yield { type: 'text_delta', text: 'RIP-' };
        yield { type: 'text_delta', text: 'FINE' };
        yield { type: 'done', result: finalAnswer('RIP-FINE') };
      },
    };
    (w.deps as { provider: Provider }).provider = streamProvider;
    const second = await continueTurn(w.deps, first.turnId, {
      message: { role: 'user', content: [{ type: 'text', text: 'riprendi' }] },
      session: w.sessions.open('owner'),
      onDelta: (d) => deltas.push(d),
    });
    if ('why' in second) throw new Error(`continuation refused: ${second.why}`);
    expect(second.turnId).toBe(first.turnId);
    expect(second.stopped).toBe('answered');
    expect(second.text).toBe('RIP-FINE');
    expect(visibleText(deltas)).toBe('FINE');
    expect(durablePartials(w.deps, first.turnId)).toBe('RIP-');
    expect(w.sessions.read(session).filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual(['RIP-FINE']);
  });

  it('E: ordinary first-call streaming is byte-for-byte unchanged', async () => {
    const deltas: TurnDelta[] = [];
    const provider: Provider = {
      kind: 'openai-compat',
      async chat(): Promise<ChatResult> {
        throw new Error('unreachable');
      },
      async *chatStream() {
        yield { type: 'text_delta', text: 'RISPOSTA-' };
        yield { type: 'text_delta', text: 'SECCA' };
        yield { type: 'done', result: finalAnswer('RISPOSTA-SECCA') };
      },
    };
    const w = streamingWorld();
    (w.deps as { provider: Provider }).provider = provider;
    const session = w.sessions.open('owner');
    const r = await runTurn(w.deps, {
      principal: owner, tenant: 'host', surface: 'cli', session, text: 'ciao', onDelta: (d) => deltas.push(d),
    });
    expect(r.stopped).toBe('answered');
    expect(r.text).toBe('RISPOSTA-SECCA');
    expect(visibleText(deltas)).toBe('RISPOSTA-SECCA');
    expect(deltas.filter((d) => d.type === 'boundary')).toHaveLength(0);
    expect(w.turns.get(r.turnId)?.counters.truncationsUsed).toBe(0);
  });
});
