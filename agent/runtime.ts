import DatabaseCtor from 'better-sqlite3';
import { openDb } from '../core/db/open.js';
import { join } from 'node:path';
import { BudgetEngine } from '../core/budget/budget.js';
import { migrate } from '../core/db/migrate.js';
import { costUsd } from '../core/budget/pricing.js';
import { loadConfig, paths, readSecret, secretDir, type Config } from '../core/config/config.js';
import { loadSealedBudgets } from '../core/rot/budgets.js';
import { mandatoryGuards } from '../core/rot/guards.js';
import { createDecide } from '../core/policy/decide.js';
import { loadPolicyMatrix } from '../core/policy/matrix.js';
import type { CapabilityDecl } from '../core/policy/types.js';
import { hardeningHolds, verify, type HardeningCheck } from '../core/rot/verify.js';
import { SessionStore } from '../core/session/store.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { buildSystemPromptBlocks, renderSystemPrompts, type SystemPromptBlocks } from './context/assemble.js';
import type { LoopDeps, RegisteredTool, SpendEntry } from './loop.js';
import { UndoJournal } from '../core/undo/journal.js';
import type { Provider } from './providers/types.js';
import { loadProfiles, selectProfile, withThinking } from './profiles/profile.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAICompatProvider } from './providers/openai-compat.js';
import { fsCapabilities, makeFsTools, type FsScope } from './tools/fs.js';
import { documentCapability, makeDocumentTool } from './tools/document.js';
import { memoryCapability, memorySearchSpec, searchMemory } from './tools/memory.js';
import { Vault } from '../core/vault/vault.js';
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
import { promptNonce } from '../core/skills/nonce.js';
import { inspectCapability, makeInspectTool } from './tools/inspect.js';
import { JobFireStore } from '../core/scheduler/job-fires.js';
import { JobStore } from '../core/scheduler/jobs.js';
import { TurnStore, describeInterrupted } from '../core/turns/store.js';
import { TodoStore } from '../core/turns/todo.js';
import { makeWaitTool, waitCapability } from './tools/wait.js';
import { makeTodoTool, todoCapability } from './tools/todo.js';
import { makeEmbedder } from '../core/memory/embed.js';
import { LlmReranker } from '../core/memory/rerank.js';
import { MemoryStore } from '../core/memory/store.js';
import { VectorIndex } from '../core/memory/vectors.js';
import type { RecallDeps } from '../core/memory/recall.js';
import { ingestPending } from '../core/memory/ingest.js';
import { sweepDuplicates } from '../core/memory/maintenance.js';
import {
  Consolidator,
  CONSOLIDATION_CAPABILITY,
  CONSOLIDATION_TENANT,
} from '../core/memory/consolidator.js';
import { lightLane } from './providers/light-lane.js';

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
   * La sandbox, o `null` se il contenimento non è disponibile qui.
   *
   * Esposta perché un job `script` gira **fuori** da un turno del modello —
   * niente tool, quindi niente `makeShellTool` a portarsela dietro — e deve
   * girare contenuto esattamente come ci gira `sys.shell`. `null` è la stessa
   * informazione che qui sotto decide se esporre `sys.shell`, e il runner dei
   * job la usa per rifiutare invece di eseguire senza contenimento.
   */
  executor: { run: SandboxExecutor['run'] } | null;
  /** Dove girano gli script dei job: la stessa radice di progetto dei tool. */
  workspace: string;
  /**
   * The light lane. Extraction, the contradiction judge and consolidation all
   * run here: they are classification and rewriting, not frontier work, and
   * paying Sonnet prices to turn a sentence into a triple is how a personal
   * agent quietly costs $80 a month.
   */
  light: { provider: Provider; model: string };
  memory: { store: MemoryStore; recall: RecallDeps };
  /**
   * The document store behind memory. Exposed so a surface indexes into the
   * same root the `document_read` tool reads from — two roots is a bug that
   * presents as "the document is not in my memory".
   */
  vault: Vault;
  budget: BudgetEngine;
  /** Scheduled jobs, on the same connection as everything else (ADR-0022). */
  jobs: JobStore;
  /**
   * The `(job.id, scheduled_for) → turn_id` bridge (B7). Exposed the same way
   * `jobs` is — `cli/gateway.ts`/`cli/repl.ts` wire it into both `Scheduler`
   * (settling a fire before `markRan`) and `makeJobRunner` (resolving one
   * before ever touching the model) — rather than each opening its own
   * `JobFireStore` on this same `db` and risking two objects disagreeing about
   * one row.
   */
  jobFires: JobFireStore;
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
  /**
   * The memory lane's trigger (ADR-0038). Already wired to `deps.onTurnEnd`;
   * exposed so a surface can print what it is doing at boot and so `muffin
   * memory extract` runs the hand-typed batch through the same door.
   */
  consolidation: Consolidator;
  /** Set when the root of trust diverged and we are running degraded. */
  safeMode: { reason: string; diverged: string[] } | null;
  /**
   * The named blocks `deps.systemPrompts` was rendered from — the same call,
   * not a second one. `muffin prompt show --blocks` (`cli/prompt-show.ts`)
   * reads this for provenance instead of re-deriving which file produced which
   * span of the string, which would be a second description of the assembly
   * next to the real one.
   */
  promptBlocks: SystemPromptBlocks;
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

