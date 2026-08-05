import DatabaseCtor from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

/**
 * The M2 definition of done, run as it is written (04 §M2).
 *
 * Three properties, and the way they are tested is the point:
 *
 *  1. **Every turn is a separate process.** Not a loop in one runtime with a
 *     `close()` in the middle — an actual `spawnSync`, so nothing survives in
 *     memory between turns and persistence is the only explanation for a
 *     correct answer.
 *  2. **Every question opens a fresh session.** With one session the answer
 *     could come from the transcript, which would prove nothing about memory.
 *     A new session id means recall is the only path from the question to Marco.
 *  3. **State is asserted in SQL, not in prose.** "Lucia" appearing in a reply
 *     is weak evidence; `expired_at` set and `superseded_by` pointing at the new
 *     fact is the thing that has to be true. Both are checked, in that order of
 *     authority.
 *
 *   tsx evals/memory/acceptance.ts
 *   tsx evals/memory/acceptance.ts --keep          # leave the home for poking at
 *   tsx evals/memory/acceptance.ts --model qwen/qwen3.6-27b
 */

const { values } = parseArgs({
  options: {
    home: { type: 'string' },
    model: { type: 'string' },
    'light-model': { type: 'string' },
    'base-url': { type: 'string' },
    keep: { type: 'boolean' },
  },
});

const apiKey = process.env['LLM_API_KEY'] ?? process.env['OPENROUTER_API_KEY'] ?? '';
if (apiKey === '') {
  process.stderr.write("serve LLM_API_KEY (o OPENROUTER_API_KEY) nell'ambiente\n");
  process.exit(78);
}

const HOME = values.home ?? mkdtempSync(join(tmpdir(), 'muffin-accept-'));
const MODEL = values.model ?? 'anthropic/claude-sonnet-5';
const LIGHT = values['light-model'] ?? 'anthropic/claude-haiku-4.5';
const BASE_URL = values['base-url'] ?? 'https://openrouter.ai/api/v1';
const CLI = join(import.meta.dirname, '..', '..', 'cli', 'main.ts');

const ACCOUNTANT = 'Marco Serra';
const SUCCESSOR = 'Lucia Deiana';

type Step = { label: string; ok: boolean; detail: string; ms: number };
const steps: Step[] = [];
let turns = 0;

