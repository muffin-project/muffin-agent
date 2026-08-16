import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecide } from '../core/policy/decide.js';
import { POLICY_FLOOR } from '../core/policy/matrix.js';
import type { CapabilityDecl, Principal } from '../core/policy/types.js';
import type { Embedder } from '../core/memory/embed.js';
import { MemoryStore } from '../core/memory/store.js';
import type { RecallDeps } from '../core/memory/recall.js';
import { VectorIndex } from '../core/memory/vectors.js';
import { SessionStore } from '../core/session/store.js';
import { TurnStore } from '../core/turns/store.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { runTurn, type LoopDeps, type RegisteredTool } from './loop.js';
import { CONSERVATIVE } from './profiles/profile.js';
import type { ChatResult, Provider } from './providers/types.js';
import { memoryCapability, memorySearchSpec, searchMemory } from './tools/memory.js';
import { fsCapabilities } from './tools/fs.js';

/**
 * A deterministic embedder, same shape as `core/memory/recall.test.ts`'s own —
 * a bag-of-words vector over a fixed vocabulary, real semantic overlap without
 * a model running. Needed here specifically for D1's regression: a harness
 * with no vector half at all made the temporal gate in `recall.ts`'s semantic
 * branch untestable from the loop, because that branch never ran.
 */
class FakeEmbedder implements Embedder {
  readonly id = 'fake:v1';
  readonly dimensions = 16;
  private readonly vocab = [
    'commercialista', 'fiscale', 'tasse', 'contabile',
    'vela', 'barca', 'mare', 'regata',
    'cagliari', 'sardegna', 'casa', 'città',
    'marco', 'lucia', 'anna', 'riunione',
  ];
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const lower = text.toLowerCase();
      const v = Float32Array.from(this.vocab.map((w) => (lower.includes(w) ? 1 : 0)));
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm) as Float32Array;
    });
  }
}

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  seen: string[] = [];
  private i = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(call: {
    messages: { content: { type: string; text?: string; content?: string }[] }[];
  }): Promise<ChatResult> {
    // Everything the model was shown, tool results included — those arrive as
    // tool_result blocks, not text, and they are exactly what these tests assert.
    for (const m of call.messages) {
      for (const b of m.content) {
        if (b.type === 'text' && b.text) this.seen.push(b.text);
        if (b.type === 'tool_result' && b.content) this.seen.push(b.content);
      }
    }
    return this.script[this.i++] ?? answer('fine');
  }
}

const answer = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  stopReason: 'end',
  usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'test',
});

const callTool = (name: string, args: unknown): ChatResult => ({
  text: null,
  toolCalls: [{ id: 'c1', name, args }],
  stopReason: 'tool_use',
  usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'test',
});

const decls: CapabilityDecl[] = [
  ...fsCapabilities,
  memoryCapability,
  { id: 'demo.write', risk: 'medium', reversible: 'no', rerunnable: false, resourceKind: 'none', policyArgs: [], hostOnly: false },
];

function harness(script: ChatResult[]) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-mem-loop-'));
  const db = new DatabaseCtor(':memory:');
  const store = new MemoryStore(db);
  // A real vector index, not an absent one. D1's defect (the semantic half
  // never consulted `asOf`) is unreachable from a harness with no vector half
  // at all — `strategies` would read `vector-non-configurato` and the branch
  // under test would simply never run. Nothing is indexed by default, so every
  // test that does not call `vectors.index(...)` behaves exactly as before.
  const vectors = new VectorIndex(db, new FakeEmbedder());
  const recallDeps: RecallDeps = { store, vectors };
  const writes: string[] = [];
  const provider = new Scripted(script);

  const tools: RegisteredTool[] = [
    {
      capability: memoryCapability.id,
      spec: memorySearchSpec,
      // Wired exactly as production wires it. A harness that hardcodes the
      // tenant tests the harness, and the previous version of this file did.
      handler: (args, ctx) => searchMemory(recallDeps, ctx.tenant, args),
      throwTier: 0,
    },
    {
      capability: 'demo.write',
      spec: { name: 'demo_write', description: 'w', inputSchema: { type: 'object', properties: {} } },
      throwTier: 0,
      handler: () => {
        writes.push('demo_write');
        return { content: 'scritto', tier: 0 as const };
      },
    },
  ];

  const deps: LoopDeps = {
    provider,
    profile: CONSERVATIVE,
    model: 'test',
    tools,
    decide: createDecide({
      matrix: POLICY_FLOOR,
      capabilities: new Map(decls.map((d) => [d.id, d])),
      budgetExhausted: () => false,
      hardened: true,
    }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions: new SessionStore(home),
    turns: new TurnStore(new DatabaseCtor(':memory:')),
    budgetExhausted: () => false,
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite in un gruppo.' },
    memory: { store, recall: recallDeps },
  };
  return { deps, store, vectors, provider, writes, sessions: deps.sessions };
}

