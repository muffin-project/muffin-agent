import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecide } from '../core/policy/decide.js';
import { POLICY_FLOOR } from '../core/policy/matrix.js';
import { SessionStore } from '../core/session/store.js';
import { TurnStore } from '../core/turns/store.js';
import { TodoStore } from '../core/turns/todo.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { makeWaitTool, waitCapability } from './tools/wait.js';
import { resumeTurn, runTurn, type LoopDeps } from './loop.js';
import { CONSERVATIVE } from './profiles/profile.js';
import type { ChatCall, ChatResult, Provider } from './providers/types.js';

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const wait = (id: string): ChatResult => ({
  text: null,
  toolCalls: [{ id, name: 'wait', args: { seconds: 3600, why: `checkpoint ${id}` } }],
  stopReason: 'tool_use',
  usage,
  model: 'test',
});
const answer = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage, model: 'test' });

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  private i = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(_call: ChatCall): Promise<ChatResult> {
    const next = this.script[this.i++];
    if (!next) throw new Error('script finito');
    return next;
  }
}

function harness(script: ChatResult[]) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-resume-checkpoint-'));
  const db = new DatabaseCtor(':memory:');
  const turns = new TurnStore(db);
  const provider = new Scripted(script);
  const capabilities = new Map([[waitCapability.id, waitCapability]]);
  const deps: LoopDeps = {
    provider,
    profile: CONSERVATIVE,
    model: 'test',
    tools: [makeWaitTool(turns, () => new Date('2026-08-29T00:00:00.000Z'))],
    capabilities,
    decide: createDecide({ matrix: POLICY_FLOOR, capabilities, budgetExhausted: () => false, hardened: true }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions: new SessionStore(home),
    turns,
    todos: new TodoStore(db),
    budgetExhausted: () => false,
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite.' },
    now: () => new Date('2026-08-29T00:00:00.000Z'),
  };
  return { deps, turns, db };
}

describe('resume budget: un checkpoint durevole dimostra progresso', () => {
  it('quattro wait consecutivi non esauriscono il circuit breaker dei crash', async () => {
    // Il dump reale mostra la stessa forma con approval anziché timer: il turno
    // progredisce, si sospende deliberatamente, l'owner risponde, progredisce e
    // si sospende di nuovo. Prima della fix il quarto resume viene rifiutato
    // perché `resumes` accumula per tutta la vita del turno, anche se tre nuovi
    // checkpoint durevoli hanno già dimostrato che non è un crash loop.
    const h = harness([wait('w1'), wait('w2'), wait('w3'), wait('w4'), answer('arrivato fino in fondo')]);

    const first = await runTurn(h.deps, {
      principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
      tenant: 'host',
      surface: 'cli',
      session: h.deps.sessions.open('resume-checkpoint'),
      text: 'aspetta quattro volte e poi rispondi',
    });
    expect(first.stopped).toBe('suspended');

    for (let i = 0; i < 3; i++) {
      const resumed = await resumeTurn(h.deps, first.turnId);
      expect('why' in resumed).toBe(false);
      expect(!('why' in resumed) && resumed.stopped).toBe('suspended');
      // La sospensione riuscita è il checkpoint: il prossimo resume non deve
      // ereditare il debito dei checkpoint precedenti.
      expect(h.turns.get(first.turnId)?.counters.resumes).toBe(0);
    }

    const last = await resumeTurn(h.deps, first.turnId);
    expect('why' in last).toBe(false);
    expect(!('why' in last) && last.stopped).toBe('answered');
    expect(!('why' in last) && last.text).toBe('arrivato fino in fondo');
  });
});

describe('resume budget: il bound resta un bound', () => {
  /**
   * La prova che separa questa correzione da quella proposta in #241.
   *
   * Quella azzerava `resumes` dentro `TurnStore.suspend`, e la sua motivazione
   * copriva un caso solo: «un processo che muore prima di questa scrittura non
   * prende il reset». Vero — ma un crash **dopo** una sospensione riuscita il
   * reset lo prende. Sospende, muore, riprende, sospende, muore: ogni
   * sospensione cancella l'evidenza del crash precedente e il breaker non
   * scatta mai. `MAX_RESUMES` smetterebbe di essere un bound sul loop di
   * recovery, che e l'unica cosa che deve fare.
   *
   * Qui il contatore non viene mai azzerato: semplicemente il risveglio voluto
   * non lo paga. Quindi i crash si sommano attraverso le sospensioni, e questo
   * test muore se qualcuno reintroduce l'azzeramento.
   */
  it('i crash si sommano attraverso le sospensioni riuscite, e al quarto si ferma', async () => {
    // wait, poi ogni ripresa muore prima di chiudere: `crash()` lascia la riga
    // come la lascia un processo ucciso — `interrupted`, senza barriera.
    // Ogni ripresa risospende: cosi il turno resta vivo e l'alternanza
    // sospensione-riuscita / crash e proprio quella che il reset in `suspend`
    // non chiuderebbe mai.
    const h = harness([wait('w1'), wait('w2'), wait('w3'), wait('w4'), answer('mai raggiunta')]);

    const first = await runTurn(h.deps, {
      principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
      tenant: 'host',
      surface: 'cli',
      session: h.deps.sessions.open('resume-crash'),
      text: 'aspetta, poi muori tre volte',
    });
    expect(first.stopped).toBe('suspended');
    expect(h.turns.get(first.turnId)?.counters.resumes).toBe(0);

    // La sospensione e riuscita. Da qui in poi sono solo crash.
    const crash = (): void => {
      h.db
        .prepare(
          `UPDATE turns SET status = 'interrupted', claimed_by = NULL, claim_token = NULL,
                            wait_for = NULL, wake_at = NULL WHERE id = ?`,
        )
        .run(first.turnId);
    };

    for (let i = 1; i <= 3; i++) {
      crash();
      const ripresa = await resumeTurn(h.deps, first.turnId);
      // La ripresa gira e si risospende. Cio che conta e il contatore: sale
      // di uno per ogni crash, perche il crash ha tolto la barriera.
      expect(!('why' in ripresa) && ripresa.stopped).toBe('suspended');
      expect(h.turns.get(first.turnId)?.counters.resumes).toBe(i);
    }

    // Il quarto tentativo trova il contatore a MAX_RESUMES e si ferma, invece
    // di riprovare all'infinito a ogni boot.
    crash();
    const quarta = await resumeTurn(h.deps, first.turnId);
    expect('why' in quarta && quarta.why).toBe('exhausted');
  });
});
