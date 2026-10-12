import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { runTurn, type RegisteredTool, type ToolContext } from '../../agent/loop.js';
import { selectProfile, loadProfiles } from '../../agent/profiles/profile.js';
import { OpenAICompatProvider } from '../../agent/providers/openai-compat.js';
import type { ChatCall, ChatResult, Provider } from '../../agent/providers/types.js';
import {
  capabilityDiscoveryCapability,
  makeCapabilitySearchTool,
} from '../../agent/tools/capability-search.js';
import { createDecide } from '../../core/policy/decide.js';
import { POLICY_FLOOR } from '../../core/policy/matrix.js';
import type { CapabilityDecl } from '../../core/policy/types.js';
import { SessionStore } from '../../core/session/store.js';
import { JsonlExporter, SimpleTracer } from '../../core/tracing/tracer.js';
import { TurnStore } from '../../core/turns/store.js';
import { TodoStore } from '../../core/turns/todo.js';

type Mode = 'flat' | 'deferred';

type Outcome = {
  readonly mode: Mode;
  readonly pass: boolean;
  readonly why: string;
  readonly iterations: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly ms: number;
  readonly calls: readonly string[];
  readonly firstTools: readonly string[];
};

function declaration(id: string): CapabilityDecl {
  return {
    id,
    effect: 'context',
    risk: 'low',
    reversible: 'yes',
    rerunnable: true,
    resourceKind: 'none',
    policyArgs: [],
    hostOnly: false,
  };
}

function inert(name: string): { tool: RegisteredTool; decl: CapabilityDecl } {
  const decl = declaration('eval.' + name);
  return {
    decl,
    tool: {
      capability: decl.id,
      spec: {
        name,
        description: 'Support capability ' + name + ' for its own domain operations.',
        inputSchema: { type: 'object' },
      },
      throwTier: 0,
      handler: () => ({ content: name + ': no inventory data.', tier: 0 }),
    },
  };
}

const inventoryDecl = declaration('eval.inventory_lookup');

const inventoryTool: RegisteredTool = {
  capability: inventoryDecl.id,
  spec: {
    name: 'inventory_lookup',
    description:
      'Look up the current inventory quantity for a SKU. Use this for stock, warehouse quantity, or units available.',
    inputSchema: {
      type: 'object',
      properties: {
        sku: { type: 'string', description: 'SKU to look up.' },
      },
      required: ['sku'],
    },
  },
  throwTier: 0,
  handler: (args) => {
    const sku =
      args !== null && typeof args === 'object' && typeof (args as { sku?: unknown }).sku === 'string'
        ? (args as { sku: string }).sku
        : '';
    if (sku.toUpperCase() !== 'BLUE-17') {
      return { content: 'SKU not found.', isError: true, tier: 0 };
    }
    return { content: 'SKU BLUE-17: 37 units available.', tier: 0 };
  },
};

class ObservedProvider implements Provider {
  readonly seen: ChatCall[] = [];

  constructor(private readonly inner: Provider) {}

  get kind(): Provider['kind'] {
    return this.inner.kind;
  }

  async chat(call: ChatCall): Promise<ChatResult> {
    this.seen.push(call);
    return this.inner.chat(call);
  }
}

function observed(tool: RegisteredTool, calls: string[]): RegisteredTool {
  return {
    ...tool,
    handler: async (args: unknown, ctx: ToolContext) => {
      calls.push(tool.spec.name);
      return tool.handler(args, ctx);
    },
  };
}

