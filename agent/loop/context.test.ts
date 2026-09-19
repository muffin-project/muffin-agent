import { describe, expect, it } from 'vitest';
import type { SessionMessage } from '../../core/session/store.js';
import type { Principal, TenantId } from '../../core/policy/types.js';
import type { TodoItem } from '../../core/turns/todo.js';
import type { ContentBlock, ImageBlock, AudioBlock } from '../providers/types.js';
import type { ReinjectedHistory } from '../context/history-taint.js';
import type { TurnInput } from './types.js';
import { assembleSemantic, buildContext, describeAssembly, media, primoMessaggio, userAudios, userImages } from './context.js';

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

  it('memory rides in its own evidence message, ahead of the owner input', () => {
    const recalled = [{ type: 'text' as const, text: '[ricordo] qualcosa' }];
    const messages = buildContext(baseInput(), recalled, [], noHistory, new Date(2026, 0, 1), 'm', 'p', undefined, undefined, new Set());
    const memory = messages.find((m) => m.origin === 'memory')!;
    expect(memory.content[0]).toEqual(recalled[0]);
    const ownerIndex = messages.findIndex((m) => m.origin === 'owner');
    expect(messages.indexOf(memory)).toBeLessThan(ownerIndex);
  });
});

const openPlan: TodoItem[] = [
  {
    seq: 1,
    text: 'passo del piano',
    state: 'pending',
    note: null,
    tier: 0,
    dueAt: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  },
];

const textOf = (content: ContentBlock[]): string =>
  content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

describe('P0 provenance · current owner input is isolated', () => {
  const recalled = [{ type: 'text' as const, text: '[ricordo] UNICOMEMORIA' }];

  function built(text = 'DOMANDA-OWNER') {
    return buildContext(
      baseInput({ text }),
      recalled,
      openPlan,
      noHistory,
      new Date(2026, 5, 1, 12, 0, 0),
      'm',
      'p',
      undefined,
      undefined,
      new Set(),
    );
  }

  it('the last message carries only owner bytes, marked owner', () => {
    const messages = built();
    const last = messages[messages.length - 1]!;
    expect(last.origin).toBe('owner');
    expect(last.role).toBe('user');
    expect(textOf(last.content)).toBe('DOMANDA-OWNER');
  });

  it('memory, runtime and work ride as separate non-owner messages', () => {
    const messages = built();
    const memory = messages.filter((m) => m.origin === 'memory');
    const runtime = messages.filter((m) => m.origin === 'runtime');
    const work = messages.filter((m) => m.origin === 'work');
    expect(memory.length).toBe(1);
    expect(textOf(memory[0]!.content)).toContain('UNICOMEMORIA');
    expect(runtime.length).toBe(1);
    expect(work.length).toBe(1);
    expect(textOf(work[0]!.content)).toContain('passo del piano');
    // Nothing injected leaks into the owner message.
    const ownerText = textOf(messages[messages.length - 1]!.content);
    expect(ownerText).not.toContain('UNICOMEMORIA');
    expect(ownerText).not.toContain('passo del piano');
  });

  it('no message is internally owner-originated except the current input', () => {
    const messages = built();
    for (const m of messages.slice(0, -1)) {
      expect(m.origin).not.toBe('owner');
    }
  });

  it('the history-cut announcement is harness control, never owner words', () => {
    const messages = buildContext(
      baseInput(),
      [],
      [],
      { kept: [], dropped: 3 },
      new Date(2026, 0, 1),
      'm',
      'p',
      undefined,
      undefined,
      new Set(),
    );
    expect(messages[0]!.origin).toBe('harness');
  });

  it('volatile tail order is deterministic: history, memory, runtime, work, owner', () => {
    const messages = built();
    const order = messages.map((m) => m.origin ?? 'legacy');
    const rank = (o: string): number =>
      ({ harness: 0, legacy: 1, memory: 2, runtime: 3, work: 4, owner: 5 })[o] ?? 9;
    const ranks = order.map(rank);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(messages[messages.length - 1]!.origin).toBe('owner');
  });

  it('only the volatile clock moves between two builds: the rest is byte-identical', () => {
    const at = (h: number) => new Date(2026, 5, 1, h, 0, 0);
    const first = buildContext(baseInput(), recalled, openPlan, noHistory, at(12), 'm', 'p', undefined, undefined, new Set());
    const second = buildContext(baseInput(), recalled, openPlan, noHistory, at(13), 'm', 'p', undefined, undefined, new Set());
    expect(first.length).toBe(second.length);
    for (let i = 0; i < first.length; i++) {
      if (first[i]!.origin === 'runtime') {
        expect(first[i]).not.toEqual(second[i]);
      } else {
        expect(first[i]).toEqual(second[i]);
      }
    }
  });
});

describe('P0 provenance · semantic sections are observable without raw text', () => {
  it('describeAssembly reports source, reason, size and stability per section', () => {
    const ctx = assembleSemantic({
      input: baseInput({ text: 'DOMANDA-OWNER' }),
      recalled: [{ type: 'text' as const, text: '[ricordo] qualcosa' }],
      open: openPlan,
      spoken: noHistory,
      adesso: new Date(2026, 5, 1, 12, 0, 0),
      modello: 'm',
      profilo: 'p',
      istanza: undefined,
      timeZone: undefined,
      undoneTraceIds: new Set(),
    });
    const sections = describeAssembly(ctx);
    const byKey = Object.fromEntries(sections.map((s) => [s.key, s]));
    expect(byKey['owner']!.origin).toBe('owner');
    expect(byKey['owner']!.stability).toBe('volatile');
    expect(byKey['memory']!.origin).toBe('memory');
    expect(byKey['work']!.origin).toBe('work');
    expect(byKey['runtime']!.origin).toBe('runtime');
    for (const s of sections) {
      expect(s.reason.length).toBeGreaterThan(0);
      expect(s.bytes).toBeGreaterThan(0);
    }
  });

  it('the descriptor carries no raw content: a secret stays out of its JSON', () => {
    const secret = 'sk-segreto-UNICO-987654321';
    const ctx = assembleSemantic({
      input: baseInput({ text: `la chiave è ${secret}` }),
      recalled: [{ type: 'text' as const, text: `ricordo con ${secret} dentro` }],
      open: openPlan,
      spoken: noHistory,
      adesso: new Date(2026, 5, 1, 12, 0, 0),
      modello: 'm',
      profilo: 'p',
      istanza: undefined,
      timeZone: undefined,
      undoneTraceIds: new Set(),
    });
    expect(JSON.stringify(describeAssembly(ctx))).not.toContain(secret);
  });
});