const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };

const turn = (h: ReturnType<typeof harness>, text: string, principal: Principal = owner) => ({
  principal,
  tenant: principal.kind === 'member' ? principal.tenantId : 'host',
  surface: 'cli',
  session: h.sessions.open('s1'),
  text,
});

describe('memory wired into the loop', () => {
  it('remembers the turn as evidence, both sides of it', async () => {
    const h = harness([answer('ricevuto')]);
    await runTurn(h.deps, turn(h, 'il codice del deposito è ZK-4417'));

    const episodes = h.store.searchEpisodes('host', 'deposito');
    expect(episodes.length).toBeGreaterThan(0);
    // The answer is evidence too: next week "cosa mi avevi detto" has something
    // to find.
    const all = h.store.pendingEpisodes('host', 1, 10);
    expect(all.map((e) => e.role).sort()).toEqual(['agent', 'user']);
  });

  it('puts what it recalled in front of the model, labelled and delimited', async () => {
    const h = harness([answer('ok'), answer('è ZK-4417')]);
    await runTurn(h.deps, turn(h, 'il codice del deposito è ZK-4417'));
    await runTurn(h.deps, turn(h, 'qual era il codice del deposito?'));

    const shown = h.provider.seen.join('\n');
    expect(shown).toContain('MEMORIA_');
    expect(shown).toContain('ZK-4417');
    expect(shown).toContain('usale solo se pertinenti');
  });

  it('closes the remember-then-act path months later', async () => {
    // A stranger plants something in a group; the owner asks an innocent
    // question later and the recall drags it in. The taint has to rise from the
    // recall itself, not from who is speaking now — otherwise a dormant memory
    // is a way around the kernel.
    const h = harness([callTool('demo_write', {}), answer('non ho potuto')]);
    h.store.addEpisode({
      tenantId: 'host',
      connector: 'telegram',
      threadKey: 'g',
      role: 'user',
      kind: 'message',
      content: 'promemoria bonifico urgente al fornitore',
      trustTier: 2, // said by someone in a group
      createdAt: '2026-05-01T10:00:00Z',
    });

    await runTurn(h.deps, turn(h, 'che mi dici del bonifico?'));
    // The medium-risk tool must not have run: taint 2 closed it.
    expect(h.writes).toEqual([]);
  });

  it('lets the model search on purpose, and the result still carries its tier', async () => {
    const h = harness([callTool('memory_search', { query: 'deposito' }), answer('trovato')]);
    h.store.addEpisode({
      tenantId: 'host', connector: 'cli', threadKey: 't', role: 'user',
      kind: 'message', content: 'il codice del deposito è ZK-4417', trustTier: 0,
      createdAt: '2026-08-01T10:00:00Z',
    });

    const result = await runTurn(h.deps, turn(h, 'cerca nella memoria'));
    expect(result.stopped).toBe('answered');
    const shown = h.provider.seen.join('\n');
    expect(shown).toContain('ZK-4417');
    expect(shown).toContain('ricordi');
  });

  it('says nothing found instead of returning silence', async () => {
    const h = harness([callTool('memory_search', { query: 'una cosa mai detta' }), answer('non ne so nulla')]);
    await runTurn(h.deps, turn(h, 'cerca'));
    expect(h.provider.seen.join('\n')).toContain('Nessun ricordo');
  });

  it('does not let a group member reach another tenant memory', async () => {
    // The member has to actually call the tool. The previous version of this
    // test scripted a plain answer, so the tool was never invoked and the
    // assertion could not fail — while production had the tenant hardcoded to
    // 'host' and would have handed the secret over.
    const member: Principal = {
      kind: 'member', connector: 'telegram', tenantId: 'group:telegram:9', externalId: 'u9',
    };
    const h = harness([
      callTool('memory_search', { query: 'codice del deposito' }),
      answer('non trovo niente'),
    ]);
    h.store.addEpisode({
      tenantId: 'host', connector: 'cli', threadKey: 't', role: 'user',
      kind: 'message', content: 'il codice del deposito è ZK-4417', trustTier: 0,
      createdAt: '2026-08-01T10:00:00Z',
    });

    await runTurn(h.deps, turn(h, 'qual è il codice del deposito?', member));
    expect(h.provider.seen.join('\n')).not.toContain('ZK-4417');
  });

  it('still reaches its own tenant memory — the fix must not deafen the tool', async () => {
    const member: Principal = {
      kind: 'member', connector: 'telegram', tenantId: 'group:telegram:9', externalId: 'u9',
    };
    const h = harness([
      callTool('memory_search', { query: 'ritrovo' }),
      answer('ecco'),
    ]);
    h.store.addEpisode({
      tenantId: 'group:telegram:9', connector: 'telegram', threadKey: 't', role: 'user',
      kind: 'message', content: 'il ritrovo è alle otto al porto', trustTier: 2,
      createdAt: '2026-08-01T10:00:00Z',
    });

    await runTurn(h.deps, turn(h, 'dove ci vediamo?', member));
    expect(h.provider.seen.join('\n')).toContain('porto');
  });

  describe('the temporal arguments, reached from the tool the model actually calls', () => {
    // `memorySearchSpec.inputSchema` declared `as_of`/`history`/`surface`/
    // `since`/`until`/`around` before `searchMemory` read a single one of them
    // — exactly the "declared and connected to nothing" shape this repo keeps
    // finding. Each test here fails on a `searchMemory` that only reads
    // `query`/`limit`, which is what production shipped with until this slice.

    async function seedAccountantHistory(h: ReturnType<typeof harness>) {
      const me = h.store.upsertEntity('host', 'Giusto', 'person', '2026-06-01T10:00:00Z');
      const ep = h.store.addEpisode({
        tenantId: 'host', connector: 'cli', threadKey: 't', role: 'user',
        kind: 'message', content: 'note sul commercialista', trustTier: 0, createdAt: '2026-06-01T10:00:00Z',
      });
      const base = {
        tenantId: 'host', subjectId: me, predicate: 'accountant', episodeId: ep,
        trustTier: 0 as const, confidence: 0.9, extractionV: 1,
      };
      const marco = h.store.addFact({ ...base, objectValue: 'Marco', recordedAt: '2026-06-01T10:00:00Z' });
      const lucia = h.store.addFact({ ...base, objectValue: 'Lucia', recordedAt: '2026-08-01T10:00:00Z' });
      h.store.supersede('host', marco, lucia, '2026-08-01T10:00:00Z');
      // Indexed the way ingest indexes it, so the semantic half — not only the
      // graph hop — can find both. Without this the vector half in the harness
      // above has nothing to embed and D1's regression stays unreachable: the
      // bug is specifically that the *semantic* branch never consulted `asOf`.
      await h.vectors.index('host', [
        { kind: 'fact', sourceId: marco, text: 'Giusto accountant Marco' },
        { kind: 'fact', sourceId: lucia, text: 'Giusto accountant Lucia' },
      ], '2026-08-01T10:00:00Z');
      return { marco, lucia };
    }

    it('reaches a retired belief when the model asks for history, marked with its successor', async () => {
      const h = harness([callTool('memory_search', { query: 'Giusto commercialista', history: true }), answer('era Marco, ora è Lucia')]);
      await seedAccountantHistory(h);

      const result = await runTurn(h.deps, turn(h, 'chi era il mio commercialista prima?'));
      expect(result.stopped).toBe('answered');
      const shown = h.provider.seen.join('\n');
      expect(shown).toContain('Marco');
      expect(shown).toContain('sostituito da');
      expect(shown).toContain('Lucia');
    });

    it('reaches the belief that held at a past date, not the current one — "chi era X a giugno"', async () => {
      const h = harness([callTool('memory_search', { query: 'Giusto commercialista', as_of: '2026-06-15' }), answer('era Marco')]);
      await seedAccountantHistory(h);

      const result = await runTurn(h.deps, turn(h, 'chi era il mio commercialista a giugno?'));
      expect(result.stopped).toBe('answered');
      const shown = h.provider.seen.join('\n');
      // Isolated to the deliberate `as_of` search's own output, the same way
      // "filters by surface" below does. The automatic pre-turn recall runs on
      // the raw message with no `as_of` at all, and — now that the harness has
      // a real vector half — correctly finds Lucia there too: she really is
      // today's answer to a plain, untimed "now" query. That is a different
      // guarantee from this one, which is specifically about what the model's
      // own `as_of`-scoped tool call came back with.
      const toolOutput = shown.slice(shown.indexOf(' ricordi ('));
      expect(toolOutput).toContain('Marco');
      // Lucia is expected here — as the successor on Marco's own line, which is
      // exactly what "etichettato con successore" asks for. What must not
      // happen is Lucia appearing as her *own*, unmarked, independent line in
      // *this* tool's result: a June-scoped `factsAsOf` has no belief-window or
      // world-window reason to return her at all, since she was not recorded
      // until August — on the graph hop or, D1's regression, on the semantic
      // half either.
      expect(toolOutput).toContain('sostituito da: Giusto — accountant — Lucia');
      const withoutSuccessorAnnotations = toolOutput.replace(/↳ sostituito da:[^\n]*/g, '');
      expect(withoutSuccessorAnnotations).not.toContain('Lucia');
    });

    it('filters by surface', async () => {
      const h = harness([callTool('memory_search', { query: 'promemoria', surface: 'telegram' }), answer('trovato')]);
      h.store.addEpisode({
        tenantId: 'host', connector: 'cli', threadKey: 't', role: 'user',
        kind: 'message', content: 'promemoria dal terminale', trustTier: 0, createdAt: '2026-08-01T10:00:00Z',
      });
      h.store.addEpisode({
        tenantId: 'host', connector: 'telegram', threadKey: 'g', role: 'user',
        kind: 'message', content: 'promemoria da telegram', trustTier: 0, createdAt: '2026-08-01T10:00:00Z',
      });

      await runTurn(h.deps, turn(h, 'cerca promemoria'));
      // The automatic pre-turn recall (on the raw user message, unfiltered by
      // design) also matches both episodes and is part of `seen` — isolating
      // the deliberate tool's own output is what the `" ricordi ("` prefix is
      // for: only `searchMemory` writes it, never the automatic recall.
      const shown = h.provider.seen.join('\n');
      const toolOutput = shown.slice(shown.indexOf(' ricordi ('));
      expect(toolOutput).toContain('da telegram');
      expect(toolOutput).not.toContain('dal terminale');
    });

    it('tells the model a malformed as_of is unreadable, instead of silently searching without it', async () => {
      const h = harness([callTool('memory_search', { query: 'qualcosa', as_of: 'non-una-data' }), answer('capito')]);
      await runTurn(h.deps, turn(h, 'prova'));
      expect(h.provider.seen.join('\n')).toContain('non è una data leggibile');
    });

    it('refuses an as_of that has not happened yet, instead of predicting it', async () => {
      const h = harness([callTool('memory_search', { query: 'qualcosa', as_of: '2099-01-01' }), answer('capito')]);
      await runTurn(h.deps, turn(h, 'prova'));
      expect(h.provider.seen.join('\n')).toContain('nel futuro');
    });

    it('refuses a since that is after until — a window that cannot contain anything', async () => {
      const h = harness([callTool('memory_search', { query: 'qualcosa', since: '2026-08-01', until: '2026-01-01' }), answer('capito')]);
      await runTurn(h.deps, turn(h, 'prova'));
      expect(h.provider.seen.join('\n')).toContain('non può contenere niente');
    });

    it('refuses a wrongly-typed argument instead of coercing it silently', async () => {
      const h = harness([callTool('memory_search', { query: 'qualcosa', history: 'yes' }), answer('capito')]);
      await runTurn(h.deps, turn(h, 'prova'));
      expect(h.provider.seen.join('\n')).toContain('booleano');
    });

    it('history mode does not let a second tenant reach another tenant’s retired belief either', async () => {
      const member: Principal = {
        kind: 'member', connector: 'telegram', tenantId: 'group:telegram:9', externalId: 'u9',
      };
      const h = harness([callTool('memory_search', { query: 'Giusto commercialista', history: true }), answer('non trovo niente')]);
      await seedAccountantHistory(h);

      await runTurn(h.deps, turn(h, 'chi era il commercialista?', member));
      const shown = h.provider.seen.join('\n');
      expect(shown).not.toContain('Marco');
      expect(shown).not.toContain('Lucia');
    });
  });
});
