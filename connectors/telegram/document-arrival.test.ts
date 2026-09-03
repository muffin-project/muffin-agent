import DatabaseCtor from 'better-sqlite3';
import type { Update } from '@grammyjs/types';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRuntime } from '../../agent/runtime.js';
import type { LoopDeps } from '../../agent/loop.js';
import type { ChatCall, ChatResult, Provider } from '../../agent/providers/types.js';
import { runInit } from '../../cli/init.js';
import { telegramVault } from '../../cli/surface.js';
import { paths } from '../../core/config/config.js';
import { buildPdf, pagesWithoutText } from '../../core/documents/fixtures/pdf.js';
import { TelegramConnector } from './connector.js';
import type { TelegramApi } from './api.js';
import { UpdateInbox } from './updates.js';
import { TelegramDeliveryStore } from './delivery.js';

/**
 * The acceptance scenario, run the way the owner runs it: a PDF sent to the bot.
 *
 * DAY-1 requirement C7 was `BLOCKER — nessun parser`, and the sentence under it is the
 * one this file has to falsify: *"un PDF che arriva su Telegram viene salvato e
 * mai indicizzato"*. Every layer below the connector is the production assembly
 * — `buildRuntime`, the real vault, the real tools, the real kernel. Only the
 * model and the network are replaced, because the alternative is a paid call and
 * a download.
 *
 * Two properties, and they are the two halves of the owner's directive. The
 * document goes in **whole**, so the last page is recallable; and the turn is
 * handed a **compact view with a way back in**, so answering a question about
 * page two does not cost eighty pages of context. A test for either one alone
 * would pass on a design that gets the other backwards.
 */

const OWNER = 4242;
const GROUP = -100200;
const OTHER_GROUP = -100201;
const STRANGER = 9999;
const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
// The vault path includes the receipt day. Pin it: a fixture whose tool call
// says 2026-08-15 must not start failing only because the wall clock crossed
// midnight. Production still receives the real timestamp from UpdateInbox.
const RECEIVED_AT = '2026-08-15T12:00:00.000Z';

const CONTRATTO = buildPdf({
  title: 'Contratto',
  pages: [
    ['Contratto di locazione', 'fra le parti sottoscritte'],
    ['Canone mensile 850 euro', 'da versare entro il cinque'],
    ['Recesso con preavviso di tre mesi'],
  ],
});

const withDocument = (
  id: number,
  name: string,
  sender: { chatId: number; fromId: number; type: 'private' | 'supergroup' } = {
    chatId: OWNER,
    fromId: OWNER,
    type: 'private',
  },
): Update =>
  ({
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: sender.chatId, type: sender.type },
      from: { id: sender.fromId, is_bot: false, first_name: 'o' },
      caption: 'tieni questo',
      document: { file_id: `f${id}`, file_unique_id: `u${id}`, file_name: name, file_size: 4096 },
    },
  }) as unknown as Update;

const reply = (text: string): ChatResult => ({
  text, toolCalls: [], stopReason: 'end', usage: USAGE, model: 'test-model',
});
const callDocumentRead = (args: Record<string, unknown>): ChatResult => ({
  text: null,
  toolCalls: [{ id: 'c1', name: 'document_read', args }],
  stopReason: 'tool_use',
  usage: USAGE,
  model: 'test-model',
});

