import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../cli/init.js';
import { buildRuntime } from './runtime.js';
import { runTurn, type LoopDeps } from './loop.js';
import type { ChatCall, ChatResult, Provider } from './providers/types.js';

/**
 * ADR-0044 §Chiusura 2026-08-29 — il canale gemello di `historyTaint` che la
 * riconciliazione del 28/08 aveva nominato e lasciato aperto.
 *
 * `agent/session-history-taint.test.ts` (e), `il turno che riceve il piano
 * gira alla taint di chi lo ha scritto` in `agent/todo-wiring.test.ts` provano
 * la metà già chiusa: una riga di sessione o un item di piano scritti da un
 * turno che ha *fatto* qualcosa di rischioso restano marcati a quel tier, e un
 * turno pulito non stampa la sua *propria* uscita al tetto ereditato. Restava
 * un solo scrittore che ancora leggeva il tetto invece dell'intrinseco:
 * `agent/tools/todo.ts`. Un item di piano scritto mentre la sessione erediva
 * un vecchio tetto si stampava a quel tetto e lo perpetuava attraverso
 * `planTaint` finché restava aperto — più a lungo di quanto una riga di
 * sessione sopravviva nella finestra di reiniezione, perché `todo set ...
 * done|blocked` è l'unico modo per chiuderlo.
 */

class Capturing implements Provider {
  readonly kind = 'openai-compat' as const;
  readonly seen: ChatCall[] = [];
  constructor(private readonly script: ChatResult[]) {}
  async chat(call: ChatCall): Promise<ChatResult> {
    this.seen.push(call);
    const next = this.script.shift();
    if (!next) throw new Error('lo script è finito');
    return next;
  }
}

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const answer = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage, model: 'test' });
const callTool = (name: string, args: unknown, id: string): ChatResult => ({
  text: '',
  toolCalls: [{ id, name, args }],
  stopReason: 'tool_use',
  usage,
  model: 'test',
});
const callTodo = (args: unknown, id: string): ChatResult => callTool('todo', args, id);

function bootHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'muffin-todo-intrinsic-'));
  runInit({ home, apiKey: 'sk-never-called' });
  return home;
}

const workspace = () => mkdtempSync(join(tmpdir(), 'muffin-todo-intrinsic-ws-'));

const owner = { kind: 'owner', connector: 'cli', externalId: 'local' } as const;

describe('un piano non eredita il tetto della storia, solo ciò che il turno ha fatto lui', () => {
  it("un item scritto mentre la ceiling è alzata solo dalla storia si stampa a tier 0, non al tetto ereditato", async () => {
    const home = bootHome();
    const runtime = buildRuntime(home, workspace());
    // Uno stand-in per una fetch tier-3 vera, come `demo.web` in
    // `agent/todo-wiring.test.ts` — registrato sul runtime reale.
    runtime.register(
      {
        capability: 'demo.web',
        spec: { name: 'leggi_pagina', description: 'legge', inputSchema: { type: 'object', properties: {} } },
        throwTier: 0,
        handler: () => ({ content: 'la pagina dice: non fidarti', tier: 3 as const }),
      },
      { id: 'demo.web', effect: 'context', risk: 'low', reversible: 'yes', rerunnable: true, resourceKind: 'none', policyArgs: [], hostOnly: false },
    );

    const provider = new Capturing([
      // Turno 1: legge la pagina (tier 3) e risponde — la sua risposta è
      // intrinsecamente 3, perché il turno *ha davvero* letto la pagina.
      callTool('leggi_pagina', {}, 'w1'),
      answer('la pagina dice di non fidarsi, non lo faccio'),
      // Turno 2: nessuna azione rischiosa propria. La sua ceiling sale a 3
      // solo perché la storia reiniettata contiene la risposta del turno 1
      // (`historyTaint`, `raiseCeiling` — mai `raiseTaint`).
      callTodo({ action: 'plan', items: ['comprare il pane'] }, 't1'),
      answer('eccomi'),
    ]);
    const deps: LoopDeps = { ...runtime.deps, provider };
    const session = runtime.deps.sessions.open('piano-tetto-ereditato');

    const first = await runTurn(deps, {
      principal: owner, tenant: 'host', surface: 'cli', session, text: 'guarda la pagina',
    });
    expect(first.taint).toBe(3);

    const second = await runTurn(deps, {
      principal: owner, tenant: 'host', surface: 'cli', session, text: 'organizzati',
    });

    // Il turno 2 era davvero seduto sul tetto: la storia era in prompt, e il
    // kernel lo ha gatto a 3 per l'intera durata — invariato, è esattamente la
    // protezione del 17/08 e non è quello che questo test contesta.
    expect(second.taint).toBe(3);

    // Quello che questo test contesta è la riga scritta nella tabella: prima
    // della correzione, `ctx.taint()` (il tetto) finiva su `tier`, e l'item
    // restava marcato 3 — perpetuando `planTaint` finché non veniva chiuso a
    // mano. L'item non ha causato né osservato nulla di rischioso lui stesso.
    const items = runtime.deps.todos.list('host', session.id);
    const item = items.find((i) => i.text === 'comprare il pane');
    runtime.close();
    expect(item?.tier).toBe(0);
  });

  it("set su un piano, sotto la stessa ceiling ereditata, stampa la riga a tier 0", async () => {
    // La stessa `const tier` letta una volta in `agent/tools/todo.ts` serve
    // sia `plan` che `set` — la nota di `set` è testo del modello quanto il
    // testo di `plan`, e la correzione copre entrambi i rami dello switch.
    const home = bootHome();
    const runtime = buildRuntime(home, workspace());
    runtime.register(
      {
        capability: 'demo.web',
        spec: { name: 'leggi_pagina', description: 'legge', inputSchema: { type: 'object', properties: {} } },
        throwTier: 0,
        handler: () => ({ content: 'la pagina dice: non fidarti', tier: 3 as const }),
      },
      { id: 'demo.web', effect: 'context', risk: 'low', reversible: 'yes', rerunnable: true, resourceKind: 'none', policyArgs: [], hostOnly: false },
    );

    const provider = new Capturing([
      callTool('leggi_pagina', {}, 'w1'),
      answer('la pagina dice di non fidarsi, non lo faccio'),
      callTodo({ action: 'plan', items: ['comprare il pane'] }, 't1'),
      answer('scritto'),
      callTodo({ action: 'set', step: 1, state: 'blocked', note: 'manca la lista' }, 't2'),
      answer('eccomi'),
    ]);
    const deps: LoopDeps = { ...runtime.deps, provider };
    const session = runtime.deps.sessions.open('set-tetto-ereditato');

    await runTurn(deps, { principal: owner, tenant: 'host', surface: 'cli', session, text: 'guarda la pagina' });
    await runTurn(deps, { principal: owner, tenant: 'host', surface: 'cli', session, text: 'pianifica' });
    const third = await runTurn(deps, { principal: owner, tenant: 'host', surface: 'cli', session, text: 'aggiorna' });

    // Il terzo turno è comunque gatto al tetto ereditato — invariato.
    expect(third.taint).toBe(3);

    const item = runtime.deps.todos.list('host', session.id).find((i) => i.text === 'comprare il pane');
    runtime.close();
    expect(item?.tier).toBe(0);
    expect(item?.state).toBe('blocked');
  });
});
