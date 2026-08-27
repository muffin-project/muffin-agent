import DatabaseCtor from 'better-sqlite3';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { itConSandbox } from '../sandbox-host.js';
import { install, until } from '../harness.js';

/**
 * Un job che esegue invece di ragionare — e la prova è un conto a zero.
 *
 * L'owner l'ha chiesto con parole precise: *«tutte cose in cui LLM non sta
 * sempre girando… Muffin è un sistema»*. Il confronto con Hermes, verificato
 * sulla documentazione ufficiale, ha trovato che quel sistema spedisce i cron
 * script-only descrivendoli come «No LLM call. Zero tokens, zero agent loop,
 * zero model spend», mentre Muffin aveva la filosofia giusta in un solo
 * sottosistema — il cancello a due stadi di `core/scheduler/observe.ts` — senza
 * averla generalizzata al proprio scheduler. Ogni `Job` portava un obiettivo in
 * linguaggio naturale, e ogni occorrenza un turno, cioè una chiamata al
 * modello: «controlla ogni cinque minuti se il sito è giù» costava un turno a
 * ogni tick, per sempre.
 *
 * ## Perché il provider finto è la prova giusta
 *
 * `inst.provider.main()` registra ogni richiesta che il binario ha mandato al
 * modello. Un conto a **zero** dopo che il job è girato *e ha consegnato* non è
 * un'interpretazione: è l'assenza di una richiesta HTTP che sarebbe stata
 * registrata se ci fosse stata. È la stessa ragione per cui `job-fires`
 * asserisce `mainCalls.length !== 1` — il modello finto, non il database, è
 * ciò che distingue "ripreso" da "rifatto".
 */

describe('acceptance · un job script gira senza modello', () => {
  // `itConSandbox` e non `it`: questo scenario fa girare un job script, e un
  // job script gira nel sandbox. Dentro Docker `bwrap` non può montare `/proc`,
  // quindi qui andava rosso con un messaggio che si legge come «il sandbox di
  // Muffin è rotto su Linux» — e non lo è: bwrap grezzo lì funziona. La
  // domanda ora la fa bwrap, non Muffin, quindi un difetto di Muffin resta
  // rosso e solo un limite della macchina diventa un salto dichiarato.
  itConSandbox(
    'esegue, consegna, e non chiama mai il modello — e tace quando non ha niente da dire',
    async () => {
      const inst = await install({
        // Se il modello venisse chiamato, questa risposta comparirebbe
        // nell'output: è un canarino, non un copione.
        main: [{ text: 'QUESTA RISPOSTA NON DEVE MAI COMPARIRE' }],
        env: { MUFFIN_GATEWAY_TICK_MS: '300' },
      });
      try {
        const gateway = await inst.gateway();
        await gateway.waitFor(/muffin gateway/, 20_000);

        // --- (a) un job che ha qualcosa da dire.
        const parlante = await inst.muffin([
          'jobs',
          'add',
          '--cron',
          '0 8 * * *',
          '--channel',
          'cli',
          '--script',
          'echo "il sito non risponde"',
        ]);
        if (parlante.code !== 0) throw new Error(`jobs add --script: exit ${parlante.code}\n${parlante.err}`);

        const scaduto = (dove: string, valori: unknown[] = []): void => {
          // `inst.db` è in sola lettura: le scritture di scenario vogliono una
          // connessione propria, come in `lane-concurrency`.
          const w = new DatabaseCtor(join(inst.home, 'muffin.db'));
          w.prepare(`UPDATE jobs SET next_fire_at = ? ${dove}`).run(
            new Date(Date.now() - 60_000).toISOString(),
            ...valori,
          );
          w.close();
        };
        scaduto('');

        // Lo stdout dello script arriva all'owner sul canale del job.
        await gateway.waitFor(/il sito non risponde/, 40_000);

        // --- (b) IL PUNTO: il modello non è stato chiamato. Nemmeno una volta.
        expect(inst.provider.main()).toHaveLength(0);
        expect(`${gateway.stdout()}${gateway.stderr()}`).not.toContain('NON DEVE MAI COMPARIRE');

        // --- (c) il turno durevole esiste comunque: è ciò che tiene
        //     l'esattamente-una-volta e la visibilità. Ma dichiara di non aver
        //     speso niente.
        const turni = inst.db(
          (d) =>
            d.prepare(`SELECT model, counters, status FROM turns`).all() as Array<{
              model: string;
              counters: string;
              status: string;
            }>,
        );
        expect(turni).toHaveLength(1);
        expect(turni[0]?.model).toContain('script');
        expect(turni[0]?.status).toBe('done');
        const counters = JSON.parse(turni[0]?.counters ?? '{}') as {
          usage?: { inputTokens: number; outputTokens: number };
          spentUsd?: number;
        };
        expect(counters.usage?.inputTokens).toBe(0);
        expect(counters.usage?.outputTokens).toBe(0);
        expect(counters.spentUsd).toBe(0);

        // --- (d) un job che NON ha niente da dire non dice niente.
        const muto = await inst.muffin([
          'jobs',
          'add',
          '--cron',
          '0 9 * * *',
          '--channel',
          'cli',
          '--script',
          'true',
        ]);
        if (muto.code !== 0) throw new Error(`jobs add muto: exit ${muto.code}\n${muto.err}`);

        const prima = `${gateway.stdout()}${gateway.stderr()}`.length;
        scaduto(`WHERE goal = ?`, ['true']);

        // È girato: due turni, non uno.
        await until(() => inst.db((d) => (d.prepare(`SELECT COUNT(*) AS n FROM turns`).get() as { n: number }).n) === 2, 40_000);

        // E non ha consegnato niente: nessun messaggio vuoto all'owner.
        const dopo = `${gateway.stdout()}${gateway.stderr()}`;
        expect(dopo.slice(prima).trim()).toBe('');
        // Il modello continua a non essere mai stato chiamato.
        expect(inst.provider.main()).toHaveLength(0);

        await gateway.stop();
      } finally {
        await inst.cleanup();
      }
    },
    90_000,
  );
});
