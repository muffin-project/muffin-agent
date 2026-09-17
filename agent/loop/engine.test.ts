import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import DatabaseCtor from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDecide } from '../../core/policy/decide.js';
import { POLICY_FLOOR } from '../../core/policy/matrix.js';
import type { Principal } from '../../core/policy/types.js';
import { SessionStore } from '../../core/session/store.js';
import { JsonlExporter, SimpleTracer } from '../../core/tracing/tracer.js';
import { TurnStore } from '../../core/turns/store.js';
import { TodoStore } from '../../core/turns/todo.js';
import { type LoopDeps, runTurn } from '../loop.js';
import { CONSERVATIVE } from '../profiles/profile.js';
import {
  type ChatCall,
  type ChatResult,
  type Provider,
  ProviderError,
} from '../providers/types.js';

afterEach(() => vi.restoreAllMocks());

/**
 * Slice 9 (Fase A, §3) moves the last of `guidaIlTurno` — the deterministic
 * pre-loop and the `try`/`catch` around `runRounds` — into
 * `agent/loop/engine.ts`. What is measured here is what that `try`/`catch` and
 * that preamble are *for*, not that the file exists:
 *
 *  - **Nothing is generated before the pre-loop is done deciding.** The
 *    permission snapshot, the doors, the exposed tools, the recall and the
 *    context are all resolved before the first `chat()`, and the owner's own
 *    line is in the transcript by then — a crash inside the first model call
 *    cannot lose the input that caused it.
 *  - **A turn that *threw* still closes its row.** A provider that exhausts
 *    its transport retries never reaches `finish`, so without the outer
 *    `catch` the row stays `running` and the next boot reclaims it as
 *    *interrupted* — "we do not know whether it ran" — when we know exactly
 *    how it ended.
 *  - **The engine has one caller.** `guidaIlTurno` is reachable only through
 *    `drive()` in `agent/loop/entry.ts`; that is the whole shape the `/steer`
 *    invariant rests on (ADR-0054 §2, emendamento 03/09c), and a second
 *    importer would silently reopen the exit nobody drains.
 */

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };
const NOW = () => new Date('2026-09-05T10:00:00.000Z');

const answer = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  stopReason: 'end',
  usage,
  model: 'test-model',
});

/** Registra ogni chiamata, e cosa la sessione conteneva nell'istante in cui è partita. */
class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  readonly seen: ChatCall[] = [];
  private i = 0;
  constructor(
    private readonly script: (ChatResult | Error)[],
    private readonly durante: (n: number) => void = () => {},
  ) {}
  async chat(request: ChatCall): Promise<ChatResult> {
    this.seen.push(request);
    this.durante(this.seen.length);
    const next = this.script[this.i++] ?? this.script.at(-1);
    if (next === undefined) throw new Error('lo script è finito');
    if (next instanceof Error) throw next;
    return next;
  }
}

function world(script: (ChatResult | Error)[], durante: (n: number) => void = () => {}) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-loop-engine-'));
  const db = new DatabaseCtor(':memory:');
  const turns = new TurnStore(db);
  const sessions = new SessionStore(home);
  const capabilities = new Map();
  const provider = new Scripted(script, durante);
  const deps: LoopDeps = {
    provider,
    profile: CONSERVATIVE,
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
    turns,
    todos: new TodoStore(db),
    budgetExhausted: () => false,
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite.' },
    now: NOW,
  };
  return { deps, turns, sessions, provider };
}

describe('il pre-loop decide prima che il modello generi', () => {
  it('la riga dell owner è già in conversazione quando parte la prima chiamata', async () => {
    let sessioneAllaPrimaChiamata: unknown = null;
    const w = world([answer('ecco')], (n) => {
      if (n === 1) sessioneAllaPrimaChiamata = w.sessions.read(session);
    });
    const session = w.sessions.open('pre-loop');

    const r = await runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'una domanda che deve sopravvivere a un crash',
    });

    expect(r.stopped).toBe('answered');
    // Scritta **prima** della generazione, non dopo: è la proprietà, non
    // l'ordine casuale di due scritture.
    expect(JSON.stringify(sessioneAllaPrimaChiamata)).toContain(
      'una domanda che deve sopravvivere a un crash',
    );
    // E il contesto che il pre-loop ha montato è quello che il modello vede.
    const primo = w.provider.seen[0]!;
    expect(JSON.stringify(primo.messages)).toContain(
      'una domanda che deve sopravvivere a un crash',
    );
    expect(JSON.stringify(primo.system)).toContain('Sei Muffin.');
    // Il segno durevole che il preambolo è girato: senza, ogni ripresa lo
    // rifarebbe e conterebbe la prima esecuzione come un resume.
    expect(w.turns.get(r.turnId)!.counters.contextBuilt).toBe(true);
  });
});

describe('il catch esterno: un turno che lancia chiude comunque la sua riga', () => {
  it('il provider esaurisce i ritentativi, restituisce un errore sicuro e chiude la riga', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const w = world([new ProviderError('502 dal provider', true, 502, 'transport')]);
    const session = w.sessions.open('rethrow');
    const result = await runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'cerca',
    });
    expect(result.stopped).toBe('error');
    expect(result.text).toContain('HTTP 502');
    expect(result.text).not.toContain('502 dal provider');
    // `closeRecord(scope, 'error')` è girato dentro il `catch` di
    // `guidaIlTurno`: senza, questa riga sarebbe ancora `running` e il boot
    // successivo la reclamerebbe come *interrupted*.
    const righe = w.turns.reclaim(new Date('2026-09-06T10:00:00.000Z'));
    expect(righe).toEqual([]);
  });
});

describe('il motore ha un solo chiamante', () => {
  it('nessun modulo di produzione importa ./engine.js tranne entry.ts', () => {
    const qui = dirname(fileURLToPath(import.meta.url));
    const importatori = readdirSync(qui)
      .filter((nome) => nome.endsWith('.ts') && !nome.endsWith('.test.ts'))
      .filter((nome) =>
        /from\s+['"]\.\/engine\.js['"]/.test(readFileSync(join(qui, nome), 'utf8')),
      );
    // `drive()` è l'imbuto, ed è imbuto solo finché è l'unica porta: un
    // secondo importatore sarebbe un'uscita che nessuno drena.
    expect(importatori).toEqual(['entry.ts']);
  });
});

describe('la corsia main onora il Retry-After del provider (#496)', () => {
  it('attende la finestra dichiarata dal server prima di ritentare, poi risponde', async () => {
    // Backoff azzerato (random 0): l'unica attesa possibile è i 400ms che il
    // provider dichiara. Soglia a 300: i timer anticipano, non posticipano.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const w = world([
      new ProviderError('429 lento', true, 429, 'transport', 400),
      answer('eccomi dopo la finestra'),
    ]);
    const session = w.sessions.open('retry-after');

    const started = Date.now();
    const result = await runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'cerca',
    });

    expect(result.stopped).toBe('answered');
    expect(result.text).toContain('eccomi dopo la finestra');
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(w.provider.seen).toHaveLength(2);
  });
});
