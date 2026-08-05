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
import { loadProfiles, selectProfile } from './profiles/profile.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAICompatProvider } from './providers/openai-compat.js';
import { fsCapabilities, fsList, fsRead, fsToolSpecs, fsWrite, type FsScope } from './tools/fs.js';

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

  const provider =
    config.provider.kind === 'anthropic'
      ? new AnthropicProvider(readSecret(config.provider.apiKeyRef, home), config.provider.baseUrl)
      : new OpenAICompatProvider(
          readSecret(config.provider.apiKeyRef, home),
          config.provider.baseUrl,
          { 'HTTP-Referer': 'https://github.com/muffin-ai/muffin', 'X-Title': 'muffin' },
        );

  const profile = selectProfile(config.models.main, loadProfiles());

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
  ];

  const capabilities = new Map<string, CapabilityDecl>(fsCapabilities.map((c) => [c.id, c]));
  const decide = createDecide({
    capabilities,
    budgetExhausted: () => budget.exhausted(),
    hardened: config.rot.mode === 'hardened',
  });

  return {
    config,
    budget,
    safeMode,
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
