import DatabaseCtor from 'better-sqlite3';
import type { Update } from '@grammyjs/types';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../../cli/init.js';
import { buildRuntime } from '../../agent/runtime.js';
import type { LoopDeps } from '../../agent/loop.js';
import type { ChatCall, ChatResult, Provider } from '../../agent/providers/types.js';
import { TelegramConnector, type TelegramConfig } from './connector.js';
import { ModelLane } from '../../core/turns/model-lane.js';
import type { TelegramApi } from './api.js';
import { UpdateInbox } from './updates.js';
import { TelegramDeliveryStore } from './delivery.js';

/**
 * A real group turn, through the real connector, gets the group context.
 *
 * The two halves of this slice are each correct in isolation and each useless
 * alone: an assembler that produces a group prompt nobody selects, or a
 * selection in `runTurn` fed by an assembler that produces one prompt. That
 * pairing is the defect this repository keeps finding, so the proof runs from
 * the entry point production actually uses — an `Update` off the wire, through
 * `drain()` → `handle()` → `runTurn()` — and reads what the provider was
 * handed.
 *
 * Everything below `TelegramConnector` is the production assembly
 * (`buildRuntime`): the real tools, the real capability declarations, the real
 * kernel. Only the provider is replaced, because the alternative is a network
 * call.
 */

const OWNER = 4242;
const GROUP = -100200;
const STRANGER = 9999;

const privateMsg = (id: number, fromId = OWNER): Update =>
  ({
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: OWNER, type: 'private' },
      from: { id: fromId, is_bot: false, first_name: 'o' },
      text: 'ciao',
    },
  }) as unknown as Update;

const groupMsg = (id: number): Update =>
  ({
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: GROUP, type: 'supergroup' },
      from: { id: STRANGER, is_bot: false, first_name: 'x' },
      // Menzionato di proposito: dal 04/09/2026 un messaggio di gruppo che non
      // nomina Muffin non apre nessun turno (`apreUnTurno`, ADR-0063), quindi
      // un `groupMsg` nudo qui non proverebbe piu' niente — arriverebbe verde
      // perche' il turno non parte, non perche' il prompt e' quello giusto.
      text: '@MuffinBot ciao a tutti',
    },
  }) as unknown as Update;

const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const reply = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  stopReason: 'end',
  usage: USAGE,
  model: 'test-model',
});
const callTool = (name: string): ChatResult => ({
  text: null,
  toolCalls: [{ id: 'c1', name, args: {} }],
  stopReason: 'tool_use',
  usage: USAGE,
  model: 'test-model',
});

function harness(config: TelegramConfig, script: ChatResult[] = []) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-groupctx-'));
  const workspace = mkdtempSync(join(tmpdir(), 'muffin-groupctx-ws-'));
  runInit({ home, apiKey: 'sk-groupctx-never-called' });
  const runtime = buildRuntime(home, workspace);

  const seen: ChatCall[] = [];
  let step = 0;
  const provider: Provider = {
    kind: 'openai-compat',
    chat: async (call: ChatCall) => {
      seen.push(call);
      return script[step++] ?? reply('Ok.');
    },
  };

  const loop: LoopDeps = { ...runtime.deps, provider };

  const api = {
    sendMessage: async () => ({}) as never,
    editMessageText: async () => ({}) as never,
    sendChatAction: async () => true,
    sendMessageDraft: async () => true,
  } as unknown as TelegramApi;

  const connector = new TelegramConnector({
    loop,
    sessions: runtime.deps.sessions,
    lane: new ModelLane(),
    inbox: new UpdateInbox(runtime.db),
    delivery: new TelegramDeliveryStore(runtime.db),
    api,
    config,
  });

  // Lo username che `connect()` prenderebbe da `getMe`. Il banco chiama
  // `drain()` senza connettersi, quindi va messo a mano: senza, il gate di
  // gruppo non puo' riconoscere una menzione e fallisce chiuso — corretto in
  // produzione, inutile qui.
  (connector as unknown as { meUsername: string }).meUsername = 'MuffinBot';

  return { connector, seen, runtime, prompts: runtime.deps.systemPrompts };
}

