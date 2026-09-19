import { describe, expect, it } from 'vitest';
import type { SessionMessage } from '../../core/session/store.js';
import type { Principal, TenantId } from '../../core/policy/types.js';
import type { TodoItem } from '../../core/turns/todo.js';
import { reinjectedHistory } from '../context/history-taint.js';
import type { TurnInput } from './types.js';
import { assembleSemantic, buildContext, describeAssembly } from './context.js';
import { compileForAnthropic } from '../providers/compile.js';

/**
 * Context P1-A — #529 temporal salience, RED-first.
 *
 * Plan state != conversational reminder state. An open undated todo stays
 * available for continuity without inducing Muffin to repeat it, transcript
 * gaps are legible without per-line noise, automation never impersonates the
 * owner, and historic tool bulk never floods volatile attention.
 */

const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };
const systemScheduler: Principal = { kind: 'system', source: 'scheduler' };

const baseInput = (overrides: Partial<TurnInput> = {}): TurnInput => ({
  principal: owner,
  tenant: 'host' as TenantId,
  surface: 'cli',
  session: { id: 'p1a', file: '/dev/null' },
  text: 'ciao',
  ...overrides,
});

const todoOpen = (over: Partial<TodoItem> = {}): TodoItem => ({
  seq: 1,
  text: 'rivedere il contratto',
  state: 'pending',
  note: null,
  tier: 0,
  dueAt: null,
  createdAt: new Date('2026-05-01T09:00:00.000Z').toISOString(),
  updatedAt: new Date('2026-05-01T09:00:00.000Z').toISOString(),
  ...over,
});

const msg = (over: Partial<SessionMessage> = {}): SessionMessage => ({
  role: 'user',
  content: 'riga',
  surface: 'cli',
  createdAt: new Date('2026-05-01T10:00:00.000Z').toISOString(),
  ...over,
});

const textOfMessages = (messages: { content: { type: string; text?: string }[] }[]): string =>
  messages
    .flatMap((m) => m.content)
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

describe('P1-A · 1 no-nag: undated open todo is background continuity, not a reminder', () => {
  it('work section keeps the item but frames it as silent background state', () => {
    const ctx = assembleSemantic({
      input: baseInput({ text: 'che tempo fa oggi?' }),
      recalled: [],
      open: [todoOpen()],
      spoken: { kept: [], dropped: 0 },
      adesso: new Date('2026-05-01T12:00:00.000Z'),
      modello: 'm',
      profilo: 'p',
      istanza: undefined,
      timeZone: 'UTC',
      undoneTraceIds: new Set(),
    });
    expect(ctx.work).not.toBeNull();
    const workText = textOfMessages([ctx.work!]);
    // Still available for continuity / compaction survival.
    expect(workText).toContain('rivedere il contratto');
    // Background framing, not reminder-like.
    expect(workText).toMatch(/sottofondo|stato interno|continuit/i);
    expect(workText).toMatch(/non menzionarl|non ricordarl|silenz/i);
    // Old reminder framing is gone (mutation: restoring it must turn this red).
    expect(workText).not.toContain('Piano di questa conversazione');
    // Surfacing needs a reason — the rule is stated, not just a generic persona line.
    expect(workText).toMatch(/pertinent|blocca|dovut|proattiv/i);
    expect(workText).toMatch(/solo fatto di essere .* apert/i);
  });

  it('stays background across 4 unrelated owner turns', () => {
    const unrelated = ['che tempo fa?', 'raccontami una barzelletta', 'cosa mangio stasera?', 'hai visto la partita?'];
    for (const text of unrelated) {
      const messages = buildContext(
        baseInput({ text }),
        [],
        [todoOpen()],
        { kept: [], dropped: 0 },
        new Date('2026-05-01T12:00:00.000Z'),
        'm',
        'p',
        undefined,
        'UTC',
        new Set(),
      );
      const work = messages.find((m) => m.origin === 'work')!;
      expect(work).toBeDefined();
      const t = textOfMessages([work]);
      expect(t).toContain('rivedere il contratto');
      expect(t).not.toContain('Piano di questa conversazione');
      expect(t).toMatch(/sottofondo|stato interno|continuit/i);
    }
  });
});

describe('P1-A · 2 relevant todo remains retrievable', () => {
  it('asking about open work still finds the item without a separate lookup', () => {
    const messages = buildContext(
      baseInput({ text: 'cosa dovevamo ancora fare?' }),
      [],
      [todoOpen()],
      { kept: [], dropped: 0 },
      new Date('2026-05-01T12:00:00.000Z'),
      'm',
      'p',
      undefined,
      'UTC',
      new Set(),
    );
    const work = messages.find((m) => m.origin === 'work')!;
    expect(textOfMessages([work])).toContain('rivedere il contratto');
    // The owner message itself stays pure — the plan was not removed from the model,
    // it just was never deleted from the work section to answer this.
    const last = messages[messages.length - 1]!;
    expect(last.origin).toBe('owner');
  });
});

