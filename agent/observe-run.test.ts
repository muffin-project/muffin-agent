import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Absence } from '../core/memory/absence.js';
import { MemoryStore } from '../core/memory/store.js';
import { createDecide } from '../core/policy/decide.js';
import type { CapabilityDecl, DecisionRequest, Principal } from '../core/policy/types.js';
import { SessionStore } from '../core/session/store.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { absenceGoal, makeAbsenceComposer } from './observe-run.js';
import type { LoopDeps, RegisteredTool } from './loop.js';
import { CONSERVATIVE } from './profiles/profile.js';
import type { ChatCall, ChatResult, Provider } from './providers/types.js';

const ABSENCE: Absence = {
  entityId: 7,
  name: 'la tesi',
  kind: 'thing',
  occasions: 9,
  firstSeen: '2026-05-01T09:00:00.000Z',
  lastSeen: '2026-07-01T09:00:00.000Z',
  spanDays: 61,
  gapDays: 40,
  p: 0.0041,
};

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  readonly seen: ChatCall[] = [];
  private i = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(request: ChatCall): Promise<ChatResult> {
    this.seen.push(request);
    return this.script[this.i++] ?? reply('fine');
  }
}

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const reply = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage, model: 't' });
const toolCall = (name: string): ChatResult => ({
  text: null,
  toolCalls: [{ id: 'c1', name, args: {} }],
  stopReason: 'tool_use',
  usage,
  model: 't',
});

const decl: CapabilityDecl = {
  id: 'demo.read',
  risk: 'low',
  reversible: 'yes',
  resourceKind: 'none',
  policyArgs: [],
  hostOnly: false,
};

/** Minimal turn deps, plus the two things this file needs to look at. */
function harness(
  script: ChatResult[],
  over: Partial<LoopDeps> = {},
): {
  deps: LoopDeps;
  provider: Scripted;
  principals: Principal[];
  sessionIds: string[];
} {
  const home = mkdtempSync(join(tmpdir(), 'muffin-observe-run-'));
  const provider = new Scripted(script);
  const principals: Principal[] = [];
  const sessionIds: string[] = [];
  // The real store, with `open` observed: the composer's claim is that each call
  // opens its own session, and a stub would not prove the loop then used it.
  const sessions = new SessionStore(home);
  const openSession = sessions.open.bind(sessions);
  sessions.open = (id?: string) => {
    const ref = openSession(id);
    sessionIds.push(ref.id);
    return ref;
  };
  const tools: RegisteredTool[] = [
    {
      capability: 'demo.read',
      spec: { name: 'demo_read', description: 'read', inputSchema: { type: 'object', properties: {} } },
      handler: () => ({ content: 'letto' }),
    },
  ];
  const decide = createDecide({
    capabilities: new Map([[decl.id, decl]]),
    budgetExhausted: () => false,
    hardened: false,
  });
  return {
    provider,
    principals,
    sessionIds,
    deps: {
      provider,
      profile: CONSERVATIVE,
      model: 'test-model',
      tools,
      decide: (req: DecisionRequest) => {
        principals.push(req.principal);
        return decide(req);
      },
      tracer: new SimpleTracer(new JsonlExporter(home)),
      sessions,
      budgetExhausted: () => false,
      systemPrompt: 'Sei Muffin.',
      ...over,
    },
  };
}

describe('absenceGoal', () => {
  it('carries the concrete anchor — the entity and the numbers that made it visible', () => {
    const goal = absenceGoal(ABSENCE);
    expect(goal).toContain('la tesi');
    expect(goal).toContain('9');
    expect(goal).toContain('61');
    expect(goal).toContain('40');
    expect(goal).toContain('0.0041');
  });

  it('forces the provenance discipline: an inference goes out as a question, never as a claim', () => {
    const goal = absenceGoal(ABSENCE);
    expect(goal).toMatch(/ipotesi/);
    expect(goal).toMatch(/dedot|inferen/);
    // The failure mode has a name in this project, and the prompt names it too.
    expect(goal).toContain('ho notato');
  });
});

describe('makeAbsenceComposer', () => {
  it('non scrive il proprio prompt nella memoria da cui lo Stadio-1 legge', async () => {
    // Il ciclo che questo test chiude: `runTurn` registra l'input come episodio
    // `role: 'user'`, tier 0 — cioè come se avesse parlato l'owner. Il testo è
    // il goal generato da noi, che *nomina l'entità*. Da lì: recall lo ripesca
    // senza filtro di ruolo, il vector index lo indicizza, e `memory extract`
    // lo mina in `facts` con `origin: 'said'` — la tabella esatta che
    // `detectAbsences` legge. Risultato: il nudge sull'assenza di X registra
    // una menzione di X, e il sistema si fabbrica la prova da sé (la regola sta
    // scritta in `ingest.ts`, ed è proprio questa).
    //
    // Lo Stadio-2 non ha bisogno di memoria: il goal dice "quello che ti serve
    // è tutto qui sopra". Quindi il turno gira senza, e la traccia di ciò che è
    // stato detto vive nel fire log, che è durevole e la giustifica coi numeri.
    const db = new DatabaseCtor(':memory:');
    const store = new MemoryStore(db);
    const h = harness([reply('quando hai visto la tesi?')], { memory: { store, recall: { store } } });

    await makeAbsenceComposer(h.deps, 'cli')(ABSENCE);

    expect(db.prepare('SELECT role, content FROM episodes').all()).toEqual([]);
  });


  it('runs stage 2 as the scheduler principal, on a session of its own, and returns the message', async () => {
    const h = harness([toolCall('demo_read'), reply('quando hai visto la tesi l\'ultima volta?')]);
    const text = await makeAbsenceComposer(h.deps, 'cli')(ABSENCE);

    expect(text).toBe('quando hai visto la tesi l\'ultima volta?');
    // The kernel must see system:scheduler, not the owner: a proactive turn does
    // not inherit the owner's column (threat model §3).
    expect(h.principals[0]).toEqual({ kind: 'system', source: 'scheduler' });
    expect(JSON.stringify(h.provider.seen[0]?.messages)).toContain('la tesi');
  });

  it('each composition gets a fresh session — nudges are not one growing conversation', async () => {
    const h = harness([reply('primo'), reply('secondo')]);
    const compose = makeAbsenceComposer(h.deps, 'cli');
    await compose(ABSENCE);
    await compose({ ...ABSENCE, entityId: 8, name: 'il corso' });

    expect(h.sessionIds).toHaveLength(2);
    expect(h.sessionIds[0]).not.toBe(h.sessionIds[1]);
  });

  it('a turn that did not answer produces nothing to send, loudly', async () => {
    // Over budget is the honest version of "no message": the caller must not
    // record a fire for it, so the silence stays open for the next run.
    const h = harness([reply('non arriverà mai')], { budgetExhausted: () => true });
    await expect(makeAbsenceComposer(h.deps, 'cli')(ABSENCE)).rejects.toThrow(/stage 2/);
  });
});