function harness(bytes: Buffer | Buffer[], script: ChatResult[] = []) {
  // Una home della forma di produzione (`~/.muffin`): il segmento col punto è
  // ciò che rendeva questo test verde mentre l'ingest reale rifiutava tutto.
  const home = join(mkdtempSync(join(tmpdir(), 'muffin-docarr-')), '.muffin');
  mkdirSync(home, { recursive: true });
  const workspace = mkdtempSync(join(tmpdir(), 'muffin-docarr-ws-'));
  runInit({ home, apiKey: 'sk-docarr-never-called' });
  const runtime = buildRuntime(home, workspace);
  const vaultRoot = paths(home).vault;
  mkdirSync(join(vaultRoot, 'inbox'), { recursive: true });

  // The download, without the network. `downloadToVault` asks the API for a URL
  // and then fetches it; both are stubbed and nothing else about the path is.
  //
  // Only that URL. Every other outbound call fails, which is not laziness — it
  // is the ordinary state of a fresh install: no embedder is running, so
  // `reindex` reaches one that refuses the connection. A stub that answered
  // everything would have hidden the bug this test found, where a down embedder
  // made the connector report `[allegato NON ricevuto]` over a document it had
  // just indexed in full.
  let download = 0;
  vi.stubGlobal('fetch', async (input: unknown) => {
    if (String(input).includes('api.telegram.example')) {
      const body = Array.isArray(bytes) ? bytes[download++] : bytes;
      if (!body) throw new TypeError('unexpected extra download');
      return new Response(new Uint8Array(body));
    }
    throw new TypeError('fetch failed');
  });

  const seen: ChatCall[] = [];
  let step = 0;
  const provider: Provider = {
    kind: 'openai-compat',
    chat: async (call: ChatCall) => {
      seen.push(call);
      return script[step++] ?? reply('Ok.');
    },
  };

  const api = {
    fileUrl: async () => 'https://api.telegram.example/file/bot-token/documents/x.pdf',
    sendMessage: async () => ({}) as never,
    editMessageText: async () => ({}) as never,
    sendChatAction: async () => true,
    sendMessageDraft: async () => true,
  } as unknown as TelegramApi;

  const connector = new TelegramConnector({
    loop: { ...runtime.deps, provider } satisfies LoopDeps,
    sessions: runtime.deps.sessions,
    inbox: new UpdateInbox(runtime.db),
    delivery: new TelegramDeliveryStore(runtime.db),
    api,
    // Exactly the wiring `cli/surface.ts` builds, including the runtime's own
    // vault — a connector indexing into a second root would produce documents
    // `document_read` cannot open, and every assertion below would still pass
    // if this test built its own.
    vault: telegramVault(runtime, vaultRoot),
    config: { token: 't', ownerUserId: OWNER, ownerChatId: OWNER },
    now: () => new Date(RECEIVED_AT),
  });

  return { connector, seen, runtime, vaultRoot };
}

async function deliver(h: ReturnType<typeof harness>, updates: Update[]): Promise<void> {
  const inbox = (h.connector as unknown as { deps: { inbox: UpdateInbox } }).deps.inbox;
  inbox.accept(updates, RECEIVED_AT);
  await (h.connector as unknown as { drain: () => Promise<void> }).drain();
}

/** Everything the model was actually shown this turn, tool results included. */
const transcript = (call: ChatCall): string => JSON.stringify(call.messages);

/**
 * Only what a tool handed back.
 *
 * Separated from `transcript` on purpose: the turn's own recall also carries
 * chunks of the same document, so asserting "the portion did not include page
 * three" against the whole transcript would be asserting something about recall
 * instead of about the drill-down.
 */
