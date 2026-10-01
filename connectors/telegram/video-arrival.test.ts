import type { Update } from '@grammyjs/types';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dimenticaModalita } from '../../agent/providers/modalita.js';
import { buildRuntime } from '../../agent/runtime.js';
import type { LoopDeps } from '../../agent/loop.js';
import type { AudioBlock, ChatCall, ChatResult, Provider } from '../../agent/providers/types.js';
import { runInit } from '../../cli/init.js';
import { telegramVault, vistaFor } from '../../cli/surface.js';
import { paths } from '../../core/config/config.js';
import type { Voce } from '../../core/audio/voce.js';
import { TelegramConnector } from './connector.js';
import { ModelLane } from '../../core/turns/model-lane.js';
import type { TelegramApi } from './api.js';
import { UpdateInbox } from './updates.js';
import { TelegramDeliveryStore } from './delivery.js';

/**
 * Un video mandato al bot, per intero: un fotogramma per gli occhi e
 * l'audio per le orecchie, composti in un solo arrivo.
 *
 * Sotto c'è il montaggio di produzione — `buildRuntime`, il vault vero, la
 * vera `vistaFor`; finti sono i due modelli, la rete, `ffmpeg` e la voce
 * (iniettata come nei test delle note vocali).
 *
 * La cosa che questi test tengono chiusa è che le due metà falliscano da
 * sole: un fotogramma che non si apre non cancella la trascrizione e
 * viceversa — e il turno gira comunque, sapendo cosa ha e cosa gli manca.
 */

const OWNER = 4242;
const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const RECEIVED_AT = '2026-10-02T12:00:00.000Z';
const BASE = 'https://openrouter.example.test/api/v1';

/** Un mp4 riconoscibile dall'intestazione: `tipoAudio` guarda `ftyp` all'offset 4. */
const MP4 = Buffer.concat([Buffer.from('xxxxftyp', 'latin1'), Buffer.alloc(512)]);

const withVideo = (id: number): Update =>
  ({
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: OWNER, type: 'private' },
      from: { id: OWNER, is_bot: false, first_name: 'o' },
      video: { file_id: `v${id}`, file_unique_id: `u${id}`, width: 100, height: 100, duration: 5, file_size: MP4.length },
    },
  }) as unknown as Update;

const reply = (text: string): ChatResult => ({
  text, toolCalls: [], stopReason: 'end', usage: USAGE, model: 'test-model',
});

function harness(voce: (percorso: string) => Promise<Voce>, cieco = true) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-video-arr-'));
  const workspace = mkdtempSync(join(tmpdir(), 'muffin-video-arr-ws-'));
  runInit({ home, apiKey: 'sk-video-never-called', provider: 'openai-compat', baseUrl: BASE, mainModel: 'solo/testo', lightModel: 'vede/immagini' });
  const runtime = buildRuntime(home, workspace);
  const vaultRoot = paths(home).vault;
  mkdirSync(join(vaultRoot, 'inbox'), { recursive: true });

  vi.stubGlobal(
    'fetch',
    async (input: unknown) => {
      const url = String(input);
      if (url.includes('api.telegram.example')) return new Response(new Uint8Array(MP4));
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
      return reply('una strada di sera');
    },
  };
  (runtime.light as { provider: Provider }).provider = luce;

  const api = {
    fileUrl: async () => 'https://api.telegram.example/file/bot-token/video/x.mp4',
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
    voce,
    vista: vistaFor(runtime),
    config: { token: 't', ownerUserId: OWNER, ownerChatId: OWNER },
    now: () => new Date(RECEIVED_AT),
  });

  return { connector, seen, seenLight };
}

/** Un `ffmpeg` finto che scrive un PNG dovunque gli si chiede l'uscita. */
function fakeFfmpeg(): { ripristina: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-fake-ffmpeg-'));
  const bin = join(dir, 'ffmpeg');
  writeFileSync(
    bin,
    '#!/bin/sh\nultimo=""; for a in "$@"; do ultimo="$a"; done\nprintf \'\\211\\120\\116\\107\\015\\012\\032\\012\' > "$ultimo"\nhead -c 64 /dev/zero >> "$ultimo"\n',
  );
  chmodSync(bin, 0o755);
  const prima = process.env.PATH;
  process.env.PATH = `${dir}:${prima ?? ''}`;
  return { ripristina: () => {
    if (prima === undefined) delete process.env.PATH;
    else process.env.PATH = prima;
  } };
}

const trascritto = async (): Promise<Voce> => ({ modo: 'trascritto', testo: 'che bella strada' });

async function deliver(h: ReturnType<typeof harness>, updates: Update[]): Promise<void> {
  const inbox = (h.connector as unknown as { deps: { inbox: UpdateInbox } }).deps.inbox;
  inbox.accept(updates, RECEIVED_AT);
  await (h.connector as unknown as { drain: () => Promise<void> }).drain();
}

const transcript = (call: ChatCall): string => JSON.stringify(call.messages);
const blocchi = (call: ChatCall, tipo: string): unknown[] =>
  call.messages.flatMap((m) => (typeof m.content === 'string' ? [] : m.content)).filter((b) => (b as { type: string }).type === tipo);

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  dimenticaModalita();
});

describe('un video: fotogramma agli occhi, trascrizione alle orecchie', () => {
  it("il turno ha l'immagine del fotogramma e il testo trascritto", async () => {
    const finto = fakeFfmpeg();
    try {
      const h = harness(trascritto, false);
      await deliver(h, [withVideo(1)]);

      expect(h.seen).toHaveLength(1);
      expect(blocchi(h.seen[0]!, 'image')).toHaveLength(1);
      expect(transcript(h.seen[0]!)).toContain('video-frame');
      expect(transcript(h.seen[0]!)).toContain('che bella strada');
      expect(transcript(h.seen[0]!)).toContain('parole dette nel video');
    } finally {
      finto.ripristina();
    }
  });

  it('con ascolto diretto l audio va al modello come blocco', async () => {
    const finto = fakeFfmpeg();
    try {
      const blocco: AudioBlock = { type: 'audio', mediaType: 'audio/mp4', data: 'ZnlwZQ==' };
      const h = harness(async () => ({ modo: 'ascolta', blocco }), false);
      await deliver(h, [withVideo(1)]);

      expect(blocchi(h.seen[0]!, 'image')).toHaveLength(1);
      expect(blocchi(h.seen[0]!, 'audio')).toEqual([blocco]);
    } finally {
      finto.ripristina();
    }
  });

  it('il modello cieco riceve il fotogramma descritto e firmato', async () => {
    const finto = fakeFfmpeg();
    try {
      const h = harness(trascritto, true);
      await deliver(h, [withVideo(1)]);

      expect(blocchi(h.seen[0]!, 'image')).toEqual([]);
      expect(transcript(h.seen[0]!)).toContain('questo modello non vede le immagini');
      expect(transcript(h.seen[0]!)).toContain('una strada di sera');
      expect(transcript(h.seen[0]!)).toContain('che bella strada');
    } finally {
      finto.ripristina();
    }
  });

  it('fotogramma che non si apre: la riga lo dice, la trascrizione resta', async () => {
    // Senza ffmpeg nel PATH il fotogramma fallisce; la voce finta copre l'audio.
    const h = harness(trascritto);
    await deliver(h, [withVideo(1)]);

    expect(blocchi(h.seen[0]!, 'image')).toEqual([]);
    expect(transcript(h.seen[0]!)).toContain('fotogramma non si apre');
    expect(transcript(h.seen[0]!)).toContain('che bella strada');
  });
});