describe('P1-A · 3 due remains authoritative via the existing commitment path', () => {
  it('a dated todo still renders with its moment and no parallel cooldown', () => {
    const due = todoOpen({ dueAt: new Date('2026-05-02T09:00:00.000Z').toISOString() });
    const ctx = assembleSemantic({
      input: baseInput({ text: 'ciao' }),
      recalled: [],
      open: [due],
      spoken: { kept: [], dropped: 0 },
      adesso: new Date('2026-05-01T12:00:00.000Z'),
      modello: 'm',
      profilo: 'p',
      istanza: undefined,
      timeZone: 'UTC',
      undoneTraceIds: new Set(),
    });
    const workText = textOfMessages([ctx.work!]);
    // Still governed by the existing due/commitment rendering.
    expect(workText).toContain('2026-05-02');
    // No parallel scheduler/cooldown vocabulary introduced here.
    expect(workText).not.toMatch(/cooldown|lastSurfacedAt|non menzionare per \d+ minut/i);
    // The framing names the existing commitment mechanism as the due authority.
    expect(workText).toMatch(/commitment|dovut/i);
  });
});

describe('P1-A · 4 temporal gap is legible from createdAt', () => {
  it('a multi-hour gap produces a sparse marker (mutation: removing it must redden this)', () => {
    const kept: SessionMessage[] = [
      msg({ role: 'user', content: 'prima parte', createdAt: new Date('2026-05-01T10:00:00.000Z').toISOString() }),
      msg({ role: 'assistant', content: 'risposta', createdAt: new Date('2026-05-01T10:00:30.000Z').toISOString() }),
      msg({ role: 'user', content: 'riprendiamo dopo', createdAt: new Date('2026-05-01T13:05:00.000Z').toISOString() }),
    ];
    const messages = buildContext(
      baseInput({ text: 'eccomi di nuovo' }),
      [],
      [],
      { kept, dropped: 0 },
      new Date('2026-05-01T13:05:30.000Z'),
      'm',
      'p',
      undefined,
      'UTC',
      new Set(),
    );
    const flat = textOfMessages(messages);
    // Legible temporal evidence for the ~3h discontinuity.
    expect(flat).toMatch(/3 ore|tre ore/i);
    expect(flat).toMatch(/pausa|ripresa|dopo/i);
    // Sparse: one marker for the one large gap, not a timestamp on every line.
    const markers = flat.match(/\[?(pausa|ripresa)[^\n]*\]/gi) ?? [];
    expect(markers.length).toBeGreaterThanOrEqual(1);
    expect(markers.length).toBeLessThanOrEqual(2);
    // Original lines survive verbatim underneath the marker.
    expect(flat).toContain('prima parte');
    expect(flat).toContain('riprendiamo dopo');
  });

  it('a day-scale gap names days', () => {
    const kept: SessionMessage[] = [
      msg({ role: 'user', content: 'lunedì', createdAt: new Date('2026-05-01T10:00:00.000Z').toISOString() }),
      msg({ role: 'user', content: 'giovedì', createdAt: new Date('2026-05-04T10:00:00.000Z').toISOString() }),
    ];
    const messages = buildContext(
      baseInput({ text: 'ci sono di nuovo' }),
      [],
      [],
      { kept, dropped: 0 },
      new Date('2026-05-04T10:00:30.000Z'),
      'm',
      'p',
      undefined,
      'UTC',
      new Set(),
    );
    expect(textOfMessages(messages)).toMatch(/3 giorn/i);
  });
});

