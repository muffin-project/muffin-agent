/**
 * Pilot A/B sull'execution policy (issue #498): stessa domanda, tre modi di chiederla.
 *
 * Bracci, a parità di modello (`--model`, di default il main dell'installazione;
 * `--light-model` di default il light):
 *
 * - `A` — status quo Qwen: `adaptive` + `deterministic` (profilo intatto);
 * - `C` — `off` + `deterministic`;
 * - `T0` — profilo intatto (il comportamento di oggi per il modello sotto test);
 * - `DEF` — campionamento di default del provider;
 * - `T07` — temperature esplicita 0.7 dal nuovo vocabolario dei profili.
 *
 * (`B` — `adaptive` + `model-default` su Qwen — misurato nel round 1:
 * indistinguibile da A. `DEF` ne è il gemello generico.)
 *
 * Il quarto braccio della issue (`low/bounded reasoning`) non è esprimibile:
 * `ReasoningRequest.effort/maxTokens` non ha superficie in profilo/config
 * (solo `mode`), quindi non c'è manopola da girare — finding registrato, non
 * misurabile qui.
 *
 * Ogni braccio gira su home + workspace usa-e-getta (`runInit`, mai
 * `~/.muffin`), provider OpenRouter vero, tool veri su file fixture generati
 * qui dentro, approver che permette tutto e annota gli ask. Metriche dalle
 * righe `turns` che il turno scrive da sé (niente seconda contabilità):
 * iterazioni, tool call, recovery, esito, token, spesa, muro.
 *
 * Chiave: solo da `--api-key-env` (mai argv, mai disco fuori dalla home
 * usa-e-getta che si cancella alla fine — stesso patto di
 * `evals/character/con-la-chiave.ts`). `--max-usd` ferma tutto sopra soglia.
 * `--dry-run` stampa il piano senza rete.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runInit } from '../../cli/init.js';
import { loadConfig, muffinHome, saveConfig } from '../../core/config/config.js';
import { runTurn } from '../../agent/loop.js';
import { buildRuntime, type Runtime } from '../../agent/runtime.js';

type Arm = 'A' | 'C' | 'T0' | 'DEF' | 'T07';
export const ARMS: Arm[] = ['A', 'C', 'T0', 'DEF', 'T07'];

/**
 * Cosa cambia ogni braccio rispetto al profilo shipped, applicato dopo
 * `buildRuntime` (misura, non configurazione installata):
 *
 * - A/C: i bracci Qwen (thinking via config, sampling dal profilo);
 * - T0: profilo intatto (il comportamento di oggi per il modello sotto test);
 * - DEF: solo campionamento di default del provider;
 * - T07: temperature esplicita dal nuovo vocabolario dei profili.
 */
const ARM_THINKING: Partial<Record<Arm, 'off'>> = { C: 'off' };
const ARM_SAMPLING: Partial<Record<Arm, 'model-default' | { temperature: number }>> = {
  DEF: 'model-default',
  T07: { temperature: 0.7 },
};

type TaskDef = {
  id: string;
  /** I turni in sequenza, stessa sessione: dal secondo in poi servono la history. */
  turns: string[];
  /** Repliche a sessioni fresche: separano segnale da rumore. */
  reps: number;
  seed: (ws: string) => void;
  /**
   * Giudizio meccanico, mai un LLM (che si lascia convincere dal tono).
   * `answers` una per turno; `toolCallsPerTurn` dice se il modello ha
   * riusato la conversazione o è tornato sul disco.
   */
  check: (ws: string, answers: string[], toolCallsPerTurn: number[]) => { pass: boolean; detail: string };
};

const RIGHE_CSV = [
  ['id', 'importo'],
  ...Array.from({ length: 20 }, (_, i) => [String(i + 1), String((i + 1) * 11)]),
];
const SOMMA_ATTESA = RIGHE_CSV.slice(1).reduce((n, r) => n + Number(r[1]), 0);