/** One CLI invocation = one process. Returns stdout, stderr and the exit code. */
function muffin(args: string[]): { code: number; out: string; err: string } {
  const result = spawnSync('npx', ['tsx', CLI, ...args], {
    env: { ...process.env, MUFFIN_HOME: HOME },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return { code: result.status ?? -1, out: result.stdout ?? '', err: result.stderr ?? '' };
}

/** A question in a session of its own: the transcript cannot be the answer. */
function ask(question: string, session: string): string {
  turns += 1;
  const r = muffin(['run', question, '--session', session]);
  if (r.code !== 0) throw new Error(`"${question}" è uscito con ${r.code}: ${r.err.slice(-400)}`);
  return r.out.trim();
}

function record(label: string, started: number, ok: boolean, detail: string): void {
  steps.push({ label, ok, detail, ms: Date.now() - started });
  process.stderr.write(`${ok ? '✓' : '✗'} ${label.padEnd(34)} ${detail}\n`);
}

function db(): DatabaseCtor.Database {
  return new DatabaseCtor(join(HOME, 'muffin.db'), { readonly: true });
}

type FactRow = {
  id: number;
  object_value: string;
  expired_at: string | null;
  superseded_by: number | null;
  episode_id: number;
};

/** Any fact whose object names the person — the predicate the model chose is its business. */
function factsAbout(who: string): FactRow[] {
  const conn = db();
  try {
    return conn
      .prepare(
        `SELECT id, object_value, expired_at, superseded_by, episode_id
           FROM facts WHERE tenant_id = 'host' AND object_value LIKE ?
          ORDER BY id`,
      )
      .all(`%${who.split(' ')[0]}%`) as FactRow[];
  } finally {
    conn.close();
  }
}

process.stderr.write(`accettazione M2 · ${MODEL} + ${LIGHT}\nhome: ${HOME}\n\n`);

try {
  // ---- setup ----------------------------------------------------------------
  let t = Date.now();
  const init = muffin([
    'init', '--provider', 'openai-compat', '--base-url', BASE_URL,
    '--model', MODEL, '--light-model', LIGHT, '--api-key', apiKey,
  ]);
  record('init', t, init.code === 0, init.code === 0 ? 'home creata e sigillata' : init.err.slice(-200));
  if (init.code !== 0) process.exit(2);

  // ---- 1. tell it something --------------------------------------------------
  t = Date.now();
  ask(`${ACCOUNTANT} è il mio commercialista, lo vedo giovedì`, 's1-dico');
  const extract1 = muffin(['memory', 'extract']);
  const marcoFacts = factsAbout(ACCOUNTANT);
  record(
    'estrazione dal primo turno',
    t,
    marcoFacts.length > 0,
    marcoFacts.length > 0 ? extract1.out.trim() : 'nessun fatto su Marco estratto',
  );

  // ---- 2. new process, new session: only memory can answer -------------------
  t = Date.now();
  const answer1 = ask('chi è il mio commercialista?', 's2-chiedo');
  const knows = /marco/i.test(answer1);
  record('ricorda dopo il riavvio', t, knows, knows ? answer1.slice(0, 90) : `risposta: ${answer1.slice(0, 120)}`);

  // ---- 3. change of mind -----------------------------------------------------
  t = Date.now();
  ask(`ho cambiato commercialista: ora è ${SUCCESSOR}`, 's3-cambio');
  muffin(['memory', 'extract']);
  const after = factsAbout(ACCOUNTANT);
  const retired = after.find((f) => f.expired_at !== null && f.superseded_by !== null);
  const luciaFacts = factsAbout(SUCCESSOR).filter((f) => f.expired_at === null);
  const bitemporal = retired !== undefined && luciaFacts.length > 0;
  record(
    'supersede bi-temporale',
    t,
    bitemporal,
    bitemporal
      ? `fatto #${retired!.id} ritirato il ${retired!.expired_at?.slice(0, 10)} → #${retired!.superseded_by}`
      : `Marco attivi: ${after.filter((f) => f.expired_at === null).length}, Lucia attivi: ${luciaFacts.length}`,
  );

  // ---- 4. the current answer -------------------------------------------------
  t = Date.now();
  const answer2 = ask('chi è il mio commercialista adesso?', 's4-adesso');
  const current = /lucia/i.test(answer2);
  record('risponde col fatto corrente', t, current, answer2.slice(0, 90));

  // ---- 5. the retired belief is still answerable ------------------------------
  t = Date.now();
  const answer3 = ask('e prima di lei, chi era il mio commercialista?', 's5-prima');
  const historical = /marco/i.test(answer3);
  record('risponde col fatto ritirato', t, historical, answer3.slice(0, 90));

  // ---- 6. provenance is a foreign key, not a story ----------------------------
  t = Date.now();
  const target = retired ?? marcoFacts[0];
  let whyOk = false;
  let whyDetail = 'nessun fatto su cui chiedere why';
  if (target) {
    const why = muffin(['memory', 'why', String(target.id)]);
    whyOk = why.code === 0 && /commercialista/i.test(why.out) && /episodio #\d+/.test(why.out);
    whyDetail = whyOk
      ? (why.out.split('\n').find((l) => l.includes('da episodio')) ?? '').trim()
      : why.out.slice(0, 160) || why.err.slice(0, 160);
  }
  record('why mostra l’episodio di origine', t, whyOk, whyDetail);

  // ---- 7. the graph is not corrupt --------------------------------------------
  t = Date.now();
  const check = muffin(['memory', 'check']);
  record('invarianti del grafo', t, check.code === 0, check.out.trim().split('\n')[0] ?? '');

  // ---- 8. the semantic half actually ran --------------------------------------
  t = Date.now();
  const stats = muffin(['memory', 'stats']);
  const vectorLine = stats.out.split('\n').find((l) => l.startsWith('indice vett.')) ?? '';
  const chunks = Number(/(\d+) chunk/.exec(vectorLine)?.[1] ?? 0);
  const vecs = Number(/(\d+) vettori/.exec(vectorLine)?.[1] ?? 0);
  // Zero here does not fail the run: without Ollama recall is text-only by
  // design. It fails only if chunks exist without vectors, which is the silent
  // corruption case.
  const vectorsOk = chunks === vecs;
  record(
    'indice vettoriale coerente',
    t,
    vectorsOk,
    chunks === 0 ? 'nessun embedder: recall solo testuale (dichiarato)' : vectorLine.replace(/\s+/g, ' '),
  );
} finally {
  const failed = steps.filter((s) => !s.ok);
  const seconds = (steps.reduce((s, x) => s + x.ms, 0) / 1000).toFixed(1);
  process.stderr.write(
    `\n${steps.length - failed.length}/${steps.length} · ${turns} turni in processi separati · ${seconds}s\n`,
  );
  if (failed.length > 0) process.stderr.write(`NON superato: ${failed.map((f) => f.label).join(', ')}\n`);
  if (values.keep) process.stderr.write(`home tenuta: ${HOME}\n`);
  else if (!values.home) rmSync(HOME, { recursive: true, force: true });
  process.exitCode = failed.length === 0 ? 0 : 1;
}
