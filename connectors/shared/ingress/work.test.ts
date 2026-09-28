import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runInit } from '../../../cli/init.js';
import { buildRuntime } from '../../../agent/runtime.js';
import { ContinuationGone } from '../../../agent/loop.js';
import type { LoopDeps } from '../../../agent/loop.js';
import type { Provider } from '../../../agent/providers/types.js';
import { identify } from '../../../core/surface/types.js';
import type { TurnRecord } from '../../../core/turns/store.js';
import { ModelLane } from '../../../core/turns/model-lane.js';
import { runWork } from './work.js';
import { makeIngressPort, type InboundEvent, type IngressPort } from './types.js';
import { providerMessages } from '../../../agent/loop/provider-checkpoint.js';

/**
 * §4 invariant 1, the **writing** half: what the `work` stage puts in
 * `turns.surface` is `port.surface.id` and nothing else.
 *
 * Before slice 14 that column was a string literal inside each connector
 * (`surface: 'telegram'`), while the map that has to find the connector again
 * after a restart was keyed by a *second* literal in `cli/surface.ts`. Nothing
 * made the two agree, and the failure mode is silent: `doors.get(turn.surface)`
 * misses, `approve` answers `unavailable`, and the owner's suspended turn never
 * comes back. `cli/porta-durevole.test.ts` proves the reading half against the
 * real assembly; this file proves the writing half against the real store.
 */

function porta(id: string, transport: 'edit' | 'off' = 'edit'): IngressPort {
  return makeIngressPort(
    {
      id,
      limits: { maxMessageChars: 4096, maxUploadBytes: 1, maxDownloadBytes: 1 },
      streaming: { transport },
      places: ['direct'],
      negotiate: (p: string) =>
        transport === 'edit' && p === 'direct'
          ? ({ stream: ['edit', 'off'] as const, editEveryMs: 1_000, maxEditsPerMinute: 20, draftTtlMs: 0, files: ['say'] as const })
          : { stream: ['off'] as const, editEveryMs: 0, maxEditsPerMinute: 0, draftTtlMs: 0, files: ['say'] as const },
      handles: () => true,
      deliver: async () => ({ ok: true }),
    } as never,
    { commands: true, buttons: true, edit: transport !== 'off', typing: true, upload: true },
  );
}

function ambiente(): { loop: LoopDeps; sessions: LoopDeps['sessions']; turns: LoopDeps['turns'] } {
  const home = mkdtempSync(join(tmpdir(), 'muffin-work-'));
  const workspace = mkdtempSync(join(tmpdir(), 'muffin-work-ws-'));
  runInit({ home, apiKey: 'sk-work-mai-usata' });
  const runtime = buildRuntime(home, workspace);
  const provider: Provider = {
    kind: 'openai-compat',
    chat: async () =>
      ({
        text: 'ecco',
        toolCalls: [],
        stopReason: 'end',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: 'test-model',
      }) as never,
  };
  const loop: LoopDeps = { ...runtime.deps, provider };
  return { loop, sessions: runtime.deps.sessions, turns: runtime.deps.turns };
}

function evento(port: IngressPort, over: Partial<InboundEvent> = {}): InboundEvent {
  return {
    port,
    eventId: '1',
    compositionId: '1',
    identity: { connector: 'telegram', authorId: '7', conversationId: '7', direct: true },
    address: { channel: `${port.surface.id}:7`, record: { chatId: 7, messageId: 10, channel: `${port.surface.id}:7` } },
    addressing: { direct: true, mentionsBot: false, repliesToBot: false },
    parts: [{ source: 'author', tier: 0, text: 'ciao' }],
    receivedAt: new Date('2026-09-05T10:00:00.000Z'),
    ...over,
  };
}

async function gira(
  env: ReturnType<typeof ambiente>,
  port: IngressPort,
  over: { ownerId?: string; contentTaint?: 0 | 1 | 2 | 3; workId?: string } = {},
): Promise<TurnRecord | null> {
  const ev = evento(port);
  const workId = over.workId ?? 'w-uno';
  await runWork({ loop: env.loop, sessions: env.sessions, lane: new ModelLane() }, port, ev, {
    workId,
    identity: identify(ev.identity, over.ownerId ?? '7'),
    text: 'ciao',
    contentTaint: over.contentTaint ?? 0,
    replyTo: ev.address.record,
    signal: new AbortController().signal,
    steer: () => [],
  });
  return env.turns.get(workId);
}

describe('`turns.surface` è `port.surface.id`, e non un letterale scritto nel connettore', () => {
  it('una porta chiamata `telegram` scrive `telegram`', async () => {
    const env = ambiente();
    const row = await gira(env, porta('telegram'));
    expect(row?.surface).toBe('telegram');
  });

  it('e una porta chiamata altrimenti scrive quell altro — la colonna segue la porta', async () => {
    const env = ambiente();
    const p = porta('terza-porta', 'off');
    const row = await gira(env, p);
    // Il difetto che questa scena esclude: un connettore che scrive il suo
    // nome a mano continuerebbe a dire `telegram` per una porta che non lo è.
    expect(row?.surface).toBe('terza-porta');
    expect(row?.surface).toBe(p.surface.id);
  });
});

describe('l indirizzo durevole è quello della porta, non uno inventato dal router', () => {
  it('`replyTo` è il record opaco passato, e `replyChannel` viene da `address.channel`', async () => {
    const env = ambiente();
    const row = await gira(env, porta('telegram'));
    expect(row?.replyTo).toMatchObject({ chatId: 7, messageId: 10, channel: 'telegram:7' });
  });
});

