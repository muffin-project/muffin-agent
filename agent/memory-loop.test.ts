import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecide } from '../core/policy/decide.js';
import { POLICY_FLOOR } from '../core/policy/matrix.js';
import type { CapabilityDecl, Principal } from '../core/policy/types.js';
import type { Embedder } from '../core/memory/embed.js';
import { MemoryStore } from '../core/memory/store.js';
import type { RecallDeps } from '../core/memory/recall.js';
import { LlmReranker, RERANK_MIN_CANDIDATES, type Reranker } from '../core/memory/rerank.js';
import { BudgetEngine } from '../core/budget/budget.js';
import { VectorIndex } from '../core/memory/vectors.js';
import { SessionStore } from '../core/session/store.js';
import { TurnStore } from '../core/turns/store.js';
import { TodoStore } from '../core/turns/todo.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { runTurn, type LoopDeps, type RegisteredTool } from './loop.js';
import { CONSERVATIVE } from './profiles/profile.js';
import { lightLane, type LightSpend } from './providers/light-lane.js';
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
  // era il default della classe: la riga 'context' non lo eredita più
  { id: 'demo.write', effect: 'context', maxTaint: 1, risk: 'medium', reversible: 'no', rerunnable: false, resourceKind: 'none', policyArgs: [], hostOnly: false },
];

function harness(script: ChatResult[], over: { reranker?: Reranker } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-mem-loop-'));
  const db = new DatabaseCtor(':memory:');
  const store = new MemoryStore(db);
  // A real vector index, not an absent one. D1's defect (the semantic half
  // never consulted `asOf`) is unreachable from a harness with no vector half
  // at all — `strategies` would read `vector-non-configurato` and the branch
  // under test would simply never run. Nothing is indexed by default, so every
  // test that does not call `vectors.index(...)` behaves exactly as before.
  const vectors = new VectorIndex(db, new FakeEmbedder());
  const recallDeps: RecallDeps = { store, vectors, ...(over.reranker === undefined ? {} : { reranker: over.reranker }) };
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
    capabilities: new Map(decls.map((d) => [d.id, d])),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions: new SessionStore(home),
    turns: new TurnStore(new DatabaseCtor(':memory:')),
    todos: new TodoStore(new DatabaseCtor(':memory:')),
    budgetExhausted: () => false,
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite in un gruppo.' },
    memory: { store, recall: recallDeps },
  };
  return { deps, store, vectors, provider, writes, home, sessions: deps.sessions };
}

const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };

const turn = (
  h: ReturnType<typeof harness>,
  text: string,
  principal: Principal = owner,
  session = 's1',
) => ({
  principal,
  tenant: principal.kind === 'member' ? principal.tenantId : 'host',
  surface: 'cli',
  session: h.sessions.open(session),
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
    // Un altro thread, e non lo stesso: da quando gli episodi portano il turno
    // che li ha scritti, un turno non ripesca cio che la propria history gia
    // riporta parola per parola. Nello stesso thread questa domanda avrebbe la
    // risposta davanti *senza* memoria, e il blocco MEMORIA_ resterebbe vuoto —
    // che e il comportamento voluto, non un buco. Il caso «stesso thread, ma
    // fuori dalla finestra» ha un test suo in `memory-lineage.test.ts`.
    await runTurn(h.deps, turn(h, 'qual era il codice del deposito?', owner, 's2'));

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

/**
 * La cucitura: il costo del reranker sale davvero sullo span del recall.
 *
 * `recall()` lo restituisce col risultato — non ha un tracer, e dargliene uno
 * sarebbe plumbing attraverso quattro file per un numero. Ma restituirlo e non
 * attaccarlo è lo stesso guasto di non calcolarlo: era l'ultima chiamata al
 * modello invisibile, e sarebbe rimasta invisibile.
 */
describe('lo span del recall porta il costo del reranker', () => {
  it("i token della chiamata finiscono sullo span che la contiene", async () => {
    const usato = { inputTokens: 812, outputTokens: 19, cacheReadTokens: 5 };
    const h = harness([answer('ok')], {
      reranker: {
        id: 'finto',
        rerank: async (_q, candidates, topK) => ({ items: candidates.slice(0, topK), reordered: true, usage: usato }),
      },
    });
    // Sopra `RERANK_MIN_CANDIDATES`, altrimenti `recall` non chiama affatto.
    for (let i = 0; i < RERANK_MIN_CANDIDATES + 4; i++) {
      h.store.addEpisode({
        tenantId: 'host', connector: 'cli', threadKey: 't', role: 'user',
        kind: 'message', content: `commercialista numero ${i}`, trustTier: 0,
        createdAt: '2026-08-04T11:00:00Z',
      });
    }
    await runTurn(h.deps, turn(h, 'commercialista'));

    const spans = readdirSync(join(h.home, 'traces'))
      .filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) => readFileSync(join(h.home, 'traces', f), 'utf8').trim().split('\n'))
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { attributes: Record<string, unknown> })
      .filter((x) => x.attributes['gen_ai.operation.name'] === 'memory.recall');

    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes).toMatchObject({
      'gen_ai.usage.input_tokens': 812,
      'gen_ai.usage.output_tokens': 19,
      'muffin.usage.cache_read_tokens': 5,
    });
  });
});

