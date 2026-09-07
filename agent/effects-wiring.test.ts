import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../cli/init.js';
import type { ToolContext } from './loop.js';
import { buildRuntime } from './runtime.js';

/**
 * Il registro degli effetti attraverso l'assemblaggio **vero**.
 *
 * `agent/tools/effects.test.ts` costruisce il tool a mano e gli passa un fuso:
 * prova che l'handler è corretto, e resterebbe verde **anche** se
 * `buildRuntime` smettesse di passargli il fuso dell'owner — che è esattamente
 * la mutazione da cui questa fetta è stata riparata. Misurato: rimettere
 * `makeEffectsTool(turns)` senza secondo argomento lascia tutti gli unit test
 * verdi. Un difetto che nessun rosso segnala è la firma di questo repository.
 *
 * Quindi qui si parte da `buildRuntime` e si chiama il tool **come lo trova il
 * loop**, cercandolo nel registro per nome. Togli
 * `budgets.quietHours.timezone` dalla chiamata a `makeEffectsTool` in
 * `agent/runtime.ts`, e questo file va rosso.
 */

function bootHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'muffin-effectswire-'));
  runInit({ home, apiKey: 'sk-never-called' });
  return home;
}

const workspace = () => mkdtempSync(join(tmpdir(), 'muffin-effectswire-ws-'));

const ctx = (turnId: string): ToolContext =>
  ({
    turnId,
    tenant: 'host',
    principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
  }) as ToolContext;

describe('il registro degli effetti, dal runtime vero', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("«oggi» è la giornata dell'owner sigillata nel RoT, non quella del processo", async () => {
    /**
     * Deterministico, e deve esserlo: la prima versione di questo test
     * confrontava «oggi a Roma» con «oggi nel fuso del processo» e li trovava
     * uguali per venti ore su ventiquattro — cioè passava senza asserire
     * niente per quasi tutta la giornata, che è lo stesso guasto che sta
     * provando a impedire.
     *
     * Le 23:30 UTC del 7 sono già lo **08** a Roma. `defaults/rot/budgets.json`
     * sigilla `Europe/Rome` per ogni installazione fresca, e il fuso del
     * processo è forzato su `UTC`: le due risposte sono due giorni diversi, e
     * restano tali a qualunque ora si esegua la suite.
     *
     * Solo `Date` è finto (`toFake`): `better-sqlite3` e il resto del runtime
     * girano con i loro timer veri.
     */
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-07T23:30:00.000Z'));
    const fusoProcesso = process.env['TZ'];
    process.env['TZ'] = 'UTC';
    try {
      const runtime = buildRuntime(bootHome(), workspace());
      try {
        const turns = runtime.deps.turns;
        turns.create({
          id: 't1',
          principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
          tenant: 'host',
          surface: 'cli',
          sessionId: 's1',
          model: 'm',
          messages: [],
          taint: 0,
          counters: {
            iterations: 0,
            recoveriesUsed: 0,
            transportRetriesLeft: 2,
            toolCallsMade: 0,
            nudgedForCompletion: false,
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            spentUsd: 0,
            resumes: 0,
            contextBuilt: false,
          },
        });
        // Scritta «adesso», cioè alle 23:30 UTC del 7 — dentro l'08 di Roma e
        // dentro il 7 di UTC. È la riga su cui i due fusi non possono essere
        // d'accordo.
        turns.startToolCall('t1', {
          callId: 'c1',
          tool: 'fs_write',
          capability: 'fs.write',
          rerunnable: true,
          args: {},
          effect: {
            row: 'host',
            reversible: 'undoable',
            resource: '/ws/diario-di-oggi.md',
            decision: 'allow',
          },
        });

        const tool = runtime.deps.tools.find((t) => t.spec.name === 'sys_effects');
        expect(tool, 'sys_effects non è registrato dal runtime vero').toBeDefined();

        const out = await tool!.handler({ scope: 'today' }, ctx('t1'));
        // L'intestazione dichiara la giornata che il runtime ha davvero usato.
        expect(out.content, 'la giornata non è quella dell’owner').toContain('giornata 2026-09-08');
        expect(out.content, 'la giornata è quella del processo, non dell’owner').not.toContain(
          'giornata 2026-09-07',
        );
        // E la riga c'è davvero: senza questa, l'asserzione sopra passerebbe
        // anche su un report vuoto con l'intestazione giusta.
        expect(out.content).toContain('diario-di-oggi.md');
      } finally {
        runtime.close();
      }
    } finally {
      if (fusoProcesso === undefined) delete process.env['TZ'];
      else process.env['TZ'] = fusoProcesso;
    }
  });
});
