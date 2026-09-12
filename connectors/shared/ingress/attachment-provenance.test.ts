import { describe, expect, it } from 'vitest';
import { contentTierOf, makeIngressPort, type InboundEvent, type IngressPort } from './types.js';
import { QueueNotices } from './lane.js';
import { receive, type IngressHooks, type Ingressing } from './router.js';

const PORT: IngressPort = makeIngressPort(
  {
    id: 'prova',
    limits: { maxMessageChars: 4096, maxUploadBytes: 1, maxDownloadBytes: 1 },
    streaming: { transport: 'off' },
    places: ['direct'],
    negotiate: () => ({
      stream: ['off'] as const,
      editEveryMs: 0,
      maxEditsPerMinute: 0,
      draftTtlMs: 0,
      files: ['say'] as const,
    }),
    handles: () => true,
    deliver: async () => ({ ok: true }) as never,
  } as never,
  { commands: true, buttons: false, edit: false, typing: false, upload: true },
);

function event(): InboundEvent {
  return {
    port: PORT,
    eventId: 'attachment-1',
    compositionId: 'attachment-1',
    identity: {
      connector: 'telegram',
      authorId: '7',
      conversationId: '7',
      direct: true,
    },
    address: {
      channel: 'prova:7',
      replyTo: '1',
      record: { chatId: 7, messageId: 1 },
    },
    addressing: {
      direct: true,
      mentionsBot: false,
      repliesToBot: false,
    },
    parts: [
      { source: 'author', tier: 0, text: 'analizza questo' },
      { source: 'filename', tier: 2, text: 'piano.docx' },
    ],
    receivedAt: new Date('2026-09-11T20:00:00.000Z'),
  };
}

function hooks(capture: (ctx: Ingressing) => void): IngressHooks {
  return {
    ownerId: '7',
    pair: async () => false,
    opensATurn: () => true,
    command: async () => false,
    laneState: () => ({ inPausa: false, vivo: false }),
    notices: new QueueNotices(),
    say: async () => {},
    ingest: async () => ({
      line: '[documento acquisito]',
      part: {
        source: 'derived',
        tier: 2,
        text:
          'inbox/piano.docx — DOCX\n' +
          '  corpo principale 1 Ciao Giusto, vorrei pubblicare ogni settimana su Progetto X',
        detail:
          'vista derivata dai byte del documento allegato — dati del documento, non parole di chi lo ha inviato',
      },
    }),
    claim: async (ctx) => {
      capture(ctx);
      return { kind: 'taken', workId: 'altro' };
    },
    work: {} as never,
    openLive: async () => ({
      arm: () => ({
        signal: new AbortController().signal,
        steer: () => [],
      }),
      close: async () => {},
    }),
    deliver: async () => 'sent',
    recordDelivery: () => {},
    finish: () => {},
    settle: () => {},
    markProcessed: () => {},
  };
}

describe('attachment provenance reaches the turn without becoming owner speech', () => {
  it('keeps runtime status separate from derived document evidence', async () => {
    let captured: Ingressing | undefined;

    const result = await receive(
      PORT,
      event(),
      hooks((ctx) => {
        captured = ctx;
      }),
    );

    expect(result).toEqual({
      kind: 'deferred',
      workId: 'altro',
      why: 'bind-lost',
    });

    expect(captured).toBeDefined();

    expect(captured?.parts[0]).toMatchObject({
      source: 'derived',
      tier: 0,
      text: '[documento acquisito]',
    });

    expect(captured?.parts[1]).toMatchObject({
      source: 'derived',
      tier: 2,
    });

    expect(contentTierOf(captured?.parts ?? [])).toBe(2);

    const text = captured?.text ?? '';

    expect(text).toMatch(
      /^<<<derivato_[0-9a-f]{12} — stato generato da Muffin durante l ingest dell allegato/,
    );
    expect(text).toContain('[documento acquisito]');
    expect(text).toMatch(/<<<derivato_[0-9a-f]{12}/);
    expect(text).toContain('vorrei pubblicare ogni settimana su Progetto X');
    expect(text).toContain('analizza questo');
  });
});