/** Feeds updates through the inbox exactly as polling would. */
async function deliver(h: ReturnType<typeof harness>, updates: Update[]): Promise<void> {
  const inbox = (h.connector as unknown as { deps: { inbox: UpdateInbox } }).deps.inbox;
  inbox.accept(updates, new Date().toISOString());
  await (h.connector as unknown as { drain: () => Promise<void> }).drain();
}

describe('a group turn arriving off the wire', () => {
  it('is given the group prompt, and never the owner one', async () => {
    const h = harness({ token: 't', ownerUserId: OWNER, ownerChatId: OWNER });
    try {
      await deliver(h, [groupMsg(1)]);
      expect(h.seen).toHaveLength(1);

      const system = h.seen[0]!.system;
      expect(system).toHaveLength(1);
      const text = system[0]!.type === 'text' ? system[0]!.text : '';

      // Named first and compared second, on purpose. These three lines are the
      // defect stated as an assertion, and they fail on the previous commit
      // against the prompt a real group turn was actually handed — the owner's
      // private pact and the block that tells the agent to ask for the person's
      // name a piece at a time. An equality against `prompts.group` alone would
      // have gone green the moment both classes pointed at the same string.
      expect(text).not.toContain('Al primo incontro');
      expect(text).not.toContain('Non mi dai ragione per farmi contento');
      // Unique to the group persona. `/ospite/` used to stand here and matched
      // `voice.md`, which both classes carry — so it stayed green with the
      // whole posture block deleted.
      expect(text).toContain('## Dove sei adesso');
      expect(text).toContain('Non tratto chi scrive come il mio owner');

      expect(text).toBe(h.prompts.group);
      expect(text).not.toBe(h.prompts.owner);
    } finally {
      h.runtime.close();
    }
  });

  it('keeps its own cache prefix, so two classes are two warm caches', async () => {
    const h = harness({ token: 't', ownerUserId: OWNER, ownerChatId: OWNER });
    try {
      await deliver(h, [groupMsg(1)]);
      const block = h.seen[0]!.system[0]!;
      // Both halves, together: the group text *and* the breakpoint on it. The
      // marker alone has been true since M1 and proves nothing about this
      // slice; what is new is that the string under the marker is per class, so
      // the two prefixes warm two caches instead of colliding on one.
      expect(block.type === 'text' && block.text).toBe(h.prompts.group);
      expect(block.type === 'text' && block.cache).toBe('stable');
    } finally {
      h.runtime.close();
    }
  });

  it('sees only the tools its principal could actually call', async () => {
    const h = harness({ token: 't', ownerUserId: OWNER, ownerChatId: OWNER });
    try {
      await deliver(h, [groupMsg(1)]);
      const names = (h.seen[0]!.tools ?? []).map((t) => t.name);

      expect(names).toContain('memory_search');
      // Every host-only tool the assembled runtime registers. The kernel
      // refuses each of these for a member at `decide.ts:132`; showing them was
      // a menu of guaranteed refusals in front of a taint-2 turn.
      expect(names).not.toContain('fs_read');
      expect(names).not.toContain('fs_list');
      expect(names).not.toContain('fs_write');
      expect(names).not.toContain('skill_read');
      expect(names).not.toContain('process_list');
      expect(names).not.toContain('process_kill');
    } finally {
      h.runtime.close();
    }
  });

  it('names only this principal when the model invents a tool', async () => {
    // The other half of the same leak, and the one that survives filtering the
    // list: hiding a tool from the menu is undone by an error message that
    // recites the whole inventory. One hallucinated call was enough — and a
    // hallucinated call is the *expected* behaviour of a weak model given a
    // short list, which is what a member now gets.
    const h = harness({ token: 't', ownerUserId: OWNER, ownerChatId: OWNER }, [
      callTool('non_esiste'),
      reply('Ok, ho capito.'),
    ]);
    try {
      await deliver(h, [groupMsg(1)]);
      expect(h.seen).toHaveLength(2);

      // The result the loop fed back on the second call.
      const fedBack = h.seen[1]!.messages.flatMap((m) => m.content)
        .filter((b) => b.type === 'tool_result')
        .map((b) => (b.type === 'tool_result' ? b.content : ''))
        .join('\n');

      expect(fedBack).toContain('non esiste');
      expect(fedBack).toContain('memory_search');
      expect(fedBack).not.toContain('fs_read');
      expect(fedBack).not.toContain('fs_write');
      expect(fedBack).not.toContain('skill_read');
      expect(fedBack).not.toContain('process_kill');
    } finally {
      h.runtime.close();
    }
  });

  it('still meets the kernel, not the filter, if it names a host-only tool anyway', async () => {
    // Defence in depth is only depth if the second layer still runs. The lookup
    // stays on the full registry precisely so this arrives as a policy denial
    // with a code — `decide.ts:132`, `principal_forbidden` — instead of a
    // "that tool does not exist" that would be a lie and would leave the kernel
    // branch silently unexercised on this path.
    const h = harness({ token: 't', ownerUserId: OWNER, ownerChatId: OWNER }, [
      callTool('fs_read'),
      reply('Non posso, te lo dico.'),
    ]);
    try {
      await deliver(h, [groupMsg(1)]);
      const fedBack = h.seen[1]!.messages.flatMap((m) => m.content)
        .filter((b) => b.type === 'tool_result')
        .map((b) => (b.type === 'tool_result' ? b.content : ''))
        .join('\n');

      expect(fedBack).toContain('Rifiutato dal kernel dei permessi');
      expect(fedBack).toContain('principal_forbidden');
      expect(fedBack).not.toContain('non esiste');
    } finally {
      h.runtime.close();
    }
  });
});

