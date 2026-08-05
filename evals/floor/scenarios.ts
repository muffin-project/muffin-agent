import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RegisteredTool } from '../../agent/loop.js';
import type { TurnResult } from '../../agent/loop.js';

/**
 * The capability floor.
 *
 * This is the contract the harness declares to the model: how many tools it
 * puts in front of it, how long a chain it expects it to hold, how much context
 * has to stay usable, and what it must recover from unaided. A capability that
 * only works above the floor is a capability that quietly requires a frontier
 * model — and then "runs locally" becomes a label, which is exactly the failure
 * the previous Muffin lived with.
 *
 * Few scenarios, each multi-turn and realistic, rather than a sweep of
 * micro-probes: a hundred one-shot checks measure prompt formatting, and the
 * thing that actually breaks is holding a thread across four tool calls.
 */

export type ScenarioContext = {
  result: TurnResult;
  /** Every tool invocation in order, as the loop actually made them. */
  toolCalls: { name: string; args: Record<string, unknown> }[];
  workDir: string;
  read: (relative: string) => string | null;
};

export type Verdict = { pass: boolean; why: string };

export type Scenario = {
  id: string;
  /** Which dimension of the floor this one is evidence for. */
  dimension: 'sequencing' | 'breadth' | 'recovery' | 'horizon' | 'context' | 'abstention';
  seed(dir: string): void;
  prompt: string;
  /** Extra tools, for the scenarios that measure breadth or failure handling. */
  extraTools?: RegisteredTool[];
  check(ctx: ScenarioContext): Verdict;
};

const called = (ctx: ScenarioContext, name: string) => ctx.toolCalls.filter((c) => c.name === name).length;

/** Filler that is plainly filler, so a hit on the planted facts is not luck. */
function padding(lines: number, tag: string): string {
  return Array.from(
    { length: lines },
    (_, i) => `${tag} riga ${i + 1}: nota di servizio senza contenuto rilevante, archiviata per completezza.`,
  ).join('\n');
}

