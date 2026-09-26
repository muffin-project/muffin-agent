import { join } from 'node:path';
import type DatabaseCtor from 'better-sqlite3';
import { ApprovalStore } from '../core/approvals/store.js';
import { BudgetEngine } from '../core/budget/budget.js';
import { costUsd } from '../core/budget/pricing.js';
import {
  type Config,
  loadConfig,
  paths,
  promptVersion,
  readDefaultChannel,
  readSecret,
  secretDir,
} from '../core/config/config.js';
import { tightenHome } from '../core/config/private-fs.js';
import { resolveWorkspace } from '../core/config/workspace.js';
import { migrate } from '../core/db/migrate.js';
import { openDb } from '../core/db/open.js';
import { loadMcpRegistry } from '../core/mcp/registry.js';
import {
  CONSOLIDATION_CAPABILITY,
  CONSOLIDATION_TENANT,
  Consolidator,
} from '../core/memory/consolidator.js';
import { makeEmbedder } from '../core/memory/embed.js';
import { ingestPending } from '../core/memory/ingest.js';
import { sweepDuplicates } from '../core/memory/maintenance.js';
import type { RecallDeps } from '../core/memory/recall.js';
import { LlmReranker } from '../core/memory/rerank.js';
import { MemoryStore } from '../core/memory/store.js';
import { VectorIndex } from '../core/memory/vectors.js';
import { type EgressPolicy, hostAllowed, loadEgress } from '../core/net/egress.js';
import { createDecide } from '../core/policy/decide.js';
import { loadPolicyMatrix } from '../core/policy/matrix.js';
import type { CapabilityDecl } from '../core/policy/types.js';
import { loadSealedBudgets } from '../core/rot/budgets.js';
import { mandatoryGuards } from '../core/rot/guards.js';
import { type HardeningCheck, hardeningHolds, verify } from '../core/rot/verify.js';
import { SandboxExecutor } from '../core/sandbox/executor.js';
import { assessShellBoundary } from '../core/sandbox/shell-boundary.js';
import { JobFireStore } from '../core/scheduler/job-fires.js';
import { JobStore } from '../core/scheduler/jobs.js';
import type { QuietHours } from '../core/scheduler/proactivity.js';
import { SessionStore } from '../core/session/store.js';
import { promptNonce } from '../core/skills/nonce.js';
import { discoverSkills, skillsPromptSection } from '../core/skills/skills.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { describeInterrupted, TurnStore } from '../core/turns/store.js';
import { TodoStore } from '../core/turns/todo.js';
import { UndoJournal } from '../core/undo/journal.js';
import { Vault } from '../core/vault/vault.js';
import {
  buildSystemPromptBlocks,
  type IstanzaFacts,
  renderSystemPrompts,
  type SystemPromptBlocks,
} from './context/assemble.js';
import type { Approver, LoopDeps, RegisteredTool, SpendEntry, TurnRuntimeInfo } from './loop.js';
import { loadProfiles, selectProfile, withThinking } from './profiles/profile.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { type LightAttemptReport, lightLane } from './providers/light-lane.js';
import { OpenAICompatProvider } from './providers/openai-compat.js';
import type { Provider } from './providers/types.js';
import {
  type CapabilityGap,
  formatCapabilityGap,
  truncationGap,
} from './tools/capability-status.js';
import { documentCapability, makeDocumentTool } from './tools/document.js';
import { effectsCapability, makeEffectsTool } from './tools/effects.js';
import { type FsScope, fsCapabilities, fsList, makeFsTools } from './tools/fs.js';
import { httpCapability, makeHttpTool } from './tools/http.js';
import { inspectCapability, makeInspectTool } from './tools/inspect.js';
import { buildMcpTools } from './tools/mcp.js';
import {
  memoryCapability,
  memorySearchSpec,
  memoryWhySpec,
  searchMemory,
  whyMemory,
} from './tools/memory.js';
import { forgetMemory, memoryForgetCapability, memoryForgetSpec } from './tools/memory-forget.js';
import { makeProcessTools, processCapabilities } from './tools/process.js';
import { makeScheduleTool, scheduleCapability } from './tools/schedule.js';
import { diagnoseSearch, makeSearchTool, searchCapability } from './tools/search.js';
import {
  makeShellTool,
  makeShellWriteTool,
  shellCapability,
  shellWriteCapability,
} from './tools/shell.js';
import { makeSkillTool, skillCapability } from './tools/skill.js';
import { makeTodoTool, todoCapability } from './tools/todo.js';
import { makeVaultSaveTool, vaultWriteCapability } from './tools/vault-save.js';
import { makeWaitTool, waitCapability } from './tools/wait.js';

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
  /**
   * The owner's quiet window, from inside the seal.
   *
   * Exposed for the same reason `budget` is: the proactivity rails are read by
   * things built *outside* this file — `cli/gateway.ts` and `cli/repl.ts` wire
   * the dated-commitment lane (ADR-0060) — and a second `loadSealedBudgets`
   * call there would be a second reader of the same sealed file, which is
   * exactly how `cli/jobs.ts` and the observe path once disagreed about what
   * `{quietHours:{timezone:1}}` meant.
   */
  quietHours: QuietHours;
  /**
   * `surfaces.default` — where the owner reads — **read from disk per call**,
   * not the copy in `config` above.
   *
   * A live question, exposed the way `budget.exhausted()` is, and a judge
   * measured why. The dated-commitment lane (ADR-0060) tells the owner to run
   * `muffin surface default telegram` when a promise has nowhere to go. That
   * command is a *different process* rewriting `config.json`; this one holds a
   * snapshot taken at boot. So the owner ran the remedy the agent asked for,
   * on a gateway that keeps running for days under launchd, and the next pass
   * still said `"cli" non arriva a nessuno da qui` — the remedy inert, with
   * nothing to distinguish it from a bug.
   *
   * Two callers, one function, for the same reason `makeCommitmentLane` is one
   * function: a manopola that works from the gateway and not the REPL is a
   * manopola the owner cannot rely on.
   *
   * The read is a plain `readFileSync` + parse of a file that is deliberately
   * **outside** the seal (`core/rot/budgets.ts` states why: `config.json` holds
   * the surfaces and the pairing state), so it crosses no trust boundary. A
   * config that has become unreadable or invalid since boot falls back to the
   * booted value rather than throwing: the caller is on the 30-second beat that
   * keeps the gateway's claim alive, and a promise is not the thing to take a
   * process down over.
   *
   * What this does *not* buy: a surface **enabled** after boot. The registry is
   * built once by `connectSurfaces`, so pointing the default at a surface this
   * process never connected returns `{ delivered: false }` — honest, anchor
   * left open, and still a restart. Turning the knob between surfaces that were
   * already up is the case this makes live, and it is the case the remedy names.
   */
  defaultChannel: () => string;
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
   * Chi sa chiedere un'approvazione, superficie per superficie.
   *
   * Era una funzione sola su `deps.approve`, e una funzione sola era il difetto:
   * il REPL ci scriveva la sua, quindi un turno arrivato da Telegram faceva
   * comparire `[s/N]` nel terminale — la domanda a chi non l'aveva fatta, in un
   * posto che chi ha il telefono in mano non sta guardando. Il terminale
   * registra `cli` (`cli/repl.ts`), Telegram registra `telegram`
   * (`cli/surface.ts`), e `deps.approve` è l'instradatore: una superficie senza
   * nessuno registrato risponde `unavailable`, che è la cosa vera da dire.
   */
  approvers: Map<string, Approver>;
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
   * Every capability this assembly switched off or truncated, structured —
   * `web_search` disabled, `shell_run` disabled, any tool `profile.
   * maxToolsExposed` cut. The producer `bootLines` above is *rendered from*
   * (agent/tools/capability-status.ts), and the same array `sys.inspect`
   * (agent/tools/inspect.ts) and `muffin doctor` (cli/doctor.ts's own search
   * check) read from — one source, so a turn and the owner's terminal cannot
   * disagree about why a tool is missing.
   */
  capabilityGaps: CapabilityGap[];
  /**
   * Late registration for tools that arrive asynchronously (MCP servers).
   * Registers the capability too: a tool the kernel does not know is a tool
   * the loop cannot ever be allowed to call.
   */
  register(tool: RegisteredTool, decl: CapabilityDecl): void;
  /**
   * Redo the `profile.maxToolsExposed` cut against the tools registered *so
   * far*, in place of the one `buildRuntime` computed before any late
   * registration existed.
   *
   * `send_file` (`cli/surface.ts#attachSendFile`) and MCP tools
   * (`attachMcp`) both arrive after `buildRuntime` returns — the first
   * `computeExposureGaps` pass inside it cannot see either, so its
   * `capabilityGaps`/`bootLines` describe a tool list that is already stale
   * by the time a surface prints them. `cli/gateway.ts` and `cli/repl.ts`
   * call this once, right after every `attach*` call for that boot has run,
   * and print what it returns next to `bootLines` rather than trusting the
   * frozen array. `cli/run.ts` calls it after its own `attachMcp`, having
   * never attached `send_file` at all.
   *
   * Returns the `'truncated'` lines only (already formatted, `capability
   * tagliato: …`), for a caller to print — `capabilityGaps` itself is
   * mutated in place, so `sys.inspect`'s own live read of it stays correct
   * without calling this.
   */
  recomputeExposure(): string[];
  /** Awaited by close(); attachments park their teardown here. */
  onClose(hook: () => Promise<void>): void;
  close(): void;
};