export function buildRuntime(
  home = paths().home,
  cwd = process.cwd(),
  opts: {
    /**
     * Dove finiscono le righe che il consolidamento scrive **mentre** qualcosa
     * d'altro sta usando il terminale.
     *
     * Iniettabile e non cablata su `process.stderr` per un difetto misurato: il
     * REPL ha una riga di stato che si riscrive in place, e questo log —
     * costruito qui, dove di quella riga non si sa niente — le si incollava
     * dentro invece di sostituirla (`⠋ penso…consolidamento: …`). Chi possiede
     * il terminale è il chiamante, quindi è il chiamante a dire come ci si
     * scrive. Il default resta il comportamento di sempre, per il gateway e per
     * chiunque non abbia un terminale da proteggere.
     */
    log?: (line: string) => void;
  } = {},
): Runtime {
  const p = paths(home);
  const exporter = new JsonlExporter(home);
  const tracer = new SimpleTracer(exporter);

  const configNotes: string[] = [];
  const config = loadConfig(home, (line) => configNotes.push(`! ${line}`));
  exporter.pruneOlderThan(config.traces.retentionDays);

  // Root of trust before anything reads policy from it: in single-user mode a
  // divergence degrades instead of refusing, but it is never ignored.
  const rot = verify(home, config.rot.mode);

  // `hardened` is checked, never believed. The mode in `config.json` is a
  // self-report — `init --hardened` wrote the word and created no service user
  // — and the kernel reads that word to turn a high-risk owner capability from
  // *ask* into a silent allow. Asking for the stronger mode therefore delivered
  // a weaker one. The claim now has to hold on this machine, and when it does
  // not the kernel is told the truth and the owner is told which file gave it
  // away.
  const hardening: HardeningCheck =
    config.rot.mode === 'hardened'
      ? hardeningHolds(home)
      : { holds: false, why: 'modalità dichiarata single-user' };
  const rotNotes: string[] = [];
  if (config.rot.mode === 'hardened' && !hardening.holds) {
    rotNotes.push(
      `! rot: modalità "hardened" dichiarata ma non vera su questa macchina (${hardening.why}) — ` +
        'tratto il root of trust come single-user: rilevo le manomissioni, non le impedisco, ' +
        'e le capability ad alto rischio continuano a chiedere',
    );
  }

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

  // The caps come from inside the seal, and this line is the whole point of the
  // change: they used to come from `config.budget`, a file the manifest does not
  // cover, so the sealed `budgets.json` was protecting a copy of the numbers
  // while the ones that bound sat where anything able to write the home could
  // raise them. Same placement argument as the matrix above — read once at boot,
  // never per decision.
  const budgets = loadSealedBudgets(home);
  const budgetNotes = budgets.notes.map((n) => `! ${n}`);

  const db = openDb(p.db);
  // Versioned schema lifecycle before any store constructs (RETURN S2): the
  // additive store DDL below stays the fresh-install path; ordered reshapings,
  // the old-code-on-newer-data guard and the pre-migration VACUUM INTO backup
  // live in one place. A boot with nothing pending costs zero here.
  migrate(db, { backupDir: join(p.home, 'backups') });
  const budget = new BudgetEngine(db, budgets.caps);
  const jobs = new JobStore(db);
  const turns = new TurnStore(db);
  // The identity/idempotency bridge from a due occurrence to a durable turn
  // (B7, ADR-0035 emendamento №5). Same connection as `jobs`/`turns`, same
  // `CREATE TABLE IF NOT EXISTS` additivity as every other store here.
  const jobFires = new JobFireStore(db);
  // The plan, on the same connection as everything else (ADR-0022). Built here
  // rather than inside the loop because two things read it — the tool that
  // writes rows and `buildContext`, which shows them back on every turn — and a
  // second handle would let those two disagree about what is open.
  const todos = new TodoStore(db);

  /**
   * Turns that a dead process was holding, named at boot.
   *
   * This is the read half of the turn record, and it is on the real path
   * because every surface builds a runtime: `muffin run`, the REPL and the
   * gateway all print `bootLines` before their first turn. Without it the row
   * would be written and consulted by nobody, which is this repo's signature
   * defect and the reason the record exists in the first place.
   *
   * The concrete failure it makes visible is measured, not hypothetical: a
   * process that dies inside `TelegramConnector.handle` leaves the update
   * pending, and the restart re-runs the whole turn — **tool calls and their
   * effects included** — with nothing anywhere saying that it did.
   *
   * It reclaims, it does not resume: rows go to `interrupted`, never straight to
   * `runnable`. The split is the point — marking happens at boot in **every**
   * process that opens the home, resuming happens in the one process that owns
   * the lane (`core/turns/lane.ts`). Merging them would resume a turn inside
   * `buildRuntime`, i.e. inside `muffin doctor`.
   *
   * (This comment used to end "promising a resume that does not exist would be
   * worse than the silence it replaces". A resume exists now; the sentence was
   * left behind by the slice that built it, which is exactly how a comment
   * becomes a lie a reader has no way to catch.)
   */
  const turnNotes = turns
    .reclaim()
    .map((t) => `! ${describeInterrupted(t)}`);

  /**
   * Turns suspended with nobody to wake them, named at boot for the same reason
   * interrupted ones are.
   *
   * Only the surfaces that do **not** own a lane can produce this state — the
   * REPL and `muffin run` both stand down for the gateway (ADR-0035) — so it is
   * precisely the owner running Muffin from a terminal who would otherwise wait
   * for an answer that no process is coming back to give.
   */
  const waitingNotes = ((): string[] => {
    const { waiting } = turns.health({ windowMs: 0 });
    if (waiting.count === 0) return [];
    const due = waiting.oldestWakeAt === null ? '' : ` (il più vecchio scade ${waiting.oldestWakeAt.slice(0, 16).replace('T', ' ')})`;
    return [
      `! ${waiting.count} turni sospesi in attesa di risveglio${due} — li riprende la corsia del gateway, ` +
        `\`muffin doctor\` dice se ne sta girando uno`,
    ];
  })();

  /**
   * Turns that answered with nobody to tell, named at boot for the same
   * reason `waitingNotes` is (D2, judge round 2).
   *
   * `agent/turn-lane.ts` writes `delivery = 'undeliverable'` on the row the
   * moment it happens, but the process that resumed the turn is not
   * necessarily the process an owner is watching — a gateway with no
   * terminal writes this to a journal nobody tails. `bootLines` is read by
   * every surface (`muffin run`, the REPL, the gateway) before its first
   * turn, which is what makes this the second, durable notice next to
   * `muffin doctor`'s own.
   */
  const undeliverableNotes = ((): string[] => {
    const { undeliverable } = turns.health({ windowMs: 0 });
    if (undeliverable.count === 0) return [];
    return [`! ${undeliverable.count} turni con risposta senza indirizzo — \`muffin doctor\` li nomina`];
  })();

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
          //
          // L'instradamento invece **non** ha un default: è una scelta
          // dell'owner su prezzo, quantizzazione e chi può conservare i suoi
          // dati, e sceglierla al posto suo qui sarebbe deciderla in silenzio.
          // Assente = quello che fa il gateway da sé; `muffin doctor` dice
          // cosa vuol dire.
          config.provider.routing ? { routing: config.provider.routing } : {},
        );

  const profileProblems: string[] = [];
  const profiles = loadProfiles(undefined, (line) => profileProblems.push(line));
  // L'override dell'owner (`config.json` §thinking) sulla sola corsia di
  // conversazione: la light qui sotto tiene il profilo del *suo* modello, e le
  // corsie della memoria chiedono `off` da sé.
  const profile = withThinking(selectProfile(config.models.main, profiles), config.thinking);

  const recordSpend = (entry: SpendEntry): number => {
    const usd = costUsd(entry.model, entry, config.provider.baseUrl);
    budget.record({ ...entry, usd });
    return usd;
  };

  /**
   * The light lane, behind the boundary that bills it and makes its requests
   * legal on the wire.
   *
   * The unwrapped `provider` is never handed to extraction, the judge or the
   * reranker again: those three were a second entry point to the model that the
   * loop's `recordSpend` and `profile.sampling` did not reach, so the memory
   * lane spent invisibly and would 400 on any light model from 4.7 onward. See
   * `agent/providers/light-lane.ts` for why this is a wrapper and not three
   * parameters.
   */
  const light = lightLane(provider, {
    profile: selectProfile(config.models.light, profiles),
    record: (entry) =>
      void recordSpend({ ...entry, tenant: CONSOLIDATION_TENANT, capability: CONSOLIDATION_CAPABILITY }),
  });

  // Memory. The vector half is optional and its absence is reported rather than
  // hidden: an embedder that is not running turns semantic recall into keyword
  // search, and the difference has to be visible in `doctor` and in the traces.
  const memoryStore = new MemoryStore(db);
  let vectors: VectorIndex | undefined;
  try {
    // Dalla config, non cablato: l'embedder è una scelta di installazione (il
    // primo commento di `core/memory/embed.ts` lo dice da sempre, e finora non
    // si poteva fare). Su una VPS senza Ollama, un `new OllamaEmbedder()` fisso
    // significa che niente viene indicizzato e il recall resta solo testuale.
    vectors = new VectorIndex(
      db,
      makeEmbedder(
        config.embedder,
        (ref) => readSecret(ref, home),
        // Entrare in modalità degradata è un evento, non uno stato da scoprire
        // leggendo `doctor` di propria iniziativa: passa dallo stesso writer
        // del consolidamento, quindi nel REPL rispetta la riga di stato invece
        // di incollarcisi dentro.
        (motivo) =>
          (opts.log ?? ((line: string) => process.stderr.write(`${line}\n`)))(
            `embedder: ${motivo.message} — passo al fallback, e ci resto fino al riavvio`,
          ),
      ),
    );
  } catch {
    vectors = undefined;
  }
  const recallDeps: RecallDeps = {
    store: memoryStore,
    vectors,
    reranker: new LlmReranker(light, config.models.light),
  };

  // One vault per runtime, shared by the tool that reads documents and by the
  // surfaces that put them there. Built here rather than in each caller so the
  // drill-down and the connector cannot end up pointed at different roots —
  // which would fail as "document not found" and look like a tenant problem.
  const vault = new Vault(memoryStore, p.vault);

  // Writes are scoped to the working directory, and the root of trust is never
  // writable from a tool whatever the scope says.
  //
  // `denyRead` names every place a secret can be, which is more than one now.
  // The list was `[p.secrets]` while ADR-0030 required `cwd` to be the repo —
  // because that is where the gitignored `.env` with the model key lives — and
  // `fs.read` is low risk with no `maxTaint`, so its ceiling is
  // `defaultMaxTaint.low`, which `rot/policy.json` sets to 3. In an owner turn
  // that had already taken one tier-3 tool result (the fetch-then-act pattern
  // the threat model calls *"il più comune, e va chiuso"*), `fs_read(".env")`
  // returned the provider key in plaintext. Not exploitable on the owner's
  // machine only because no `.env` existed yet — and ADR-0030 is the document
  // telling them to create one.
  // Named explicitly rather than by a "looks like a secret" heuristic. `.env` is
  // the one file inside `root` that a decision record instructs the owner to
  // fill with a key; a pattern over `*.pem`, `id_rsa`, `credentials` and the
  // rest would deny a moving target and buy the confidence of a complete list
  // without being one. What makes the key safe is that it no longer has to be
  // here (`secretDir('persistent')`); this entry is the belt for the owner who
  // has not moved it yet.
  //
  // The list itself moved to `core/rot/guards.ts`, because it was written out
  // twice here — once for the fs tools, once for the sandbox — and both copies
  // held three of the five categories the threat model requires. `.git/hooks`
  // and the shell dotfiles were in neither, and both are the same escape: a
  // contained write that becomes an uncontained execution the next time the
  // owner commits, or opens a shell.
  const guards = mandatoryGuards(home, cwd);
  const scope: FsScope = { root: cwd, denyWrite: guards.denyWrite, denyRead: guards.denyRead };
  const tools: RegisteredTool[] = [
    ...makeFsTools(scope),
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
      // `throwTier: 0` — `searchMemory` (`agent/tools/memory.ts`) never throws
      // with recalled text; recalled fragments only ever leave through its
      // fenced `return`, tiered to the worst source pulled in. An escape here
      // would be `recall()`'s own storage/internal error.
      throwTier: 0,
    },
    // The other half of "a document enters whole": the vault stores every page
    // and the model is handed an index, so it needs a door back to the text.
    // An index with no door is a summary with extra steps.
    makeDocumentTool(vault, memoryStore),
  ];

  // The hands of M3. The shell tool is registered only when the probe proved a
  // real containment on this host: absent sandbox → absent tool, declared in
  // doctor — never a silent unsandboxed run (ADR-0018 rule 5, tightened: v1 is
  // strict mode, the ask-gated escape hatch arrives as its own capability).
  // Literally the same `guards` object the fs tools got, which is what the
  // comment here used to only ask for: "two deny-lists that drift are one
  // deny-list plus a hole". They were two hand-written copies, and both were
  // missing the same two categories — so the hole was in neither copy's
  // divergence but in both of them agreeing on an incomplete list.
  const executor = new SandboxExecutor(guards);
  const contained = executor.status().available;
  if (contained) {
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
      const opzioni = {
        apiKey: readSecret(config.search.apiKeyRef, home),
        ...(config.search.maxResults === undefined ? {} : { maxResults: config.search.maxResults }),
      };
      // Uno `switch` esaustivo e non un `tavilyBackend` incondizionato: con un
      // solo caso il codice generato è lo stesso, ma aggiungere un id al
      // catalogo diventa un **errore di compilazione qui** invece di un motore
      // scelto in config e ignorato a runtime.
      switch (config.search.provider) {
        case 'tavily':
          backend = tavilyBackend(opzioni);
          break;
        default:
          throw new Error(`motore di ricerca non implementato: ${String(config.search.provider)}`);
      }
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

  /**
   * The two runtime primitives (M5-BIS §2) — registered **last**, and the
   * position is a decision rather than an accident of where the import landed.
   *
   * `profile.maxToolsExposed` truncates this list by registration order, and
   * `consumer-local.json` sets it to **10** against a default install of twelve
   * tools. Sitting where they used to (positions 6-7, in the base array) `wait`
   * and `todo` pushed `skill_read` and `http_get` off the end — a weak local
   * model silently lost the web and the skill catalogue in exchange for the
   * ability to suspend itself, which is the wrong trade on the profile least
   * able to run a multi-turn plan in the first place. Nothing said so: the two
   * tools simply were not in the request.
   *
   * So the order is by what a turn loses without it: reading and remembering,
   * then hands, then the catalogue, then the web, then these. On a frontier
   * profile (cap 24) nothing is cut and the order is invisible; on the small
   * one it is the whole difference. `runtime-exposure.test.ts` pins the
   * resulting set, so a future insertion cannot move a capability across the
   * line without a test saying which one moved.
   *
   * Neither is optional on any install: they need no key, no probe and no
   * daemon — a database is the whole dependency, and this runtime has one open.
   * `wait` gets the store for one purpose only, counting how many turns this
   * tenant already holds suspended; it cannot suspend anything by itself.
   */
  tools.push(makeWaitTool(turns), makeTodoTool(todos));

  const capabilities = new Map<string, CapabilityDecl>(
    [
      ...fsCapabilities,
      memoryCapability,
      documentCapability,
      shellCapability,
      httpCapability,
      ...processCapabilities,
      skillCapability,
      inspectCapability,
      // Declared next to the tools above, in the same commit: a tool whose
      // capability the kernel has never heard of is refused `no_capability` on
      // its first call, and a capability with no tool is dead weight. The pair
      // is what `register` keeps together for MCP, and this list is where the
      // built-ins get the same treatment.
      waitCapability,
      todoCapability,
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
    //
    // That comment shipped above a line that wired only the monthly cap. It
    // named its own defect and the line below it did not change — which is the
    // most instructive shape this repo produces, because prose that describes
    // the fix reads exactly like prose that documents it.
    budgetExhausted: (tenant) => budget.exhausted() || budget.tenantExhausted(tenant),
    hardened: hardening.holds,
    egressAllowed: (host) => hostAllowed(host, egress),
    // Safe mode was computed at boot and never reached the kernel, while the
    // CLI told the user "capabilities above low risk are denied". That was the
    // only place in the system where the code asserted a guarantee it did not
    // provide.
    safeMode: safeMode !== null,
  });

  const closeHooks: Array<() => Promise<void>> = [];

  /**
   * The thing that makes memory fill itself (ADR-0038).
   *
   * Built here and not in the gateway, deliberately: turns happen in whichever
   * process is running them — the gateway hosts the remote surfaces, a REPL
   * window hosts the terminal — and a consolidator that only the gateway owned
   * would leave an owner with no installed unit exactly where they are today,
   * at zero facts. Two processes cannot double-extract; the durable lane lock
   * inside `ingestPending` refuses the second.
   */
  const consolidation = new Consolidator({
    db,
    budgetExhausted: () => budget.exhausted(),
    ingest: (limit) =>
      ingestPending(
        {
          store: memoryStore,
          provider: light,
          model: config.models.light,
          tracer,
          ...(vectors ? { vectors } : {}),
        },
        CONSOLIDATION_TENANT,
        limit,
      ),
    // The maintenance half, in the same object literal as the batch it follows.
    // Bound here and not left for a surface to remember: a sweep that some
    // callers wire and others do not is the twelfth member of this repo's
    // "declared and connected to nothing" family. It spends nothing — SQL over
    // rows the batch just wrote — so there is no install for which switching it
    // off would be the right default.
    sweep: (at) => sweepDuplicates(memoryStore, CONSOLIDATION_TENANT, at),
    log: opts.log ?? ((line) => process.stderr.write(`${line}\n`)),
  });

  // One prompt per tenant class, assembled here and never per turn: the class
  // a turn belongs to is a property of who is speaking, and `runTurn` picks.
  // Built once so each class keeps its own warm cache prefix. Computed as
  // blocks first and joined once (`renderSystemPrompts`) so `deps.systemPrompts`
  // and `promptBlocks` below describe the identical assembly rather than two
  // calls that could drift apart.
  const promptBlocks = buildSystemPromptBlocks(
    home,
    safeMode !== null,
    skillsPromptSection(skillScan.skills, promptNonce(home)),
  );

  /**
   * Registrato qui e non con gli altri tool più sopra: le sue fonti — la mappa
   * delle capability, i blocchi del prompt, il safe mode — esistono solo a
   * questo punto di `buildRuntime`. Metterlo prima significherebbe passargli
   * dei getter pigri su variabili non ancora assegnate, cioè un modo elaborato
   * di leggere `undefined`.
   */
  tools.push(
    makeInspectTool({
      config,
      profile,
      safeMode,
      // Stesso import dinamico, stessa ragione: `describeBuild` sta in
      // `cli/update.ts`, ed è la funzione che stampa la riga `build` di
      // `muffin doctor` (#159). Una seconda lettura di git direbbe la stessa
      // cosa fino al giorno che non la dice più.
      build: async () => {
        const { describeBuild } = await import('../cli/update.js');
        const { fileURLToPath } = await import('node:url');
        const { dirname } = await import('node:path');
        return describeBuild(dirname(fileURLToPath(import.meta.url)));
      },
      tools,
      capabilities,
      promptBlocks,
      /**
       * La stessa funzione che esegue `muffin doctor`, importata al momento
       * della chiamata.
       *
       * L'import è dinamico per non creare un arco statico `agent/` → `cli/`:
       * in questo repo le dipendenze vanno nell'altro verso, e `cli/` importa
       * già `agent/runtime.js` così (`cli/memory.ts`, `cli/vault.ts`). Resta
       * comunque un debito di layering — `runDoctor` è un motore di verifica
       * che vive in `cli/` perché lì è nato, non perché è il suo posto — ed è
       * registrato come follow-up invece che nascosto.
       *
       * Iniettarla dal chiamante sarebbe stato peggio: un secondo posto da
       * ricordare, e la stessa storia di `explicitCache` (due harness che
       * dimenticarono il flag e pagarono pieno in silenzio).
       */
      doctor: async () => (await import('../cli/doctor.js')).runDoctor(home),
      turns: () => turns.health({ windowMs: 0 }),
      jobs: () => jobs.list(),
    }),
  );

  /**
   * Il tetto del profilo taglia in silenzio, e questo lo dice.
   *
   * `visibleTools` + `maxToolsExposed` decidono cosa il modello vede, e un
   * tool oltre la linea non produce né errore né log: semplicemente non esiste
   * per quel turno. Su `consumer-local` (tetto 10, la soglia contro cui è
   * disegnato l'harness) i tool registrati sono già più di dieci, quindi la
   * riga sotto non è ipotetica — è lo stato dell'installazione dell'owner.
   *
   * ADR-0008: degradare dichiarando. Chi chiede a Muffin di ispezionarsi e
   * riceve una risposta recitata deve poter vedere **perché** senza leggere
   * questo file.
   */
  const tagliati = tools.slice(profile.maxToolsExposed).map((t) => t.spec.name);

  return {
    executor: contained ? executor : null,
    workspace: cwd,
    config,
    budget,
    jobs,
    jobFires,
    db,
    consolidation,
    safeMode,
    promptBlocks,
    bootLines: [
      ...turnNotes,
      ...waitingNotes,
      ...undeliverableNotes,
      ...skillScan.problems.map((p) => `! ${p}`),
      ...profileProblems.map((p) => `! ${p}`),
      ...(tagliati.length === 0
        ? []
        : [
            `! profilo ${profile.name}: ${tagliati.length} tool registrati oltre il tetto di ${profile.maxToolsExposed} e quindi invisibili al modello — ${tagliati.join(', ')}`,
          ]),
      ...searchNotes,
      ...matrixNotes,
      ...budgetNotes,
      ...rotNotes,
      ...configNotes,
    ],
    register: (tool, decl) => {
      capabilities.set(decl.id, decl);
      tools.push(tool);
    },
    onClose: (hook) => {
      closeHooks.push(hook);
    },
    light: { provider: light, model: config.models.light },
    memory: { store: memoryStore, recall: recallDeps },
    vault,
    deps: {
      provider,
      profile,
      model: config.models.main,
      tools,
      decide,
      // The declarations, so the loop derives the policy resource from
      // resourceKind/policyArgs instead of guessing at argument names.
      capabilities,
      // Il registro di undo: senza questa riga `fs_write` è offerto al modello e
      // non scrive mai, perché il kernel giudica `draft` e `draft` senza copia
      // rifiuta (M5-BIS D2/D3/D11). Il difetto era esattamente qui — un verdetto
      // del kernel senza implementazione a valle — quindi la cucitura ha un test
      // suo in `runtime.test.ts`, non solo il ramo nel loop.
      undo: new UndoJournal(p.undo),
      tracer,
      sessions: new SessionStore(home),
      // On the same connection as everything else, for ADR-0022's reason: one
      // process, one handle. It is also what lets a turn record and the update
      // that produced it commit together the day the connector needs that.
      turns,
      // The read half of `todo`. Required by `LoopDeps` on purpose: this is the
      // seam that makes the plan a mechanism, and a surface that forgot it would
      // keep writing rows nobody is shown.
      todos,
      budgetExhausted: (tenant) => budget.exhausted() || budget.tenantExhausted(tenant),
      recordSpend,
      // The seam the loop never had. It is what turns "a turn ended" into "the
      // memory lane has work", and without it `ingestPending` keeps the single
      // hand-typed caller it has had since M2 — which is why an install's facts
      // stay at zero and recall stays keyword-only for its whole life.
      onTurnEnd: ({ tenant }) => consolidation.notify(tenant),
      systemPrompts: renderSystemPrompts(promptBlocks),
      memory: { store: memoryStore, recall: recallDeps },
    },
    close: () => {
      // First, and before the database goes: a trailing edge that fires after
      // `db.close()` writes against a closed handle, which is the shape that
      // once took the gateway down through an unhandled rejection
      // (`Scheduler.run`). A batch already in flight is left to finish or die
      // with the process — its lane lock goes stale on its own, and `markRan`'s
      // per-episode marker means a killed batch replays one episode, not many.
      consolidation.stop();
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
  // **Ordine deterministico, e non è pedanteria.** Nella gerarchia della cache
  // di prompt i `tools` vengono **prima** del `system` (documentazione
  // Anthropic sul prompt caching: «tools, system, then messages»), quindi un
  // elenco di tool che cambia ordine fra due processi non invalida solo se
  // stesso: porta via anche il prefisso di sistema, che è la parte grossa.
  // Questi tool arrivano da server interrogati in rete, cioè nell'ordine in
  // cui rispondono. Oggi è latente — con zero server configurati la funzione
  // esce sopra — ed è il momento giusto per renderlo impossibile.
  const capacita = [...attachment.capabilities].sort((a, b) => a.id.localeCompare(b.id));
  for (const decl of capacita) {
    const tool = attachment.tools
      .filter((t) => t.capability === decl.id)
      .sort((a, b) => a.spec.name.localeCompare(b.spec.name));
    for (const t of tool) runtime.register(t, decl);
  }
  runtime.onClose(() => attachment.close());
  return attachment.report;
}

