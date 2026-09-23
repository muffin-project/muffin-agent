import DatabaseCtor from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { runTurn, type RegisteredTool } from '../../agent/loop.js';
import { loadProfiles, selectProfile } from '../../agent/profiles/profile.js';
import { OpenAICompatProvider } from '../../agent/providers/openai-compat.js';
import { fsCapabilities, makeFsTools, type FsScope } from '../../agent/tools/fs.js';
import { BudgetEngine } from '../../core/budget/budget.js';
import { createDecide } from '../../core/policy/decide.js';
import { POLICY_FLOOR } from '../../core/policy/matrix.js';
import type { CapabilityDecl } from '../../core/policy/types.js';
import { loadConfig, readSecret } from '../../core/config/config.js';
import { SessionStore } from '../../core/session/store.js';
import { TurnStore } from '../../core/turns/store.js';
import { TodoStore } from '../../core/turns/todo.js';
import { JsonlExporter, SimpleTracer } from '../../core/tracing/tracer.js';
import { SCENARIOS, crowdTools, type Scenario, type Verdict } from './scenarios.js';


/**
 * One prompt for both classes: the floor eval measures tool-calling, not
 * posture, and a scenario that ever runs as a member is measured against
 * something rather than crashing on a missing key. One constant so the two
 * entries cannot drift.
 */
const FLOOR_PROMPT =
  'Sei Muffin. Hai dei tool: usali invece di dire che lo faresti. ' +
  'Se un tool fallisce o un dato non esiste, dillo — non inventare. ' +
  'Quando hai finito, rispondi e basta.';

/**
 * Floor runner.
 *
 * Runs the real loop against a real model — no mocks, because the thing being
 * measured is precisely what a mock would paper over. Deliberately cheap to
 * run once and explicit about what it costs: the point is a few honest runs,
 * not a sweep.
 *
 *   tsx evals/floor/run.ts --model anthropic/claude-sonnet-5
 *   tsx evals/floor/run.ts --model qwen/qwen3.6-27b --only recovery,horizon
 *   tsx evals/floor/run.ts --model X --reps 3        # the release gate
 *
 * A single run tells you whether it works. Three consecutive clean runs are
 * what promotes a model to a pinned reference, because the failures that matter
 * here are intermittent by nature.
 */

type Outcome = Verdict & {
  scenario: string;
  dimension: string;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  error?: string;
};

const decls = new Map<string, CapabilityDecl>(fsCapabilities.map((c) => [c.id, c]));