/**
 * Same parse `cli/gateway.ts#tickMsFromEnv` uses, for the same reason: a
 * test-only timing knob that is a silent no-op on anything but a positive
 * finite number, never a thrown error over a malformed env var.
 */
function msFromEnv(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * The order `buildRuntime` registers built-in tools in, named without
 * building any of them — the fact `muffin doctor` needs to say which ones a
 * profile's ceiling would cut without opening a database or a sandbox to get
 * it, so the ceiling reads the same as `sys.inspect`'s (which does hold the
 * real, live array).
 *
 * `sandboxAvailable` and `searchOn` are the only two conditionals in the
 * literal build below; every other position is unconditional. MCP tools are
 * never part of this: they attach after `buildRuntime` returns
 * (`attachMcp`), which is also why they never counted toward `tagliati`
 * there.
 *
 * `agent/runtime-exposure.test.ts` asserts this against the real, constructed
 * array — the same de-drift discipline as `capabilityGaps` above: a second
 * hand-typed order would be exactly the kind of copy this repository has
 * already paid for once (`slice/turno-sospeso`, cited in that test).
 */
export function baseToolOrder(input: {
  sandboxAvailable: boolean;
  searchOn: boolean;
  /**
   * Whether `send_file` will exist for this install (DAY-1 requirement B14,
   * `cli/surface.ts#attachSendFile`) — `false` by default because
   * `buildRuntime` genuinely does not know yet: the gateway and the REPL
   * attach it after `buildRuntime` returns (they hold the `SurfaceRegistry`
   * it needs), `muffin run` never does.
   *
   * Placed **before** `wait`/`todo`/`sys_inspect` on purpose: those three are
   * the tools this list already names, deliberately, as the ones a cut may
   * take first (comment below, and `runtime-exposure.test.ts`'s +1 for
   * `fs_search` names `sys_inspect` as "the first of the list to fall"). A
   * tool an owner's turn actually depends on for getting an artifact back —
   * DAY-1, not scaffolding — must not rank below the harness's own
   * self-inspection merely because it happens to attach later in the boot
   * sequence. That was the measured defect: `send_file` used to land after
   * `sys_inspect` in the live array for no reason anyone chose, which made it
   * the *first* casualty of a cut, not the last.
   */
  sendFileAvailable?: boolean;
}): string[] {
  return [
    'fs_read',
    'fs_list',
    'fs_search',
    'fs_write',
    'fs_edit',
    'memory_search',
    'memory_why',
    'memory_forget',
    'document_read',
    // Accanto a `document_read`, e non in coda: sono le due metà della stessa
    // cosa — si salva per rileggere. In una stanza con grant (ADR-0073) queste
    // due sono quasi tutto il menu, quindi farle cadere per prime da un tetto
    // di profilo vorrebbe dire tagliare proprio la capacità che il sigillo ha
    // appena concesso.
    'vault_save',
    // Adjacent, and the read-only one first: the model reads this list in
    // order, and ADR-0074 punto 4 makes `shell_run` the default choice while
    // `shell_run_write` is the one that can change things. Both ask since
    // ADR-0091; if a profile's cap ever splits the pair, the half that
    // survives must be the half that cannot write.
    ...(input.sandboxAvailable ? ['shell_run', 'shell_run_write'] : []),
    'process_list',
    'process_kill',
    'skill_read',
    'http_get',
    ...(input.searchOn ? ['web_search'] : []),
    ...(input.sendFileAvailable ? ['send_file'] : []),
    /**
     * Sopra `wait`/`todo`/`sys_inspect`, e per l'argomento che `send_file` ha
     * gia' vinto due righe piu' su: quelli tre sono i primi che un taglio di
     * profilo prende, e il registro degli effetti (D15) e' una riga DAY-1 —
     * la risposta a «cosa hai fatto oggi». Perderla in silenzio significa un
     * owner che non puo' piu' vedere cosa e' passato senza domanda, che e'
     * esattamente la sorveglianza che ADR-0074 rende necessaria togliendo
     * quasi ogni domanda. Fra l'auto-descrizione e l'auto-rendiconto, il
     * secondo.
     */
    'sys_effects',
    'wait',
    'todo',
    'schedule_recurring',
    'sys_inspect',
  ];
}