export const TASKS: TaskDef[] = [
  {
    // Prima i conversazionali: se il tetto di spesa scatta, i dati nuovi
    // sopravvivono (gli ancoraggi file esistono già dal round 1).
    id: 'T3c-storia-senza-rilettura',
    turns: ['Leggi docs/a.txt ed elenca le righe.', 'Senza rileggere il file: qual era la seconda riga?'],
    reps: 2,
    seed: (ws) => {
      mkdirSync(join(ws, 'docs'), { recursive: true });
      writeFileSync(join(ws, 'docs', 'a.txt'), 'alfa\nbeta\ngamma\n');
      writeFileSync(join(ws, 'docs', 'b.txt'), 'uno\n');
    },
    check: (_ws, answers, toolCallsPerTurn) => {
      const seconda = answers[1] ?? '';
      const ricorda = seconda.toLowerCase().includes('beta');
      const riuso = (toolCallsPerTurn[1] ?? 1) === 0 ? 'senza rilettura' : 'rileggendo';
      return ricorda
        ? { pass: true, detail: `ricorda beta ${riuso}` }
        : { pass: false, detail: `dimentica la history (${riuso}): ${seconda.slice(0, 160)}` };
    },
  },
  {
    id: 'T4c-correzione-con-memoria',
    turns: ["Scrivi data/nota.txt con scritto 'bozza'.", "Cambialo in 'finale' e dimmi cosa c'era scritto prima."],
    reps: 2,
    seed: (ws) => {
      mkdirSync(join(ws, 'data'), { recursive: true });
    },
    check: (ws, answers, _toolCallsPerTurn) => {
      let file = '';
      try {
        file = readFileSync(join(ws, 'data', 'nota.txt'), 'utf8').trim();
      } catch {
        return { pass: false, detail: 'nota.txt assente' };
      }
      const seconda = answers[1] ?? '';
      return file === 'finale' && seconda.toLowerCase().includes('bozza')
        ? { pass: true, detail: 'finale su disco, bozza ricordata' }
        : { pass: false, detail: `file=${file}, ricorda-bozza=${seconda.toLowerCase().includes('bozza')}` };
    },
  },
  {
    id: 'T1-somma-csv',
    turns: ['Leggi data/numeri.csv e scrivi data/somma.txt con la somma della colonna importo, solo il numero.'],
    reps: 1,
    seed: (ws) => {
      mkdirSync(join(ws, 'data'), { recursive: true });
      writeFileSync(join(ws, 'data', 'numeri.csv'), `${RIGHE_CSV.map((r) => r.join(',')).join('\n')}\n`);
    },
    check: (ws, answers, _toolCallsPerTurn) => {
      let file = '';
      try {
        file = readFileSync(join(ws, 'data', 'somma.txt'), 'utf8').trim();
      } catch {
        return { pass: false, detail: `somma.txt assente; risposta: ${(answers[0] ?? '').slice(0, 160)}` };
      }
      return file === String(SOMMA_ATTESA)
        ? { pass: true, detail: `somma ${file}` }
        : { pass: false, detail: `file dice ${file}, atteso ${SOMMA_ATTESA}` };
    },
  },
  {
    id: 'T2-report-txt',
    turns: ['Conta le righe di ogni .txt in docs/ e scrivi report.txt con una riga per file "nome: N righe" più una riga finale "totale: M righe".'],
    reps: 1,
    seed: (ws) => {
      mkdirSync(join(ws, 'docs'), { recursive: true });
      writeFileSync(join(ws, 'docs', 'a.txt'), 'uno\ndue\ntre\n');
      writeFileSync(join(ws, 'docs', 'b.txt'), 'uno\n');
      writeFileSync(join(ws, 'docs', 'c.txt'), 'uno\ndue\ntre\nquattro\ncinque\n');
    },
    check: (ws, answers, _toolCallsPerTurn) => {
      void answers;
      let file = '';
      try {
        file = readFileSync(join(ws, 'report.txt'), 'utf8');
      } catch {
        return { pass: false, detail: 'report.txt assente' };
      }
      const ok = file.includes('a.txt') && file.includes('3') && file.includes('b.txt') && file.includes('totale');
      return ok ? { pass: true, detail: 'report con nomi, conteggi e totale' } : { pass: false, detail: `incompleto: ${file.slice(0, 200)}` };
    },
  },
];

export type Row = {
  arm: Arm;
  task: string;
  rep: number;
  pass: boolean;
  detail: string;
  outcome: string;
  iterations: number;
  toolCalls: number;
  recoveries: number;
  asks: number;
  inputTokens: number;
  outputTokens: number;
  spentUsd: number;
  wallMs: number;
};

const OWNER = { kind: 'owner', connector: 'cli', externalId: 'ab-pilot' } as const;

