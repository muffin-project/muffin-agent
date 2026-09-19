import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecide } from '../../core/policy/decide.js';
import { POLICY_FLOOR } from '../../core/policy/matrix.js';
import type { Principal } from '../../core/policy/types.js';
import { SessionStore } from '../../core/session/store.js';
import { JsonlExporter, SimpleTracer } from '../../core/tracing/tracer.js';
import { TurnStore } from '../../core/turns/store.js';
import { TodoStore } from '../../core/turns/todo.js';
import { runTurn, type LoopDeps } from '../loop.js';
import { CONSERVATIVE } from '../profiles/profile.js';
import type { ChatCall, ChatResult, Provider } from '../providers/types.js';
import { searchCapability, searchSpec } from '../tools/search.js';
import { resolveConversationId } from './conversation.js';

describe('resolveConversationId · the seam OpenRouter session_id hangs from', () => {
  it('is stable across turns of the same session', () => {
    const session = { id: 'telegram:-100', file: '/dev/null' };
    expect(resolveConversationId(session)).toBe(resolveConversationId(session));
  });

  it('differs across sessions', () => {
    expect(resolveConversationId({ id: 'telegram:-100', file: '/a' })).not.toBe(
      resolveConversationId({ id: 'telegram:-200', file: '/b' }),
    );
  });

  it('is never a turn id: two turns of one session share it', () => {
    const session = { id: 's1', file: '/dev/null', generation: 0 };
    const conversation = resolveConversationId(session);
    expect(conversation).not.toBe('turn-aaa');
    expect(conversation).not.toBe('turn-bbb');
    expect(resolveConversationId(session)).toBe(conversation);
  });

  it('principal != session != conversation != turn, in value', () => {
    // The private owner scope: principal `owner`, session `owner`,
    // conversation `owner#g0`, turn a fresh id every turn.
    expect(resolveConversationId({ id: 'owner', file: '/dev/null', generation: 0 })).toBe('owner#g0');
  });

  it('a ref without generation reads as the legacy default g0', () => {
    // Every literal `{id, file}` built before the field existed.
    expect(resolveConversationId({ id: 'owner', file: '/dev/null' })).toBe('owner#g0');
  });

  it('follows the generation: /new moves the conversation, a new turn does not', () => {
    const before = resolveConversationId({ id: 'owner', file: '/dev/null', generation: 0 });
    const afterNew = resolveConversationId({ id: 'owner', file: '/dev/null', generation: 1 });
    expect(afterNew).not.toBe(before);
    expect(afterNew).toBe('owner#g1');
  });
});

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  readonly seen: ChatCall[] = [];
  async chat(call: ChatCall): Promise<ChatResult> {
    this.seen.push(call);
    return { text: 'ok', toolCalls: [], stopReason: 'end', usage, model: 'test' };
  }
}

describe('conversation identity end to end · loop to provider call', () => {
  function world() {
    const home = mkdtempSync(join(tmpdir(), 'muffin-conv-'));
    const sessions = new SessionStore(home);
    const provider = new Scripted();
    const caps = new Map([[searchCapability.id, searchCapability]]);
    const deps: LoopDeps = {
      provider,
      profile: CONSERVATIVE,
      model: 'test',
      tools: [],
      capabilities: caps,
      decide: createDecide({ matrix: POLICY_FLOOR, capabilities: caps, budgetExhausted: () => false, hardened: true }),
      tracer: new SimpleTracer(new JsonlExporter(home)),
      sessions,
      turns: new TurnStore(new DatabaseCtor(':memory:')),
      todos: new TodoStore(new DatabaseCtor(':memory:')),
      budgetExhausted: () => false,
      systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite.' },
    };
    return { deps, sessions, provider };
  }

  const inputFor = (session: { id: string; file: string }) => ({
    principal: owner,
    tenant: 'host' as const,
    surface: 'cli',
    session,
    text: 'ciao',
  });

  it('a turn sends the session generation the store resolved, not the principal', async () => {
    const { deps, sessions, provider } = world();
    await runTurn(deps, inputFor(sessions.open('owner')));
    expect(provider.seen[0]!.conversation).toBe('owner#g0');
  });

  it('two turns without /new share the conversation; after /new it moves', async () => {
    const { deps, sessions, provider } = world();
    await runTurn(deps, inputFor(sessions.open('owner')));
    await runTurn(deps, inputFor(sessions.open('owner')));
    expect(provider.seen[1]!.conversation).toBe(provider.seen[0]!.conversation);

    sessions.newConversation(sessions.open('owner'));
    await runTurn(deps, inputFor(sessions.open('owner')));
    expect(provider.seen[2]!.conversation).toBe('owner#g1');
    expect(provider.seen[2]!.conversation).not.toBe(provider.seen[0]!.conversation);
  });
});
