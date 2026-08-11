import DatabaseCtor from 'better-sqlite3';
import { BudgetEngine } from '../core/budget/budget.js';
import { costUsd } from '../core/budget/pricing.js';
import { loadConfig, paths, readSecret, type Config } from '../core/config/config.js';
import { createDecide } from '../core/policy/decide.js';
import { loadPolicyMatrix } from '../core/policy/matrix.js';
import type { CapabilityDecl } from '../core/policy/types.js';
import { verify } from '../core/rot/verify.js';
import { SessionStore } from '../core/session/store.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { buildSystemPrompts } from './context/assemble.js';
import type { LoopDeps, RegisteredTool } from './loop.js';
import type { Provider } from './providers/types.js';
import { loadProfiles, selectProfile } from './profiles/profile.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAICompatProvider } from './providers/openai-compat.js';
import { fsCapabilities, fsList, fsRead, fsToolSpecs, fsWrite, type FsScope } from './tools/fs.js';
import { memoryCapability, memorySearchSpec, searchMemory } from './tools/memory.js';
import { SandboxExecutor } from '../core/sandbox/executor.js';
import { makeShellTool, shellCapability } from './tools/shell.js';
import { hostAllowed, loadEgress, type EgressPolicy } from '../core/net/egress.js';
import { httpCapability, makeHttpTool } from './tools/http.js';
import { makeSearchTool, searchCapability, tavilyBackend } from './tools/search.js';
import { makeProcessTools, processCapabilities } from './tools/process.js';
import { loadMcpRegistry } from '../core/mcp/registry.js';
import { buildMcpTools } from './tools/mcp.js';
import { discoverSkills, skillsPromptSection } from '../core/skills/skills.js';
import { makeSkillTool, skillCapability } from './tools/skill.js';
import { JobStore } from '../core/scheduler/jobs.js';
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
  /** Scheduled jobs, on the same connection as everything else (ADR-0022). */
  jobs: JobStore;
  /**
   * That same connection, for the coordination a runtime cannot express through
   * one of its stores — today the gateway lock (ADR-0035), which the REPL reads
   * to decide whether it may start a ticker.
   *
   * Exposed rather than letting callers open a second handle, which is what
   * `connectSurfaces` does and what ADR-0035 warns against by name: *"moltiplica
   * le connessioni al DB e le corse"*. One process, one connection.
   */
  db: DatabaseCtor.Database;
  /** Set when the root of trust diverged and we are running degraded. */
  safeMode: { reason: string; diverged: string[] } | null;
  /**
   * Boot-visible notes a surface should print before the first turn — today,
   * skills that failed to load and why. Empty means nothing was skipped.
   */
  bootLines: string[];
  /**
   * Late registration for tools that arrive asynchronously (MCP servers).
   * Registers the capability too: a tool the kernel does not know is a tool
   * the loop cannot ever be allowed to call.
   */
  register(tool: RegisteredTool, decl: CapabilityDecl): void;
  /** Awaited by close(); attachments park their teardown here. */
  onClose(hook: () => Promise<void>): void;
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

  // The permission matrix, read here and nowhere else: `decide` is synchronous
  // and pure, so the file is opened once per boot and the kernel closes over
  // the result. Placed immediately after `verify` because that comment above is
  // literal — this is the "anything reads policy from it" it was written for.
  // A fallback is a boot line, not a silent substitution: the numbers still
  // work, and the owner needs to know they are the compiled ones.
  const matrix = loadPolicyMatrix(home);
  const matrixNotes =
    matrix.source === 'fallback' && matrix.note !== null
      ? [`! matrice permessi: valori compilati, non rot/policy.json — ${matrix.note}`]
      : [];

  const db = new DatabaseCtor(p.db);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  const budget = new BudgetEngine(db, config.budget);
  const jobs = new JobStore(db);

  // One connection, two lanes: the endpoint is the same, the model id is not.
  const provider: Provider =
    config.provider.kind === 'anthropic'
      ? new AnthropicProvider(readSecret(config.provider.apiKeyRef, home), config.provider.baseUrl)
      : new OpenAICompatProvider(
          readSecret(config.provider.apiKeyRef, home),
          config.provider.baseUrl,
          { 'HTTP-Referer': 'https://github.com/muffin-ai/muffin', 'X-Title': 'muffin' },
          // Cache breakpoints are the provider's own decision, defaulted from
          // the endpoint (`wantsExplicitCache`): the first version made every
          // caller pass the flag, and the two eval harnesses immediately forgot
          // — same endpoint, full price, silently.
        );

  const profileProblems: string[] = [];
  const profile = selectProfile(config.models.main, loadProfiles(undefined, (line) => profileProblems.push(line)));

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
  const scope: FsScope = { root: cwd, denyWrite: [p.rot, p.secrets, p.config], denyRead: [p.secrets] };
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
      // The tenant comes from the turn, never from this line. Baking it in here
      // is how a group member ends up reading the owner's memory.
      handler: async (args, ctx) => searchMemory(recallDeps, ctx.tenant, args),
      // Recalled memory is the grounding of the turn, not a payload the model
      // can re-fetch on a whim: clearing it to save context deletes the reason
      // the answer was anchored to anything.
      keepResult: true,
    },
  ];

  // The hands of M3. The shell tool is registered only when the probe proved a
  // real containment on this host: absent sandbox → absent tool, declared in
  // doctor — never a silent unsandboxed run (ADR-0018 rule 5, tightened: v1 is
  // strict mode, the ask-gated escape hatch arrives as its own capability).
  const executor = new SandboxExecutor({
    denyWrite: [p.rot, p.secrets, p.config],
    denyRead: [p.secrets],
  });
  if (executor.status().available) {
    tools.push(makeShellTool(executor, { root: cwd }));
  }

  // Process inspection/management is a host operation, not sandboxed execution:
  // it acts on the host's own process table, so it does not depend on the
  // sandbox probe the way shell does. The kernel is the whole containment here
  // — list is capped at taint 1, kill is high-risk (ask in single-user).
  tools.push(...makeProcessTools());

  // Skills: metadata always in context, bodies on demand through their own
  // door. A skill that failed to parse is a boot-visible problem line, never a
  // silently half-loaded one.
  const skillScan = discoverSkills(home);
  tools.push(makeSkillTool(skillScan.skills));

  // Egress. A home installed before egress.json existed gets the empty policy,
  // not a bricked boot — which is fail-closed the visible way: the kernel then
  // answers `ask` for every URL, and the first fetch tells the owner why.
  let egress: EgressPolicy;
  try {
    egress = loadEgress(home);
  } catch {
    egress = { allow: [] };
  }
  tools.push(makeHttpTool(egress));

  // Search is registered only when it is configured, so an unconfigured install
  // has no `web_search` in its tool list rather than one that fails at the first
  // call. The key is read here and never leaves this closure — the same handling
  // the model key gets.
  let searchOn = false;
  const searchNotes: string[] = [];
  if (config.search) {
    // The key is read inside the try for the same reason the endpoint check is
    // below it: a half-configured search must switch search off, not refuse to
    // boot. Editing config.json and running `muffin secret set` are two steps,
    // and between them every command that builds a runtime used to die —
    // `muffin`, `muffin run`, `muffin memory why`. The sibling misconfiguration
    // three lines down already degrades to a boot line; this one did not.
    let backend;
    try {
      backend = tavilyBackend({
        apiKey: readSecret(config.search.apiKeyRef, home),
        ...(config.search.maxResults === undefined ? {} : { maxResults: config.search.maxResults }),
      });
    } catch (error) {
      searchNotes.push(
        `! web_search spento: ${error instanceof Error ? error.message : String(error)}`,
      );
      backend = undefined;
    }

    // The endpoint is a constant, so it gets checked once here rather than on
    // every call — but it does get checked. Skipping it because "the model
    // cannot choose the host anyway" is how egress.json stops describing where
    // this process actually talks.
    if (backend) {
      const endpointHost = new URL(backend.endpoint).hostname;
      if (hostAllowed(endpointHost, egress)) {
        tools.push(makeSearchTool(backend));
        searchOn = true;
      } else {
        searchNotes.push(
          `! web_search spento: ${endpointHost} non è in rot/egress.json — aggiungilo e rifai \`muffin rot reseal\``,
        );
      }
    }
  }

  const capabilities = new Map<string, CapabilityDecl>(
    [
      ...fsCapabilities,
      memoryCapability,
      shellCapability,
      httpCapability,
      ...processCapabilities,
      skillCapability,
      // Declared only when the tool exists. A capability the kernel knows about
      // but nothing can invoke is the harmless direction; the dangerous one is a
      // tool the kernel has never heard of, and registering them together is
      // what keeps them from drifting apart.
      ...(searchOn ? [searchCapability] : []),
    ].map((c) => [c.id, c]),
  );
  const decide = createDecide({
    capabilities,
    // The line that makes `rot/policy.json` load-bearing. Delete it and the
    // build fails — which is the point: the previous arrangement had the same
    // numbers compiled in, so deleting the *file* changed nothing at all.
    matrix,
    // Both caps, not just the monthly one. The per-tenant daily cap is the one
    // that exists for a group talking to itself, and it was declared, tested
    // and never consulted.
    budgetExhausted: () => budget.exhausted(),
    hardened: config.rot.mode === 'hardened',
    egressAllowed: (host) => hostAllowed(host, egress),
    // Safe mode was computed at boot and never reached the kernel, while the
    // CLI told the user "capabilities above low risk are denied". That was the
    // only place in the system where the code asserted a guarantee it did not
    // provide.
    safeMode: safeMode !== null,
  });

  const closeHooks: Array<() => Promise<void>> = [];

  return {
    config,
    budget,
    jobs,
    db,
    safeMode,
    bootLines: [
      ...skillScan.problems.map((p) => `! ${p}`),
      ...profileProblems.map((p) => `! ${p}`),
      ...searchNotes,
      ...matrixNotes,
    ],
    register: (tool, decl) => {
      capabilities.set(decl.id, decl);
      tools.push(tool);
    },
    onClose: (hook) => {
      closeHooks.push(hook);
    },
    light: { provider, model: config.models.light },
    memory: { store: memoryStore, recall: recallDeps },
    deps: {
      provider,
      profile,
      model: config.models.main,
      tools,
      decide,
      // The declarations, so the loop derives the policy resource from
      // resourceKind/policyArgs instead of guessing at argument names.
      capabilities,
      tracer,
      sessions: new SessionStore(home),
      budgetExhausted: () => budget.exhausted(),
      recordSpend: (entry) => {
        const usd = costUsd(entry.model, entry, config.provider.baseUrl);
        budget.record({ ...entry, usd });
        return usd;
      },
      // One prompt per tenant class, assembled here and never per turn: the
      // class a turn belongs to is a property of who is speaking, and `runTurn`
      // picks. Built once so each class keeps its own warm cache prefix.
      systemPrompts: buildSystemPrompts(
        home,
        safeMode !== null,
        skillsPromptSection(skillScan.skills),
      ),
      memory: { store: memoryStore, recall: recallDeps },
    },
    close: () => {
      // Async teardown is best-effort (srt registers its own exit hook, MCP
      // children die with the pipe); the DB close stays synchronous and
      // unconditional.
      for (const hook of closeHooks) void hook().catch(() => {});
      void executor.close().catch(() => {});
      db.close();
    },
  };
}

/**
 * Connect the allowlisted MCP servers and register their verified tools.
 * Separate from buildRuntime on purpose: connecting spawns processes and is
 * async, and a runtime for `muffin memory why` has no reason to pay it.
 * Returns the report lines for the surface to print.
 */
export async function attachMcp(runtime: Runtime, home = paths().home): Promise<string[]> {
  const registry = loadMcpRegistry(home);
  if (Object.keys(registry.servers).length === 0) return [];
  const attachment = await buildMcpTools(registry);
  for (const decl of attachment.capabilities) {
    const tool = attachment.tools.filter((t) => t.capability === decl.id);
    for (const t of tool) runtime.register(t, decl);
  }
  runtime.onClose(() => attachment.close());
  return attachment.report;
}