async function runArm(
  arm: Arm,
  model: string,
  lightModel: string,
  baseUrl: string,
  apiKey: string,
  out: (l: string) => void,
  maxUsd: number,
  signalMs: number,
): Promise<Row[]> {
  const home = mkdtempSync(join(tmpdir(), 'muffin-ab-home-'));
  const ws = mkdtempSync(join(tmpdir(), 'muffin-ab-ws-'));
  try {
    runInit({ home, apiKey, provider: 'openai-compat', baseUrl, mainModel: model, lightModel });
    if (ARM_THINKING[arm] !== undefined) {
      const cfg = loadConfig(home);
      saveConfig({ ...cfg, thinking: ARM_THINKING[arm] }, home);
    }
    const runtime: Runtime = buildRuntime(home, ws);
    if (ARM_SAMPLING[arm] !== undefined) {
      runtime.deps.profile = { ...runtime.deps.profile, sampling: ARM_SAMPLING[arm] };
    }
    let asks = 0;
    runtime.approvers.set('cli', async () => {
      asks += 1;
      return 'allow';
    });
    const rows: Row[] = [];
    for (const task of TASKS) {
      for (let rep = 1; rep <= task.reps; rep += 1) {
        if (runtime.budget.monthToDateUsd() > maxUsd) {
          out(`tetto $${maxUsd} superato: stop`);
          break;
        }
        task.seed(ws);
        const session = runtime.deps.sessions.open(`ab-${arm}-${task.id}-r${rep}`);
        const answers: string[] = [];
        const callsPerTurn: number[] = [];
        let outcome = '';
        let iters = 0;
        let tools = 0;
        let recs = 0;
        let input = 0;
        let output = 0;
        let spent = 0;
        let wall = 0;
        let threw: string | null = null;
        for (const prompt of task.turns) {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), signalMs);
          const t0 = Date.now();
          try {
            const result = await runTurn(
              runtime.deps,
              { principal: { ...OWNER }, tenant: 'host', surface: 'cli', session, text: prompt, signal: ctrl.signal },
            );
            outcome = result.stopped;
            answers.push(result.text);
            const row = runtime.deps.turns.get(result.turnId);
            const c = row?.counters;
            callsPerTurn.push(c?.toolCallsMade ?? -1);
            iters += c?.iterations ?? 0;
            tools += c?.toolCallsMade ?? 0;
            recs += c?.recoveriesUsed ?? 0;
            input += c?.usage.inputTokens ?? 0;
            output += c?.usage.outputTokens ?? 0;
            spent += c?.spentUsd ?? 0;
          } catch (error) {
            threw = error instanceof Error ? error.message : String(error);
            outcome = 'threw';
            break;
          } finally {
            clearTimeout(timer);
            wall += Date.now() - t0;
          }
        }
        const chk = threw !== null ? { pass: false, detail: `throw: ${threw}` } : task.check(ws, answers, callsPerTurn);
        rows.push({
          arm,
          task: task.id,
          rep,
          pass: chk.pass && outcome === 'answered',
          detail: chk.detail,
          outcome,
          iterations: iters,
          toolCalls: tools,
          recoveries: recs,
          asks,
          inputTokens: input,
          outputTokens: output,
          spentUsd: spent,
          wallMs: wall,
        });
        asks = 0;
        const last = rows[rows.length - 1];
        out(`${arm} ${task.id} r${rep}: ${last?.pass === true ? 'PASS' : 'FAIL'} (${last?.detail})`);
      }
    }
    out(`spesa cumulata home: $${runtime.budget.monthToDateUsd().toFixed(4)}`);
    runtime.close();
    return rows;
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
}

export function table(rows: Row[]): string {
  const head = '| braccio | task | rep | esito | iter | tool | rec | ask | in | out | $ | muro_ms |';
  const lines = [head, '|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    lines.push(
      `| ${r.arm} | ${r.task} | ${r.rep} | ${r.pass ? 'PASS' : 'FAIL'} (${r.outcome}) | ${r.iterations} | ${r.toolCalls} | ${r.recoveries} | ${r.asks} | ${r.inputTokens} | ${r.outputTokens} | ${r.spentUsd.toFixed(4)} | ${r.wallMs} |`,
    );
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      model: { type: 'string' },
      'light-model': { type: 'string' },
      'base-url': { type: 'string' },
      'api-key-env': { type: 'string', default: 'MUFFIN_AB_KEY' },
      arms: { type: 'string', default: 'A,C' },
      'max-usd': { type: 'string', default: '1' },
      'signal-ms': { type: 'string', default: `${6 * 60_000}` },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const install = loadConfig(muffinHome());
  const model = values.model ?? install.models.main;
  const lightModel = values['light-model'] ?? install.models.light;
  const baseUrl = values['base-url'] ?? install.provider.baseUrl ?? 'https://openrouter.ai/api/v1';
  const arms = String(values.arms)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s): s is Arm => (ARMS as string[]).includes(s));
  const maxUsd = Number(values['max-usd']);
  const signalMs = Number(values['signal-ms']);
  const out = (l: string): void => {
    process.stdout.write(`${l}\n`);
  };

  out(`# A/B execution policy — modello ${model}`);
  out(`bracci: ${arms.join(', ')} · task: ${TASKS.map((t) => t.id).join(', ')} · tetto $${maxUsd} · timeout turno ${signalMs}ms`);
  if (values['dry-run']) {
    out('(dry-run: nessun turno, nessuna rete)');
    return;
  }
  const key = process.env[values['api-key-env'] as string];
  if (!key) {
    process.stderr.write(`manca ${values['api-key-env']} nell'ambiente (chiave mai in argv)\n`);
    process.exit(78);
  }
  const rows: Row[] = [];
  for (const arm of arms) {
    out(`## braccio ${arm}`);
    rows.push(...(await runArm(arm, model, lightModel, baseUrl, key, out, maxUsd, signalMs)));
  }
  out('');
  out(table(rows));
  const tot = rows.reduce((n, r) => n + (r.spentUsd > 0 ? r.spentUsd : 0), 0);
  out(`\nspesa turni: $${tot.toFixed(4)} ( consolidation light inclusa nelle home usa-e-getta, rimosse)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