/**
 * E1, l'altra metà trovata dal judge: la spesa del reranker dentro il turno di
 * un job deve finire sul contatore di quel job.
 *
 * Il difetto, tracciato: `recall()` chiama `deps.reranker` durante il turno, il
 * reranker usa la corsia light, e la corsia light registrava la riga di spesa
 * **senza `job_id`** (`LightSpend` non lo portava). `BudgetEngine.jobMonthUsd`
 * filtra su `job_id`, quindi la riga era invisibile al tetto per-job: un job
 * poteva passare il proprio cap pur pagando il reranker dei suoi turni. Questo
 * test lo rende impossibile — la riga light, e solo quella, deve portare il job.
 */
describe('E1: la spesa del reranker è attribuita al job che l\'ha causata', () => {
  it('il turno di un job spende la chiamata del reranker sul job, non su nessuno', async () => {
    // La risposta del reranker è JSON e porta un model diverso da quello main,
    // così la riga light è distinguibile da quella del turno.
    const rerankReply: ChatResult = {
      text: '{"order":[0,1,2]}',
      toolCalls: [],
      stopReason: 'end',
      usage: { inputTokens: 40, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: 'light-served',
    };
    const h = harness([rerankReply, answer('fatto')]);
    // Sopra `RERANK_MIN_CANDIDATES`, o `recall` non chiama affatto il reranker.
    for (let i = 0; i < RERANK_MIN_CANDIDATES + 4; i++) {
      h.store.addEpisode({
        tenantId: 'host', connector: 'cli', threadKey: 't', role: 'user',
        kind: 'message', content: `commercialista numero ${i}`, trustTier: 0,
        createdAt: '2026-08-04T11:00:00Z',
      });
    }

    // La stessa forma di produzione: la corsia light avvolge il provider e
    // fattura ogni chiamata; il loop fattura la propria con `recordSpend`. La
    // riga light è quella che questo test interroga.
    const budget = new BudgetEngine(new DatabaseCtor(':memory:'), { monthlyUsd: 100, perTenantDailyUsd: 100 });
    const righeLight: Array<{ model: string; jobId: string | null }> = [];
    h.deps.memory!.recall.reranker = new LlmReranker(
      lightLane(h.provider, {
        profile: CONSERVATIVE,
        record: (entry: LightSpend) => {
          budget.record({ ...entry, tenant: 'host', capability: 'consolidation', usd: 0.01 });
          righeLight.push({ model: entry.model, jobId: entry.jobId ?? null });
        },
      }),
      'light-model',
    );
    h.deps.recordSpend = (entry) => {
      budget.record({ ...entry, usd: 0.02 });
      return 0.02;
    };

    await runTurn(h.deps, { ...turn(h, 'commercialista'), jobId: 'job-1' });

    // La riga della corsia light porta il job. Senza il threading di `jobId`
    // questa lista è `[{ model: 'light-served', jobId: null }]` e il tetto
    // per-job non vede la spesa.
    expect(righeLight).toEqual([{ model: 'light-served', jobId: 'job-1' }]);
    // E il contatore che il tetto legge la include: 0.01 del reranker + 0.02 del
    // turno.
    expect(budget.jobMonthUsd('job-1')).toBeCloseTo(0.03, 10);
  });

  it('un turno senza job non attribuisce la spesa del reranker a nessuno', async () => {
    const rerankReply: ChatResult = {
      text: '{"order":[0,1,2]}',
      toolCalls: [],
      stopReason: 'end',
      usage: { inputTokens: 40, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: 'light-served',
    };
    const h = harness([rerankReply, answer('fatto')]);
    for (let i = 0; i < RERANK_MIN_CANDIDATES + 4; i++) {
      h.store.addEpisode({
        tenantId: 'host', connector: 'cli', threadKey: 't', role: 'user',
        kind: 'message', content: `commercialista numero ${i}`, trustTier: 0,
        createdAt: '2026-08-04T11:00:00Z',
      });
    }
    const righeLight: Array<string | null> = [];
    h.deps.memory!.recall.reranker = new LlmReranker(
      lightLane(h.provider, {
        profile: CONSERVATIVE,
        record: (entry: LightSpend) => righeLight.push(entry.jobId ?? null),
      }),
      'light-model',
    );

    await runTurn(h.deps, turn(h, 'commercialista'));

    expect(righeLight).toEqual([null]);
  });
});
