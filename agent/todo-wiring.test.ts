import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../cli/init.js';
import { buildRuntime } from './runtime.js';
import { runTurn, type LoopDeps } from './loop.js';
import type { ChatCall, ChatResult, Provider } from './providers/types.js';

/**
 * The plan reaches the model, through the production assembly.
 *
 * `core/turns/todo.test.ts` proves the rows behave. Every one of those tests
 * would stay green if `buildRuntime` stopped registering the tool, or if
 * `buildContext` stopped reading the store — and the result would be a table
 * with a writer, no reader, and a green suite, which is this repository's
 * signature defect and the reason `todos` is a **required** field on
 * `LoopDeps` rather than an optional one.
 *
 * So the assertions here are on what the provider was actually sent, on the
 * real runtime, across a restart. Delete the `todoSection` call in
 * `buildContext` and this file goes red; delete `makeTodoTool` from
 * `buildRuntime`'s tool list and it goes red at the first turn.
 */

/** Answers whatever it is told to, and keeps every request it was sent. */
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

const answer = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  stopReason: 'end',
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'test',
});

const callTodo = (args: unknown): ChatResult => ({
  text: '',
  toolCalls: [{ id: 'c1', name: 'todo', args }],
  stopReason: 'tool_use',
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'test',
});

function bootHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'muffin-todowire-'));
  runInit({ home, apiKey: 'sk-never-called' });
  return home;
}

const workspace = () => mkdtempSync(join(tmpdir(), 'muffin-todowire-ws-'));

/** Every piece of text the model was sent in the last request, flattened. */
function prompt(call: ChatCall | undefined): string {
  return (call?.messages ?? [])
    .flatMap((m) => m.content)
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('\n');
}

const owner = { kind: 'owner', connector: 'cli', externalId: 'local' } as const;

describe('buildRuntime mette wait e todo sul percorso reale', () => {
  it('registra i due tool con le loro capability, o il kernel li rifiuterebbe', () => {
    const runtime = buildRuntime(bootHome(), workspace());
    const names = runtime.deps.tools.map((t) => t.spec.name);
    runtime.close();
    expect(names).toContain('wait');
    expect(names).toContain('todo');
    // A tool whose capability the kernel has never heard of answers
    // `no_capability` on its first call — registered together, or not at all.
    expect(runtime.deps.capabilities?.get('turn.wait')).toBeDefined();
    expect(runtime.deps.capabilities?.get('turn.todo')).toBeDefined();
  });
});

describe('il piano torna nel contesto del turno dopo, senza che nessuno lo chieda', () => {
  it('un piano scritto in un turno è davanti al modello nel turno successivo', async () => {
    const home = bootHome();
    const ws = workspace();
    const runtime = buildRuntime(home, ws);
    const provider = new Capturing([
      callTodo({ action: 'plan', items: ['leggere il contratto', 'rispondere a Marco'] }),
      answer('scritto'),
      answer('eccomi'),
    ]);
    const deps: LoopDeps = { ...runtime.deps, provider };
    const session = runtime.deps.sessions.open('piano');

    await runTurn(deps, { principal: owner, tenant: 'host', surface: 'cli', session, text: 'organizzati' });
    await runTurn(deps, { principal: owner, tenant: 'host', surface: 'cli', session, text: 'a che punto sei?' });
    runtime.close();

    const second = prompt(provider.seen[provider.seen.length - 1]);
    expect(second).toContain('Piano di questa conversazione');
    expect(second).toContain('1. [pending] leggere il contratto');
    expect(second).toContain('2. [pending] rispondere a Marco');
    // The deterministic completion criterion is stated where the model reads
    // about the plan at all — it is the only place it appears.
    expect(second).toMatch(/finito quando nessun passo/);
  });

  it('sopravvive al riavvio del processo: un runtime nuovo lo rimette in contesto', async () => {
    const home = bootHome();
    const ws = workspace();
    const first = buildRuntime(home, ws);
    const write: LoopDeps = {
      ...first.deps,
      provider: new Capturing([callTodo({ action: 'plan', items: ['ricordare la revisione'] }), answer('ok')]),
    };
    await runTurn(write, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session: first.deps.sessions.open('durevole'),
      text: 'segnati una cosa',
    });
    first.close();

    // A second runtime over the same home is what a restart is. The plan is in
    // the database, not in a closure that died with the process.
    const second = buildRuntime(home, ws);
    const provider = new Capturing([answer('eccomi')]);
    await runTurn(
      { ...second.deps, provider },
      {
        principal: owner,
        tenant: 'host',
        surface: 'cli',
        session: second.deps.sessions.open('durevole'),
        text: 'e adesso?',
      },
    );
    second.close();

    expect(prompt(provider.seen[0])).toContain('1. [pending] ricordare la revisione');
  });

  it('un passo chiuso sparisce dal contesto — restare davanti è un invito a rifarlo', async () => {
    const home = bootHome();
    const runtime = buildRuntime(home, workspace());
    const provider = new Capturing([
      callTodo({ action: 'plan', items: ['una cosa sola'] }),
      answer('scritto'),
      callTodo({ action: 'set', step: 1, state: 'done' }),
      answer('fatto'),
      answer('niente da fare'),
    ]);
    const deps: LoopDeps = { ...runtime.deps, provider };
    const session = runtime.deps.sessions.open('chiuso');

    await runTurn(deps, { principal: owner, tenant: 'host', surface: 'cli', session, text: 'pianifica' });
    await runTurn(deps, { principal: owner, tenant: 'host', surface: 'cli', session, text: 'chiudi' });
    await runTurn(deps, { principal: owner, tenant: 'host', surface: 'cli', session, text: 'e ora?' });
    runtime.close();

    const last = prompt(provider.seen[provider.seen.length - 1]);
    // The row is still there — nothing is ever deleted — it simply stops being
    // pushed at a turn that has nothing to do with it.
    expect(last).not.toContain('Piano di questa conversazione');
    expect(last).not.toContain('una cosa sola');
  });

  it('una conversazione senza piano non paga niente', async () => {
    const runtime = buildRuntime(bootHome(), workspace());
    const provider = new Capturing([answer('ciao')]);
    await runTurn(
      { ...runtime.deps, provider },
      {
        principal: owner,
        tenant: 'host',
        surface: 'cli',
        session: runtime.deps.sessions.open('vuoto'),
        text: 'ciao',
      },
    );
    runtime.close();
    expect(prompt(provider.seen[0])).not.toContain('Piano di questa conversazione');
  });

  it('il piano sta nella coda volatile, non nel prefisso stabile che si cachea', async () => {
    const home = bootHome();
    const runtime = buildRuntime(home, workspace());
    const provider = new Capturing([
      callTodo({ action: 'plan', items: ['un passo'] }),
      answer('ok'),
      answer('eccomi'),
    ]);
    const deps: LoopDeps = { ...runtime.deps, provider };
    const session = runtime.deps.sessions.open('cache');
    await runTurn(deps, { principal: owner, tenant: 'host', surface: 'cli', session, text: 'pianifica' });
    await runTurn(deps, { principal: owner, tenant: 'host', surface: 'cli', session, text: 'poi?' });
    runtime.close();

    // The system prompt is built once at boot precisely so it stays
    // byte-identical and the prefix stays warm. A list that changes every turn
    // in front of it would go cold on every message.
    const last = provider.seen[provider.seen.length - 1]!;
    const system = last.system.map((s) => (s.type === 'text' ? s.text : '')).join('\n');
    expect(system).not.toContain('un passo');
    expect(prompt(last)).toContain('un passo');
  });
});
