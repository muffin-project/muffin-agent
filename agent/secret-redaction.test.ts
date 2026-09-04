import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync, readFileSync } from 'node:fs';
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

/**
 * P34-2 (audit 2026-08-16), closed by the owner's directive of 2026-08-17:
 * *"i secret non devono mai essere mostrati o mostrabili, né in logs, né in
 * chat, da nessuna parte"* — redaction at the write boundary, not a later
 * prune (a prune leaves the secret visible for as long as it runs, and
 * "showable" is already a violation).
 *
 * `agent/secret-read.test.ts` proves a **different** claim: that a tool
 * cannot *read* the key file at all. This file proves the one after it —
 * that if a tool's own output happens to *contain* a secret-shaped string
 * (an owner's file with a pasted key, a header echoed back in an error), the
 * three sinks that outlive the turn — the durable record
 * (`turn_tool_calls.content`, `turns.messages`), and the session JSONL —
 * never carry the raw bytes, only the redaction marker. It reads the actual
 * SQLite row and the actual JSONL line, not the in-memory `ToolOutcome`,
 * because a fix that redacted only what the model sees and not what gets
 * written down would pass every test that stops at `provider.seen`.
 *
 * This is `redact.ts`'s best-effort text scan (class 3): a tool's own
 * words happening to look like a credential. It is not the structural
 * guarantee for a secret the backend actually knows (`readSecret`) — that
 * one holds because no tool handler ever calls `readSecret` in the first
 * place (`core/config/secret-boundary.test.ts`), so this scenario never
 * needs to arise for a *real* key. See ADR-0048.
 */

const FAKE_KEY = 'sk-ant-QUESTA-STRINGA-SEMBRA-UNA-CHIAVE-1234567890';
const FAKE_BEARER_ERROR = 'upstream 401: Authorization: Bearer sk-ant-ALTRA-CHIAVE-FINTA-0987654321 rifiutato';

class ScriptedProvider implements Provider {
  readonly kind = 'openai-compat' as const;
  private i = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(): Promise<ChatResult> {
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

const callTool = (name: string): ChatResult => ({
  text: null,
  toolCalls: [{ id: `t${Math.random().toString(36).slice(2, 8)}`, name, args: {} }],
  stopReason: 'tool_use',
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'test',
});

const answer = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  stopReason: 'end',
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'test',
});

const decl = (id: string): CapabilityDecl => ({
  id,
  effect: 'context',
  risk: 'low',
  reversible: 'yes',
  rerunnable: true,
  resourceKind: 'none',
  policyArgs: [],
  hostOnly: false,
});

const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };

function bench(tools: RegisteredTool[]) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-secret-redaction-'));
  const store = new SessionStore(home);
  const db = new DatabaseCtor(':memory:');
  const turns = new TurnStore(db);
  const decls = tools.map((t) => decl(t.capability));
  const deps: LoopDeps = {
    provider: new ScriptedProvider([]),
    profile: CONSERVATIVE,
    model: 'test-model',
    tools,
    decide: createDecide({
      matrix: POLICY_FLOOR,
      capabilities: new Map(decls.map((d) => [d.id, d])),
      budgetExhausted: () => false,
      hardened: true,
    }),
    capabilities: new Map(decls.map((d) => [d.id, d])),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions: store,
    turns,
    todos: new TodoStore(db),
    budgetExhausted: () => false,
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite in un gruppo.' },
  };
  return { deps, store, db, home };
}

/** Every trace line written so far, newest file included, concatenated. */
function traceText(home: string): string {
  const dir = join(home, 'traces');
  const day = new Date().toISOString().slice(0, 10);
  const file = join(dir, `${day}.jsonl`);
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

describe('the write boundary — a tool result that looks like a secret', () => {
  it('never reaches turn_tool_calls.content, turns.messages or the session JSONL in the clear', async () => {
    const b = bench([
      {
        capability: 'demo.leak',
        spec: { name: 'demo_leak', description: 'returns a file that has a key pasted in it', inputSchema: { type: 'object', properties: {} } },
        throwTier: 0,
        handler: () => ({ content: `qui c'è la chiave: ${FAKE_KEY}\ne il resto della nota`, tier: 0 as const }),
      },
    ]);
    const scripted = new ScriptedProvider([callTool('demo_leak'), answer('letto')]);
    const deps: LoopDeps = { ...b.deps, provider: scripted };
    const session = b.store.open('s1');

    const result = await runTurn(deps, { principal: owner, tenant: 'host', surface: 'cli', session, text: 'leggi la nota' });

    // 1. The durable record — `turn_tool_calls.content`.
    const call = b.db
      .prepare(`SELECT content FROM turn_tool_calls WHERE turn_id = ? ORDER BY started_at DESC LIMIT 1`)
      .get(result.turnId) as { content: string } | undefined;
    expect(call?.content, 'turn_tool_calls.content leaked the raw key').not.toContain(FAKE_KEY);
    expect(call?.content).toContain('«redacted:');

    // 2. The durable record — `turns.messages` (the checkpoint/finish write).
    const row = b.db.prepare(`SELECT messages FROM turns WHERE id = ?`).get(result.turnId) as { messages: string };
    expect(row.messages, 'turns.messages leaked the raw key').not.toContain(FAKE_KEY);
    expect(row.messages).toContain('«redacted:');

    // 3. The session JSONL — read from disk, not from the in-memory call.
    const transcript = b.store.read(session);
    const toolMessage = transcript.find((m) => m.role === 'tool');
    expect(toolMessage?.content, 'the session transcript leaked the raw key').not.toContain(FAKE_KEY);
    expect(toolMessage?.content).toContain('«redacted:');
  });

  it('the same durable sinks, plus the trace, for a thrown error carrying a Bearer header', async () => {
    // The catch path in `runTool` does not append to the session today (only
    // a successful outcome does) — pre-existing and out of this slice's
    // scope. What it does write, on every path, is the durable record and
    // the span's `error` (`core/tracing/tracer.ts`, closed for P34-1 by
    // `053934f`); those two are what this test pins for the failure exit.
    const b = bench([
      {
        capability: 'demo.leak',
        spec: { name: 'demo_boom', description: 'throws with a header in the message', inputSchema: { type: 'object', properties: {} } },
        throwTier: 0,
        handler: () => {
          throw new Error(FAKE_BEARER_ERROR);
        },
      },
    ]);
    const scripted = new ScriptedProvider([callTool('demo_boom'), answer('ok')]);
    const deps: LoopDeps = { ...b.deps, provider: scripted };
    const session = b.store.open('s2');
    const secret = 'sk-ant-ALTRA-CHIAVE-FINTA-0987654321';

    const result = await runTurn(deps, { principal: owner, tenant: 'host', surface: 'cli', session, text: 'prova' });

    const call = b.db
      .prepare(`SELECT content FROM turn_tool_calls WHERE turn_id = ? ORDER BY started_at DESC LIMIT 1`)
      .get(result.turnId) as { content: string } | undefined;
    expect(call?.content, 'turn_tool_calls.content leaked the header').not.toContain(secret);
    expect(call?.content).toContain('«redacted:');

    const row = b.db.prepare(`SELECT messages FROM turns WHERE id = ?`).get(result.turnId) as { messages: string };
    expect(row.messages, 'turns.messages leaked the header').not.toContain(secret);

    const trace = traceText(b.home);
    expect(trace, 'the trace file leaked the header').not.toContain(secret);
    expect(trace).toContain('«redacted:');
  });
});
