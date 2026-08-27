import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecide } from '../core/policy/decide.js';
import { POLICY_FLOOR } from '../core/policy/matrix.js';
import type { CapabilityDecl, Principal } from '../core/policy/types.js';
import { SessionStore } from '../core/session/store.js';
import { TurnStore } from '../core/turns/store.js';
import { TodoStore } from '../core/turns/todo.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { runTurn, type LoopDeps, type RegisteredTool, type ToolOutcome, type TurnEvent } from './loop.js';
import { CONSERVATIVE } from './profiles/profile.js';
import type { ChatResult, Provider } from './providers/types.js';
import { searchCapability, searchSpec } from './tools/search.js';

/**
 * B6: se una tool call fallisce, recupera?
 *
 * Fino a qui il retry esisteva **solo a livello di trasporto** (`agent/loop.ts`,
 * `MAX_TRANSPORT_RETRIES`): il modello si poteva richiamare, un tool no. Un 429
 * di Tavily o una connessione caduta a metà erano un fallimento secco che
 * arrivava al modello come «ricerca fallita», e da lì il turno proseguiva su
 * un'informazione che non c'era.
 *
 * Le due condizioni sono entrambe necessarie e i test le separano, perché
 * hanno ragioni diverse:
 *
 * - `retryable` risponde **«questo fallimento è transitorio?»** — se manca, si
 *   riproverebbe un «file non trovato» tre volte per ottenerlo tre volte.
 * - `rerunnable` risponde **«ripeterlo è sicuro?»** — è la dichiarazione che
 *   il ripristino dopo un crash già usa, ed è l'unica cosa che sta fra un retry
 *   e un effetto raddoppiato.
 *
 * Tutto passa da `runTurn`, mai dalla funzione di retry direttamente: ogni
 * difetto che questo repo ha pagato viveva nel cablaggio, non nell'unità.
 */

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  private i = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(): Promise<ChatResult> {
    return this.script[this.i++] ?? answer('fine');
  }
}

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const answer = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage, model: 'test' });
const callTool = (name: string, args: unknown): ChatResult => ({
  text: null,
  toolCalls: [{ id: 'c1', name, args }],
  stopReason: 'tool_use',
  usage,
  model: 'test',
});

/**
 * Un tool che risponde secondo un copione, e conta quante volte è stato
 * chiamato. Il conteggio è la cosa misurata: «ha riprovato» è un numero di
 * invocazioni dell'handler, non una riga di log.
 */
function toolScritto(esiti: ToolOutcome[], capability: CapabilityDecl): { tool: RegisteredTool; chiamate: () => number } {
  let n = 0;
  return {
    chiamate: () => n,
    tool: {
      capability: capability.id,
      spec: searchSpec,
      handler: () => {
        const esito = esiti[Math.min(n, esiti.length - 1)]!;
        n += 1;
        return esito;
      },
      throwTier: 0,
    },
  };
}

function harness(script: ChatResult[], tool: RegisteredTool, decl: CapabilityDecl) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-tool-retry-'));
  const decls = [decl];
  const eventi: TurnEvent[] = [];
  const deps: LoopDeps = {
    provider: new Scripted(script),
    profile: CONSERVATIVE,
    model: 'test',
    tools: [tool],
    capabilities: new Map(decls.map((d) => [d.id, d])),
    decide: createDecide({
      matrix: POLICY_FLOOR,
      capabilities: new Map(decls.map((d) => [d.id, d])),
      budgetExhausted: () => false,
      hardened: true,
    }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions: new SessionStore(home),
    turns: new TurnStore(new DatabaseCtor(':memory:')),
    todos: new TodoStore(new DatabaseCtor(':memory:')),
    budgetExhausted: () => false,
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite in un gruppo.' },
  };
  return { deps, eventi };
}

const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };

