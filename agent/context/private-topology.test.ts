import { describe, expect, it } from 'vitest';
import { ambienteSection } from './assemble.js';

describe('private topology in the volatile turn context', () => {
  const base = {
    adesso: new Date('2026-09-11T12:00:00.000Z'),
    surface: 'telegram',
    classe: 'group' as const,
    model: 'test-model',
    profilo: 'test',
    timeZone: 'UTC',
  };

  it('does not tell an unpaired private DM that other people are present', () => {
    const text = ambienteSection({ ...base, tenant: 'direct:telegram:4242' });
    expect(text).toContain('in privato');
    expect(text).toContain('non ancora verificata come owner');
    expect(text).not.toContain('ci sono altre persone');
  });

  it('still describes a real group as shared', () => {
    const text = ambienteSection({ ...base, tenant: 'group:telegram:-100' });
    expect(text).toContain('in un gruppo');
    expect(text).toContain('altre persone');
  });
});
