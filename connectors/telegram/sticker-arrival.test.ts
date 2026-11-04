import type { Update } from '@grammyjs/types';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
import { TelegramConnector } from './connector.js';
import { ModelLane } from '../../core/turns/model-lane.js';
import type { TelegramApi } from './api.js';
import { UpdateInbox } from './updates.js';
import { TelegramDeliveryStore } from './delivery.js';

/**
 * Uno sticker mandato al bot, per intero, nei tre formati che Telegram serve.
 *
 * Il messaggio non dice il formato — lo dicono i byte dopo il download — e
 * prima di questa slice uno sticker cadeva nel silenzio totale: nessun turno,
 * nessuna riga, nessun log. Sotto c'è il montaggio di produzione (buildRuntime,
 * vault vero, vera `vistaFor`); finti sono i due modelli, la rete e `ffmpeg`.
 *
 * - webp statico: un'immagine come le altre, e se il modello non ci vede vale
 *   la stessa descrizione firmata delle foto;
 * - webm video: un fotogramma col ffmpeg (finto qui), e il fotogramma fa la
 *   strada delle immagini;
 * - tgs animato: niente in casa lo renderizza, e la riga lo dice col rimedio.
 */

const OWNER = 4242;
const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const RECEIVED_AT = '2026-10-02T12:00:00.000Z';
const BASE = 'https://openrouter.example.test/api/v1';

const WEBP = Buffer.concat([Buffer.from('RIFF1234WEBP', 'latin1'), Buffer.alloc(512)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(512)]);
const TGS = Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.alloc(512)]);

const withSticker = (id: number, bytes: Buffer): Update =>
  ({
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: OWNER, type: 'private' },
      from: { id: OWNER, is_bot: false, first_name: 'o' },
      sticker: { file_id: `s${id}`, file_unique_id: `u${id}`, width: 512, height: 512, is_animated: false, is_video: false, file_size: bytes.length },
    },
  }) as unknown as Update;

const reply = (text: string): ChatResult => ({
  text, toolCalls: [], stopReason: 'end', usage: USAGE, model: 'test-model',
});

function harness(stickerBytes: Buffer, cieco = true) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-sticker-arr-'));
  const workspace = mkdtempSync(join(tmpdir(), 'muffin-sticker-arr-ws-'));
  runInit({ home, apiKey: 'sk-sticker-never-called', provider: 'openai-compat', baseUrl: BASE, mainModel: 'solo/testo', lightModel: 'vede/immagini' });
  const runtime = buildRuntime(home, workspace);
  const vaultRoot = paths(home).vault;
  mkdirSync(join(vaultRoot, 'inbox'), { recursive: true });

  vi.stubGlobal(
    'fetch',
    async (input: unknown) => {
      const url = String(input);
      if (url.includes('api.telegram.example')) return new Response(new Uint8Array(stickerBytes));
      if (url.includes('/models')) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'solo/testo', architecture: { input_modalities: cieco ? ['text'] : ['text', 'image'] } },
              { id: 'vede/immagini', architecture: { input_modalities: ['text', 'image'] } },
            ],
          }),
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
      return reply('un gatto col cappello');
    },
  };
  (runtime.light as { provider: Provider }).provider = luce;

  const api = {
    fileUrl: async () => 'https://api.telegram.example/file/bot-token/sticker/x.webp',
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
    vault: telegramVault(runtime, vaultRoot),
    vista: vistaFor(runtime),
    config: { token: 't', ownerUserId: OWNER, ownerChatId: OWNER },
    now: () => new Date(RECEIVED_AT),
  });

  return { connector, seen, seenLight };
}

/** Un `ffmpeg` finto che scrive un PNG dovunque gli si chiede l'uscita. */
function fakeFfmpeg(): { dir: string; prima: string | undefined; ripristina: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-fake-ffmpeg-'));
  const bin = join(dir, 'ffmpeg');
  writeFileSync(
    bin,
    '#!/bin/sh\nultimo=""; for a in "$@"; do ultimo="$a"; done\nprintf \'\\211\\120\\116\\107\\015\\012\\032\\012\' > "$ultimo"\nhead -c 64 /dev/zero >> "$ultimo"\n',
  );
  chmodSync(bin, 0o755);
  const prima = process.env.PATH;
  process.env.PATH = `${dir}:${prima ?? ''}`;
  return { dir, prima, ripristina: () => {
    if (prima === undefined) delete process.env.PATH;
    else process.env.PATH = prima;
  } };
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
  dimenticaModalita();
});

describe('sticker webp: una foto come le altre', () => {
  it('il modello che vede riceve i byte', async () => {
    const h = harness(WEBP, false);
    await deliver(h, [withSticker(1, WEBP)]);

    expect(h.seen).toHaveLength(1);
    expect(imageParts(h.seen[0]!)).toHaveLength(1);
    expect(transcript(h.seen[0]!)).toContain('te la sto mostrando');
    expect(h.seenLight).toHaveLength(0);
  });

  it('il modello cieco riceve la descrizione firmata, non i byte', async () => {
    const h = harness(WEBP, true);
    await deliver(h, [withSticker(1, WEBP)]);

    expect(h.seen).toHaveLength(1);
    expect(transcript(h.seen[0]!)).toContain('questo modello non vede le immagini');
    expect(transcript(h.seen[0]!)).toContain('un gatto col cappello');
    expect(imageParts(h.seen[0]!)).toEqual([]);
  });
});

describe('sticker webm: un fotogramma fa la strada delle immagini', () => {
  it('il fotogramma arriva al modello che vede, e il nome dice cos\u2019è', async () => {
    const finto = fakeFfmpeg();
    try {
      const h = harness(WEBM, false);
      await deliver(h, [withSticker(1, WEBM)]);

      expect(h.seen).toHaveLength(1);
      expect(imageParts(h.seen[0]!)).toHaveLength(1);
      expect(transcript(h.seen[0]!)).toContain('sticker-frame');
    } finally {
      finto.ripristina();
    }
  });
});

describe('sticker tgs: niente in casa lo apre, e lo si dice', () => {
  it('il turno gira lo stesso, con la riga e il rimedio', async () => {
    const h = harness(TGS, true);
    await deliver(h, [withSticker(1, TGS)]);

    expect(h.seen).toHaveLength(1);
    const testo = transcript(h.seen[0]!);
    expect(testo).toContain('non apribile');
    expect(testo).toContain('animato');
    expect(testo).toContain('screenshot');
    expect(imageParts(h.seen[0]!)).toEqual([]);
    expect(h.seenLight).toHaveLength(0);
  });
});
