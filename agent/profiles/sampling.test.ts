import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeSampling, loadProfiles } from './profile.js';

/**
 * Il sampling esplicito per famiglia (issue #498, precedente Aider
 * `use_temperature`): valori misurati nei dati del profilo, mai rami nel
 * loop. Lo schema rifiuta ad alta voce ciò che spedirebbe silenzio.
 */
describe('sampling esplicito', () => {
  const base: Record<string, unknown> = {
    schemaVersion: 1,
    name: 'prova',
    match: ['*gemma*'],
    maxToolsExposed: 21,
    maxToolCallsPerTurn: null,
    thinking: 'adaptive',
    recovery: [],
    notes: '',
  };

  function load(json: unknown): { ok: boolean; sampling?: unknown; problems: string[] } {
    const problems: string[] = [];
    const tmp = mkdtempSync(join(tmpdir(), 'muffin-profiles-sampling-'));
    writeFileSync(join(tmp, 'p.json'), JSON.stringify(json));
    const [p] = loadProfiles(tmp, (line) => problems.push(line));
    return { ok: p !== undefined, sampling: (p as { sampling?: unknown } | undefined)?.sampling, problems };
  }

  it('accetta valori espliciti misurati', () => {
    const r = load({ ...base, sampling: { temperature: 0.7 } });
    expect(r.ok).toBe(true);
    expect(r.sampling).toEqual({ temperature: 0.7 });
  });

  it('rifiuta snake_case, fuori scala e tipi sbagliati invece di spedirli in silenzio', () => {
    for (const sampling of [{ top_p: 0.9 }, { temperature: 3 }, { temperature: 'alta' }, { temperature: 0.7, bogus: 1 }]) {
      const r = load({ ...base, sampling });
      expect(r.ok, JSON.stringify(sampling)).toBe(false);
      expect(r.problems.join('\n')).toContain('p.json');
    }
  });

  it('un profilo vecchio senza sampling tiene il deterministico di prima', () => {
    const { sampling, ...senza } = base;
    void sampling;
    const r = load(senza);
    expect(r.ok).toBe(true);
    expect(r.sampling).toBe('deterministic');
  });

  it('describeSampling nomina parole e valori, mai [object Object]', () => {
    expect(describeSampling('deterministic')).toContain('temperature 0');
    expect(describeSampling('model-default')).toContain('nothing sent');
    expect(describeSampling({ temperature: 0.7, topP: 0.95 })).toBe('explicit (temperature 0.7, topP 0.95)');
    expect(describeSampling({})).toContain('model-default');
  });
});
