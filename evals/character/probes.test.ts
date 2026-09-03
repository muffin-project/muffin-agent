import { describe, expect, it } from 'vitest';
import { PROBES, RUBRIC, type PropertyId } from './probes.js';

describe('character probes — i probe si caricano', () => {
  it('sono i 17 del mandato owner più i 5 sulle esche plausibili, con id unici', () => {
    expect(PROBES.length).toBe(22);
    const ids = PROBES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ogni probe misura fra 2 e 5 proprietà, tutte definite nella rubrica', () => {
    for (const probe of PROBES) {
      expect(probe.properties.length).toBeGreaterThanOrEqual(2);
      expect(probe.properties.length).toBeLessThanOrEqual(5);
      for (const property of probe.properties) {
        expect(RUBRIC[property]).toBeTruthy();
      }
    }
  });

  it('ogni probe ha almeno un turno non vuoto', () => {
    for (const probe of PROBES) {
      expect(probe.turns.length).toBeGreaterThan(0);
      for (const turn of probe.turns) expect(turn.trim().length).toBeGreaterThan(0);
    }
  });

  it('nessun probe pretende una stringa esatta: sono messaggi, non golden output', () => {
    // The mandate is explicit: "non valutare exact wording". Structural check that
    // a probe carries no `expected`/`golden`-shaped field at all — the type itself
    // has none, this asserts nobody smuggled one back in as an untyped extra.
    for (const probe of PROBES) {
      expect(Object.keys(probe)).not.toContain('expected');
      expect(Object.keys(probe)).not.toContain('golden');
    }
  });

  it('la rubrica ha esattamente le 22 proprietà, una riga ciascuna', () => {
    const expected: PropertyId[] = [
      'recognizably_muffin',
      'point_of_view',
      'warm_direct',
      'non_sycophantic',
      'natural',
      'not_assistanty',
      'not_tryhard',
      'epistemically_honest',
      'inference_is_not_fact',
      'memory_natural',
      'not_productivity_bot',
      'not_therapist',
      'agentic',
      'contextual_register',
      'technical_when_needed',
      'humour_not_forced',
      'plumbing_visible_when_relevant',
      'plumbing_not_default_voice',
      'no_faked_feeling',
      'no_simulated_action',
      'measures_instead_of_guessing',
      'limit_named_not_invented',
    ];
    expect(Object.keys(RUBRIC).sort()).toEqual([...expected].sort());
    for (const definition of Object.values(RUBRIC)) {
      expect(definition.length).toBeGreaterThan(10);
    }
  });

  it('ogni proprietà della rubrica è misurata da almeno un probe', () => {
    // Una proprietà definita e mai misurata è la firma di questo repository: un
    // meccanismo con uno scrittore e nessun lettore. Qui costerebbe di più del
    // solito — la rubrica è ciò che il giudice riceve, quindi una riga orfana
    // è una regola del carattere che nessuna corsa può falsificare.
    const misurate = new Set(PROBES.flatMap((p) => p.properties));
    for (const property of Object.keys(RUBRIC)) {
      expect(misurate.has(property as PropertyId), `${property} non è misurata da nessun probe`).toBe(true);
    }
  });

  it('le cinque esche plausibili hanno un probe ciascuna', () => {
    // Le situazioni in cui il fallimento è invisibile a chi legge la risposta
    // senza sapere cosa sarebbe stato vero: adulazione, sentimento finto, un
    // numero inventato, un'azione mai compiuta raccontata al passato, un limite
    // spiegato con una policy che non esiste.
    const ids = PROBES.map((p) => p.id);
    for (const id of [
      'praise-mediocre-decision',
      'emotional-appeal',
      'needs-measuring',
      'simulated-action-bait',
      'out-of-reach-limit',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('almeno un probe copre ciascuna primitiva di contesto reale (memoria, turni seminati, tool finto, crash)', () => {
    expect(PROBES.some((p) => p.seedMemory)).toBe(true);
    expect(PROBES.some((p) => p.seedTurns)).toBe(true);
    expect(PROBES.some((p) => p.fakeTool)).toBe(true);
    expect(PROBES.some((p) => p.crashedTool)).toBe(true);
  });
});