async function oneRun(input: {
  readonly mode: Mode;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
}): Promise<Outcome> {
  const home = mkdtempSync(join(tmpdir(), 'muffin-capability-real-'));
  const db = new DatabaseCtor(':memory:');
  const sessions = new SessionStore(home);
  const turns = new TurnStore(db);
  const todos = new TodoStore(db);
  const calls: string[] = [];

  const core = [
    inert('fs_read'),
    inert('fs_list'),
    inert('fs_search'),
    inert('memory_search'),
    inert('skill_read'),
  ];
  // Approximate the current native-catalogue breadth rather than comparing a
  // six-tool flat baseline against a four-tool projection. The static schema
  // byte measurement uses the exact shipped catalogue separately; this real
  // model lane asks whether selection/reliability still holds at comparable
  // breadth.
  const fillers = [
    'document_read',
    'vault_save',
    'process_list',
    'process_kill',
    'http_get',
    'wait',
    'todo',
    'schedule_recurring',
    'sys_inspect',
    'sys_effects',
    'memory_why',
    'memory_forget',
    'memory_propose',
    'send_file',
    'shell_run',
    'shell_run_write',
  ].map(inert);
  const search = makeCapabilitySearchTool();
  const tools = [
    ...core.map((entry) => observed(entry.tool, calls)),
    ...fillers.map((entry) => observed(entry.tool, calls)),
    observed(inventoryTool, calls),
    observed(search, calls),
  ];
  const capabilities = new Map<string, CapabilityDecl>([
    ...core.map((entry) => [entry.decl.id, entry.decl] as const),
    ...fillers.map((entry) => [entry.decl.id, entry.decl] as const),
    [inventoryDecl.id, inventoryDecl],
    [capabilityDiscoveryCapability.id, capabilityDiscoveryCapability],
  ]);

  const baseProfile = selectProfile(
    input.model,
    loadProfiles(join(import.meta.dirname, '..', '..', 'agent', 'profiles')),
  );
  const profile = {
    ...baseProfile,
    maxToolsExposed: input.mode === 'flat' ? 24 : 4,
  };

  const provider = new ObservedProvider(
    new OpenAICompatProvider(input.apiKey, input.baseUrl),
  );
  const started = Date.now();
  try {
    const result = await runTurn(
      {
        provider,
        profile,
        model: input.model,
        tools,
        capabilities,
        decide: createDecide({
          capabilities,
          matrix: POLICY_FLOOR,
          budgetExhausted: () => false,
          hardened: true,
        }),
        tracer: new SimpleTracer(new JsonlExporter(home)),
        sessions,
        turns,
        todos,
        budgetExhausted: () => false,
        systemPrompts: {
          owner:
            'Sei Muffin. Usa i tool disponibili per rispondere con dati verificati. ' +
            'Se il dato non è disponibile, non inventarlo.',
          group: 'Sei Muffin.',
        },
      },
      {
        principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
        tenant: 'host',
        surface: 'cli',
        session: sessions.open('capability-real-' + input.mode),
        text: 'Quante unità ci sono a magazzino per lo SKU BLUE-17? Usa i tool disponibili e non inventare.',
      },
    );

    const inventoryCalls = calls.filter((name) => name === 'inventory_lookup').length;
    const discoveryCalls = calls.filter((name) => name === 'capability_search').length;
    const firstTools = provider.seen[0]?.tools?.map((tool) => tool.name) ?? [];
    const hasAnswer = /\b37\b/.test(result.text);
    const projectionShape =
      input.mode === 'flat'
        ? firstTools.includes('inventory_lookup') &&
          !firstTools.includes('capability_search')
        : firstTools.length <= 4 &&
          firstTools.includes('inventory_lookup') &&
          firstTools.includes('capability_search');

    const pass =
      result.stopped === 'answered' &&
      hasAnswer &&
      inventoryCalls === 1 &&
      projectionShape;

    return {
      mode: input.mode,
      pass,
      why: pass
        ? input.mode === 'flat'
          ? 'inventory tool selected directly'
          : discoveryCalls === 0
            ? 'hidden inventory tool preloaded from task text then selected'
            : 'preloaded inventory tool selected after an additional discovery call'
        : [
            'stopped=' + result.stopped,
            'answer37=' + String(hasAnswer),
            'inventoryCalls=' + String(inventoryCalls),
            'discoveryCalls=' + String(discoveryCalls),
            'firstTools=' + firstTools.join('|'),
          ].join(', '),
      iterations: result.iterations,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      ms: Date.now() - started,
      calls,
      firstTools,
    };
  } catch (error) {
    return {
      mode: input.mode,
      pass: false,
      why: error instanceof Error ? error.message : String(error),
      iterations: 0,
      inputTokens: 0,
      outputTokens: 0,
      ms: Date.now() - started,
      calls,
      firstTools: provider.seen[0]?.tools?.map((tool) => tool.name) ?? [],
    };
  } finally {
    db.close();
  }
}

const { values } = parseArgs({
  options: {
    model: { type: 'string' },
    'base-url': { type: 'string' },
    reps: { type: 'string' },
    json: { type: 'boolean' },
  },
});

const model = values.model ?? 'gpt-4o-mini';
const baseUrl = values['base-url'] ?? 'https://api.openai.com/v1';
const reps = Number(values.reps ?? 3);

const apiKey = process.env['LLM_API_KEY'] ?? process.env['OPENAI_API_KEY'] ?? '';

if (apiKey === '') {
  process.stderr.write(
    'serve LLM_API_KEY/OPENAI_API_KEY nell’ambiente\n',
  );
  process.exit(78);
}

const outcomes: Outcome[] = [];
for (const mode of ['flat', 'deferred'] as const) {
  process.stderr.write('— ' + mode + ' —\n');
  for (let rep = 1; rep <= reps; rep++) {
    const outcome = await oneRun({ mode, model, baseUrl, apiKey });
    outcomes.push(outcome);
    process.stderr.write(
      (outcome.pass ? '✓' : '✗') +
        ' ' +
        mode +
        ' ' +
        String(rep) +
        '/' +
        String(reps) +
        ' · ' +
        String(outcome.iterations) +
        ' passaggi · ' +
        String(outcome.inputTokens) +
        ' in / ' +
        String(outcome.outputTokens) +
        ' out · ' +
        (outcome.ms / 1000).toFixed(1) +
        's · ' +
        outcome.why +
        ' · calls=' +
        outcome.calls.join('→') +
        '\n',
    );
  }
}

const aggregate = (mode: Mode) => {
  const rows = outcomes.filter((outcome) => outcome.mode === mode);
  return {
    pass: rows.filter((row) => row.pass).length + '/' + String(rows.length),
    avgIterations: Number(
      (rows.reduce((sum, row) => sum + row.iterations, 0) / rows.length).toFixed(2),
    ),
    avgInputTokens: Math.round(
      rows.reduce((sum, row) => sum + row.inputTokens, 0) / rows.length,
    ),
    avgOutputTokens: Math.round(
      rows.reduce((sum, row) => sum + row.outputTokens, 0) / rows.length,
    ),
    avgMs: Math.round(rows.reduce((sum, row) => sum + row.ms, 0) / rows.length),
  };
};

const summary = {
  model,
  reps,
  flat: aggregate('flat'),
  deferred: aggregate('deferred'),
  outcomes,
};

process.stderr.write('CAPABILITY_REAL_MODEL ' + JSON.stringify(summary) + '\n');
if (values.json) process.stdout.write(JSON.stringify(summary, null, 2) + '\n');

process.exitCode = outcomes.every((outcome) => outcome.pass) ? 0 : 1;