describe('identità e taint arrivano già decisi', () => {
  it('l owner apre la sessione `owner`, la stessa che apre il terminale', async () => {
    const env = ambiente();
    const row = await gira(env, porta('telegram'));
    expect(row?.principal.kind).toBe('owner');
    expect(row?.tenant).toBe('host');
    expect(env.sessions.open('owner').id).toBe(row?.sessionId);
  });

  it('chi non è l owner resta `member`, ma una DM conserva la topologia `direct`', async () => {
    const env = ambiente();
    const row = await gira(env, porta('telegram'), { ownerId: '999' });
    expect(row?.principal.kind).toBe('member');
    expect(row?.tenant).toBe('direct:telegram:7');
  });

  it('il contentTaint alza il tier di partenza del turno, e il turno lo registra', async () => {
    const env = ambiente();
    const row = await gira(env, porta('telegram'), { contentTaint: 2 });
    // DAY-1 requirement B16: un inoltro non può far partire il turno al tier di
    // chi lo ha inoltrato.
    expect(row?.taint).toBe(2);
  });
});

describe('l identità già impegnata è la riga scritta', () => {
  it('il turno nasce con il `workId` passato, mai con un secondo id', async () => {
    const env = ambiente();
    const row = await gira(env, porta('telegram'), { workId: 'identita-impegnata' });
    expect(row?.id).toBe('identita-impegnata');
    // E una sola riga: se `runWork` ne coniasse una sua, qui ce ne sarebbero due.
    expect(env.turns.get('identita-impegnata')).not.toBeNull();
  });
});

describe('continuazione conversazionale (P0-B)', () => {
  const counters = {
    iterations: 3,
    recoveriesUsed: 5,
    transportRetriesLeft: 7,
    truncationsUsed: 0,
    toolCallsMade: 2,
    nudgedForCompletion: false,
    usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    spentUsd: 0,
    resumes: 0,
    contextBuilt: true,
    activeModelMs: 0,
  };

  function rigaContinuabile(env: ReturnType<typeof ambiente>): void {
    const created = env.turns.create(
      {
        id: 'cont-1',
        principal: { kind: 'owner', connector: 'telegram', externalId: '7' },
        tenant: 'host',
        surface: 'telegram',
        sessionId: 'owner',
        model: env.loop.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'fai' }] }],
        taint: 0,
        counters,
      },
      4242,
    );
    expect(
      env.turns.releaseContinuable(
        'cont-1',
        {
          messages: providerMessages(created),
          taint: 0,
          counters,
          reason: { class: 'provider_empty' as const, lease: 0, at: '2026-09-18T17:14:09.000Z' },
        },
        created.claimToken,
      ),
    ).toBe(true);
  }

  function giraRiprendi(env: ReturnType<typeof ambiente>, port: IngressPort, workId: string) {
    const ev = evento(port, { parts: [{ source: 'author', tier: 0, text: 'riprendi' }] });
    return runWork({ loop: env.loop, sessions: env.sessions, lane: new ModelLane() }, port, ev, {
      workId,
      identity: identify(ev.identity, '7'),
      text: 'riprendi',
      contentTaint: 0,
      replyTo: ev.address.record,
      signal: new AbortController().signal,
      steer: () => [],
    });
  }

  it('"riprendi" continua la riga continuabile sulla stessa identità', async () => {
    const env = ambiente();
    rigaContinuabile(env);
    const out = await giraRiprendi(env, porta('telegram'), 'w9');
    expect(out.turnId).toBe('cont-1');
    expect(out.stopped).toBe('answered');
    const row = env.turns.get('cont-1');
    expect(row?.status).toBe('done');
    expect(row?.leaseIndex).toBe(1);
    // E nessuna riga per l'evento: un "riprendi" non è un lavoro nuovo.
    expect(env.turns.get('w9')).toBeNull();
  });

  it('un target sparito fra bind ed esecuzione rimanda senza ricalcolare', async () => {
    const env = ambiente();
    rigaContinuabile(env);
    // Il resolver vede la riga continuabile (continuableFor reale); la
    // rilettura di `runWork` la trova già presa altrove. Lo spy è la
    // seconda corsia che vince la race fra bind ed esecuzione.
    const reale = env.turns.get('cont-1')!;
    const originale = env.turns.get.bind(env.turns);
    const spy = vi.spyOn(env.turns, 'get').mockImplementation((id: string) =>
      id === 'cont-1' ? { ...reale, status: 'running' as const } : originale(id),
    );
    try {
      const port = porta('telegram');
      const ev = evento(port, { parts: [{ source: 'author', tier: 0, text: 'riprendi' }] });
      await expect(
        runWork({ loop: env.loop, sessions: env.sessions, lane: new ModelLane() }, port, ev, {
          workId: 'w9',
          identity: identify(ev.identity, '7'),
          text: 'riprendi',
          contentTaint: 0,
          replyTo: ev.address.record,
          signal: new AbortController().signal,
          steer: () => [],
        }),
      ).rejects.toBeInstanceOf(ContinuationGone);
    } finally {
      spy.mockRestore();
    }
    // Niente ricalcolo: nessuna riga per l'evento, la continuabile intatta.
    expect(env.turns.get('w9')).toBeNull();
    expect(env.turns.get('cont-1')?.status).toBe('continuable');
  });
});