const transitorio: ToolOutcome = { content: 'fetch failed: ECONNRESET', isError: true, retryable: true, tier: 0 };
const definitivo: ToolOutcome = { content: '404 not found', isError: true, tier: 0 };
const riuscito: ToolOutcome = { content: 'i risultati', tier: 3 };

async function giro(esiti: ToolOutcome[], decl: CapabilityDecl = searchCapability) {
  const { tool, chiamate } = toolScritto(esiti, decl);
  const h = harness([callTool('web_search', { query: 'x' }), answer('fatto')], tool, decl);
  const result = await runTurn(h.deps, {
    principal: owner,
    tenant: 'host',
    surface: 'cli',
    session: h.deps.sessions.open('s1'),
    text: 'cerca',
    onProgress: (e) => h.eventi.push(e),
  });
  return { result, chiamate: chiamate(), eventi: h.eventi };
}

describe('un fallimento transitorio si riprova', () => {
  it('un guasto di rete al primo colpo, e al secondo va: il modello vede il successo', async () => {
    const g = await giro([transitorio, riuscito]);
    expect(g.chiamate).toBe(2);
    expect(g.result.stopped).toBe('answered');
  });

  /**
   * Tre tentativi in tutto, non infiniti: un servizio giù non deve diventare un
   * turno che non finisce più.
   */
  it('e se non va mai, si ferma a tre tentativi', async () => {
    const g = await giro([transitorio]);
    expect(g.chiamate).toBe(3);
    expect(g.result.stopped).toBe('answered');
  });

  /**
   * Il retry silenzioso è indistinguibile da uno stallo: chi guarda vede lo
   * spinner fermo per il doppio del tempo. L'evento esiste per quello, ed esce
   * **prima** dell'attesa.
   */
  it('e lo dice, invece di far sembrare che sia bloccato', async () => {
    const g = await giro([transitorio, riuscito]);
    const retry = g.eventi.filter((e) => e.type === 'tool_retry');
    expect(retry).toHaveLength(1);
    expect(retry[0]).toMatchObject({ name: 'web_search', attempt: 2 });
    // L'annuncio arriva prima della fine del tool, non dopo.
    const iRetry = g.eventi.findIndex((e) => e.type === 'tool_retry');
    const iFine = g.eventi.findIndex((e) => e.type === 'tool_end');
    expect(iRetry).toBeLessThan(iFine);
  });
});

describe('cosa NON si riprova', () => {
  /**
   * Un fallimento che non si è dichiarato transitorio è un fallimento sulla
   * richiesta, non sulla rete: rifarlo identico ottiene identicamente la stessa
   * cosa.
   */
  it('un errore che non si dichiara transitorio va provato una volta sola', async () => {
    const g = await giro([definitivo]);
    expect(g.chiamate).toBe(1);
    expect(g.eventi.filter((e) => e.type === 'tool_retry')).toHaveLength(0);
  });

  /**
   * **La condizione di sicurezza.** `rerunnable: false` dice che rieseguire può
   * raddoppiare un effetto — è la stessa dichiarazione che il ripristino dopo
   * un crash consulta per decidere se una chiamata «forse fatta» si può rifare.
   * Un tool può dichiararsi transitorio quanto vuole: se ripeterlo non è
   * sicuro, non si ripete.
   */
  it('un fallimento transitorio su una capability NON rerunnable resta uno solo', async () => {
    const nonRipetibile: CapabilityDecl = { ...searchCapability, rerunnable: false };
    const g = await giro([transitorio, riuscito], nonRipetibile);
    expect(g.chiamate).toBe(1);
    expect(g.eventi.filter((e) => e.type === 'tool_retry')).toHaveLength(0);
  });

  /**
   * Un successo non si riprova nemmeno se qualcuno ha lasciato `retryable`
   * acceso: la porta è `isError`, e questo test la tiene chiusa.
   */
  it('un successo non si ripete mai, retryable o no', async () => {
    const g = await giro([{ content: 'ok', retryable: true, tier: 3 }]);
    expect(g.chiamate).toBe(1);
  });
});
