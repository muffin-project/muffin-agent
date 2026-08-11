import DatabaseCtor from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { runTurn, type RegisteredTool } from '../../agent/loop.js';
import { loadProfiles, selectProfile } from '../../agent/profiles/profile.js';
import { OpenAICompatProvider } from '../../agent/providers/openai-compat.js';
import { fsCapabilities, fsList, fsRead, fsToolSpecs, fsWrite, type FsScope } from '../../agent/tools/fs.js';
import { BudgetEngine } from '../../core/budget/budget.js';
import { createDecide } from '../../core/policy/decide.js';
import type { CapabilityDecl } from '../../core/policy/types.js';
import { SessionStore } from '../../core/session/store.js';
import { JsonlExporter, SimpleTracer } from '../../core/tracing/tracer.js';
import { SCENARIOS, type Scenario, type Verdict } from './scenarios.js';

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

async function runScenario(scenario: Scenario, model: string, apiKey: string, baseUrl: string): Promise<Outcome> {
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
    handler: async (args) => {
      observed.push({ name: tool.spec.name, args: (args ?? {}) as Record<string, unknown> });
      return tool.handler(args);
    },
  });

  const tools: RegisteredTool[] = [
    { capability: 'fs.read', spec: fsToolSpecs[0]!, handler: (a) => ({ content: fsRead(scope, String((a as { path: string }).path)) }) },
    { capability: 'fs.list', spec: fsToolSpecs[1]!, handler: (a) => ({ content: fsList(scope, String((a as { path: string }).path)) }) },
    {
      capability: 'fs.write',
      spec: fsToolSpecs[2]!,
      handler: (a) => {
        const x = a as { path: string; content: string };
        return { content: fsWrite(scope, String(x.path), String(x.content ?? '')) };
      },
    },
    ...(scenario.extraTools ?? []),
  ].map(observe);

  const db = new DatabaseCtor(join(home, 'muffin.db'));
  const budget = new BudgetEngine(db, { monthlyUsd: 5, perTenantDailyUsd: 5 });
  const sessions = new SessionStore(home);
  const started = Date.now();

  try {
    const result = await runTurn(
      {
        provider: new OpenAICompatProvider(apiKey, baseUrl, {
          'HTTP-Referer': 'https://github.com/muffin-ai/muffin',
          'X-Title': 'muffin-floor',
        }),
        profile: selectProfile(model, loadProfiles(join(import.meta.dirname, '..', '..', 'agent', 'profiles'))),
        model,
        tools,
        decide: createDecide({ capabilities: decls, budgetExhausted: () => budget.exhausted(), hardened: true }),
        tracer: new SimpleTracer(new JsonlExporter(home)),
        sessions,
        budgetExhausted: () => budget.exhausted(),
        // The floor is measured on the owner class: the scenarios run as the
        // owner on the host tenant, and a capability floor is about what the
        // model can do with its tools, not about which tenant is asking. The
        // group entry is the same text so a scenario that ever runs as a member
        // is measured against something rather than crashing on a missing key.
        systemPrompts: {
          owner:
            'Sei Muffin. Hai dei tool: usali invece di dire che lo faresti. ' +
            'Se un tool fallisce o un dato non esiste, dillo — non inventare. ' +
            'Quando hai finito, rispondi e basta.',
          group:
            'Sei Muffin. Hai dei tool: usali invece di dire che lo faresti. ' +
            'Se un tool fallisce o un dato non esiste, dillo — non inventare. ' +
            'Quando hai finito, rispondi e basta.',
        },
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
    json: { type: 'boolean' },
  },
});

const model = values.model ?? 'anthropic/claude-sonnet-5';
const baseUrl = values['base-url'] ?? 'https://openrouter.ai/api/v1';
const apiKey = process.env['LLM_API_KEY'] ?? process.env['OPENROUTER_API_KEY'] ?? '';
if (apiKey === '') {
  process.stderr.write('serve LLM_API_KEY (o OPENROUTER_API_KEY) nell\'ambiente\n');
  process.exit(78);
}

const only = values.only?.split(',').map((s) => s.trim());
const selected = only ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS;
const reps = Number(values.reps ?? 1);

process.stderr.write(`floor · ${model} · ${selected.length} scenari × ${reps} run\n\n`);

const all: Outcome[] = [];
for (let rep = 1; rep <= reps; rep++) {
  if (reps > 1) process.stderr.write(`— run ${rep}/${reps}\n`);
  for (const scenario of selected) {
    const outcome = await runScenario(scenario, model, apiKey, baseUrl);
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
