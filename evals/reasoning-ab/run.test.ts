import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARMS, TASKS, table } from './run.js';

/**
 * L'harness A/B senza rete: i fixture si provano contro i propri check.
 * Un fixture rotto fallirebbe il pilot in modo confondente — meglio un rosso
 * qui, a costo zero, prima di spendere. I task conversazionali si simulano
 * con le risposte che un modello diligente darebbe, turno per turno.
 */
describe('reasoning-ab fixtures', () => {
  it('ogni task ha id unico, turni e repliche sensate', () => {
    const ids = TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TASKS) {
      expect(t.turns.length).toBeGreaterThan(0);
      expect(t.reps).toBeGreaterThanOrEqual(1);
    }
    expect(ARMS).toEqual(['A', 'C', 'T0', 'DEF', 'T07']);
  });

  it('T3c: ricorda beta senza rilettura, dimentica senza', () => {
    const t = TASKS.find((x) => x.id === 'T3c-storia-senza-rilettura');
    const ws = mkdtempSync(join(tmpdir(), 'muffin-ab-fixture-'));
    try {
      t?.seed(ws);
      expect(t?.check(ws, ['alfa beta gamma', 'la seconda era beta'], [1, 0]).pass).toBe(true);
      const dimentica = t?.check(ws, ['alfa beta gamma', 'non ricordo, fammi rileggere'], [1, 0]);
      expect(dimentica?.pass).toBe(false);
      expect(dimentica?.detail).toContain('history');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('T4c: file finale e bozza ricordata, o niente', () => {
    const t = TASKS.find((x) => x.id === 'T4c-correzione-con-memoria');
    const ws = mkdtempSync(join(tmpdir(), 'muffin-ab-fixture-'));
    try {
      t?.seed(ws);
      writeFileSync(join(ws, 'data', 'nota.txt'), 'finale\n');
      expect(t?.check(ws, ['ok', "fatto, prima c'era bozza"], [1, 1]).pass).toBe(true);
      writeFileSync(join(ws, 'data', 'nota.txt'), 'finale\n');
      expect(t?.check(ws, ['ok', 'fatto'], [1, 1]).pass).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('la tabella rende una riga per replica', () => {
    const out = table([
      {
        arm: 'A',
        task: 'T1',
        rep: 2,
        pass: true,
        detail: 'x',
        outcome: 'answered',
        iterations: 3,
        toolCalls: 2,
        recoveries: 0,
        asks: 0,
        inputTokens: 1,
        outputTokens: 1,
        spentUsd: 0.01,
        wallMs: 5,
      },
    ]);
    expect(out).toContain('| A | T1 | 2 | PASS (answered) | 3 | 2 |');
  });
});