describe('P1-A · 5 rapid conversation stays clean', () => {
  it('messages seconds apart gain no repetitive temporal metadata', () => {
    const base = new Date('2026-05-01T10:00:00.000Z').getTime();
    const kept: SessionMessage[] = [0, 12, 25, 41].map((s, i) =>
      msg({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `rapido ${i}`,
        createdAt: new Date(base + s * 1000).toISOString(),
      }),
    );
    const messages = buildContext(
      baseInput({ text: 'ancora qui' }),
      [],
      [],
      { kept, dropped: 0 },
      new Date(base + 55 * 1000),
      'm',
      'p',
      undefined,
      'UTC',
      new Set(),
    );
    const flat = textOfMessages(messages);
    expect(flat).toContain('rapido 0');
    expect(flat).toContain('rapido 3');
    // No gap-marker vocabulary at all on a sub-minute exchange.
    expect(flat).not.toMatch(/\[pausa di|\[ripresa dopo/);
  });
});

describe('P1-A · 6 provenance reused, never duplicated', () => {
  it('gap markers are harness control; history stays legacy; compiler keeps the boundary', () => {
    const kept: SessionMessage[] = [
      msg({ role: 'user', content: 'prima', createdAt: new Date('2026-05-01T10:00:00.000Z').toISOString() }),
      msg({ role: 'user', content: 'dopo ore', createdAt: new Date('2026-05-01T14:00:00.000Z').toISOString() }),
    ];
    const ctx = assembleSemantic({
      input: baseInput({ text: 'ciao' }),
      recalled: [{ type: 'text', text: '[ricordo] qualcosa' }],
      open: [todoOpen()],
      spoken: { kept, dropped: 0 },
      adesso: new Date('2026-05-01T14:00:30.000Z'),
      modello: 'm',
      profilo: 'p',
      istanza: undefined,
      timeZone: 'UTC',
      undoneTraceIds: new Set(),
    });
    const gapMarkers = ctx.history.filter((m) => m.origin === 'harness');
    expect(gapMarkers.length).toBeGreaterThanOrEqual(1);
    const replayed = ctx.history.filter((m) => (m.origin ?? 'legacy') === 'legacy');
    expect(replayed.length).toBe(2);
    expect(ctx.memory!.origin).toBe('memory');
    expect(ctx.runtime.origin).toBe('runtime');
    expect(ctx.work!.origin).toBe('work');
    expect(ctx.owner.origin).toBe('owner');
    // Provider compiler: harness control never folds into legacy evidence.
    const compiled = compileForAnthropic([
      ...(ctx.announcement ? [ctx.announcement] : []),
      ...ctx.history,
    ]);
    expect(compiled.length).toBeGreaterThan(1);
  });

  it('describeAssembly still describes without raw text (no secret leakage)', () => {
    const secret = 'sk-segreto-P1A-987654321';
    const ctx = assembleSemantic({
      input: baseInput({ text: `la chiave è ${secret}` }),
      recalled: [{ type: 'text', text: `ricordo con ${secret}` }],
      open: [todoOpen()],
      spoken: {
        kept: [
          msg({ content: `vecchio con ${secret}`, createdAt: new Date('2026-05-01T10:00:00.000Z').toISOString() }),
          msg({ content: 'molto dopo', createdAt: new Date('2026-05-01T14:00:00.000Z').toISOString() }),
        ],
        dropped: 0,
      },
      adesso: new Date('2026-05-01T14:00:30.000Z'),
      modello: 'm',
      profilo: 'p',
      istanza: undefined,
      timeZone: 'UTC',
      undoneTraceIds: new Set(),
    });
    expect(JSON.stringify(describeAssembly(ctx))).not.toContain(secret);
  });
});

describe('P1-A · autonomy: active work never renders as owner input', () => {
  it('a scheduler directive rides as WORK with automation framing, and no owner message exists', () => {
    const ctx = assembleSemantic({
      input: baseInput({ principal: systemScheduler, text: 'manda il brief delle 9' }),
      recalled: [],
      open: [],
      spoken: { kept: [], dropped: 0 },
      adesso: new Date('2026-05-01T09:00:00.000Z'),
      modello: 'm',
      profilo: 'p',
      istanza: undefined,
      timeZone: 'UTC',
      undoneTraceIds: new Set(),
    });
    expect(ctx.owner.origin).not.toBe('owner');
    expect(ctx.owner.origin).toBe('work');
    const directiveText = textOfMessages([ctx.owner]);
    expect(directiveText).toContain('manda il brief delle 9');
    expect(directiveText).toMatch(/automatico|schedulat|non è l'owner/i);
    const flat = buildContext(
      baseInput({ principal: systemScheduler, text: 'manda il brief delle 9' }),
      [],
      [],
      { kept: [], dropped: 0 },
      new Date('2026-05-01T09:00:00.000Z'),
      'm',
      'p',
      undefined,
      'UTC',
      new Set(),
    );
    expect(flat.some((m) => m.origin === 'owner')).toBe(false);
  });

  it('a human turn still ends with a pure owner message', () => {
    const messages = buildContext(
      baseInput({ text: 'domanda umana' }),
      [],
      [],
      { kept: [], dropped: 0 },
      new Date('2026-05-01T09:00:00.000Z'),
      'm',
      'p',
      undefined,
      'UTC',
      new Set(),
    );
    const last = messages[messages.length - 1]!;
    expect(last.origin).toBe('owner');
    expect(textOfMessages([last])).toBe('domanda umana');
  });
});

describe('P1-A · raw tool bulk never floods volatile attention', () => {
  it('historic tool rows are excluded from reinjection and from rendered history', () => {
    const big = 'x'.repeat(100_000);
    const history: SessionMessage[] = [
      msg({ role: 'user', content: 'leggi il file', createdAt: new Date('2026-05-01T10:00:00.000Z').toISOString() }),
      {
        role: 'tool',
        content: big,
        toolCallId: 'c-big',
        toolName: 'fs_read',
        surface: 'cli',
        createdAt: new Date('2026-05-01T10:00:05.000Z').toISOString(),
      },
      msg({ role: 'assistant', content: 'letto', createdAt: new Date('2026-05-01T10:00:10.000Z').toISOString() }),
    ];
    const spoken = reinjectedHistory(history, 40);
    expect(spoken.kept.some((m) => m.role === 'tool')).toBe(false);
    expect(spoken.kept.length).toBe(2);
    const messages = buildContext(
      baseInput({ text: 'e adesso?' }),
      [],
      [],
      spoken,
      new Date('2026-05-01T10:00:30.000Z'),
      'm',
      'p',
      undefined,
      'UTC',
      new Set(),
    );
    expect(textOfMessages(messages)).not.toContain(big.slice(0, 1000));
  });
});
