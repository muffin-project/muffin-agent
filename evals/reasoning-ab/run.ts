/**
 * Pilot A/B sull'execution policy (issue #498): stessa domanda, tre modi di chiederla.
 *
 * Bracci, a parità di modello (`--model`, di default il main dell'installazione):
 *
 * - `A` — status quo: `adaptive` + `deterministic` (il profilo shipped, intatto);
 * - `B` — `adaptive` + `model-default` (nessuna temperature sul filo);
 * - `C` — `off` + `deterministic` (il default che la #498 vieta senza misura).
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

type Arm = 'A' | 'B' | 'C';
export const ARMS: Arm[] = ['A', 'B', 'C'];

export type TaskDef = {
  id: string;
  prompt: string;
  seed: (ws: string) => void;
  check: (ws: string, answer: string) => { pass: boolean; detail: string };
};

const RIGHE_CSV = [
  ['id', 'importo'],
  ...Array.from({ length: 20 }, (_, i) => [String(i + 1), String((i + 1) * 11)]),
];
const SOMMA_ATTESA = RIGHE_CSV.slice(1).reduce((n, r) => n + Number(r[1]), 0);

export const TASKS: TaskDef[] = [
  {
    id: 'T1-somma-csv',
    prompt: 'Leggi data/numeri.csv e scrivi data/somma.txt con la somma della colonna importo, solo il numero.',
    seed: (ws) => {
      mkdirSync(join(ws, 'data'), { recursive: true });
      writeFileSync(join(ws, 'data', 'numeri.csv'), `${RIGHE_CSV.map((r) => r.join(',')).join('\n')}\n`);
    },
    check: (ws, answer) => {
      let file = '';
      try {
        file = readFileSync(join(ws, 'data', 'somma.txt'), 'utf8').trim();
      } catch {
        return { pass: false, detail: `somma.txt assente; risposta: ${answer.slice(0, 160)}` };
      }
      return file === String(SOMMA_ATTESA)
        ? { pass: true, detail: `somma ${file}` }
        : { pass: false, detail: `file dice ${file}, atteso ${SOMMA_ATTESA}; risposta: ${answer.slice(0, 160)}` };
    },
  },
  {
    id: 'T1b-somma-csv-bis',
    prompt: 'Leggi data/numeri.csv e scrivi data/somma2.txt con la somma della colonna importo, solo il numero.',
    seed: (ws) => {
      mkdirSync(join(ws, 'data'), { recursive: true });
      writeFileSync(join(ws, 'data', 'numeri.csv'), `${RIGHE_CSV.map((r) => r.join(',')).join('\n')}\n`);
    },
    check: (ws, answer) => {
      let file = '';
      try {
        file = readFileSync(join(ws, 'data', 'somma2.txt'), 'utf8').trim();
      } catch {
        return { pass: false, detail: `somma2.txt assente; risposta: ${answer.slice(0, 160)}` };
      }
      return file === String(SOMMA_ATTESA)
        ? { pass: true, detail: `somma ${file}` }
        : { pass: false, detail: `file dice ${file}, atteso ${SOMMA_ATTESA}; risposta: ${answer.slice(0, 160)}` };
    },
  },
  {
    id: 'T2-report-txt',
    prompt: 'Conta le righe di ogni .txt in docs/ e scrivi report.txt con una riga per file "nome: N righe" più una riga finale "totale: M righe".',
    seed: (ws) => {
      mkdirSync(join(ws, 'docs'), { recursive: true });
      writeFileSync(join(ws, 'docs', 'a.txt'), 'uno\ndue\ntre\n');
      writeFileSync(join(ws, 'docs', 'b.txt'), 'uno\n');
      writeFileSync(join(ws, 'docs', 'c.txt'), 'uno\ndue\ntre\nquattro\ncinque\n');
    },
    check: (ws, answer) => {
      let file = '';
      try {
        file = readFileSync(join(ws, 'report.txt'), 'utf8');
      } catch {
        return { pass: false, detail: `report.txt assente; risposta: ${answer.slice(0, 160)}` };
      }
      const ok = file.includes('a.txt') && file.includes('3') && file.includes('b.txt') && file.includes('totale');
      return ok
        ? { pass: true, detail: 'report con nomi, conteggi e totale' }
        : { pass: false, detail: `report incompleto: ${file.slice(0, 200)}` };
    },
  },
  {
    id: 'T3-spiega-script',
    prompt: 'In due righe al massimo: cosa fa lo script operazioni.py?',
    seed: (ws) => {
      writeFileSync(join(ws, 'operazioni.py'), 'import sys\n\ndef raddoppia(numeri):\n    return [n * 2 for n in numeri]\n\nif __name__ == "__main__":\n    print(raddoppia([1, 2, 3]))\n');
    },
    check: (_ws, answer) => {
      const a = answer.toLowerCase();
      const ok = a.includes('raddoppia') || (a.includes('doppi') && a.includes('lista'));
      return ok
        ? { pass: true, detail: 'descrive il raddoppio' }
        : { pass: false, detail: `non descrive: ${answer.slice(0, 200)}` };
    },
  },
];

export type Row = {
  arm: Arm;
  task: string;
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
  baseUrl: string,
  apiKey: string,
  out: (l: string) => void,
  maxUsd: number,
  signalMs: number,
): Promise<Row[]> {
  const home = mkdtempSync(join(tmpdir(), 'muffin-ab-home-'));
  const ws = mkdtempSync(join(tmpdir(), 'muffin-ab-ws-'));
  try {
    runInit({ home, apiKey, provider: 'openai-compat', baseUrl, mainModel: model, lightModel: model });
    if (arm === 'C') {
      const cfg = loadConfig(home);
      saveConfig({ ...cfg, thinking: 'off' }, home);
    }
    const runtime: Runtime = buildRuntime(home, ws);
    if (arm === 'B') {
      // Solo campionamento di default del provider: il profilo shipped resta
      // quello selezionato, cambia solo la manopola che manda temperature.
      runtime.deps.profile = { ...runtime.deps.profile, sampling: 'model-default' };
    }
    let asks = 0;
    runtime.approvers.set('cli', async () => {
      asks += 1;
      return 'allow';
    });
    const rows: Row[] = [];
    for (const task of TASKS) {
      if (runtime.budget.monthToDateUsd() > maxUsd) {
        out(`tetto $${maxUsd} superato: stop`);
        break;
      }
      task.seed(ws);
      const session = runtime.deps.sessions.open(`ab-${arm}-${task.id}`);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), signalMs);
      const t0 = Date.now();
      let outcome = '';
      let text = '';
      try {
        const result = await runTurn(
          runtime.deps,
          { principal: { ...OWNER }, tenant: 'host', surface: 'cli', session, text: task.prompt, signal: ctrl.signal },
        );
        outcome = result.stopped;
        text = result.text;
        const row = runtime.deps.turns.get(result.turnId);
        const c = row?.counters;
        const chk = task.check(ws, text);
        rows.push({
          arm,
          task: task.id,
          pass: chk.pass && outcome === 'answered',
          detail: chk.detail,
          outcome,
          iterations: c?.iterations ?? -1,
          toolCalls: c?.toolCallsMade ?? -1,
          recoveries: c?.recoveriesUsed ?? -1,
          asks,
          inputTokens: c?.usage.inputTokens ?? -1,
          outputTokens: c?.usage.outputTokens ?? -1,
          spentUsd: c?.spentUsd ?? -1,
          wallMs: Date.now() - t0,
        });
      } catch (error) {
        rows.push({
          arm,
          task: task.id,
          pass: false,
          detail: `throw: ${error instanceof Error ? error.message : String(error)}`,
          outcome: 'threw',
          iterations: -1,
          toolCalls: -1,
          recoveries: -1,
          asks,
          inputTokens: -1,
          outputTokens: -1,
          spentUsd: -1,
          wallMs: Date.now() - t0,
        });
      } finally {
        clearTimeout(timer);
      }
      asks = 0;
      out(`${arm} ${task.id}: ${rows[rows.length - 1]?.pass === true ? 'PASS' : 'FAIL'} (${rows[rows.length - 1]?.detail})`);
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
  const head = '| braccio | task | esito | iter | tool | rec | ask | in | out | $ | muro_ms |';
  const lines = [head, '|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    lines.push(
      `| ${r.arm} | ${r.task} | ${r.pass ? 'PASS' : 'FAIL'} (${r.outcome}) | ${r.iterations} | ${r.toolCalls} | ${r.recoveries} | ${r.asks} | ${r.inputTokens} | ${r.outputTokens} | ${r.spentUsd.toFixed(4)} | ${r.wallMs} |`,
    );
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      model: { type: 'string' },
      'base-url': { type: 'string' },
      'api-key-env': { type: 'string', default: 'MUFFIN_AB_KEY' },
      arms: { type: 'string', default: 'A,B,C' },
      'max-usd': { type: 'string', default: '2' },
      'signal-ms': { type: 'string', default: `${6 * 60_000}` },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const install = loadConfig(muffinHome());
  const model = values.model ?? install.models.main;
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
    rows.push(...(await runArm(arm, model, baseUrl, key, out, maxUsd, signalMs)));
  }
  out('');
  out(table(rows));
  const tot = rows.reduce((n, r) => n + (r.spentUsd > 0 ? r.spentUsd : 0), 0);
  out(`\nspesa turni: $${tot.toFixed(4)} ( consolidation light inclusa nelle home usa-e-getta, rimosse)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