describe('il gate di gruppo, dal filo', () => {
  /**
   * La prova del **cablaggio**, non del criterio: `gate-di-gruppo.test.ts`
   * prova gia' `apreUnTurno` come funzione pura. Questo prova che `drain()` la
   * chiama davvero — la distinzione che questo repository continua a trovare
   * come difetto, e che una suite verde non nota.
   */
  it('un messaggio di gruppo che non chiama Muffin non arriva mai al modello', async () => {
    const h = harness({ token: 't', ownerUserId: OWNER, ownerChatId: OWNER });
    const nudo = {
      update_id: 900,
      message: {
        message_id: 900,
        date: 0,
        chat: { id: GROUP, type: 'supergroup' },
        from: { id: STRANGER, is_bot: false, first_name: 'x' },
        text: 'ragazzi che si fa stasera',
      },
    } as unknown as Update;

    await deliver(h, [nudo]);

    expect(h.seen).toHaveLength(0);
  });

  it('lo stesso messaggio, con la menzione, il modello lo vede', async () => {
    const h = harness({ token: 't', ownerUserId: OWNER, ownerChatId: OWNER });
    const chiamato = {
      update_id: 901,
      message: {
        message_id: 901,
        date: 0,
        chat: { id: GROUP, type: 'supergroup' },
        from: { id: STRANGER, is_bot: false, first_name: 'x' },
        text: '@MuffinBot ragazzi che si fa stasera',
      },
    } as unknown as Update;

    await deliver(h, [chiamato]);

    expect(h.seen.length).toBeGreaterThan(0);
  });
});

describe("the owner's own chat is untouched by the split", () => {
  it('still gets the owner prompt and the whole tool list', async () => {
    const h = harness({ token: 't', ownerUserId: OWNER, ownerChatId: OWNER });
    try {
      await deliver(h, [privateMsg(1)]);
      expect(h.seen).toHaveLength(1);

      const block = h.seen[0]!.system[0]!;
      expect(block.type === 'text' && block.text).toBe(h.prompts.owner);

      const names = (h.seen[0]!.tools ?? []).map((t) => t.name);
      expect(names).toContain('fs_read');
      expect(names).toContain('memory_search');
      // The exposure cap still applies, and it applies after the filter.
      expect(names.length).toBeLessThanOrEqual(h.runtime.deps.profile.maxToolsExposed);
    } finally {
      h.runtime.close();
    }
  });

  it('silently drops a stranger DM before the model, even when the chat id matches the owner', async () => {
    // This starts where production starts. A principal with member authority
    // is not enough for this single-owner bot: an unknown private sender must
    // not get even a member-scoped reply.
    const h = harness({ token: 't', ownerUserId: OWNER, ownerChatId: OWNER });
    try {
      await deliver(h, [privateMsg(1, STRANGER)]);
      expect(h.seen).toHaveLength(0);
      const inbox = (h.connector as unknown as { deps: { inbox: UpdateInbox } }).deps.inbox;
      expect(inbox.pending()).toHaveLength(0);
      expect(inbox.get(1)?.payload).toBe('{}');
    } finally {
      h.runtime.close();
    }
  });
});