export function buildRuntime(
  home = paths().home,
  /**
   * The directory the caller is *proposing* as the turn's workspace, not the
   * workspace itself: `resolveWorkspace` below refuses it when it is the
   * installation. The default stays `process.cwd()` because for `muffin run`
   * and the REPL the owner chose that directory by standing in it — and it is
   * exactly the surfaces where nobody chose it (a supervised gateway, whose
   * cwd its unit pins to the home on purpose) that the refusal is for.
   */
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
    /**
     * Extra paths no tool may read, layered on top of `mandatoryGuards` —
     * never a substitute for it. Production never passes this; it exists for
     * a caller that runs a *real* model against a throwaway home and needs
     * the read-only shell lane (`sys.shell`, ADR-0074 punto 4 — deliberately
     * allow-by-default on reads, `--ro-bind / /` minus the mandatory guards)
     * to see only that home, not the operator's real one. `evals/character/run.ts`
     * is the first caller: a probe whose fixture workspace has nothing to
     * find can send the model looking on the real disk, and a real network
     * model's tool result is bytes leaving the machine (found running D13's
     * first instrumented round, `docs/evidence/eval-fuga-filesystem-2026-09-07.md`).
     */
    extraDenyRead?: readonly string[];
  } = {},
): Runtime {
  const p = paths(home);
  // Startup migration (#639): tighten a pre-existing same-user home before
  // anything reads or writes state. Fresh homes are already private by
  // construction; this is the upgrade path for installs created under a
  // permissive umask. Foreign-owned (hardened) material is skipped inside.
  try {
    tightenHome(home);
  } catch {
    /* best-effort: tightening must not break boot */
  }
  /**
   * Where this turn may write — never where Muffin is installed.
   *
   * One call site, deliberately: every surface builds its runtime through this
   * function, so the guarantee holds for `muffin run` and the REPL as well as
   * for the gateway, and a surface added next year cannot forget it. See
   * `core/config/workspace.ts` for the measurement that made this necessary
   * and for why the workspace is a sibling of the home rather than a
   * subdirectory of it.
   */
  const { workspace, notes: workspaceNotes } = resolveWorkspace(home, cwd);
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
  const turnNotes = turns.reclaim().map((t) => `! ${describeInterrupted(t)}`);

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
    const due =
      waiting.oldestWakeAt === null
        ? ''
        : ` (il più vecchio scade ${waiting.oldestWakeAt.slice(0, 16).replace('T', ' ')})`;
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
    return [
      `! ${undeliverable.count} turni con risposta senza indirizzo — \`muffin doctor\` li nomina`,
    ];
  })();

  // One connection, two lanes: the endpoint is the same, the model id is not.
  const createMainProvider = (source: Config): Provider =>
    source.provider.kind === 'anthropic'
      ? new AnthropicProvider(readSecret(source.provider.apiKeyRef, home), source.provider.baseUrl)
      : new OpenAICompatProvider(
          readSecret(source.provider.apiKeyRef, home),
          source.provider.baseUrl,
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
          source.provider.routing ? { routing: source.provider.routing } : {},
        );
  let provider: Provider = createMainProvider(config);
  let providerFingerprint = JSON.stringify(config.provider);
  let lightFingerprint = JSON.stringify({ provider: config.provider, light: config.models.light });

  const profileProblems: string[] = [];
  const profiles = loadProfiles(undefined, (line) => profileProblems.push(line));
  // L'override dell'owner (`config.json` §thinking) sulla sola corsia di
  // conversazione: la light qui sotto tiene il profilo del *suo* modello, e le
  // corsie della memoria chiedono `off` da sé.
  const profile = withThinking(selectProfile(config.models.main, profiles), config.thinking);

  const recordSpendWithBaseUrl = (entry: SpendEntry, baseUrl: string | undefined): number => {
    const usd = costUsd(entry.model, entry, baseUrl);
    // `entry` porta già `jobId` quando il turno è il giro di un job
    // (`agent/loop.ts`), e lo spread lo passa dritto alla riga di `spend`:
    // niente da tenere in sincrono qui, e nessun secondo posto in cui
    // l'attribuzione possa perdersi.
    budget.record({ ...entry, usd });
    return usd;
  };
  const makeRecordSpend =
    (baseUrl: string | undefined) =>
    (entry: SpendEntry): number =>
      recordSpendWithBaseUrl(entry, baseUrl);
  let recordSpend = makeRecordSpend(config.provider.baseUrl);
  let lightBaseUrl = config.provider.baseUrl;

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
   *
   * `let`, ricovered by `refreshLightModel`: a light switch must reach new
   * turns without a restart (#500), and every consumer below reads this
   * binding — never a copy — so the swap is atomic per call. In-flight calls
   * keep the old wrapper, which is the safe direction.
   */
  /**
   * Physical light attempts as point spans (#496): one per attempt that
   * starts, including attempts of requests that ultimately fail — the count
   * success-only spend accounting cannot carry. Start and end coincide
   * because the lane reports beginnings; the count IS the number of spans.
   */
  const reportLightAttempt = (attempt: LightAttemptReport): void => {
    const span = tracer.start('muffin.light.attempt', {
      'gen_ai.request.model': attempt.model,
      'muffin.light.attempt': attempt.attempt,
      'muffin.light.request_id': attempt.requestId,
    });
    span.end();
  };
  let light = lightLane(provider, {
    profile: selectProfile(config.models.light, profiles),
    record: (entry) =>
      void recordSpendWithBaseUrl(
        {
          ...entry,
          tenant: CONSOLIDATION_TENANT,
          capability: CONSOLIDATION_CAPABILITY,
        },
        lightBaseUrl,
      ),
    onAttempt: reportLightAttempt,
  });
  const lightInfo: { provider: Provider; model: string } = {
    provider: light,
    model: config.models.light,
  };

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
  // `fs.read` sits on the `context` effect row, whose ceiling is 3
  // (ADR-0053; `defaultMaxTaint.low`, also 3, before it). In an owner turn
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
  const guards = mandatoryGuards(home, workspace);
  const denyRead = [...guards.denyRead, ...(opts.extraDenyRead ?? [])];
  const scope: FsScope = {
    root: workspace,
    denyWrite: guards.denyWrite,
    denyRead,
  };
  /**
   * Ogni capacità spenta o tagliata a questo assemblaggio, riempito via `push`
   * man mano che ogni pezzo sotto scopre il proprio motivo — mai riassegnato,
   * per lo stesso motivo per cui `tools` non lo è: `sys.inspect`
   * (agent/tools/inspect.ts) ne tiene lo stesso riferimento e legge quello che
   * c'è al momento della chiamata, non una copia presa a questo punto del boot.
   */
  const capabilityGaps: CapabilityGap[] = [];
  const tools: RegisteredTool[] = [
    ...makeFsTools(scope),
    {
      capability: memoryCapability.id,
      spec: memorySearchSpec,
      // The tenant comes from the turn, never from this line. Baking it in here
      // is how a group member ends up reading the owner's memory.
      handler: async (args, ctx) => searchMemory(recallDeps, ctx.tenant, args, ctx.jobId),
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
    {
      // DAY-1 C5: the agent's own door to `muffin memory why` — same
      // capability as `memory_search` above (`memory.read`), same tenant
      // scoping rule (the turn's, never one the model names), registered
      // right next to it so a reader sees both halves of "read the memory"
      // together. Declared and never registered here would have been the
      // exact failure the row was BLOCKER for: the CLI's `cmdMemoryWhy`
      // already worked, and nothing wired the model's equivalent into a live
      // runtime.
      capability: memoryCapability.id,
      spec: memoryWhySpec,
      handler: async (args, ctx) => whyMemory(recallDeps, ctx.tenant, args, ctx.jobId),
      // The provenance a "why" answer rests on is the turn's own grounding,
      // same as a `memory_search` hit — clearing it to save context would
      // strip the reason the answer was said in the first place.
      keepResult: true,
      // `whyMemory` never throws with a provenance answer; only a
      // storage-level error escapes its fenced `return`s.
      throwTier: 0,
    },
    {
      // «Dimentica X» — the third verb of `docs/product/VISION.md`'s conversational
      // memory (remember, correct, forget), and the one the 08/09 cutover found
      // with no mechanism at all. Same tenant rule as the two above; the
      // capability is `memory.forget` — owner-only, same `memory` effect as
      // `memory.write`. The turn id is the provenance of the retirement.
      capability: memoryForgetCapability.id,
      spec: memoryForgetSpec,
      handler: async (args, ctx) =>
        forgetMemory(
          recallDeps,
          {
            tenant: ctx.tenant,
            turnId: ctx.turnId,
            // Il job di questo turno, quando c'è: la prima chiamata di
            // `memory_forget` fa recall e paga il reranker, quindi quella spesa
            // deve finire sul contatore del job come le altre due strade.
            ...(ctx.jobId === undefined ? {} : { jobId: ctx.jobId }),
          },
          args,
        ),
      // Its answer is either the candidate list (built from recalled text,
      // tiered to the worst source) or the durable result; only a storage or
      // lock error escapes.
      throwTier: 0,
    },
    // The other half of "a document enters whole": the vault stores every page
    // and the model is handed an index, so it needs a door back to the text.
    // An index with no door is a summary with extra steps.
    makeDocumentTool(vault, memoryStore),
    // L'altra metà: «salva questo». ADR-0073 punto 2 — la prima scrittura
    // deliberata che questo sistema abbia mai avuto, per l'owner come per una
    // stanza che il sigillo nomina. `hostOnly: true` sulla dichiarazione, quindi
    // registrarla qui non concede niente a nessun gruppo: è `tenants` in
    // `rot/policy.json` a decidere chi la raggiunge.
    makeVaultSaveTool({ root: p.vault, vault, vectors }),
  ];

  // The hands of M3. The shell tool is registered only when the shared
  // boundary proves BOTH halves of the claim (#642): a real containment on
  // this host (behavioral probe) AND — on Linux/bubblewrap — a trusted setup
  // patch posture for CVE-2026-87766 (upstream ≥ 0.12.0). A probe-only gate
  // exposed `shell_run` on bwrap 0.11.1 while doctor could only warn; both
  // now read `assessShellBoundary`, so the two never describe two different
  // machines. Absent sandbox OR unverified posture → absent tool, declared in
  // doctor — never a silent unsandboxed run (ADR-0018 rule 5, tightened: v1
  // is strict mode, the ask-gated escape hatch arrives as its own capability).
  // Literally the same `guards` object the fs tools got, which is what the
  // comment here used to only ask for: "two deny-lists that drift are one
  // deny-list plus a hole". They were two hand-written copies, and both were
  // missing the same two categories — so the hole was in neither copy's
  // divergence but in both of them agreeing on an incomplete list.
  const executor = new SandboxExecutor({ ...guards, denyRead });
  const boundary = assessShellBoundary(executor.status());
  const contained = boundary.usable;
  if (contained) {
    // Both lanes or neither (ADR-0074 punto 4). The read-only one is not a fallback
    // for a host where containment failed — it is the *stricter* of the two and
    // rests on the same probe: `runReadOnly` confines writes to scratch,
    // disables direct IP networking, and on Linux cannot open Unix-domain
    // sockets (the filter is requested and verified before any command runs).
    // A host that cannot
    // prove the declared containment cannot run either lane. Registering it alone there
    // would be the silent degradation the ADR forbids, pointed the other way.
    tools.push(
      makeShellTool(executor, { root: workspace }),
      makeShellWriteTool(executor, { root: workspace }),
    );
  }
  // The absent case used to produce nothing at all here — no boot line, no
  // structured record, not even the generic degrade note the search failures
  // got. `sys.shell` simply was not in the tool list, and the only way to
  // learn why was `muffin doctor`'s own, separate sandbox probe (line ~999),
  // which nothing pointed a turn at. Same boundary doctor reads, computed
  // here instead of re-probed/re-graded, with the reason doctor will print —
  // behavioral failure and unverified patch posture stay distinguishable.
  if (!contained) {
    capabilityGaps.push({
      capability: 'shell_run, shell_run_write',
      kind: 'disabled',
      reason: boundary.reason,
      remedy: boundary.remedy,
    });
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
  // not a bricked boot — which is fail-closed the visible way for what this
  // still governs: `url`-resource capabilities (none shipped yet) and which
  // third-party endpoints get registered below (`diagnoseSearch`). `sys.http`
  // itself no longer reads `egress` at all — ADR-0066 made it `url-read`, open
  // regardless of this file's contents.
  let egress: EgressPolicy;
  try {
    egress = loadEgress(home);
  } catch {
    egress = { allow: [] };
  }
  tools.push(makeHttpTool());

  // Search is registered only when it is configured, so an unconfigured install
  // has no `web_search` in its tool list rather than one that fails at the first
  // call. The key is read here and never leaves this closure — the same handling
  // the model key gets. `diagnoseSearch` (agent/tools/search.ts) is the one
  // producer of "on, or off and why" — `sys.inspect` and `muffin doctor` call
  // the same function rather than re-deriving the sentence, which is the
  // defect this whole slice exists to close (the owner's 03/09/2026 turn: three
  // retries against a reason that was sitting in `gateway.err` the whole time).
  const searchDiagnosis = diagnoseSearch(config, egress, (ref) => readSecret(ref, home));
  const searchOn = searchDiagnosis.on;
  if (searchDiagnosis.on) {
    tools.push(makeSearchTool(searchDiagnosis.backend));
  } else if (searchDiagnosis.gap) {
    capabilityGaps.push(searchDiagnosis.gap);
  }

  /**
   * The two runtime primitives (requirements-status.md#wait-e-todo-sono-primitive-del-runtime-non-tool) — registered **last**, and the
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
  // `budgets.quietHours.timezone` e non il fuso del processo: e' la stessa
  // lettura che riceve `LoopDeps.timeZone` poco piu' sotto, e senza di essa
  // «cosa hai fatto oggi» chiesto al gateway (launchd/systemd, `TZ` del
  // supervisore) risponderebbe su una giornata diversa da quella che
  // `muffin effects` stampa sul terminale dell'owner.
  tools.push(
    makeWaitTool(turns),
    makeTodoTool(todos),
    makeEffectsTool(turns, budgets.quietHours.timezone),
    // La porta conversazionale sui job ricorrenti («ricordamelo ogni giorno
    // alle 9»): valida e persiste sullo stesso `JobStore` della CLI, con la
    // provenance del turno che ha chiesto. Accanto a `wait`/`todo` e non in
    // coda per la stessa ragione per cui quelli stanno in fondo — sono le
    // primitive del runtime, e il tetto di profilo prende da qui.
    makeScheduleTool({
      jobs,
      defaultTimezone: budgets.quietHours.timezone,
      defaultChannel: () => readDefaultChannel(home, config.surfaces.default),
    }),
  );

  const capabilities = new Map<string, CapabilityDecl>(
    [
      ...fsCapabilities,
      memoryCapability,
      // `memory_forget`'s own door, host-only: declared here or the visibility
      // filter and the kernel disagree about who sees it.
      memoryForgetCapability,
      documentCapability,
      shellCapability,
      shellWriteCapability,
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
      scheduleCapability,
      effectsCapability,
      vaultWriteCapability,
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
  const approvers = new Map<string, Approver>();
  const approvals = new ApprovalStore(db);

  /**
   * Test-only override of the trailing-edge debounce, a no-op unless a
   * scenario sets the env var — same precedent as `MUFFIN_GATEWAY_TICK_MS`
   * (`cli/gateway.ts`) and `MUFFIN_JOB_FIRES_STALL_*` (`agent/scheduler-run.ts`).
   * `CONSOLIDATION_IDLE_MS` is 20s, correct for a real conversation and far
   * too long for a scenario that has to prove the trailing edge fires at all
   * without either sleeping 20s or asserting nothing. Never set outside
   * `evals/acceptance`.
   */
  const memoryIdleMsOverride = msFromEnv(process.env['MUFFIN_MEMORY_IDLE_MS']);

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
    ...(memoryIdleMsOverride === undefined ? {} : { idleMs: memoryIdleMsOverride }),
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
    // La versione viene dalla config e da nient'altro: `muffin prompt version`
    // scrive quel campo e `promptVersion` lo legge, quindi il comando non può
    // annunciare una versione diversa da quella che il turno riceve.
    promptVersion(config),
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
      workspace,
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
      // ADR-0073: `sys_inspect` risponde «cosa raggiungo in questa stanza», e
      // in una stanza con grant la risposta non è più «tutto ciò che non è
      // host-only».
      grants: matrix.grants,
      promptBlocks,
      capabilityGaps,
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
   *
   * **Chiamata qui una volta, e richiamabile.** `attachSendFile`/`attachMcp`
   * (`cli/gateway.ts`, `cli/repl.ts`) registrano tool **dopo** che `buildRuntime`
   * è tornato — `send_file` ha bisogno del `SurfaceRegistry` che a questo punto
   * del boot non esiste ancora (verificato: `registry` in `cli/gateway.ts` è
   * `null` fino a `connectSurfaces`, molte righe dopo la chiamata a
   * `buildRuntime`). Il calcolo qui sotto, da solo, non può vedere quei tool —
   * per questo `recomputeExposure()` nell'oggetto restituito rifà lo stesso
   * calcolo sul registro live, e i due chiamanti lo invocano di nuovo dopo che
   * *tutte* le registrazioni del boot sono finite. Un `muffin run` che non
   * allega mai `send_file` resta corretto con questa sola chiamata.
   */
  const computeExposureGaps = (): void => {
    // Ordina per priorità dichiarata, non per ordine di `push`/`register`:
    // così ciò che il tetto taglia è sempre la stessa coda scelta
    // (`baseToolOrder`), mai un artefatto di quale superficie ha chiamato
    // `register()` per ultima. Un tool non elencato (MCP: dinamico per
    // natura, nessuna priorità dichiarabile qui) resta dopo tutti i nomi
    // dichiarati, nell'ordine relativo in cui è arrivato — `sort` è stabile.
    const priorita = new Map(
      baseToolOrder({
        sandboxAvailable: contained,
        searchOn,
        sendFileAvailable: tools.some((t) => t.spec.name === 'send_file'),
      }).map((name, i) => [name, i] as const),
    );
    tools.sort(
      (a, b) =>
        (priorita.get(a.spec.name) ?? Number.MAX_SAFE_INTEGER) -
        (priorita.get(b.spec.name) ?? Number.MAX_SAFE_INTEGER),
    );
    // Idempotente: una rilettura aggiorna le righe `truncated`, non le accumula.
    for (let i = capabilityGaps.length - 1; i >= 0; i -= 1) {
      if (capabilityGaps[i]?.kind === 'truncated') capabilityGaps.splice(i, 1);
    }
    const tagliati = tools.slice(profile.maxToolsExposed).map((t) => t.spec.name);
    // Stessa lista, riformattata come le altre due capacità spente qui sopra —
    // `kind: 'truncated'` invece di `'disabled'`, perché «esiste ma il tetto
    // del profilo la taglia» e «non esiste per questa installazione» sono due
    // domande diverse, e confonderle è esattamente il difetto misurato.
    for (const tool of tagliati) {
      capabilityGaps.push(
        truncationGap({
          tool,
          profileName: profile.name,
          maxToolsExposed: profile.maxToolsExposed,
        }),
      );
    }
  };
  computeExposureGaps();

  let loopDeps: LoopDeps | null = null;
  const refreshMainModel = (): void => {
    const persisted = loadConfig(home);
    const fingerprint = JSON.stringify(persisted.provider);
    if (fingerprint !== providerFingerprint) {
      provider = createMainProvider(persisted);
      providerFingerprint = fingerprint;
    }

    const nextProfile = withThinking(
      selectProfile(persisted.models.main, loadProfiles()),
      persisted.thinking,
    );
    // Keep the config and profile objects stable for their existing readers
    // (`Runtime.config`, `sys_inspect`, and exposure calculation). A running
    // turn owns shallow snapshots made by `runTurn`/`resumeTurn`.
    Object.assign(config, {
      provider: persisted.provider,
      models: { ...config.models, main: persisted.models.main, light: persisted.models.light },
      thinking: persisted.thinking,
    });
    Object.assign(profile, nextProfile);
    recordSpend = makeRecordSpend(persisted.provider.baseUrl);
    if (loopDeps !== null) {
      loopDeps.provider = provider;
      loopDeps.model = persisted.models.main;
      loopDeps.recordSpend = recordSpend;
      loopDeps.runtimeInfo = {
        providerKind: persisted.provider.kind,
        providerBaseUrl: persisted.provider.baseUrl,
        mainModel: persisted.models.main,
        lightModel: persisted.models.light,
        profile,
      };
    }
    computeExposureGaps();
  };

  /**
   * The light half of hot model application (#500): profile, wrapper, spend
   * base, reranker and the exposed snapshot follow `config.models.light`
   * without a restart.
   *
   * Runs on `prepareTurn`, i.e. between turns — never inside one. A
   * consolidation in flight keeps the old wrapper and the old reranker through
   * its own closures, which is the safe direction; the fingerprint skips the
   * rebuild when nothing changed, so the steady state costs one config read.
   */
  const refreshLightModel = (): void => {
    const persisted = loadConfig(home);
    const fingerprint = JSON.stringify({
      provider: persisted.provider,
      light: persisted.models.light,
    });
    if (fingerprint === lightFingerprint) return;
    lightFingerprint = fingerprint;
    lightBaseUrl = persisted.provider.baseUrl;
    light = lightLane(provider, {
      profile: selectProfile(persisted.models.light, profiles),
      record: (entry) =>
        void recordSpendWithBaseUrl(
          {
            ...entry,
            tenant: CONSOLIDATION_TENANT,
            capability: CONSOLIDATION_CAPABILITY,
          },
          lightBaseUrl,
        ),
      onAttempt: reportLightAttempt,
    });
    recallDeps.reranker = new LlmReranker(light, persisted.models.light);
    lightInfo.provider = light;
    lightInfo.model = persisted.models.light;
    if (loopDeps !== null && loopDeps.runtimeInfo !== undefined) {
      loopDeps.runtimeInfo = { ...loopDeps.runtimeInfo, lightModel: persisted.models.light };
    }
  };

  /**
   * I fatti d'istanza di `docs/evidence/orizzonte-del-turno-2026-09-03.md`
   * Parte 0, letti dalle **stesse fonti** che `makeInspectTool` sopra passa a
   * `sys_inspect`: `scope`/`cwd` (la stessa `FsScope` dei tool fs), `config`,
   * `jobs`, `safeMode`. Nessuna seconda copia — se una di quelle cambia
   * definizione, questa la eredita senza essere toccata.
   *
   * Una funzione, richiamata da `agent/loop.ts` a ogni turno (`deps.istanza?.()`),
   * non un valore congelato al boot: `fsList` è la stessa lettura di sola
   * lettura che il tool `fs_list` farebbe, quindi un file creato a metà
   * sessione o un job aggiunto da un'altra finestra non restano un fatto
   * stantio fino al prossimo riavvio.
   */
  const leggiIstanza = (): IstanzaFacts => ({
    cwd: workspace,
    voci: fsList(scope, '.')
      .split('\n')
      .filter((riga) => riga.length > 0),
    provider: config.provider.kind,
    jobAttivi: jobs.list().filter((j) => j.active).length,
    safeMode: safeMode ? { reason: safeMode.reason } : null,
  });

  const runtime: Runtime = {
    executor: contained ? executor : null,
    workspace,
    config,
    budget,
    quietHours: budgets.quietHours,
    defaultChannel: () => readDefaultChannel(home, config.surfaces.default),
    jobs,
    jobFires,
    db,
    consolidation,
    safeMode,
    approvers,
    promptBlocks,
    capabilityGaps,
    bootLines: [
      ...workspaceNotes,
      ...turnNotes,
      ...waitingNotes,
      ...undeliverableNotes,
      ...skillScan.problems.map((p) => `! ${p}`),
      ...profileProblems.map((p) => `! ${p}`),
      // Una riga per capacità spenta/tagliata, dalla stessa lista strutturata
      // che `sys.inspect` e `muffin doctor` leggono — non più una frase per
      // ognuna scritta qui a mano.
      ...capabilityGaps.map((gap) => `! ${formatCapabilityGap(gap)}`),
      ...matrixNotes,
      ...budgetNotes,
      ...rotNotes,
      ...configNotes,
    ],
    register: (tool, decl) => {
      capabilities.set(decl.id, decl);
      tools.push(tool);
    },
    recomputeExposure: () => {
      computeExposureGaps();
      return capabilityGaps
        .filter((g) => g.kind === 'truncated')
        .map((g) => formatCapabilityGap(g));
    },
    onClose: (hook) => {
      closeHooks.push(hook);
    },
    light: lightInfo,
    memory: { store: memoryStore, recall: recallDeps },
    vault,
    deps: {
      prepareTurn: () => {
        refreshMainModel();
        refreshLightModel();
      },
      runtimeInfo: {
        providerKind: config.provider.kind,
        providerBaseUrl: config.provider.baseUrl,
        mainModel: config.models.main,
        lightModel: config.models.light,
        profile,
      } satisfies TurnRuntimeInfo,
      provider,
      profile,
      model: config.models.main,
      tools,
      decide,
      // The declarations, so the loop derives the policy resource from
      // resourceKind/policyArgs instead of guessing at argument names.
      capabilities,
      // E i grant per stanza della stessa matrice sigillata che `decide` legge,
      // dallo stesso oggetto: il menu del modello e il kernel non possono
      // essere in disaccordo su cosa una stanza raggiunge, perché leggono la
      // stessa `PolicyMatrix` (ADR-0073 punto 1).
      grants: matrix.grants,
      // Il registro di undo: senza questa riga `fs_write` è offerto al modello e
      // non scrive mai, perché il kernel giudica `draft` e `draft` senza copia
      // rifiuta (DAY-1 requirement D2/D3/D11). Il difetto era esattamente qui — un verdetto
      // del kernel senza implementazione a valle — quindi la cucitura ha un test
      // suo in `runtime.test.ts`, non solo il ramo nel loop.
      undo: new UndoJournal(p.undo),
      approvals,
      /**
       * L'instradatore, e il fatto che sia qui e non su una superficie è la
       * proprietà: chi chiede è **la superficie da cui il turno è arrivato**,
       * scelta dal record del turno, non l'ultima che si è registrata.
       */
      approve: async (request, where) => {
        const chiedi = approvers.get(where.surface);
        return chiedi === undefined ? 'unavailable' : chiedi(request, where);
      },
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
      istanza: leggiIstanza,
      // Il fuso dell'owner, non quello del processo — la stessa lettura di
      // `quietHours` poco sopra, mai una seconda. Vedi `LoopDeps.timeZone`.
      timeZone: budgets.quietHours.timezone,
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
  loopDeps = runtime.deps;
  return runtime;
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
