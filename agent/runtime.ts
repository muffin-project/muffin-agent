import DatabaseCtor from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BudgetEngine } from '../core/budget/budget.js';
import { loadConfig, paths, readSecret, type Config } from '../core/config/config.js';
import { createDecide } from '../core/policy/decide.js';
import type { CapabilityDecl } from '../core/policy/types.js';
import { verify } from '../core/rot/verify.js';
import { SessionStore } from '../core/session/store.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import type { LoopDeps, RegisteredTool } from './loop.js';
import type { Provider } from './providers/types.js';
import { loadProfiles, selectProfile } from './profiles/profile.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAICompatProvider } from './providers/openai-compat.js';
import { fsCapabilities, fsList, fsRead, fsToolSpecs, fsWrite, type FsScope } from './tools/fs.js';
import { memoryCapability, memorySearchSpec, searchMemory } from './tools/memory.js';
import { OllamaEmbedder } from '../core/memory/embed.js';
import { LlmReranker } from '../core/memory/rerank.js';
import { MemoryStore } from '../core/memory/store.js';
import { VectorIndex } from '../core/memory/vectors.js';
import type { RecallDeps } from '../core/memory/recall.js';

/**
 * Assembly.
 *
 * Everything the loop needs, built once from config, in the order the blueprint
 * fixes: traces first so any later failure is recorded, then config, then the
 * root of trust, then the rest. A boot that fails silently at step three is a
 * boot you debug by bisecting.
 */

export type Runtime = {
  deps: LoopDeps;
  config: Config;
  /**
   * The light lane. Extraction, the contradiction judge and consolidation all
   * run here: they are classification and rewriting, not frontier work, and
   * paying Sonnet prices to turn a sentence into a triple is how a personal
   * agent quietly costs $80 a month.
   */
  light: { provider: Provider; model: string };
  memory: { store: MemoryStore; recall: RecallDeps };
  budget: BudgetEngine;
  /** Set when the root of trust diverged and we are running degraded. */
  safeMode: { reason: string; diverged: string[] } | null;
  close(): void;
};

export function buildRuntime(home = paths().home, cwd = process.cwd()): Runtime {
  const p = paths(home);
  const exporter = new JsonlExporter(home);
  const tracer = new SimpleTracer(exporter);

  const config = loadConfig(home);
  exporter.pruneOlderThan(config.traces.retentionDays);

  // Root of trust before anything reads policy from it: in single-user mode a
  // divergence degrades instead of refusing, but it is never ignored.
  const rot = verify(home, config.rot.mode);
  let safeMode: Runtime['safeMode'] = null;
  if (!rot.ok) {
    if (rot.action === 'refuse') {
      throw new Error(
        `root of trust diverged (${rot.reason}): ${rot.diverged.join(', ')}\n→ ${rot.remedy}`,
      );
    }
    safeMode = { reason: rot.reason, diverged: rot.diverged };
  }

  const db = new DatabaseCtor(p.db);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  const budget = new BudgetEngine(db, config.budget);

  // One connection, two lanes: the endpoint is the same, the model id is not.
  const provider: Provider =
    config.provider.kind === 'anthropic'
      ? new AnthropicProvider(readSecret(config.provider.apiKeyRef, home), config.provider.baseUrl)
      : new OpenAICompatProvider(
          readSecret(config.provider.apiKeyRef, home),
          config.provider.baseUrl,
          { 'HTTP-Referer': 'https://github.com/muffin-ai/muffin', 'X-Title': 'muffin' },
        );

  const profile = selectProfile(config.models.main, loadProfiles());

  // Memory. The vector half is optional and its absence is reported rather than
  // hidden: an embedder that is not running turns semantic recall into keyword
  // search, and the difference has to be visible in `doctor` and in the traces.
  const memoryStore = new MemoryStore(db);
  let vectors: VectorIndex | undefined;
  try {
    vectors = new VectorIndex(db, new OllamaEmbedder());
  } catch {
    vectors = undefined;
  }
  const recallDeps: RecallDeps = {
    store: memoryStore,
    vectors,
    reranker: new LlmReranker(provider, config.models.light),
  };

  // Writes are scoped to the working directory, and the root of trust is never
  // writable from a tool whatever the scope says.
  const scope: FsScope = { root: cwd, denyWrite: [p.rot, p.secrets, p.config] };
  const tools: RegisteredTool[] = [
    {
      capability: 'fs.read',
      spec: fsToolSpecs[0]!,
      handler: (args) => ({ content: fsRead(scope, String((args as { path: string }).path)) }),
    },
    {
      capability: 'fs.list',
      spec: fsToolSpecs[1]!,
      handler: (args) => ({ content: fsList(scope, String((args as { path: string }).path)) }),
    },
    {
      capability: 'fs.write',
      spec: fsToolSpecs[2]!,
      handler: (args) => {
        const a = args as { path: string; content: string };
        return { content: fsWrite(scope, String(a.path), String(a.content ?? '')) };
      },
    },
    {
      capability: memoryCapability.id,
      spec: memorySearchSpec,
      handler: async (args) => searchMemory(recallDeps, 'host', args),
    },
  ];

  const capabilities = new Map<string, CapabilityDecl>(
    [...fsCapabilities, memoryCapability].map((c) => [c.id, c]),
  );
  const decide = createDecide({
    capabilities,
    budgetExhausted: () => budget.exhausted(),
    hardened: config.rot.mode === 'hardened',
  });

  return {
    config,
    budget,
    safeMode,
    light: { provider, model: config.models.light },
    memory: { store: memoryStore, recall: recallDeps },
    deps: {
      provider,
      profile,
      model: config.models.main,
      tools,
      decide,
      tracer,
      sessions: new SessionStore(home),
      budgetExhausted: () => budget.exhausted(),
      systemPrompt: buildSystemPrompt(home, safeMode !== null),
      memory: { store: memoryStore, recall: recallDeps },
    },
    close: () => db.close(),
  };
}

/**
 * Identity comes from the root of trust, verbatim. It is the one part of the
 * prompt the agent cannot rewrite about itself, which is the whole point of
 * keeping it there rather than in config.
 */
function buildSystemPrompt(home: string, safeMode: boolean): string {
  const identityPath = join(paths(home).rot, 'identity.md');
  const identity = existsSync(identityPath) ? readFileSync(identityPath, 'utf8').trim() : '';
  const parts = [identity];
  parts.push(
    [
      '## Come lavori',
      '- Hai dei tool. Usali quando servono, invece di dire che lo faresti.',
      '- Se un tool fallisce o ti viene negato, dillo e spiega cosa serviva. Non fingere di aver fatto.',
      '- Quando hai finito, rispondi e basta: non chiamare altri tool per abitudine.',
    ].join('\n'),
  );
  if (safeMode) {
    parts.push(
      '## Modalità sicura\nIl Root of Trust è divergente: alcune capability sono negate. Dillo se ti impedisce di fare qualcosa.',
    );
  }
  return parts.filter((s) => s.length > 0).join('\n\n');
}
