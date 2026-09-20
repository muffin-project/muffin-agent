import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createDecide } from '../../core/policy/decide.js';
import { POLICY_FLOOR } from '../../core/policy/matrix.js';
import type { Principal } from '../../core/policy/types.js';
import { SessionStore } from '../../core/session/store.js';
import { JsonlExporter, SimpleTracer } from '../../core/tracing/tracer.js';
import { TurnStore } from '../../core/turns/store.js';
import { TodoStore } from '../../core/turns/todo.js';
import { continueTurn, resumeTurn, runTurn, type LoopDeps } from '../loop.js';
import { CONSERVATIVE } from '../profiles/profile.js';
import type { ChatCall, ChatResult, Provider } from '../providers/types.js';
import { MemoryStore } from '../../core/memory/store.js';
import { VectorIndex } from '../../core/memory/vectors.js';
import type { Embedder } from '../../core/memory/embed.js';
import type { TurnDelta } from './types.js';
import { MAX_TRANSPORT_RETRIES } from './types.js';

class FakeEmbedder implements Embedder {
  readonly id = 'fake:v1';
  readonly dimensions = 4;
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => Float32Array.from([1, 0, 0, 0]));
  }
}

/**
 * #615 — max_tokens with partial text must continue, not settle as answered.
 *
 * RED-first probe for the owner-visible correctness bug:
 * provider returns `stopReason=max_tokens` with non-empty text and zero tool
 * calls. Current `classifyProviderFailure` early-returns (text non-empty) and
 * the loop settles `answered` with the fragment, persisting it to Session as
 * if complete.
 *
 * Desired: same logical Turn/answer continues from the prefix, appends only
 * new continuation text, Session holds ONE complete assistant answer.
 */

const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };
const NOW = () => new Date('2026-09-20T12:00:00.000Z');
const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

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

function world(script: ChatResult[]) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-615-'));
  const db = new DatabaseCtor(':memory:');
  const turns = new TurnStore(db);
  const sessions = new SessionStore(home);
  const capabilities = new Map();
  const provider = new Scripted(script);
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
  return { deps, turns, sessions, provider, home };
}

describe('#615 non-streaming partial + max_tokens continues same logical answer', () => {
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

    // Same logical answer continues: two provider calls, one Turn.
    expect(w.provider.seen).toHaveLength(2);
    // Final result is the concatenation, not the fragment.
    expect(r.stopped).toBe('answered');
    expect(r.text).toBe('prima parte…seconda parte');

    // Second call continues from the exact prefix (assistant partial visible).
    const secondWire = JSON.stringify(w.provider.seen[1]!.messages);
    expect(secondWire).toContain('prima parte…');

    // Session holds ONE complete assistant answer, not a partial settlement.
    const transcript = w.sessions.read(session);
    const assistantRows = transcript.filter((m) => m.role === 'assistant');
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]!.content).toBe('prima parte…seconda parte');

    // Turn row is done/answered once, with the complete answer as result text.
    const row = w.turns.get(r.turnId);
    expect(row?.status).toBe('done');
    expect(row?.outcome).toBe('answered');
  });

  it('streaming prefix stays valid, continuation appends once, no superseded', async () => {
    const deltas: TurnDelta[] = [];
    // Streaming provider: first call streams prefix then ends max_tokens.
    const streamingProvider: Provider = {
      kind: 'openai-compat',
      async chat(call: ChatCall): Promise<ChatResult> {
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
    // Visible prefix retained, continuation appended once, never superseded.
    const texts = deltas.filter((d) => d.type === 'text').map((d) => (d as { text: string }).text).join('');
    expect(texts).toBe('prima parte…seconda parte');
    expect(deltas.filter((d) => d.type === 'boundary' && (d as { reason: string }).reason === 'superseded')).toHaveLength(0);
    const transcript = sessions.read(session);
    const assistantRows = transcript.filter((m) => m.role === 'assistant');
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]!.content).toBe('prima parte…seconda parte');
  });
});

