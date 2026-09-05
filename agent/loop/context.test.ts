import { describe, expect, it } from 'vitest';
import type { SessionMessage } from '../../core/session/store.js';
import type { Principal, TenantId } from '../../core/policy/types.js';
import type { ImageBlock, AudioBlock } from '../providers/types.js';
import type { ReinjectedHistory } from '../context/history-taint.js';
import type { TurnInput } from './types.js';
import { buildContext, media, primoMessaggio, userAudios, userImages } from './context.js';

const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };

const baseInput = (overrides: Partial<TurnInput> = {}): TurnInput => ({
  principal: owner,
  tenant: 'host' as TenantId,
  surface: 'cli',
  session: { id: 't1', file: '/dev/null' },
  text: 'ciao',
  ...overrides,
});

const image = (id: string): ImageBlock => ({ type: 'image', data: id, mediaType: 'image/png' });
const audio = (id: string): AudioBlock => ({ type: 'audio', data: id, mediaType: 'audio/ogg' });

const noHistory: ReinjectedHistory = { kept: [], dropped: 0 };

const sessionMessage = (over: Partial<SessionMessage> = {}): SessionMessage => ({
  role: 'user',
  content: 'una riga vecchia',
  surface: 'cli',
  createdAt: new Date(0).toISOString(),
  ...over,
});

describe('primoMessaggio / media', () => {
  it('puts images and audio before the text, in that order', () => {
    const input = baseInput({ images: [image('img1')], audios: [audio('aud1')], text: 'guarda qui' });
    expect(primoMessaggio(input)).toEqual([image('img1'), audio('aud1'), { type: 'text', text: 'guarda qui' }]);
  });

  it('media() is empty when neither images nor audios are present', () => {
    expect(media({})).toEqual([]);
  });
});

describe('userImages / userAudios', () => {
  it('collects images and audios from every user message, not only the last', () => {
    const messages = [
      { role: 'user' as const, content: [image('a')] },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'ok' }] },
      { role: 'user' as const, content: [image('b'), audio('c')] },
    ];
    expect(userImages(messages)).toEqual([image('a'), image('b')]);
    expect(userAudios(messages)).toEqual([audio('c')]);
  });
});

describe('buildContext', () => {
  it('MUTATION: images/audio ride before the final text block, not after', () => {
    const input = baseInput({ images: [image('foto')], text: 'cosa vedi?' });
    const messages = buildContext(input, [], [], noHistory, new Date(2026, 0, 1), 'test-model', 'test-profile', undefined, undefined, new Set());
    const last = messages[messages.length - 1]!;
    const imgIndex = last.content.findIndex((b) => b.type === 'image');
    const textIndex = last.content.findIndex((b) => b.type === 'text' && b.text === 'cosa vedi?');
    expect(imgIndex).toBeGreaterThanOrEqual(0);
    expect(textIndex).toBeGreaterThan(imgIndex);
  });

  it('MUTATION: a kept history line from a different surface is marked with the [surface] prefix', () => {
    const spoken: ReinjectedHistory = {
      kept: [sessionMessage({ surface: 'telegram', content: 'ho scritto da telefono' })],
      dropped: 0,
    };
    const input = baseInput({ surface: 'cli' });
    const messages = buildContext(input, [], [], spoken, new Date(2026, 0, 1), 'test-model', 'test-profile', undefined, undefined, new Set());
    const historyMsg = messages.find(
      (m) => m.content.some((b) => b.type === 'text' && b.text.includes('ho scritto da telefono')),
    )!;
    const block = historyMsg.content.find((b) => b.type === 'text' && b.text.includes('ho scritto da telefono'))!;
    expect(block.type).toBe('text');
    if (block.type === 'text') {
      expect(block.text).toBe('[telegram] ho scritto da telefono');
    }
  });

  it('does not mark a kept history line from the same surface as the turn', () => {
    const spoken: ReinjectedHistory = {
      kept: [sessionMessage({ surface: 'cli', content: 'stessa superficie' })],
      dropped: 0,
    };
    const input = baseInput({ surface: 'cli' });
    const messages = buildContext(input, [], [], spoken, new Date(2026, 0, 1), 'test-model', 'test-profile', undefined, undefined, new Set());
    const block = messages
      .flatMap((m) => m.content)
      .find((b) => b.type === 'text' && b.text.includes('stessa superficie'))!;
    expect(block.type).toBe('text');
    if (block.type === 'text') expect(block.text).toBe('stessa superficie');
  });

  it('announces how many prior messages were dropped, when any were', () => {
    const spoken: ReinjectedHistory = { kept: [], dropped: 3 };
    const messages = buildContext(baseInput(), [], [], spoken, new Date(2026, 0, 1), 'm', 'p', undefined, undefined, new Set());
    const announce = messages[0]!.content[0]!;
    expect(announce.type).toBe('text');
    if (announce.type === 'text') expect(announce.text).toContain('3 messaggi precedenti');
  });

  it('marks an assistant line whose trace was undone by `muffin undo`', () => {
    const spoken: ReinjectedHistory = {
      kept: [sessionMessage({ role: 'assistant', surface: 'cli', content: 'ho scritto nota.md', traceId: 'trace-1' })],
      dropped: 0,
    };
    const messages = buildContext(
      baseInput(),
      [],
      [],
      spoken,
      new Date(2026, 0, 1),
      'm',
      'p',
      undefined,
      undefined,
      new Set(['trace-1']),
    );
    const block = messages.flatMap((m) => m.content).find((b) => b.type === 'text' && b.text.includes('ho scritto nota.md'))!;
    expect(block.type).toBe('text');
    if (block.type === 'text') expect(block.text).toContain('muffin undo');
  });

  it('carries the recalled memory blocks ahead of the environment text', () => {
    const recalled = [{ type: 'text' as const, text: '[ricordo] qualcosa' }];
    const messages = buildContext(baseInput(), recalled, [], noHistory, new Date(2026, 0, 1), 'm', 'p', undefined, undefined, new Set());
    const last = messages[messages.length - 1]!;
    expect(last.content[0]).toEqual(recalled[0]);
  });
});
