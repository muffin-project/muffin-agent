import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecide } from '../core/policy/decide.js';
import { POLICY_FLOOR } from '../core/policy/matrix.js';
import type { Principal } from '../core/policy/types.js';
import { SessionStore } from '../core/session/store.js';
import { TurnStore } from '../core/turns/store.js';
import { TodoStore } from '../core/turns/todo.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { runTurn, type LoopDeps, type RegisteredTool } from './loop.js';
import { CONSERVATIVE } from './profiles/profile.js';
import type { ChatCall, ChatResult, Provider } from './providers/types.js';
import { searchCapability, searchSpec } from './tools/search.js';

/**
 * `/steer` (ADR-0054 §2): la correzione dell'owner entra al confine di giro,
 * come messaggio dell'owner, e il modello la vede alla chiamata **dopo** — mai
 * dentro il giro in corso, mai a metà di una tool call.
 */

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };

/** Registra ogni chiamata e risponde con lo script: prima un tool, poi la risposta. */
class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  readonly chiamate: ChatCall[] = [];
  private i = 0;
  constructor(
    private readonly script: ChatResult[],
    /** Cosa succede *durante* la n-esima chiamata: è lì che l'owner scrive. */
    private readonly durante: (n: number) => void = () => {},
  ) {}
  async chat(call: ChatCall): Promise<ChatResult> {
    // Una copia: il loop riusa lo stesso array di messaggi da un giro
    // all'altro, e una registrazione per riferimento vedrebbe la correzione
    // anche nella chiamata di prima.
    this.chiamate.push({ ...call, messages: JSON.parse(JSON.stringify(call.messages)) as ChatCall['messages'] });
    this.durante(this.chiamate.length);
    return this.script[this.i++] ?? { text: 'fine', toolCalls: [], stopReason: 'end', usage, model: 'test' };
  }
}

function harness(provider: Provider) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-steer-'));
  const tool: RegisteredTool = {
    capability: searchCapability.id,
    spec: searchSpec,
    handler: () => ({ content: 'risultati', tier: 3 }),
    throwTier: 0,
  };
  const caps = new Map([[searchCapability.id, searchCapability]]);
  const deps: LoopDeps = {
    provider,
    profile: CONSERVATIVE,
    model: 'test',
    tools: [tool],
    capabilities: caps,
    decide: createDecide({ matrix: POLICY_FLOOR, capabilities: caps, budgetExhausted: () => false, hardened: true }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions: new SessionStore(home),
    turns: new TurnStore(new DatabaseCtor(':memory:')),
    todos: new TodoStore(new DatabaseCtor(':memory:')),
    budgetExhausted: () => false,
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite in un gruppo.' },
  };
  return deps;
}

const testiUtente = (call: ChatCall): string[] =>
  call.messages
    .filter((m) => m.role === 'user')
    .flatMap((m) => m.content.map((b) => (b.type === 'text' ? b.text : '')));

describe('una correzione a metà turno', () => {
  it('entra al confine di giro: assente nella prima chiamata, presente nella seconda, come parole dell owner', async () => {
    // La correzione arriva **mentre** il primo giro è in corso — il modello
    // sta rispondendo — e la coda si riempie allora, non prima del turno.
    const coda: string[] = [];
    const provider = new Scripted(
      [
        { text: null, toolCalls: [{ id: 'c1', name: 'web_search', args: { query: 'x' } }], stopReason: 'tool_use', usage, model: 'test' },
        { text: 'fatto', toolCalls: [], stopReason: 'end', usage, model: 'test' },
      ],
      (n) => {
        if (n === 1) coda.push('no, cerca in italiano');
      },
    );
    const deps = harness(provider);
    const result = await runTurn(deps, {
      principal: owner,
      tenant: 'host',
      surface: 'telegram',
      session: deps.sessions.open('s1'),
      text: 'cerca una cosa',
      steer: () => coda.splice(0),
    });
    expect(result.stopped).toBe('answered');
    expect(provider.chiamate).toHaveLength(2);
    expect(testiUtente(provider.chiamate[0]!).join('\n')).not.toContain('cerca in italiano');
    const seconda = testiUtente(provider.chiamate[1]!);
    expect(seconda.at(-1)).toBe('no, cerca in italiano');
    // Consegnata una volta: la coda è vuota dopo.
    expect(coda).toEqual([]);
    // E sta nel transcript persistito, così un turno ripreso la ricorda.
    const record = deps.turns.get(result.turnId);
    expect(JSON.stringify(record?.messages)).toContain('cerca in italiano');
  });

  it('senza correzioni non cambia niente', async () => {
    const provider = new Scripted([{ text: 'ciao', toolCalls: [], stopReason: 'end', usage, model: 'test' }]);
    const deps = harness(provider);
    await runTurn(deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session: deps.sessions.open('s2'),
      text: 'ehi',
      steer: () => [],
    });
    // Le parole dell'owner viaggiano isolate nel messaggio owner, ultimo della
    // sequenza: il contesto del turno (fatti di runtime) sta in un messaggio
    // proprio, marcato runtime, mai più fuso dentro le parole dell'owner.
    const userMessages = provider.chiamate[0]!.messages.filter((m) => m.role === 'user');
    const ownerMsg = userMessages.at(-1)!;
    expect(ownerMsg.origin).toBe('owner');
    expect(testiUtente(provider.chiamate[0]!).at(-1)).toBe('ehi');
    expect(userMessages.slice(0, -1).every((m) => m.origin !== 'owner')).toBe(true);
  });
});