/** Tools that exist only to crowd the surface, and must not be called. */
function decoyTools(names: string[]): RegisteredTool[] {
  return names.map((name) => ({
    capability: 'fs.read',
    spec: {
      name,
      description: `Strumento ausiliario "${name}", non pertinente ai compiti di questa sessione.`,
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    },
    handler: () => ({ content: `${name}: nessun risultato.` }),
  }));
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'sequencing',
    dimension: 'sequencing',
    seed(dir) {
      writeFileSync(
        join(dir, 'verbale.md'),
        [
          'Riunione del 12 marzo.',
          'Presenti: Anna, Luca, Sara.',
          'Decisioni: rimandare il lancio a maggio.',
          'Luca prepara il budget entro venerdì.',
          'Sara verifica chi parla col fornitore entro lunedì.',
        ].join('\n'),
      );
    },
    prompt:
      'Leggi verbale.md e scrivi in azioni.md solo le azioni con un responsabile, una per riga. Poi dimmi quante ne hai trovate.',
    check(ctx) {
      const written = ctx.read('azioni.md');
      if (called(ctx, 'fs_read') === 0) return { pass: false, why: 'non ha letto il file' };
      if (!written) return { pass: false, why: 'azioni.md non è stato scritto' };
      const hasLuca = /luca/i.test(written);
      const hasSara = /sara/i.test(written);
      // The decision without an owner must not be there: following the
      // instruction matters more than filling the page.
      const leakedDecision = /lancio.*maggio/i.test(written);
      if (!hasLuca || !hasSara) return { pass: false, why: 'mancano azioni (Luca e/o Sara)' };
      if (leakedDecision) return { pass: false, why: 'ha incluso una decisione senza responsabile' };
      return { pass: true, why: `azioni.md corretto in ${ctx.result.iterations} passaggi` };
    },
  },

  {
    id: 'breadth',
    dimension: 'breadth',
    extraTools: decoyTools([
      'calendar_lookup',
      'weather_now',
      'unit_convert',
      'currency_rate',
      'spell_check',
      'timezone_diff',
      'random_pick',
    ]),
    seed(dir) {
      writeFileSync(join(dir, 'spesa.txt'), 'pane 2.40\nlatte 1.15\ncaffe 4.90\n');
    },
    prompt: 'Quanto ho speso in totale secondo spesa.txt? Scrivi il totale in totale.txt e dimmelo.',
    check(ctx) {
      // Ten tools in front of it, three of them relevant. Picking wrong ones is
      // the failure mode that shows up first when the surface grows.
      const decoys = ctx.toolCalls.filter((c) => !c.name.startsWith('fs_'));
      const written = ctx.read('totale.txt');
      if (decoys.length > 0) return { pass: false, why: `ha chiamato tool non pertinenti: ${decoys.map((d) => d.name).join(', ')}` };
      if (!written) return { pass: false, why: 'totale.txt non scritto' };
      if (!/8[.,]45/.test(written) && !/8[.,]45/.test(ctx.result.text)) {
        return { pass: false, why: `totale sbagliato: "${written.trim()}"` };
      }
      return { pass: true, why: 'ha usato solo i tool pertinenti e ha calcolato 8.45' };
    },
  },

  {
    id: 'recovery',
    dimension: 'recovery',
    extraTools: [
      {
        capability: 'fs.read',
        spec: {
          name: 'fetch_report',
          description:
            'Scarica un report per data. Il parametro `date` va in formato ISO (YYYY-MM-DD).',
          inputSchema: {
            type: 'object',
            properties: { date: { type: 'string' } },
            required: ['date'],
          },
        },
        handler: (() => {
          // The failure has to be unavoidable, not hoped for. A first attempt
          // that fails only when the model formats the date badly measures
          // nothing on a model that formats it correctly — which is what the
          // first version of this scenario got wrong.
          let attempts = 0;
          return (args: unknown) => {
            attempts += 1;
            const date = String((args as { date?: unknown }).date ?? '');
            if (attempts === 1) {
              return {
                content: 'Errore temporaneo: servizio non raggiungibile (503). Riprova la stessa richiesta.',
                isError: true,
              };
            }
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
              return { content: `Errore: date="${date}" non è ISO. Usa YYYY-MM-DD.`, isError: true };
            }
            return { content: `Report ${date}: fatturato 12400 euro, ordini 87.` };
          };
        })(),
      },
    ],
    seed() {
      /* nothing on disk: the point is the failing tool */
    },
    prompt: 'Prendi il report del 12 marzo 2026 e dimmi quanti ordini ci sono stati.',
    check(ctx) {
      const attempts = called(ctx, 'fetch_report');
      if (attempts < 2) return { pass: false, why: `ha chiamato fetch_report ${attempts} volte: non ha ritentato` };
      if (!/87/.test(ctx.result.text)) return { pass: false, why: 'non ha riportato 87 ordini' };
      return { pass: true, why: `ha corretto il formato da solo dopo ${attempts} tentativi` };
    },
  },

  {
    id: 'horizon',
    dimension: 'horizon',
    seed(dir) {
      // Eight files: enough sequential calls to lose the thread, few enough to
      // stay inside the floor's 15.
      for (let i = 1; i <= 8; i++) {
        writeFileSync(join(dir, `nota-${i}.txt`), i === 5 ? 'URGENTE: chiamare il commercialista.\n' : `Nota ordinaria numero ${i}.\n`);
      }
    },
    prompt:
      'Nella directory ci sono file nota-1.txt … nota-8.txt. Aprili tutti e dimmi in quale c\'è la parola URGENTE. Scrivi il nome del file in trovato.txt.',
    check(ctx) {
      const reads = called(ctx, 'fs_read');
      const written = ctx.read('trovato.txt');
      if (reads < 8) return { pass: false, why: `ha letto solo ${reads} file su 8` };
      if (!written || !/nota-5/.test(written)) return { pass: false, why: `trovato.txt sbagliato o assente` };
      return { pass: true, why: `ha tenuto il filo per ${ctx.result.iterations} passaggi` };
    },
  },

  {
    id: 'context',
    dimension: 'context',
    seed(dir) {
      // The two facts sit at the extremes of a long file: recall in the middle
      // is easy, recall at the edges is what degrades first.
      writeFileSync(
        join(dir, 'archivio.txt'),
        [
          'CODICE DEPOSITO: ZK-4417',
          padding(600, 'A'),
          padding(600, 'B'),
          'REFERENTE MAGAZZINO: Piera Onnis',
        ].join('\n'),
      );
    },
    prompt: 'Leggi archivio.txt e dimmi il codice deposito e il nome del referente magazzino.',
    check(ctx) {
      const answer = ctx.result.text;
      const code = /ZK-?4417/i.test(answer);
      const name = /onnis/i.test(answer);
      if (!code && !name) return { pass: false, why: 'non ha recuperato nessuno dei due fatti' };
      if (!code) return { pass: false, why: 'ha perso il fatto in testa al file' };
      if (!name) return { pass: false, why: 'ha perso il fatto in coda al file' };
      return { pass: true, why: 'ha recuperato entrambi gli estremi' };
    },
  },

  {
    id: 'abstention',
    dimension: 'abstention',
    seed(dir) {
      writeFileSync(join(dir, 'clienti.csv'), 'nome,citta\nAnna,Cagliari\nLuca,Milano\n');
    },
    prompt: 'Dimmi qual è il fatturato di Anna nel 2025 secondo clienti.csv.',
    check(ctx) {
      const answer = ctx.result.text.toLowerCase();
      // Inventing a number here is worse than refusing: it produces misplaced
      // trust, which is the failure the whole project is built against.
      const invented = /\d[\d.,]*\s*(euro|€|k\b)/.test(answer);
      const admits = /non c'è|non ci sono|non contiene|nessun|non è presente|non risulta|non posso|non trovo/.test(answer);
      if (invented) return { pass: false, why: 'ha inventato una cifra che nel file non c\'è' };
      if (!admits) return { pass: false, why: 'non ha detto chiaramente che il dato non esiste' };
      return { pass: true, why: 'ha detto che il dato non c\'è invece di inventarlo' };
    },
  },
];
