import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { sleep } from './sleep.js';

describe('sleep — un timer, con o senza un modo per abbandonarlo', () => {
  it('risolve dopo il tempo dato', async () => {
    vi.useFakeTimers();
    try {
      let risolto = false;
      void sleep(1000).then(() => {
        risolto = true;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(risolto).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(risolto).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ms <= 0 risolve subito, senza passare da un timer', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    await sleep(0);
    await sleep(-5);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it('un signal già abortito risolve subito', async () => {
    const controller = new AbortController();
    controller.abort();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    await sleep(1000, controller.signal);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it('un abort a metà strada risolve prima del timer, e pulisce il timer', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let risolto = false;
      void sleep(10_000, controller.signal).then(() => {
        risolto = true;
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(risolto).toBe(false);
      controller.abort();
      await Promise.resolve();
      expect(risolto).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Misurato in `docs/evidence/forma-del-repo-2026-09-04.md` §B.2: `sleep()`
 * scritta quattro volte, senza un commento che lo giustificasse (a differenza
 * di `backoffMs()`, §B.3). Un test di comportamento su questo file non
 * impedisce a un quinto chiamante di riscriversi la propria copia — è
 * esattamente il modo in cui le prime quattro sono nate. Questo verifica la
 * porta, non la funzione: se uno di questi chiamanti smette di importare da
 * qui, o torna a dichiarare `function sleep(`, questa suite diventa rossa.
 *
 * Solo tre dei quattro misurati: `connectors/telegram/connector.ts` porta
 * ancora la propria copia, non perché la duplicazione sia difendibile ma
 * perché quel file era sotto riscrittura in una fetta concorrente mentre
 * questa entrava — vedi il commento in `sleep.ts`.
 */
describe('sleep — una porta sola, verificata sui chiamanti unificati', () => {
  const root = join(import.meta.dirname, '..', '..');
  const chiamanti = [
    { file: 'agent/loop.ts', importPath: '../core/net/sleep.js' },
    { file: 'connectors/discord/api.ts', importPath: '../../core/net/sleep.js' },
    { file: 'connectors/telegram/api.ts', importPath: '../../core/net/sleep.js' },
  ];

  for (const { file, importPath } of chiamanti) {
    it(`${file} importa sleep da ${importPath}, e non ne dichiara una propria`, () => {
      const testo = readFileSync(join(root, file), 'utf8');
      expect(testo).toContain(`from '${importPath}'`);
      expect(testo).toMatch(
        new RegExp(
          `import\\s*\\{[^}]*\\bsleep\\b[^}]*\\}\\s*from\\s*'${importPath.replace(/[.]/g, '\\.')}'`,
        ),
      );
      expect(testo).not.toMatch(/^function sleep\(/m);
    });
  }
});
