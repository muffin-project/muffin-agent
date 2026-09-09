import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecide } from '../../core/policy/decide.js';
import { POLICY_FLOOR } from '../../core/policy/matrix.js';
import type { CapabilityDecl, Principal } from '../../core/policy/types.js';
import { SessionStore } from '../../core/session/store.js';
import { TurnStore } from '../../core/turns/store.js';
import { TodoStore } from '../../core/turns/todo.js';
import { JsonlExporter, SimpleTracer } from '../../core/tracing/tracer.js';
import { CONSERVATIVE } from '../profiles/profile.js';
import { searchCapability, searchSpec } from '../tools/search.js';
import { makeSnapshot } from './permissions.js';
import { runTool } from './tool-call.js';
import type { LoopDeps, RegisteredTool, ToolContext, ToolOutcome, TurnInput } from './types.js';

/**
 * Twin test for the `agent/loop/tool-call.ts` extraction (Fase A, fetta 5):
 * `runTool` and its cluster, moved out of `agent/loop.ts` in pure form. The
 * two properties that matter are named directly in the design's §4 invariants
 * 6 and 7 — the EFFECT WAL order, and the kernel resolving/deciding on the
 * same inputs it always has — not re-derived from scratch here.
 */

const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };
const member: Principal = { kind: 'member', connector: 'telegram', tenantId: 'group:telegram:g1', externalId: 'u1' };

function harness(decls: CapabilityDecl[], tools: RegisteredTool[]) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-tool-call-'));
  const deps: LoopDeps = {
    provider: undefined as never, // not exercised: runTool never calls the model
    profile: CONSERVATIVE,
    model: 'test',
    tools,
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
  return { deps, home };
}

function toolInput(principal: Principal): TurnInput {
  return {
    principal,
    tenant: 'host',
    surface: 'cli',
    session: { id: 't1', file: '/dev/null' },
    text: 'ciao',
  };
}

function toolCtx(deps: LoopDeps, principal: Principal, turnId: string): ToolContext {
  return {
    tenant: 'host',
    principal,
    turnId,
    sessionId: 's1',
    taint: () => 0,
    intrinsicTaint: () => 0,
    suspend: () => {
      throw new Error('this test never expects a suspension');
    },
  };
}

describe('EFFECT WAL — recordIntent before the handler, recordOutcome after', () => {
  /**
   * A handler that throws is the sharpest probe: it proves the intent row was
   * already durable *before* the handler ever ran (a throw cannot retroactively
   * un-write it), and that the outcome row is written on the way out even on
   * the exception path, not only on a clean return.
   */
  it('writes intent, then runs the handler, then writes the outcome — in that order', async () => {
    const order: string[] = [];
    const decl: CapabilityDecl = { ...searchCapability, hostOnly: false };
    const tool: RegisteredTool = {
      capability: decl.id,
      spec: searchSpec,
      handler: () => {
        order.push('handler');
        throw new Error('boom');
      },
      throwTier: 2,
    };
    const { deps } = harness([decl], [tool]);
    const realStart = deps.turns.startToolCall.bind(deps.turns);
    const realEnd = deps.turns.endToolCall.bind(deps.turns);
    deps.turns.startToolCall = (turnId, call) => {
      order.push('intent');
      return realStart(turnId, call);
    };
    deps.turns.endToolCall = (turnId, callId, result) => {
      order.push('outcome');
      return realEnd(turnId, callId, result);
    };
    const snapshot = makeSnapshot(deps.decide, owner, 'host', 0);
    const parent = deps.tracer.start('muffin.turn', {});
    const ctx = toolCtx(deps, owner, 'turn-1');

    const outcome = await runTool(
      deps,
      snapshot,
      parent,
      { id: 'c1', name: searchSpec.name, args: { query: 'x' } },
      toolInput(owner),
      [tool],
      ctx,
    );

    expect(order).toEqual(['intent', 'handler', 'outcome']);
    expect(outcome).toMatchObject({ type: 'tool_result', toolCallId: 'c1', isError: true, content: expect.stringContaining('boom') });
    // The outcome row really landed, at the tool's own declared throw tier —
    // "came back, so the call is decided, not uncertain" (see runTool's own
    // comment on this branch). One matching row: this call's own outcome.
    expect(deps.turns.identicalFailuresDone('turn-1', searchSpec.name, { query: 'x' }, 'boom')).toBe(1);
  });

  it('never runs the handler when the intent cannot be written durably — a refused call, not a "maybe done"', async () => {
    const decl: CapabilityDecl = { ...searchCapability, hostOnly: false };
    let handlerCalled = false;
    const tool: RegisteredTool = {
      capability: decl.id,
      spec: searchSpec,
      handler: (): ToolOutcome => {
        handlerCalled = true;
        return { content: 'i risultati', tier: 0 };
      },
      throwTier: 0,
    };
    const { deps } = harness([decl], [tool]);
    deps.turns.startToolCall = () => {
      throw new Error('disk full');
    };
    const snapshot = makeSnapshot(deps.decide, owner, 'host', 0);
    const parent = deps.tracer.start('muffin.turn', {});
    const ctx = toolCtx(deps, owner, 'turn-2');

    const outcome = await runTool(
      deps,
      snapshot,
      parent,
      { id: 'c2', name: searchSpec.name, args: { query: 'x' } },
      toolInput(owner),
      [tool],
      ctx,
    );

    expect(handlerCalled).toBe(false);
    expect(outcome).toMatchObject({ isError: true });
    expect((outcome as { content: string }).content).toContain('Intento non registrabile');
  });
});

