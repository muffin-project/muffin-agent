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
import { runTurn, type LoopDeps, type RegisteredTool } from './loop.js';
import { CONSERVATIVE } from './profiles/profile.js';
import type { ChatResult, Provider } from './providers/types.js';
import { httpCapability } from './tools/http.js';

/**
 * Quanto è largo il buco misurato in
 * `docs/evidence/muffin-nei-gruppi-2026-09-04.md` §6.1 — misurato invece che
 * discusso.
 *
 * Il reperto di partenza: un turno di gruppo parte **esattamente al soffitto**
 * di `gateParams`. `tierOf(member)` è sempre 2, `paramsMaxTaint` è 2, e il
 * gate scatta solo quando `taint > ceiling`. Quindi la prima richiesta con
 * parametri scelti dal modello esce senza che nessuno la veda.
 *
 * La domanda che §6.1 lascia aperta, ed è quella che decide se `web_search`
 * può entrare in un gruppo: **il buco è a un salto solo, o si concatena?** Se
 * un risultato tier 3 alza il turno a 3, la seconda chiamata con parametri è
 * negata e un membro non può usare Muffin come un canale ripetuto — legge una
 * volta e poi la porta si chiude. Se invece il taint non sale, il buco è un
 * proxy aperto.
 *
 * Questo file non decide se aprire `web_search` ai gruppi: fissa il confine
 * che esiste oggi, così che allargarlo diventi un test rosso invece di una
 * riga cambiata senza che nessuno se ne accorga.
 */

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  seen: string[] = [];
  private i = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(call: { messages: { content: { type: string; content?: string }[] }[] }): Promise<ChatResult> {
    for (const m of call.messages) {
      for (const b of m.content) {
        if (b.type === 'tool_result' && b.content) this.seen.push(b.content);
      }
    }
    return (
      this.script[this.i++] ?? {
        text: 'fine',
        toolCalls: [],
        stopReason: 'end',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: 'test',
      }
    );
  }
}

let callId = 0;
const callTool = (name: string, args: unknown): ChatResult => ({
  text: null,
  toolCalls: [{ id: `c${(callId += 1)}`, name, args }],
  stopReason: 'tool_use',
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'test',
});

const TENANT = 'group:telegram:-100200';
/** Uno qualunque del gruppo. Il kernel non lo distingue da uno sconosciuto: è il punto. */
const membro: Principal = { kind: 'member', connector: 'telegram', tenantId: TENANT, externalId: '9999' };

const HOST = 'allowed.example.com';
const SENZA_PARAMETRI = `https://${HOST}/pagina`;
const CON_PARAMETRI = `https://${HOST}/collect?q=SCELTA-DAL-MODELLO`;

const decls: CapabilityDecl[] = [httpCapability];

function harness(script: ChatResult[]) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-gruppo-params-'));
  const fetched: string[] = [];
  const approvals: string[] = [];

  const tools: RegisteredTool[] = [
    {
      capability: httpCapability.id,
      spec: {
        name: 'http_get',
        description: 'fetch',
        inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      },
      // Registra invece di uscire davvero: la domanda è se il kernel ha
      // lasciato girare il corpo, non cosa ha risposto la rete. `tier: 3` è
      // ciò che `agent/tools/http.ts` restituisce quando un body arriva.
      handler: (args) => {
        fetched.push(String((args as { url: string }).url));
        return { content: 'ok', tier: 3 as const };
      },
      throwTier: 0,
    },
  ];

  const deps: LoopDeps = {
    provider: new Scripted(script),
    profile: CONSERVATIVE,
    model: 'test',
    tools,
    capabilities: new Map(decls.map((d) => [d.id, d])),
    decide: createDecide({
      matrix: POLICY_FLOOR,
      capabilities: new Map(decls.map((d) => [d.id, d])),
      budgetExhausted: () => false,
      hardened: true,
      egressAllowed: (host) => host === HOST,
    }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions: new SessionStore(home),
    turns: new TurnStore(new DatabaseCtor(':memory:')),
    todos: new TodoStore(new DatabaseCtor(':memory:')),
    budgetExhausted: () => false,
    // Se il kernel chiedesse, questo direbbe di sì. È adversariale di
    // proposito: in un gruppo non c'è nessuno che possa approvare, quindi un
    // `ask` che qui passa è un `ask` che in produzione non protegge nessuno.
    approve: async (request) => {
      approvals.push(request.prompt);
      return 'allow';
    },
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite in un gruppo.' },
  };
  return { deps, fetched, approvals, provider: deps.provider as Scripted };
}

describe('un turno di gruppo e i parametri scelti dal modello', () => {
  it('la prima richiesta con parametri esce senza che nessuno la veda — §6.1, dal filo', async () => {
    const h = harness([callTool('http_get', { url: CON_PARAMETRI })]);

    await runTurn(h.deps, {
      principal: membro,
      tenant: TENANT,
      surface: 'telegram',
      session: h.deps.sessions.open('g-params-1'),
      text: 'cerca una cosa per me',
    });

    // Il reperto, fissato: non è un caso limite, è il caso normale. Un turno
    // di gruppo parte a taint 2, che è il soffitto, e `gateParams` scatta
    // solo *sopra* il soffitto.
    expect(h.fetched).toEqual([CON_PARAMETRI]);
    expect(h.approvals).toEqual([]);
  });

  it('ma dopo un risultato tier 3 la porta si chiude: il buco è a un salto solo', async () => {
    const h = harness([
      callTool('http_get', { url: SENZA_PARAMETRI }),
      callTool('http_get', { url: CON_PARAMETRI }),
    ]);

    await runTurn(h.deps, {
      principal: membro,
      tenant: TENANT,
      surface: 'telegram',
      session: h.deps.sessions.open('g-params-2'),
      text: 'leggi quella pagina e poi cerca quello che dice',
    });

    // La risposta alla domanda che §6.1 lascia aperta. La prima esce, la
    // seconda no: un membro non può concatenare «leggi il web → rimanda
    // fuori quello che hai letto», che è la forma che trasformerebbe il buco
    // in un canale ripetuto.
    expect(h.fetched).toEqual([SENZA_PARAMETRI]);
    // E non per un `ask` che qualcuno potrebbe concedere: in un gruppo non
    // c'è nessuno che possa approvare, quindi un rifiuto che degrada a
    // domanda non sarebbe una difesa.
    expect(h.approvals).toEqual([]);
    // `resource_denied`, non `ask`: il rifiuto è terminale e il modello lo
    // legge come tale, che è ciò che gli impedisce di riprovare in cerchio.
    expect(h.provider.seen.join('\n')).toContain('resource_denied');
  });
});
