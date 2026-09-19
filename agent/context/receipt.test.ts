import { describe, expect, it } from 'vitest';
import {
  buildContextReceipt,
  type ContextReceiptInput,
  estimateTokens,
  measureText,
  renderReceiptText,
} from './receipt.js';

/**
 * S0 evidence: the receipt explains a turn's context without holding any of
 * its content. Fixture secrets below are measured, never stored — every test
 * that needs the guarantee asserts against the serialized receipt.
 */

const OWNER_SECRET = 'sk-owner-secret-never-in-receipt-xyz';
const MEMORY_SECRET = 'my contact in May was Mario Rossi, call +39 000 000 0000';

function fixture(): ContextReceiptInput {
  return {
    tenantClass: 'owner',
    promptVersion: 'v1',
    model: 'test-model',
    profile: 'consumer-local',
    surface: 'cli',
    systemBlocks: [
      { name: 'persona', measure: measureText('persona text') },
      { name: 'identity', measure: measureText('identity pact') },
    ],
    history: {
      kept: [
        {
          role: 'user',
          measure: measureText('hello'),
          tier: 0,
          surfaceMarked: false,
          undoneMarked: false,
        },
        {
          role: 'assistant',
          measure: measureText('hi there'),
          tier: 0,
          surfaceMarked: false,
          undoneMarked: false,
        },
      ],
      dropped: 3,
    },
    memory: {
      items: [
        {
          id: 7,
          source: 'episode',
          origin: 'said',
          trustTier: 1,
          chars: MEMORY_SECRET.length,
          tokenEstimate: estimateTokens(MEMORY_SECRET.length),
          reason: 'ranked-slot 1',
        },
      ],
      gaps: 1,
      pinnedOverflow: 2,
      strategies: ['tetto(40)'],
    },
    plan: {
      open: [{ seq: 1, state: 'pending', tier: 1, due: false }],
      planTaint: 1,
      measure: measureText('## Piano di questa conversazione'),
    },
    runtime: {
      measure: measureText('## Questo turno'),
      cwdHash: measureText('/Users/somebody/private-work').sha,
      cwdEntries: 14,
      cwdShown: 12,
      jobCount: 2,
      safeMode: false,
    },
    ownerInput: { measure: measureText(OWNER_SECRET), media: [] },
    tools: {
      profileName: 'consumer-local',
      cap: 21,
      exposed: ['fs_read', 'todo'],
      cut: ['sys_inspect'],
      cutReason: 'registration order past cap',
      toolChoice: 'auto',
      specMeasure: measureText('tool specs'),
    },
    synthetic: [
      {
        kind: 'history-cut',
        role: 'user',
        measure: measureText('[3 messaggi precedenti ...]'),
        trigger: 'dropped>0',
      },
    ],
    excluded: [{ what: 'job bodies', reason: 'by design: count only', count: 2 }],
    taint: { ceiling: 1, history: 0, memory: 1, plan: 1 },
    redactions: [{ kind: 'log-redaction', count: 1 }],
  };
}

describe('context receipt (S0)', () => {
  it('rolls totals up from per-category measures', () => {
    const r = buildContextReceipt(fixture());
    expect(r.version).toBe(1);
    const expectedBytes =
      r.byCategory['system']!.bytes +
      r.byCategory['history']!.bytes +
      r.byCategory['memory']!.bytes +
      r.byCategory['plan']!.bytes +
      r.byCategory['runtime']!.bytes +
      r.byCategory['owner_input']!.bytes +
      r.byCategory['tools']!.bytes +
      r.byCategory['synthetic']!.bytes;
    expect(r.totals.bytes).toBe(expectedBytes);
    expect(r.totals.tokenEstimate).toBeGreaterThan(0);
  });

  it('holds no raw private content anywhere in the serialized receipt', () => {
    const r = buildContextReceipt(fixture());
    const json = JSON.stringify(r);
    expect(json).not.toContain(OWNER_SECRET);
    expect(json).not.toContain(MEMORY_SECRET);
    expect(json).not.toContain('/Users/somebody/private-work');
    expect(json).not.toContain('hello');
    // Correlation without content: sizes and hashes survive.
    expect(json).toContain(measureText(OWNER_SECRET).sha);
    expect(json).toContain('"dropped":3');
    expect(json).toContain('tetto(40)');
  });

  it('an empty plan and empty memory cost nothing but keep their strategies', () => {
    const f = fixture();
    f.plan = { open: [], planTaint: 0, measure: measureText('') };
    f.memory = { items: [], gaps: 0, pinnedOverflow: 0, strategies: [] };
    const r = buildContextReceipt(f);
    expect(r.byCategory['plan']!.bytes).toBe(0);
    expect(r.byCategory['memory']!.bytes).toBe(0);
    expect(r.memory.strategies).toEqual([]);
  });

  it('labels cacheability where assembly determines it', () => {
    const r = buildContextReceipt(fixture());
    expect(r.cacheability['system']).toBe('stable');
    expect(r.cacheability['tools']).toBe('profile-stable');
    for (const c of ['history', 'memory', 'plan', 'runtime', 'owner_input', 'synthetic']) {
      expect(r.cacheability[c]).toBe('volatile');
    }
  });

  it('accounts exposed versus cut tools with the reason', () => {
    const r = buildContextReceipt(fixture());
    expect(r.tools.exposed).toEqual(['fs_read', 'todo']);
    expect(r.tools.cut).toEqual(['sys_inspect']);
    expect(r.tools.cutReason).toBe('registration order past cap');
    expect(r.tools.cap).toBe(21);
  });

  it('renders one deterministic line per category with no raw text', () => {
    const a = renderReceiptText(buildContextReceipt(fixture()));
    const b = renderReceiptText(buildContextReceipt(fixture()));
    expect(a).toBe(b);
    expect(a).toContain('context-receipt v1 class=owner');
    expect(a).toContain('3 dropped');
    expect(a).toContain('CUT 1: sys_inspect');
    expect(a).toContain('ceiling=1');
    expect(a).not.toContain(OWNER_SECRET);
    expect(a).not.toContain(MEMORY_SECRET);
  });

  it('measureText is deterministic and honest about sizes', () => {
    const a = measureText('abc');
    const b = measureText('abc');
    expect(a).toEqual(b);
    expect(a.bytes).toBe(3);
    expect(a.tokenEstimate).toBe(1);
    expect(measureText('').bytes).toBe(0);
    expect(measureText('').tokenEstimate).toBe(0);
  });
});