describe('a tool the model was not shown', () => {
  /**
   * `deps.tools` is the full catalog registered at boot; `exposed` is what
   * *this* turn's model was actually told about (`visibleTools`, filtered by
   * principal and profile). A host-only tool can be absent from `exposed` for
   * a group member and still be present in `deps.tools` — and a member
   * hallucinating (or probing for) that name must not get treated as if it
   * simply does not exist: it has to reach the kernel and be refused there,
   * on the trace, with a policy code — see `runTool`'s own comment on why the
   * lookup is against the full catalog and not the filtered list.
   */
  it('a host-only tool absent from `exposed` still reaches the kernel and is denied there, not reported as unknown', async () => {
    const decl: CapabilityDecl = { ...searchCapability, hostOnly: true };
    const other: CapabilityDecl = { ...searchCapability, id: 'sys.other', hostOnly: false };
    const hostOnlyTool: RegisteredTool = {
      capability: decl.id,
      spec: searchSpec,
      handler: () => ({ content: 'should never run', tier: 0 }),
      throwTier: 0,
    };
    const memberTool: RegisteredTool = {
      capability: other.id,
      spec: { ...searchSpec, name: 'member_tool' },
      handler: () => ({ content: 'ok', tier: 0 }),
      throwTier: 0,
    };
    const { deps } = harness([decl, other], [hostOnlyTool, memberTool]);
    const snapshot = makeSnapshot(deps.decide, member, 'group:telegram:g1', 0);
    const parent = deps.tracer.start('muffin.turn', {});
    const ctx = toolCtx(deps, member, 'turn-3');

    // `exposed` — what the member's turn was actually shown — excludes the
    // host-only tool, exactly as `visibleTools` would.
    const outcome = await runTool(
      deps,
      snapshot,
      parent,
      { id: 'c3', name: searchSpec.name, args: { query: 'x' } },
      toolInput(member),
      [memberTool],
      ctx,
    );

    expect(outcome).toMatchObject({ isError: true });
    const content = (outcome as { content: string }).content;
    expect(content).not.toContain('non esiste');
    expect(content).toContain('principal_forbidden');
    // No intent row for a denied call — a deny never reaches the handler, so
    // there is nothing "maybe done" about it.
    expect(deps.turns.identicalCallsDone('turn-3', searchSpec.name, { query: 'x' })).toBe(0);
  });

  it("the disclosure for a truly unknown name lists `exposed`, never the full catalog — a member never learns a host-only tool's name this way", async () => {
    const decl: CapabilityDecl = { ...searchCapability, hostOnly: true };
    const hostOnlyTool: RegisteredTool = {
      capability: decl.id,
      spec: searchSpec, // name: 'web_search'
      handler: () => ({ content: 'should never run', tier: 0 }),
      throwTier: 0,
    };
    const memberSpec = { ...searchSpec, name: 'member_tool' };
    const memberTool: RegisteredTool = {
      capability: decl.id,
      spec: memberSpec,
      handler: () => ({ content: 'ok', tier: 0 }),
      throwTier: 0,
    };
    const { deps } = harness([decl], [hostOnlyTool, memberTool]);
    const snapshot = makeSnapshot(deps.decide, member, 'group:telegram:g1', 0);
    const parent = deps.tracer.start('muffin.turn', {});
    const ctx = toolCtx(deps, member, 'turn-4');

    const outcome = await runTool(
      deps,
      snapshot,
      parent,
      { id: 'c4', name: 'nome_inventato', args: {} },
      toolInput(member),
      [memberTool],
      ctx,
    );

    const content = (outcome as { content: string }).content;
    expect(content).toContain('non esiste');
    expect(content).toContain('member_tool');
    expect(content).not.toContain('web_search');
  });
});