const toolResults = (call: ChatCall): string =>
  JSON.stringify(
    call.messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content.filter((c) => c.type === 'tool_result') : [],
    ),
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a PDF sent to the bot', () => {
  it('is indexed whole — the last page answers a search, not only the first', async () => {
    const h = harness(CONTRATTO);
    try {
      await deliver(h, [withDocument(1, 'contratto.pdf')]);

      // Page three, and specifically as a **document** episode: the turn's own
      // message quotes the index, so a search alone would match the outline and
      // report success over a document that was never indexed. This asks for
      // the chunk.
      const store = h.runtime.memory.store;
      const documentHits = (needle: string) =>
        store
          .searchEpisodes('host', needle)
          .map((hit) => store.episodeById('host', hit.id))
          .filter((e) => e?.kind === 'document');

      expect(documentHits('preavviso')).toHaveLength(1);
      expect(documentHits('preavviso')[0]?.content).toContain('p. 3');
      expect(documentHits('Canone')).toHaveLength(1);
    } finally {
      h.runtime.close();
    }
  });

  it('hands the turn an index and the way back in, not eighty pages', async () => {
    const h = harness(CONTRATTO);
    try {
      await deliver(h, [withDocument(2, 'contratto.pdf')]);
      expect(h.seen).toHaveLength(1);

      const text = transcript(h.seen[0]!);
      expect(text).toContain('3 pagine');
      expect(text).toContain('acquisito per intero');
      expect(text).toContain('document_read');
      // The caption is still a message: the file did not swallow what was said
      // with it.
      expect(text).toContain('tieni questo');
    } finally {
      h.runtime.close();
    }
  });

  it('lets the model open a page and get the document’s own words', async () => {
    // The whole point of the pair. The first turn sees the index; the model asks
    // for page two; what comes back is the text of page two, from the file.
    const h = harness(CONTRATTO, [
      callDocumentRead({ path: 'inbox/2026-08-15-3-contratto.pdf', da: 2 }),
      reply('Il canone è 850 euro al mese.'),
    ]);
    try {
      await deliver(h, [withDocument(3, 'contratto.pdf')]);
      expect(h.seen.length).toBeGreaterThanOrEqual(2);

      const returned = toolResults(h.seen[1]!);
      expect(returned).toContain('Canone mensile 850 euro');
      expect(returned).toContain('[p. 2]');
      // The portion is the range asked for and nothing else. A drill-down that
      // quietly returned the whole document would satisfy every other assertion
      // here and cost exactly what the compact view exists to save.
      expect(returned).not.toContain('preavviso di tre mesi');
    } finally {
      h.runtime.close();
    }
  });

  it('says a scan is a scan, in the turn, instead of pretending it read it', async () => {
    // The failure path, on the real route. An extractor that returned the empty
    // string here would produce "ricevuto e indicizzato" over a document with
    // nothing in it, and the owner would find out by asking a question about it.
    const h = harness(pagesWithoutText(5));
    try {
      await deliver(h, [withDocument(4, 'scansione.pdf')]);

      const text = transcript(h.seen[0]!);
      expect(text).toContain('non indicizzato');
      expect(text).toContain('OCR');
      expect(text).toContain('5 pagine');
    } finally {
      h.runtime.close();
    }
  });

  it('keeps a group document in the group tenant and lets that turn reopen it', async () => {
    const path = 'inbox/2026-08-15-5-contratto.pdf';
    const tenant = `group:telegram:${GROUP}`;
    const h = harness(CONTRATTO, [
      callDocumentRead({ path, da: 2 }),
      reply('Nel gruppo: canone 850 euro.'),
    ]);
    try {
      await deliver(h, [
        withDocument(5, 'contratto.pdf', { chatId: GROUP, fromId: STRANGER, type: 'supergroup' }),
      ]);

      const store = h.runtime.memory.store;
      const groupDocuments = store.searchEpisodes(tenant, 'Canone')
        .map((hit) => store.episodeById(tenant, hit.id))
        .filter((episode) => episode?.kind === 'document');
      expect(groupDocuments).toHaveLength(1);
      expect(store.searchEpisodes('host', 'Canone')).toHaveLength(0);
      expect(await h.runtime.vault.document('host', path)).toBeNull();

      const returned = toolResults(h.seen[1]!);
      expect(returned).toContain('Canone mensile 850 euro');
      expect(returned).toContain('[p. 2]');
    } finally {
      h.runtime.close();
    }
  });

  it('indexes only the arriving file, never the shared vault or another group attachment', async () => {
    const otherDocument = buildPdf({ pages: [['SECONDOSEGRETO appartiene soltanto all’altro gruppo']] });
    const h = harness([otherDocument, CONTRATTO]);
    const hostPath = 'privato-owner.md';
    const otherPath = 'inbox/2026-08-15-6-altro.pdf';
    const groupPath = 'inbox/2026-08-15-7-contratto.pdf';
    const tenant = `group:telegram:${GROUP}`;
    const otherTenant = `group:telegram:${OTHER_GROUP}`;
    try {
      writeFileSync(join(h.vaultRoot, hostPath), '# Privato\n\nOWNERSEGRETO resta privato.\n');
      await h.runtime.vault.reindexPath('host', hostPath);

      await deliver(h, [
        withDocument(6, 'altro.pdf', { chatId: OTHER_GROUP, fromId: STRANGER, type: 'supergroup' }),
      ]);
      await deliver(h, [
        withDocument(7, 'contratto.pdf', { chatId: GROUP, fromId: STRANGER, type: 'supergroup' }),
      ]);

      const store = h.runtime.memory.store;
      expect(store.searchEpisodes('host', 'OWNERSEGRETO')).toHaveLength(1);
      expect(store.searchEpisodes('host', 'SECONDOSEGRETO')).toHaveLength(0);
      expect(store.searchEpisodes('host', 'Canone')).toHaveLength(0);

      expect(store.searchEpisodes(otherTenant, 'SECONDOSEGRETO').length).toBeGreaterThan(0);
      expect(store.searchEpisodes(otherTenant, 'OWNERSEGRETO')).toHaveLength(0);
      expect(store.searchEpisodes(otherTenant, 'Canone')).toHaveLength(0);

      expect(store.searchEpisodes(tenant, 'Canone').length).toBeGreaterThan(0);
      expect(store.searchEpisodes(tenant, 'OWNERSEGRETO')).toHaveLength(0);
      expect(store.searchEpisodes(tenant, 'SECONDOSEGRETO')).toHaveLength(0);

      expect(await h.runtime.vault.document('host', groupPath)).toBeNull();
      expect(await h.runtime.vault.document(tenant, otherPath)).toBeNull();
      expect(await h.runtime.vault.document(otherTenant, groupPath)).toBeNull();
    } finally {
      h.runtime.close();
    }
  });
});

