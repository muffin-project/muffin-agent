import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
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
 * porta, non la funzione.
 *
 * La prima versione della guardia elencava i chiamanti a mano, e ne mancava
 * due che importavano già da qui (`agent/loop/tool-call.ts`,
 * `agent/providers/light-lane.ts`) — il difetto che un giudice ha rilevato su
 * quella fetta. L'elenco ora è *derivato* scorrendo gli import del codice di
 * produzione: un quinto chiamante entra da solo, e l'unica lista scritta a
 * mano è il pavimento che prova che la scansione non è rotta. Il secondo
 * controllo cerca `sleep` dichiarate localmente in tutte le forme finora
 * viste (`function`, `const`/`let`/`var`), ovunque in produzione: le copie di
 * §B.2 erano dichiarazioni, non import.
 */
describe('sleep — una porta sola, verificata su tutto il codice di produzione', () => {
  const root = join(import.meta.dirname, '..', '..');
  const PRODUCTION_DIRS = ['agent', 'connectors', 'cli', 'core'];
  const SLEEP_SOURCE = 'core/net/sleep.ts';

  /** Le forme in cui una copia è finora comparsa; i file di test sono esclusi a monte. */
  const DECLARATION =
    /(^|\n)[ \t]*(?:export\s+(?:default\s+)?)?(?:(?:async\s+)?function\s+sleep\s*\(|(?:const|let|var)\s+sleep\s*=)/;

  /**
   * Legami di iniezione, non copie: `cli/update.ts` sceglie fra un `sleep`
   * iniettato e un default inline — la stessa forma dei seam
   * `this.sleep = deps.sleep ?? …` di `connectors/discord/gateway.ts` e
   * `core/gateway/service.ts`, che non dichiarano un `sleep` nudo e infatti
   * non vengono segnalati. Chi aggiunge un binding del genere lo aggiunge qui,
   * con la ragione.
   */
  const INJECTION_BINDINGS = new Set(['cli/update.ts']);

  /**
   * Gli importatori al momento della stesura: il pavimento della scansione. Se
   * uno smette di importare da qui, si aggiorna con la stessa intenzione con
   * cui lo si è staccato.
   */
  const KNOWN_IMPORTERS = [
    'agent/loop/round.ts',
    'agent/loop/tool-call.ts',
    'agent/providers/light-lane.ts',
    'connectors/discord/api.ts',
    'connectors/telegram/api.ts',
    'connectors/telegram/connector.ts',
  ];

  function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules') continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) yield* walk(path);
      else if (path.endsWith('.ts')) yield path;
    }
  }

  function* productionFiles(): Generator<{ path: string; name: string }> {
    for (const dir of PRODUCTION_DIRS) {
      for (const path of walk(join(root, dir))) {
        if (path.endsWith('.test.ts')) continue;
        yield { path, name: relative(root, path) };
      }
    }
  }

  it('ogni importatore di core/net/sleep.js è coperto, e non dichiara una copia', () => {
    const importers: string[] = [];
    for (const { path, name } of productionFiles()) {
      if (name === SLEEP_SOURCE) continue;
      const source = readFileSync(path, 'utf8');
      if (!/from\s*['"][^'"]*net\/sleep\.js['"]/.test(source)) continue;
      importers.push(name);
      expect(source, `${name}: importa da core/net/sleep.js senza prendere { sleep }`).toMatch(
        /import\s*\{[^}]*\bsleep\b[^}]*\}\s*from\s*['"][^'"]*net\/sleep\.js['"]/,
      );
      expect(source, `${name}: importa sleep e poi ne dichiara una propria`).not.toMatch(
        DECLARATION,
      );
    }
    for (const known of KNOWN_IMPORTERS) {
      expect(
        importers,
        `${known} non è più visto come importatore: la scansione è rotta?`,
      ).toContain(known);
    }
  });

  it('nessun file di produzione fuori da core/net/sleep.ts dichiara una sleep propria', () => {
    const offenders: string[] = [];
    for (const { path, name } of productionFiles()) {
      if (name === SLEEP_SOURCE || INJECTION_BINDINGS.has(name)) continue;
      if (DECLARATION.test(readFileSync(path, 'utf8'))) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