/**
 * **ADR-0075 punto 4: il prompt di ogni `ask` porta l'origine del taint.**
 *
 * Il kernel dice cosa non torna indietro; da un solo snapshot non può dire
 * *quale parte del turno* ha alzato il livello, perché quella non è nella
 * `DecisionRequest`. Il giro sì, ed è qui che si prova — sul percorso vero
 * (`runTool` due volte, la stessa `PermissionSnapshot`, un `approve` che
 * cattura ciò che l'owner leggerebbe), non sulla funzione di formattazione da
 * sola: la cucitura fra chi alza il taint e chi scrive la domanda è
 * esattamente la cosa che può rompersi restando verde altrove.
 */
describe('la domanda dice da dove viene il taint — ADR-0075', () => {
  /** Una capability che chiede sempre: `host` + `reversible: 'no'` (ADR-0074). */
  const scrive: CapabilityDecl = {
    id: 'sys.shell.write',
    effect: 'host',
    risk: 'high',
    reversible: 'no',
    rerunnable: false,
    resourceKind: 'none',
    policyArgs: ['command'],
    hostOnly: false,
  };

  async function chiediDopoUnaRicerca(): Promise<string> {
    const cerca: CapabilityDecl = { ...searchCapability, hostOnly: false };
    const toolCerca: RegisteredTool = {
      capability: cerca.id,
      spec: searchSpec,
      // Tier 3: è ciò che una ricerca web restituisce davvero
      // (`agent/tools/search.ts`), non un numero scelto dal test.
      handler: (): Promise<ToolOutcome> => Promise.resolve({ content: 'risultati', tier: 3 }),
      throwTier: 3,
    };
    const toolScrive: RegisteredTool = {
      capability: scrive.id,
      spec: { name: 'shell_run_write', description: 'scrive', inputSchema: { type: 'object', properties: {} } },
      handler: (): Promise<ToolOutcome> => Promise.resolve({ content: 'fatto', tier: 0 }),
      throwTier: 0,
    };
    const { deps } = harness([cerca, scrive], [toolCerca, toolScrive]);
    let letto = '';
    deps.approve = (request) => {
      letto = request.prompt;
      return Promise.resolve('deny');
    };
    const snapshot = makeSnapshot(deps.decide, owner, 'host', 0);
    const parent = deps.tracer.start('muffin.turn', {});
    const ctx = toolCtx(deps, owner, 'turn-origine');

    await runTool(deps, snapshot, parent, { id: 'c1', name: searchSpec.name, args: { query: 'x' } }, toolInput(owner), [toolCerca, toolScrive], ctx);
    // Il turno è salito per davvero: senza questo, la riga sotto proverebbe
    // solo che una stringa viene concatenata.
    expect(snapshot.currentTaint()).toBe(3);
    await runTool(
      deps,
      snapshot,
      parent,
      { id: 'c2', name: 'shell_run_write', args: { command: 'rm -rf /tmp/x' } },
      toolInput(owner),
      [toolCerca, toolScrive],
      ctx,
    );
    return letto;
  }

  it("la domanda che segue una ricerca nomina il livello e la parte che l'ha alzato", async () => {
    const prompt = await chiediDopoUnaRicerca();
    // La prima metà resta quella di ADR-0074: si chiede per ciò che non torna.
    expect(prompt).toContain('non si torna indietro');
    // La seconda è ADR-0075: il livello, e da dove viene.
    expect(prompt).toContain('questo turno contiene contenuto di livello 3');
    expect(prompt).toContain(`il risultato di ${searchSpec.name}`);
  });

  /**
   * Il falsificatore dell'altra metà: a taint 0 non si aggiunge niente. Una
   * riga fissa che dicesse «livello 0» su ogni domanda sarebbe rumore, e il
   * rumore è come una ragione visibile smette di essere letta.
   */
  it('un turno pulito non porta nessuna riga di provenienza', async () => {
    const toolScrive: RegisteredTool = {
      capability: scrive.id,
      spec: { name: 'shell_run_write', description: 'scrive', inputSchema: { type: 'object', properties: {} } },
      handler: (): Promise<ToolOutcome> => Promise.resolve({ content: 'fatto', tier: 0 }),
      throwTier: 0,
    };
    const { deps } = harness([scrive], [toolScrive]);
    let letto = '';
    deps.approve = (request) => {
      letto = request.prompt;
      return Promise.resolve('deny');
    };
    const snapshot = makeSnapshot(deps.decide, owner, 'host', 0);
    const parent = deps.tracer.start('muffin.turn', {});
    await runTool(
      deps,
      snapshot,
      parent,
      { id: 'c1', name: 'shell_run_write', args: { command: 'ls' } },
      toolInput(owner),
      [toolScrive],
      toolCtx(deps, owner, 'turn-pulito'),
    );
    expect(letto).toContain('non si torna indietro');
    expect(letto).not.toContain('contenuto di livello');
  });
});
