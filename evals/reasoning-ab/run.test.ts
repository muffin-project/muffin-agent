import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARMS, TASKS, configureArm, table } from './run.js';
import { runInit } from '../../cli/init.js';
import { loadConfig } from '../../core/config/config.js';

/**
 * L'harness A/B senza rete: i fixture si provano contro i propri check.
 * Un fixture rotto (somma sbagliata, file mancanti) fallirebbe il pilot in
 * modo confondente — meglio un rosso qui, a costo zero, prima di spendere.
 */
describe('reasoning-ab fixtures', () => {
  it('ogni task ha id unico e prompt non vuoto', () => {
    const ids = TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TASKS) expect(t.prompt.length).toBeGreaterThan(10);
  });

  it('seed + check simulato passano offline', () => {
    for (const t of TASKS) {
      const ws = mkdtempSync(join(tmpdir(), 'muffin-ab-fixture-'));
      try {
        t.seed(ws);
        // Il check dei task file gira sul file scritto dal seed, come farebbe
        // il modello che esegue alla lettera; T3 valuta una risposta nota buona.
        const answer = t.id === 'T3-spiega-script' ? 'Raddoppia ogni elemento della lista' : '';
        const { pass, detail } = t.check(ws, answer);
        // T1/T1b/T2 senza esecuzione reale non hanno il file di output: il
        // check deve dirlo esplicitamente, non passare per caso.
        if (t.id === 'T3-spiega-script') expect(pass, detail).toBe(true);
        else expect(pass).toBe(false);
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    }
  });

  it('la tabella rende una riga per turno', () => {
    const out = table([
      {
        arm: 'A',
        task: 'T1',
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
    expect(out).toContain('| A | T1 | PASS (answered) | 3 | 2 |');
    expect(ARMS).toEqual(['A', 'B', 'C', 'D']);
  });

  it('il braccio D scrive thinking low e il C off, gli altri non toccano la config', () => {
    for (const [arm, atteso] of [['A', undefined], ['B', undefined], ['C', 'off'], ['D', 'low']] as const) {
      const home = mkdtempSync(join(tmpdir(), 'muffin-ab-arm-'));
      try {
        runInit({ home, apiKey: 'chiave-mai-usata', provider: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1', mainModel: 'qwen/qwen3.8-27b', lightModel: 'qwen/qwen3.8-27b' });
        configureArm(arm, home);
        expect(loadConfig(home).thinking, arm).toBe(atteso);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  });
});