async function runScenario(
  scenario: Scenario,
  model: string,
  apiKey: string,
  baseUrl: string,
  sweep: { tools?: number; pad?: number } = {},
): Promise<Outcome> {
  const home = mkdtempSync(join(tmpdir(), 'muffin-floor-home-'));
  const workDir = mkdtempSync(join(tmpdir(), 'muffin-floor-work-'));
  mkdirSync(join(home, 'rot'), { recursive: true });
  scenario.seed(workDir);

  const scope: FsScope = { root: workDir, denyWrite: [join(home, 'rot')] };
  const observed: { name: string; args: Record<string, unknown> }[] = [];

  // Wraps every handler so the check can assert on what was actually called,
  // not on what the final text claims was done.
  const observe = (tool: RegisteredTool): RegisteredTool => ({
    ...tool,
    // `ctx` forwarded, not dropped. A handler is `(args, ctx)` — the turn's
    // tenant and principal — since the cross-tenant leak that introduced
    // ToolContext; this wrapper still called the one-argument shape, so the
    // eval was exercising a signature production does not have. Invisible
    // because these six eval sources were typechecked by nothing.
    handler: async (args, ctx) => {
      observed.push({ name: tool.spec.name, args: (args ?? {}) as Record<string, unknown> });
      return tool.handler(args, ctx);
    },
  });

  // The same factory production wires (`agent/runtime.ts`), not a second copy of
  // the three handlers. The copy was here, and it was already one field behind:
  // an eval that runs tools production does not have measures a floor nobody
  // ships.
  const declared: RegisteredTool[] = [
    ...makeFsTools(scope),
    ...(scenario.extraTools ?? []),
    ...(sweep.pad ? crowdTools(sweep.pad) : []),
  ];
  const tools: RegisteredTool[] = declared.map(observe);

  const db = new DatabaseCtor(join(home, 'muffin.db'));
  const budget = new BudgetEngine(db, { monthlyUsd: 5, perTenantDailyUsd: 5 });
  const sessions = new SessionStore(home);
  // The floor runs the production loop, so it gets the production record too:
  // an eval on a shape the runtime does not have measures nothing.
  const turns = new TurnStore(db);
  const todos = new TodoStore(db);
  const started = Date.now();

  try {
    const result = await runTurn(
      {
        provider: new OpenAICompatProvider(apiKey, baseUrl, {
          'HTTP-Referer': 'https://github.com/muffin-project/muffin-agent',
          'X-Title': 'muffin-floor',
        }),
        // Il tetto è il parametro sotto misura, quindi qui si sovrascrive
        // invece di essere subito: il profilo resta quello vero per tutto il
        // resto (recovery, sampling, thinking), e cambia solo il numero.
        profile: ((): ReturnType<typeof selectProfile> => {
          const base = selectProfile(model, loadProfiles(join(import.meta.dirname, '..', '..', 'agent', 'profiles')));
          return sweep.tools === undefined ? base : { ...base, maxToolsExposed: sweep.tools };
        })(),
        model,
        tools,
        // The compiled floor, deliberately, not `loadPolicyMatrix(home)`: a
        // score is only comparable across runs if the matrix it was measured
        // against is the same one. An owner-tightened `policy.json` would move
        // the floor silently, which is the one thing a floor may not do.
        decide: createDecide({ capabilities: decls, matrix: POLICY_FLOOR, budgetExhausted: () => budget.exhausted(), hardened: true }),
        capabilities: decls,
        tracer: new SimpleTracer(new JsonlExporter(home)),
        sessions,
        turns,
        todos,
        budgetExhausted: () => budget.exhausted(),
        // The floor is measured on the owner class: the scenarios run as the
        // owner on the host tenant, and a capability floor is about what the
        // model can do with its tools, not about which tenant is asking. The
        // group entry is the same text so a scenario that ever runs as a member
        // is measured against something rather than crashing on a missing key.
        systemPrompts: { owner: FLOOR_PROMPT, group: FLOOR_PROMPT },
      },
      {
        principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
        tenant: 'host',
        surface: 'cli',
        session: sessions.open(scenario.id),
        text: scenario.prompt,
      },
    );

    const verdict = scenario.check({
      result,
      toolCalls: observed,
      workDir,
      read: (rel) => (existsSync(join(workDir, rel)) ? readFileSync(join(workDir, rel), 'utf8') : null),
    });

    return {
      ...verdict,
      scenario: scenario.id,
      dimension: scenario.dimension,
      iterations: result.iterations,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      ms: Date.now() - started,
    };
  } catch (error) {
    return {
      pass: false,
      why: 'errore durante il turno',
      scenario: scenario.id,
      dimension: scenario.dimension,
      iterations: 0,
      inputTokens: 0,
      outputTokens: 0,
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db.close();
  }
}

const { values } = parseArgs({
  options: {
    model: { type: 'string' },
    'base-url': { type: 'string' },
    only: { type: 'string' },
    reps: { type: 'string' },
    /** Sovrascrive `maxToolsExposed` del profilo: il numero sotto misura. */
    tools: { type: 'string' },
    /** Quanti decoy aggiungere, per avere davvero quella superficie da riempire. */
    pad: { type: 'string' },
    json: { type: 'boolean' },
  },
});

const model = values.model ?? 'anthropic/claude-sonnet-5';
const baseUrl = values['base-url'] ?? 'https://openrouter.ai/api/v1';
/**
 * La chiave: prima l'ambiente, poi il secret store dell'installazione.
 *
 * L'ambiente resta primo perché è come si punta l'eval a un endpoint diverso da
 * quello configurato. Ma `AGENTS.md` dice che i segreti si leggono da stdin,
 * mai da argv — e una chiave esportata a mano in una shell finisce nella
 * history e nella process table. Se l'installazione ne ha già una, questo eval
 * non ha ragione di chiederla di nuovo: la legge dalla stessa catena del
 * runtime (`readSecret`), senza che nessuno debba incollarla.
 */
const apiKey = ((): string => {
  const fromEnv = process.env['LLM_API_KEY'] ?? process.env['OPENROUTER_API_KEY'] ?? '';
  if (fromEnv !== '') return fromEnv;
  try {
    return readSecret(loadConfig().provider.apiKeyRef);
  } catch {
    return '';
  }
})();
if (apiKey === '') {
  process.stderr.write(
    "serve LLM_API_KEY (o OPENROUTER_API_KEY) nell'ambiente, oppure un'installazione con la chiave a posto\n",
  );
  process.exit(78);
}

const only = values.only?.split(',').map((s) => s.trim());
const selected = only ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS;
const reps = Number(values.reps ?? 1);
const sweep = {
  ...(values.tools === undefined ? {} : { tools: Number(values.tools) }),
  ...(values.pad === undefined ? {} : { pad: Number(values.pad) }),
};

process.stderr.write(
  `floor · ${model} · ${selected.length} scenari × ${reps} run` +
    `${sweep.tools === undefined ? '' : ` · tetto ${sweep.tools}`}${sweep.pad === undefined ? '' : ` · +${sweep.pad} decoy`}\n\n`,
);

const all: Outcome[] = [];
for (let rep = 1; rep <= reps; rep++) {
  if (reps > 1) process.stderr.write(`— run ${rep}/${reps}\n`);
  for (const scenario of selected) {
    const outcome = await runScenario(scenario, model, apiKey, baseUrl, sweep);
    all.push(outcome);
    process.stderr.write(
      `${outcome.pass ? '✓' : '✗'} ${outcome.scenario.padEnd(12)} ${String(outcome.iterations).padStart(2)} passaggi  ` +
        `${String(outcome.inputTokens).padStart(6)} in ${String(outcome.outputTokens).padStart(5)} out  ` +
        `${(outcome.ms / 1000).toFixed(1)}s  ${outcome.why}${outcome.error ? ` [${outcome.error}]` : ''}\n`,
    );
  }
}

const passed = all.filter((o) => o.pass).length;
const inTok = all.reduce((s, o) => s + o.inputTokens, 0);
const outTok = all.reduce((s, o) => s + o.outputTokens, 0);
// Normalised at Sonnet list price so two models are comparable on the same
// axis. It is not what this run cost — a consumer model bills a fraction of it.
const normalised = (inTok / 1e6) * 3 + (outTok / 1e6) * 15;

process.stderr.write(
  `\n${passed}/${all.length} superati · ${inTok} token in / ${outTok} out · ` +
    `${normalised.toFixed(3)} unità di costo (normalizzate a listino Sonnet, non la spesa reale)\n`,
);

// Every scenario must pass in every run: the floor is a contract, not an average.
const failedIds = [...new Set(all.filter((o) => !o.pass).map((o) => o.scenario))];
if (failedIds.length > 0) {
  process.stderr.write(`floor NON superato: ${failedIds.join(', ')}\n`);
}
if (values.json) process.stdout.write(`${JSON.stringify({ model, reps, outcomes: all }, null, 2)}\n`);
process.exitCode = failedIds.length === 0 ? 0 : 1;
