import type { Update } from '@grammyjs/types';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dimenticaModalita } from '../../agent/providers/modalita.js';
import { buildRuntime } from '../../agent/runtime.js';
import type { LoopDeps } from '../../agent/loop.js';
import type { ChatCall, ChatResult, Provider } from '../../agent/providers/types.js';
import { runInit } from '../../cli/init.js';
import { telegramVault, vistaFor } from '../../cli/surface.js';
import { paths } from '../../core/config/config.js';
import type { Vista } from '../../core/vista/vista.js';
import { TelegramConnector } from './connector.js';
import { ModelLane } from '../../core/turns/model-lane.js';
import type { TelegramApi } from './api.js';
import { UpdateInbox } from './updates.js';
import { TelegramDeliveryStore } from './delivery.js';

/**
 * Una foto mandata al bot quando il modello non ci vede, per intero.
 *
 * Sotto il connettore c'è il montaggio di produzione — `buildRuntime`, il
 * vault vero, il kernel vero, e la vera `vistaFor`: sono finti solo i due
 * modelli (principale cieco, leggero che vede, entrambi via `/models`
 * finto) e la rete.
 *
 * La cosa che questi test tengono chiusa è che la descrizione arrivi firmata:
 * il turno deve sapere che il modello non ha visto, e da chi ha ricevuto la
 * descrizione — una descrizione senza firma diventerebbe "il modello ha
 * visto".
 */

const OWNER = 4242;
const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const RECEIVED_AT = '2026-10-02T12:00:00.000Z';
const BASE = 'https://openrouter.example.test/api/v1';

/** Un PNG riconoscibile dall'intestazione: `loadImage` guarda i byte, non il nome. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(512)]);

const withPhoto = (id: number): Update =>
  ({
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: OWNER, type: 'private' },
      from: { id: OWNER, is_bot: false, first_name: 'o' },
      photo: [{ file_id: `p${id}s`, file_unique_id: `u${id}s`, width: 10, height: 10, file_size: 100 }, { file_id: `p${id}`, file_unique_id: `u${id}`, width: 100, height: 100, file_size: PNG.length }],
    },
  }) as unknown as Update;

const reply = (text: string): ChatResult => ({
  text, toolCalls: [], stopReason: 'end', usage: USAGE, model: 'test-model',
});

const modelli = (principale: string[], leggero: string[]) =>
  ({
    data: [
      { id: 'solo/testo', architecture: { input_modalities: principale } },
      { id: 'vede/immagini', architecture: { input_modalities: leggero } },
    ],
  });

function harness(vista?: (percorso: string) => Promise<Vista>, cieco = true) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-vista-arr-'));
  const workspace = mkdtempSync(join(tmpdir(), 'muffin-vista-arr-ws-'));
  runInit({ home, apiKey: 'sk-vista-never-called', provider: 'openai-compat', baseUrl: BASE, mainModel: 'solo/testo', lightModel: 'vede/immagini' });
  const runtime = buildRuntime(home, workspace);
  const vaultRoot = paths(home).vault;
  mkdirSync(join(vaultRoot, 'inbox'), { recursive: true });

  vi.stubGlobal(
    'fetch',
    async (input: unknown) => {
      const url = String(input);
      if (url.includes('api.telegram.example')) return new Response(new Uint8Array(PNG));
      if (url.includes('/models')) {
        return new Response(
          JSON.stringify(modelli(cieco ? ['text'] : ['text', 'image'], ['text', 'image'])),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new TypeError('fetch failed');
    },
  );

  const seen: ChatCall[] = [];
  const provider: Provider = {
    kind: 'openai-compat',
    chat: async (call: ChatCall) => {
      seen.push(call);
      return reply('Ok.');
    },
  };
  const seenLight: ChatCall[] = [];
  const luce: Provider = {
    kind: 'openai-compat',
    chat: async (call: ChatCall) => {
      seenLight.push(call);
      return reply('un gatto sul tavolo');
    },
  };
  (runtime.light as { provider: Provider }).provider = luce;

  const api = {
    fileUrl: async () => 'https://api.telegram.example/file/bot-token/photo/x.png',
    sendMessage: async () => ({}) as never,
    editMessageText: async () => ({}) as never,
    sendChatAction: async () => true,
    sendMessageDraft: async () => true,
  } as unknown as TelegramApi;

  const connector = new TelegramConnector({
    loop: { ...runtime.deps, provider } satisfies LoopDeps,
    sessions: runtime.deps.sessions,
    lane: new ModelLane(),
    inbox: new UpdateInbox(runtime.db),
    delivery: new TelegramDeliveryStore(runtime.db),
    api,
    vault: telegramVault(runtime, paths(home).vault),
    ...(vista ? { vista } : { vista: vistaFor(runtime) }),
    config: { token: 't', ownerUserId: OWNER, ownerChatId: OWNER },
    now: () => new Date(RECEIVED_AT),
  });

  return { connector, seen, seenLight };
}

async function deliver(h: ReturnType<typeof harness>, updates: Update[]): Promise<void> {
  const inbox = (h.connector as unknown as { deps: { inbox: UpdateInbox } }).deps.inbox;
  inbox.accept(updates, RECEIVED_AT);
  await (h.connector as unknown as { drain: () => Promise<void> }).drain();
}

const transcript = (call: ChatCall): string => JSON.stringify(call.messages);
const imageParts = (call: ChatCall): unknown[] =>
  call.messages.flatMap((m) => (typeof m.content === 'string' ? [] : m.content)).filter((b) => (b as { type: string }).type === 'image');

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  // Le modalità sono memoizzate per vita del processo: senza, il `false`
  // misurato dal primo test varrebbe anche per gli altri.
  dimenticaModalita();
});

describe('il modello non vede: la foto diventa descrizione firmata', () => {
  it('la descrizione arriva al turno, nessun byte immagine parte', async () => {
    const h = harness();
    await deliver(h, [withPhoto(1)]);

    expect(h.seen).toHaveLength(1);
    expect(transcript(h.seen[0]!)).toContain('questo modello non vede le immagini');
    expect(transcript(h.seen[0]!)).toContain('vede/immagini');
    expect(transcript(h.seen[0]!)).toContain('un gatto sul tavolo');
    expect(imageParts(h.seen[0]!)).toEqual([]);
  });

  it('e il leggero ha ricevuto davvero i byte, non un riassunto', async () => {
    const h = harness();
    await deliver(h, [withPhoto(1)]);

    expect(h.seenLight).toHaveLength(1);
    expect(imageParts(h.seenLight[0]!)).toHaveLength(1);
  });
});

describe('il modello vede: i byte vanno a lui come prima', () => {
  it('nessuna descrizione, nessun giro in più', async () => {
    const h = harness(undefined, false);
    await deliver(h, [withPhoto(1)]);

    expect(h.seen).toHaveLength(1);
    expect(imageParts(h.seen[0]!)).toHaveLength(1);
    expect(transcript(h.seen[0]!)).toContain('te la sto mostrando');
    expect(h.seenLight).toHaveLength(0);
  });
});