/**
 * Una foto mandata al bot, sulla stessa rotta vera del PDF.
 *
 * B10 diceva: «immagini bloccate: scaricate ma mai indicizzate
 * (`core/vault/vault.ts` le salta) e nessun content-block immagine verso il
 * provider». La prima metà non è un difetto e non va riparata — un'immagine
 * **non si indicizza come testo**, si mostra. Il difetto era che finiva lì: il
 * modello riceveva `[ricevuto … ma non indicizzato: non è testo né PDF né
 * DOCX]` su una foto perfettamente visibile.
 *
 * Il PNG è generato qui e non è un fixture opaco: sono i quattro byte di
 * intestazione che `loadImage` deve riconoscere, e il test controlla che il
 * **tipo lo decidano i byte** mandando l'immagine con estensione `.pdf`, che è
 * il caso vero — su Telegram il nome del file lo sceglie il mittente.
 */
const PNG_1x1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478' +
    '9c6300010000050001' +
    '0d0a2db40000000049454e44ae426082',
  'hex',
);

const withPhoto = (id: number, name: string): Update =>
  ({
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: OWNER, type: 'private' },
      from: { id: OWNER, is_bot: false, first_name: 'o' },
      caption: 'che cos è questa?',
      document: { file_id: `f${id}`, file_unique_id: `u${id}`, file_name: name, file_size: PNG_1x1.length },
    },
  }) as unknown as Update;

/** I blocchi immagine che il provider ha davvero ricevuto in questa chiamata. */
const immagini = (call: ChatCall) => call.messages.flatMap((m) => m.content).filter((b) => b.type === 'image');

describe('una foto mandata al bot', () => {
  it('arriva al modello come immagine, non come «non indicizzato»', async () => {
    const h = harness(PNG_1x1);
    try {
      await deliver(h, [withPhoto(20, 'foto.png')]);
      expect(h.seen).toHaveLength(1);

      const viste = immagini(h.seen[0]!);
      expect(viste).toHaveLength(1);
      expect(viste[0]).toMatchObject({ type: 'image', mediaType: 'image/png' });
      // E i byte sono quelli del file, non un placeholder.
      expect(Buffer.from((viste[0] as { data: string }).data, 'base64').equals(PNG_1x1)).toBe(true);
    } finally {
      h.runtime.close();
    }
  });

  it("e la riga di arrivo lo dice, invece di scusarsi per non averla indicizzata", async () => {
    const h = harness(PNG_1x1);
    try {
      await deliver(h, [withPhoto(21, 'foto.png')]);
      const text = transcript(h.seen[0]!);
      expect(text).toContain('immagine ricevuta');
      expect(text).not.toContain('non indicizzato');
      // La didascalia resta un messaggio: il file non si è mangiato ciò che è
      // stato detto insieme a lui.
      expect(text).toContain('che cos è questa?');
    } finally {
      h.runtime.close();
    }
  });

  /**
   * **Il tipo lo dicono i byte.** Il nome del file arriva dal mittente, quindi
   * non decide niente: un PNG chiamato `.pdf` resta un PNG.
   */
  it("un'estensione che mente non la nasconde al modello", async () => {
    const h = harness(PNG_1x1);
    try {
      await deliver(h, [withPhoto(22, 'travestita.pdf')]);
      const viste = immagini(h.seen[0]!);
      expect(viste).toHaveLength(1);
      expect(viste[0]).toMatchObject({ mediaType: 'image/png' });
    } finally {
      h.runtime.close();
    }
  });

  /** E un PDF resta un documento: la strada nuova non ruba quella vecchia. */
  it('un PDF continua ad arrivare come documento, non come immagine', async () => {
    const h = harness(CONTRATTO);
    try {
      await deliver(h, [withDocument(23, 'contratto.pdf')]);
      expect(immagini(h.seen[0]!)).toHaveLength(0);
      expect(transcript(h.seen[0]!)).toContain('acquisito per intero');
    } finally {
      h.runtime.close();
    }
  });
});