describe('#615 repeated truncation is bounded, restart is lossless, normal paths unchanged', () => {
  it('C: keeps returning max_tokens -> continuable truncated, never answered, no infinite loop', async () => {
    const script = Array.from({ length: 15 }, (_, i) => truncatedPartial(`pezzo${i}…`));
    const w = world(script);
    const session = w.sessions.open('owner');
    const r = await runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'raccontami una storia lunghissima',
    });
    // Bounded by the existing durable transport budget: initial + MAX retries.
    expect(r.stopped).toBe('continuable');
    expect(r.reason).toBe('truncated');
    expect(w.provider.seen).toHaveLength(MAX_TRANSPORT_RETRIES + 1);
    // Honestly incomplete: diagnostic names partial preservation + way back.
    expect(r.text).toContain('parziale');
    expect(r.text).toContain('riprendi');
    expect(r.text).not.toContain('answered');
    const row = w.turns.get(r.turnId);
    expect(row?.status).toBe('continuable');
    expect(row?.continuableReason?.class).toBe('truncated');
    // No partial settlement in Session: continuable releases never append.
    const transcript = w.sessions.read(session);
    expect(transcript.filter((m) => m.role === 'assistant')).toHaveLength(0);
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
    // Simulate crash after first truncation was accepted: prefix + harness
    // instruction checkpointed, transport budget already spent once.
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
    const prefixMessages = [
      { role: 'user', content: [{ type: 'text', text: 'raccontami una storia lunga' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'prima parte…' }] },
      {
        role: 'user',
        content: [{ type: 'text', text: 'La risposta precedente si è interrotta per limite di output.' }],
        origin: 'harness' as const,
      },
    ] as unknown as import('../providers/types.js').Message[];
    expect(
      turns.checkpoint(
        'resume615',
        {
          messages: prefixMessages,
          taint: 0,
          counters: { ...created.counters, iterations: 1, transportRetriesLeft: MAX_TRANSPORT_RETRIES - 1 },
        },
        created.claimToken,
      ),
    ).toBe(true);
    db.prepare(
      `UPDATE turns SET status = 'interrupted', claimed_by = NULL, claim_token = NULL WHERE id = 'resume615'`,
    ).run();

    const resumed = await resumeTurn(deps, 'resume615');
    if ('why' in resumed) throw new Error(`resume refused: ${resumed.why}`);
    expect(resumed.stopped).toBe('answered');
    expect(resumed.text).toBe('prima parte…seconda parte');
    // Provider saw the accepted prefix exactly once (no loss, no duplication).
    const wire = JSON.stringify(provider.seen[0]!.messages);
    expect(wire.match(/prima parte…/g)).toHaveLength(1);
    const transcript = sessions.read(sessions.open('owner'));
    const assistantRows = transcript.filter((m) => m.role === 'assistant');
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]!.content).toBe('prima parte…seconda parte');
  });

  it('D2: continuable prefix continues on owner grant without duplicating', async () => {
    const script = Array.from({ length: MAX_TRANSPORT_RETRIES + 1 }, (_, i) => truncatedPartial(`pezzo${i}…`));
    script.push(finalAnswer('finale.'));
    const w = world(script);
    const session = w.sessions.open('owner');
    const first = await runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'storia lunghissima',
    });
    expect(first.stopped).toBe('continuable');
    // Remaining script has the final continuation for the granted lease.
    const second = await continueTurn(w.deps, first.turnId, {
      message: { role: 'user', content: [{ type: 'text', text: 'riprendi' }] },
      session: w.sessions.open('owner'),
    });
    if ('why' in second) throw new Error(`continuation refused: ${second.why}`);
    expect(second.turnId).toBe(first.turnId);
    expect(second.stopped).toBe('answered');
    // Same Turn, one logical answer: prefix pieces + finale, no duplication.
    expect(second.text.startsWith('pezzo0…')).toBe(true);
    expect(second.text.endsWith('finale.')).toBe(true);
    expect(second.text).not.toContain('pezzo0…pezzo0…');
  });

  it('E: normal non-truncated answer follows current path byte-for-byte', async () => {
    const w = world([finalAnswer('risposta completa')]);
    const session = w.sessions.open('owner');
    const r = await runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'ciao',
    });
    expect(r.stopped).toBe('answered');
    expect(r.text).toBe('risposta completa');
    expect(w.provider.seen).toHaveLength(1);
    expect(w.provider.seen[0]!.maxOutputTokens).toBe(4096);
    const row = w.turns.get(r.turnId);
    expect(row?.counters.transportRetriesLeft).toBe(MAX_TRANSPORT_RETRIES);
    const transcript = w.sessions.read(session);
    expect(transcript.filter((m) => m.role === 'assistant')).toHaveLength(1);
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
    const r = await runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'ciao',
    });
    expect(r.stopped).toBe('continuable');
    expect(r.reason).toBe('truncated');
    expect(r.text).toContain('limite di output');
    expect(r.text).toContain('senza produrre contenuto');
  });

  it('G: Session and Memory end with ONE complete assistant answer', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-615-mem-'));
    const db = new DatabaseCtor(':memory:');
    const memDb = new DatabaseCtor(':memory:');
    const store = new MemoryStore(memDb);
    const vectors = new VectorIndex(memDb, new FakeEmbedder());
    const turns = new TurnStore(db);
    const sessions = new SessionStore(home);
    const capabilities = new Map();
    const provider = new Scripted([truncatedPartial('prima parte…'), finalAnswer('seconda parte')]);
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
      memory: { store, recall: { store, vectors } },
    };
    const session = sessions.open('owner');
    const r = await runTurn(deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'raccontami una storia lunga',
    });
    expect(r.stopped).toBe('answered');
    expect(r.text).toBe('prima parte…seconda parte');
    const transcript = sessions.read(session);
    const assistantRows = transcript.filter((m) => m.role === 'assistant');
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]!.content).toBe('prima parte…seconda parte');
    const all = store.pendingEpisodes('host', 1, 10);
    const agentEpisodes = all.filter((e) => e.role === 'agent');
    expect(agentEpisodes).toHaveLength(1);
    expect(agentEpisodes[0]!.content).toBe('prima parte…seconda parte');
  });
});
