import DatabaseCtor from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sqliteVec from 'sqlite-vec';
import { tmpdirBreaksSandboxSockets, SANDBOX_TMPDIR_OVERHEAD, TMPDIR_SUN_PATH_LIMIT, type SandboxProbe } from '../core/sandbox/probe.js';
import { SandboxExecutor } from '../core/sandbox/executor.js';
import { wantsExplicitCache } from '../agent/providers/openai-compat.js';
import { currentSchemaVersion, schemaVersionOf } from '../core/db/migrate.js';
import { CONSERVATIVE, loadProfiles, selectProfile } from '../agent/profiles/profile.js';
import { hardeningHolds, verify } from '../core/rot/verify.js';
import { checkRotReaders } from '../core/rot/readers.js';
import { loadPolicyMatrix } from '../core/policy/matrix.js';
import { readGateway } from '../core/gateway/lock.js';
import { checkSupervisor, realSupervisorProbes, type SupervisorProbes } from '../core/gateway/supervisor.js';
import { describeInterrupted, readTurnHealth, readUndelivered } from '../core/turns/store.js';
import { readConsolidation } from '../core/memory/consolidator.js';
import { makeEmbedder, OllamaEmbedder, type Embedder } from '../core/memory/embed.js';
import { readOpenContradictions } from '../core/memory/maintenance.js';
import { loadConfig, locateSecretAll, paths, readSecret, ConfigError } from '../core/config/config.js';
import { loadSealedBudgets } from '../core/rot/budgets.js';
import { diagnoseDefaultsDrift, type DefaultDrift } from '../core/config/defaults-drift.js';
import { describeBuild, findCheckoutRoot, type BuildStamp } from './update.js';

/**
 * Diagnosis that executes instead of assuming.
 *
 * Every check here answers "does it work", never "does it exist". The
 * difference is not pedantry: on the previous production host `bwrap` existed
 * in PATH and the sandbox contained nothing for two months, because Ubuntu
 * 24.04 blocks the user namespace it needs. A PATH check would have printed a
 * green line every day of it.
 */

export type CheckLevel = 'ok' | 'warn' | 'fail';

export type Check = {
  name: string;
  level: CheckLevel;
  detail: string;
  /** Present whenever the user has something to do about it. */
  remedy?: string;
};

export type DoctorReport = { checks: Check[]; exitCode: 0 | 1 | 2 };

export type DoctorOptions = {
  online?: boolean;
  /** Test-only: overrides the shipped `agent/profiles/` directory. */
  profilesDir?: string;
  /**
   * Test-only: overrides the real OS probes `checkSupervisor` reaches for
   * (`realSupervisorProbes`) — `systemctl`, `loginctl`, `launchctl`. Merged
   * over the real ones, so a test only has to name the probe it is driving.
   */
  supervisorProbes?: Partial<SupervisorProbes>;
  /**
   * Test-only: overrides `process.platform` for the TMPDIR-length check
   * below, so the Linux branch's logic runs in the suite regardless of which
   * OS is actually running it — the same reason `core/sandbox/probe.test.ts`
   * mocks `node:os` to exercise bubblewrap from macOS.
   */
  platform?: NodeJS.Platform;
  /**
   * Test-only: overrides the real `findCheckoutRoot` (`cli/update.ts`)
   * resolution the defaults-drift check below runs — `null` exercises the
   * declared-unknown path (rule 3) without needing a process actually
   * running outside a Git checkout.
   */
  checkoutRoot?: string | null;
  /** Test-only: sostituisce la lettura vera del commit. `null` esercita il caso «non è un checkout». */
  build?: BuildStamp | null;
  /**
   * Test-only: sostituisce la sonda vera dell'embedder, così la suite non
   * chiama `localhost:11434` millenovecento volte. Un rifiuto sta per
   * «l'embedder non risponde», con il messaggio che l'owner leggerà.
   */
  embedderProbe?: () => Promise<void>;
};

export async function runDoctor(home = paths().home, options: DoctorOptions = {}): Promise<DoctorReport> {
  const p = paths(home);
  const checks: Check[] = [];
  const ok = (name: string, detail: string) => checks.push({ name, level: 'ok', detail });
  const warn = (name: string, detail: string, remedy: string) =>
    checks.push({ name, level: 'warn', detail, remedy });
  const fail = (name: string, detail: string, remedy: string) =>
    checks.push({ name, level: 'fail', detail, remedy });

  // Prima riga di tutte, perché è la prima domanda di qualunque diagnosi:
  // *quale build sto guardando?* Il 27/08 la risposta si otteneva interrogando
  // i sottocomandi (`muffin trace --help` non aveva `turn`, questa riga non
  // esisteva) e deducendo l'età da ciò che mancava.
  const build = options.build === undefined ? describeBuild(dirname(fileURLToPath(import.meta.url))) : options.build;
  if (build === null) {
    warn('build', 'nessun checkout Git: non so quale commit stia girando', 'installa da un clone Git, o dillo tu nel riportare un problema');
  } else if (build.dirty) {
    // Non un `fail`: su una macchina di sviluppo è lo stato normale. Ma neanche
    // un `ok` silenzioso — quel SHA non descrive ciò che sta girando.
    warn('build', `${build.sha.slice(0, 12)} del ${build.date}, con modifiche non committate sopra`, 'quel commit non descrive ciò che gira: committa o riporta anche il diff');
  } else {
    ok('build', `${build.sha.slice(0, 12)} del ${build.date}`);
  }

  if (!existsSync(p.home)) {
    fail('home', `${p.home} does not exist`, 'run `muffin init`');
    return report(checks);
  }
  ok('home', p.home);

  let config;
  const configNotes: string[] = [];
  try {
    config = loadConfig(home, (line) => configNotes.push(line));
    // The cache dialect is inferred from the endpoint, and an inference the
    // owner cannot see is one they cannot correct: a miss pays full input
    // price on every turn, silently (ADR-0008 forbids exactly that shape).
    const cache =
      config.provider.kind === 'anthropic'
        ? 'breakpoints espliciti'
        : wantsExplicitCache(config.provider.baseUrl)
          ? 'breakpoints espliciti (endpoint riconosciuto)'
          : 'implicito (nessun breakpoint richiesto)';
    ok('config', `schemaVersion ${config.schemaVersion}, provider ${config.provider.kind}, cache ${cache}`);
  } catch (error) {
    const e = error as ConfigError;
    fail('config', e.message, e.remedy ?? 'run `muffin init`');
    return report(checks);
  }

  // A migration that ran in memory and said nothing would be the same class of
  // invisible fact as the cache dialect above: the file on disk still declares a
  // `budget` that no longer does anything, and the owner has no way to learn
  // that the number they raised last month stopped binding. Warn, not ok — there
  // is something for them to do (or decide not to do).
  for (const note of configNotes) {
    warn('config migrata', note, 'la riscrittura avviene da sé alla prossima modifica di config.json');
  }

  // Which per-model profile `config.models.main` actually resolves to, and
  // whether anything was dropped getting there. `profile.ts:109` and
  // ADR-0037 both say a stale profile is "nominato in `doctor`" — that was
  // false: the problems only ever reached `bootLines` (stderr at boot, via
  // `agent/runtime.ts`), which `doctor` neither imported nor ran (D3, judge,
  // 2026-08-13). `doctor` is where an owner looks when something is wrong,
  // and a model silently falling back to the conservative floor — fewer
  // tools, a shorter horizon, every crutch on, possibly a 400 on every turn
  // (D4) — is exactly that class of thing.
  const profileProblems: string[] = [];
  const profiles = loadProfiles(options.profilesDir, (line) => profileProblems.push(line));
  const resolvedProfile = selectProfile(config.models.main, profiles);
  if (profileProblems.length === 0) {
    ok('model profile', `${config.models.main} -> ${resolvedProfile.name}`);
  } else if (resolvedProfile === CONSERVATIVE) {
    // D4: a problem fired AND the configured model landed on the floor
    // profile. Named with the cost, not just the fact — an owner reading
    // this should not have to go read profile.ts to know what changed.
    fail(
      'model profile',
      `${profileProblems.join(' · ')} — ${config.models.main} caduto sul profilo conservativo: ` +
        `thinking ${resolvedProfile.thinking}, sampling ${resolvedProfile.sampling}, ` +
        `${resolvedProfile.maxToolsExposed} tool esposti (orizzonte ${resolvedProfile.maxToolCallsPerTurn}), ` +
        `stampelle [${resolvedProfile.recovery.join(', ')}]`,
      'ripara o rimuovi il profilo scartato sopra, sotto agent/profiles/',
    );
  } else {
    // Something is wrong but the model in use was not the one that paid for
    // it — still worth a line, never a fail: the owner is not degraded today.
    warn(
      'model profile',
      `${profileProblems.join(' · ')} — ${config.models.main} risolve comunque su "${resolvedProfile.name}"`,
      'ripara o rimuovi il profilo scartato sopra, sotto agent/profiles/',
    );
  }

  // Root of trust: integrity, and an honest statement of which guarantee the
  // current mode actually gives.
  const rot = verify(home, config.rot.mode);
  if (rot.ok) {
    ok('root of trust', `${rot.fileCount} files verified, mode ${rot.mode}`);
  } else if (rot.action === 'refuse') {
    fail('root of trust', `${rot.reason}: ${rot.diverged.join(', ')}`, rot.remedy);
  } else {
    warn('root of trust', `${rot.reason}: ${rot.diverged.join(', ')} — safe mode`, rot.remedy);
  }
  // Where the permission matrix came from. Same shape of invisible fact as the
  // cache dialect above: the sealed file and the compiled fallback behave
  // identically on a default install, so nothing in the agent's output tells
  // the owner which one answered — and the difference is whether their edits to
  // `rot/policy.json` mean anything.
  const matrix = loadPolicyMatrix(home);
  const taint = matrix.defaultMaxTaint;
  if (matrix.source === 'sealed') {
    ok(
      'policy matrix',
      `rot/policy.json — taint max low ${taint.low} / medium ${taint.medium} / high ${taint.high}, ${matrix.neverAtRuntime.size} mai a runtime, ${matrix.forbiddenForSystem.size} vietate agli autonomi`,
    );
  } else {
    warn(
      'policy matrix',
      `fallback ai valori compilati (${matrix.note}) — le modifiche a rot/policy.json non hanno effetto`,
      'ripristina il file dai default del repo e rifai `muffin rot reseal`',
    );
  }

  // The RoT-readers invariant, run where an owner will see it. An invariant
  // nothing executes is the defect examining itself — and this one exists
  // precisely because a sealed file went unread for months without a single
  // check going red.
  const readers = checkRotReaders(home);
  if (readers.skipped.length > 0) {
    warn('rot readers', readers.skipped.map((s) => `NON verificato — ${s.why}`).join('; '), 'run `muffin rot reseal`');
  } else if (readers.violations.length === 0) {
    ok('rot readers', `${readers.fileCount} file sigillati, ognuno con un lettore dichiarato`);
  } else {
    const worst = readers.violations.some((v) => v.severity === 'error') ? fail : warn;
    worst(
      'rot readers',
      readers.violations.map((v) => `${v.id}: ${v.sample.join(', ')}`).join(' · '),
      'un file dentro il sigillo che nessuno legge sembra vincolante e non lo è: dagli un lettore, oppure toglilo da rot/ e rifai `muffin rot reseal`',
    );
  }

  // Both modes get an answer, and `hardened` gets its claim tested. Before
  // this, `single-user` — the honest mode — was the only one that produced a
  // line, and its remedy told the owner to run `--hardened`, which wrote a word
  // into config.json, created no service user, and made the kernel *more*
  // permissive. The one mode that could be a lie was the one nobody checked.
  if (config.rot.mode === 'single-user') {
    warn(
      'root of trust mode',
      'single-user: le manomissioni sono rilevate, non impedite — un processo che gira come questo utente può ' +
        'disfare i bit read-only da solo. Conseguenza che si sente ogni giorno: senza prevenzione vera, ogni ' +
        'capability ad alto rischio (`sys.shell` in testa) ti chiede sempre conferma, mai un allow silenzioso',
      '`muffin rot harden` stampa i comandi per rendere vera la prevenzione su questa macchina, e cosa cambia una volta fatto',
    );
  } else {
    const hardening = hardeningHolds(home);
    if (hardening.holds) {
      ok(
        'root of trust mode',
        hardening.caveat
          ? `hardened: prevention verified now, but narrower than usual — ${hardening.caveat}`
          : 'hardened: this process cannot write the RoT — prevention, verified now',
      );
    } else {
      fail(
        'root of trust mode',
        `hardened dichiarato, non vero: ${hardening.why}`,
        'il kernel sta già trattando questa installazione come single-user; per la prevenzione vera il RoT deve appartenere a un altro utente OS, altrimenti metti `rot.mode` a "single-user" e togli la pretesa',
      );
    }
  }

  // What `muffin init` copied from `defaults/` and never touches again — not
  // because `muffin update` should overwrite it (`defaults/` exists to be
  // edited by the owner, agent/context/assemble.ts), but because nothing
  // before this told the owner their copy had fallen behind. Measured on the
  // owner's own machine (docs/blueprint/research/deriva-defaults-2026-08-26.md):
  // persona.md, voice.md and rot/identity.md sat at their `init`-day content
  // for weeks — the assembled prompt was half the size HEAD ships — and
  // nothing anywhere said so. See defaultsDriftCheck below for the two
  // opposite verdicts this can reach and why they must never be confused.
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const checkoutRoot = options.checkoutRoot !== undefined ? options.checkoutRoot : findCheckoutRoot(moduleDir);
  const drift = diagnoseDefaultsDrift(home, checkoutRoot);
  if (drift.length === 0) {
    warn(
      'defaults',
      "nessun registro d'installazione (installazione precedente a questa funzione) e nessun checkout Git leggibile — " +
        'non so dire se persona.md, voice.md o i default dentro rot/ sono stati aggiornati dall\'owner o sono rimasti al giorno di `init`',
      'esegui da un checkout Git di questo repository per un confronto affidabile',
    );
  } else {
    for (const d of drift) defaultsDriftCheck(ok, warn, d);
  }

  // The caps that bind, and which file they came from. Same shape of invisible
  // fact as the policy matrix above and worse in consequence: for months the
  // sealed `budgets.json` and the unsealed `config.json` carried identical
  // numbers, so nothing anywhere distinguished "the seal is holding the cap"
  // from "the seal is holding a copy of the cap".
  const budgets = loadSealedBudgets(home);
  if (budgets.capsSource === 'sealed') {
    ok(
      'tetto di spesa',
      `rot/budgets.json — ${budgets.caps.monthlyUsd} USD/mese, ${budgets.caps.perTenantDailyUsd} USD/giorno per tenant`,
    );
  } else {
    warn(
      'tetto di spesa',
      `valori compilati (${budgets.caps.monthlyUsd}/${budgets.caps.perTenantDailyUsd} USD) — ${budgets.notes.join(' · ')}`,
      'ripristina rot/budgets.json dai default del repo e rifai `muffin rot reseal`',
    );
  }
  if (budgets.quietSource === 'fallback') {
    warn(
      'quiet hours',
      `finestra compilata ${budgets.quietHours.from}-${budgets.quietHours.to} ${budgets.quietHours.timezone} — ${budgets.notes.join(' · ')}`,
      'ripristina rot/budgets.json dai default del repo e rifai `muffin rot reseal`',
    );
  }

  // Key presence only. A network call costs money and needs an explicit opt-in.
  // *Which backend answered* is part of the check, not decoration: the read
  // chain has two links now, and a chain that does not say which one spoke is
  // how an install that believes it has moved its key keeps reading the old
  // copy forever. Both locations are named when both exist, because that is the
  // shadowing case and it is silent from every other angle.
  try {
    const key = readSecret(config.provider.apiKeyRef, home);
    const where = locateSecretAll(config.provider.apiKeyRef, home);
    const answered = where[0];
    if (key.length === 0) {
      fail('api key', 'secret file is empty', `write it with \`muffin secret set\``);
    } else if (where.length > 1) {
      warn(
        'api key',
        `${key.length} chars (mai stampata) — legge ${answered?.path}, ma esiste anche ${where[1]?.path}: la seconda non viene mai usata`,
        'cancella la copia che non vuoi, così resta una sola chiave da ruotare',
      );
    } else {
      ok('api key', `${config.provider.apiKeyRef} (${answered?.backend}) — ${answered?.path}, ${key.length} chars, mai stampata`);
    }
  } catch (error) {
    const e = error as ConfigError;
    fail('api key', e.message, e.remedy ?? 'set the key');
  }
  if (options.online) {
    warn('api reachability', 'online check not implemented in M0', 'omit --online');
  }

  try {
    const db = new DatabaseCtor(p.db, { readonly: true });
    const tables = db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table'`).get() as {
      n: number;
    };
    ok('database', `${p.db}, ${tables.n} tables`);

    const schema = schemaVersionOf(db);
    if (schema === null) {
      warn('schema', 'nessuna schema_version: database mai avviato da questo codice', 'parte al primo avvio del runtime');
    } else if (schema > currentSchemaVersion()) {
      fail('schema', `database v${schema}, codice v${currentSchemaVersion()}`, 'aggiorna il codice');
    } else if (schema < currentSchemaVersion()) {
      // Unreachable while MIGRATIONS is empty (baseline is the ceiling), but
      // this is the tool the restore path points at — behind must never read
      // as healthy (judge #93 follow-up).
      warn('schema', `database v${schema}, codice v${currentSchemaVersion()} — migrazione pendente`, 'avvia il runtime (repl o gateway)');
    } else {
      ok('schema', `v${schema} (codice v${currentSchemaVersion()})`);
    }

    // The semantic half of recall, checked rather than assumed. Three separate
    // defences against the vector index being silently empty were written into
    // this repository and none of them was ever *consulted* — which is the same
    // failure they were written to prevent, one layer out.
    const chunks = countOrNull(db, 'chunks');
    if (chunks === null) {
      warn(
        'vector index',
        'no chunks table yet: recall is full-text only until something is indexed',
        'run `muffin memory extract` or `muffin vault reindex`',
      );
    } else {
      let vectors: number | null = null;
      try {
        sqliteVec.load(db);
        vectors = countOrNull(db, 'chunks_vec');
      } catch {
        vectors = null;
      }
      if (vectors === null) {
        fail(
          'vector index',
          `${chunks} chunks stored and the vector table could not be read: recall has silently lost half of itself`,
          'reinstall sqlite-vec (a native binary mismatch after `npm ci` does this)',
        );
      } else if (vectors !== chunks) {
        fail(
          'vector index',
          `${chunks} chunks but ${vectors} vectors: the index is out of sync`,
          'run `muffin memory extract` to drain the backlog',
        );
      } else if (chunks === 0) {
        warn('vector index', 'empty: recall is full-text only', 'run `muffin memory extract`');
      } else {
        // Contare non è chiedere. I due numeri dicono che ciò che è **già**
        // indicizzato è coerente; non dicono niente su ciò che verrà, e
        // `agent/runtime.ts` lo scrive esplicitamente accanto al punto in cui
        // costruisce l'embedder: «an embedder that is not running turns
        // semantic recall into keyword search, and the difference has to be
        // visible in `doctor`». Non lo era.
        //
        // Misurato sull'installazione dell'owner il 27/08: ollama giù,
        // `memory_review` con tre righe che lo dicevano dal 25, il gateway che
        // stampava «il recall resta testuale» a ogni giro — e questa riga
        // verde, «55 chunks, 55 vectors, in sync». Tutto vero e tutto
        // fuorviante: la metà semantica del recall era spenta da due giorni.
        //
        // Locale e a tempo, non dietro `--online`: quel flag copre la
        // raggiungibilità di un servizio esterno, questa è una porta su
        // 127.0.0.1 che rifiuta subito quando è chiusa. Il tetto serve per il
        // caso opposto — un server che accetta la connessione e non risponde —
        // perché `doctor` è ciò che si lancia quando la macchina è già strana.
        // L'embedder configurato, costruito qui e non assunto: se la config
        // dice `openai-compat` e `doctor` interroga Ollama, dice «giù» su una
        // macchina sana e «su» su una rotta.
        let configurato: Embedder | undefined;
        try {
          configurato = config === null ? undefined : makeEmbedder(config.embedder, (ref) => readSecret(ref, home));
        } catch {
          // Una config di embedder incompleta non deve far cadere `doctor`: è
          // proprio il momento in cui serve. Il ramo sotto la segnala.
          configurato = undefined;
        }
        const embedderError = await probeEmbedder(options.embedderProbe, configurato);
        if (embedderError === null) {
          ok('vector index', `${chunks} chunks, ${vectors} vectors, in sync`);
        } else {
          warn(
            'vector index',
            `${chunks} chunks, ${vectors} vectors coerenti, ma l'embedder non risponde (${embedderError}): ` +
              'niente di nuovo viene indicizzato e il recall è solo testuale',
            'avvia ollama (`ollama serve`) oppure indica un embedder raggiungibile con OLLAMA_URL',
          );
        }
      }
    }
    // Has the memory lane ever run? Third of the same shape, and the one that
    // was the whole defect: `ingestPending` had a single hand-typed caller, so
    // an install could sit for weeks with 0 facts and nothing anywhere said
    // why. Zero facts is also the *correct* state of a working lane on a quiet
    // week — the measured yield is one fact per thirty turns — so the number
    // that separates the two is the run count, not the fact count.
    const consolidation = readConsolidation(db);
    if (consolidation === null) {
      warn(
        'consolidamento',
        'mai eseguito: gli episodi non diventano fatti e il recall resta solo-keyword',
        'apri `muffin` (parte da solo a fine turno) oppure `muffin memory extract`',
      );
    } else {
      const last = consolidation.last;
      const when = last.ranAt.toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
      // Nothing got through: every episode the extractor attempted failed *and*
      // the batch added no fact. Three conjuncts, each load-bearing.
      //
      // `episodes` counts attempts, not successes (`ingest.ts` §`marked`), which
      // is what makes it comparable to `errors` at all. A failed extraction is
      // deliberately left unmarked so the next fire retries it — so a *minority*
      // of errors is a lane that is healing itself, and escalating that to a
      // non-zero exit would train the owner to ignore the line. What does not
      // heal is a batch where nothing came through: those same episodes fail
      // again next run, and again, forever (`ingest.ts` §`fetched`).
      //
      // `facts === 0` is not decoration. The maintenance sweep pushes its own
      // failure into `report.errors` (`consolidator.ts` §sweep), so a run of one
      // episode that succeeded and then tripped the sweep would otherwise land
      // here reading as total failure — a warn over a batch that worked.
      //
      // **La soglia è la maggioranza, non la totalità**, e la differenza è
      // stata misurata sull'installazione dell'owner il 27/08: gli ultimi tre
      // giri erano 3 errori su 3 episodi, 10 su 11 e 13 su 14, tutti con zero
      // fatti — la corsia era morta dal cambio di modello del 25/08. Il primo
      // avvisava; gli altri due leggevano `ok` **verdi**, perché un solo
      // episodio che non ha lanciato bastava a far fallire `errors >= episodes`
      // per uno. Il commento sopra dice «una *minoranza* di errori è una corsia
      // che si sta curando»: 13 su 14 non è una minoranza, quindi era la
      // soglia a essere sbagliata, non la forma. E `facts === 0` continua a
      // fare il lavoro che il caso dello sweep chiede — un giro che ha
      // prodotto un fatto non arriva qui comunque.
      const nothingGotThrough =
        last.episodes > 0 && last.facts === 0 && last.errors * 2 > last.episodes;

      // `ConsolidationOutcome` is a closed union of four (`ran | budget | busy
      // | error`); a `switch` with an exhaustive `default` is what makes a
      // fifth outcome a compile error instead of a branch that silently falls
      // into whichever case happens to sit last — the same guarantee
      // `agent/loop.ts`'s `assertNever` gives its own switch, and
      // `core/policy/decide.ts`'s `switch (decl.risk)` gets for free from its
      // non-void return type; this one has to say so, since none of these
      // branches return.
      switch (last.outcome) {
        case 'budget':
          warn(
            'consolidamento',
            `fermo dal ${when}: budget mensile esaurito`,
            // The cap moved into the seal, so the remedy moved with it: telling the
            // owner to edit config.json would now send them to a field that no
            // longer exists.
            'alza `monthlyUsd` in rot/budgets.json e fai `muffin rot reseal`, o aspetta il mese nuovo',
          );
          break;
        case 'error':
          // The batch threw, so `execute` wrote a *blank* row — zero episodi, zero
          // fatti, and the message only ever went to stderr. Printed through `ok`
          // (as it was until this branch existed) that row read exactly like the
          // quiet week above: same shape, same zeroes, green. Telling a dead lane
          // from a quiet one is the single confusion this whole check exists to
          // remove, so this is the one outcome that has to be a `fail`.
          fail(
            'consolidamento',
            `ultimo giro ${when} (${last.trigger}) fallito: gli episodi non diventano fatti ` +
              `e il recall resta solo-keyword · ${consolidation.runs} run in totale`,
            "run `muffin memory extract`: rifà il giro in primo piano e stampa l'errore, che la riga non conserva",
          );
          break;
        case 'ran':
        case 'busy': {
          if (nothingGotThrough) {
            // Unreachable on `busy`: that outcome never accumulates episodes
            // (`ingest.ts` returns before touching `pendingEpisodes` once the
            // lock refuses), so this branch is a `ran`-only concern in
            // practice even though the case is shared.
            warn(
              'consolidamento',
              `ultimo giro ${when} (${last.trigger}) · ${last.errors} errori su ${last.episodes} episodi: ` +
                `il giro è andato a vuoto e quegli episodi tornano al prossimo · ${consolidation.runs} run in totale`,
              'run `muffin memory extract`: rifà il giro in primo piano e stampa ogni errore per esteso',
            );
            break;
          }
          ok(
            'consolidamento',
            `ultimo giro ${when} (${last.trigger}/${last.outcome}) · ${last.episodes} episodi · ` +
              `${last.facts} fatti · ${consolidation.runs} run in totale` +
              // Named even when the verdict stays green, which was the defect: a
              // third of a batch could fail to extract and the owner read a line
              // with nothing on it but the successes. `muffin memory stats` had
              // been surfacing its own error count for exactly this reason
              // (`reviewLine`); this line had not.
              //
              // Gated to `ran`: on `busy`, `last.errors` is the lock-refusal
              // message `ingest.ts` pushes onto `report.errors` when
              // `acquireIngestLock` refuses, not a per-episode extraction
              // failure — every `busy` row has `errors >= 1`, so without this
              // gate a lock refusal always read as "N falliti" on a run that
              // never attempted a single episode.
              (last.outcome === 'ran' && last.errors > 0
                ? ` · ${last.errors} falliti, riprovati al prossimo giro`
                : ''),
          );
          break;
        }
        default: {
          const _exhaustive: never = last.outcome;
          throw new Error(`consolidamento: esito non gestito (${_exhaustive})`);
        }
      }
    }

    // The judge's "a human should decide" outcome, which had a durable register
    // and no reader. Here rather than only in `memory stats` because this is the
    // command an owner runs when something feels wrong, and an open contradiction
    // is the one memory state that cannot resolve itself: both beliefs stay
    // current, recall keeps returning both, and nothing in the lane will ever
    // choose. Counted open — derived from the facts — not counted total, which on
    // an append-only register only ever grows.
    const open = readOpenContradictions(db, 'host');
    if (open !== null && open > 0) {
      warn(
        'memoria da decidere',
        `${open} contraddizioni aspettano te: due valori restano entrambi attivi finché non scegli`,
        'run `muffin memory review`',
      );
    }

    // Turns that a dead process was holding. `buildRuntime` announces these at
    // boot, but a boot line scrolls past and this is the command an owner runs
    // when something feels wrong — and "the answer never came and nobody said
    // why" is exactly that feeling.
    //
    // (N1, judge round 2: this used to end "Reported, never repaired: there is
    // no resume, so the honest output is what is unknown and who has to check
    // it." That sentence did not survive the slice that built the resume —
    // the remedy two branches down already says the opposite, "il gateway li
    // riprende" — and a stale comment claiming the resume does not exist is
    // exactly how a reader ends up trusting the wrong half of this file.)
    // What is still honestly unknown is narrower: a resume replays every tool
    // call whose *outcome* was recorded and declares, rather than repeats, the
    // ones that were not — so the open question below is what a declared,
    // non-replayed call may have done to the world, never whether it runs.
    const turns = readTurnHealth(db);
    if (turns === null) {
      // Not a warning. The table is created by the first runtime that opens
      // this home, so its absence means "no turn has run here yet", which on a
      // fresh install is the correct state and not a problem to report.
      ok('turni', 'nessun turno registrato su questa home');
    } else if (turns.interrupted.length > 0) {
      warn(
        'turni',
        `${turns.total} registrati · ${turns.interrupted.length} interrotti — ${describeInterrupted(turns.interrupted[0]!)}`,
        // The old text said "non esiste ancora un resume". It did not survive
        // the slice that built one, and a remedy that tells the owner to go and
        // do by hand something the runtime now does is worse than no remedy: it
        // sends them to repeat an effect the record exists to avoid repeating.
        'il gateway li riprende alla prossima corsia; una chiamata non ri-eseguibile non viene rifatta e viene dichiarata — se aveva effetti sul mondo, verificali',
      );
    } else {
      ok('turni', `${turns.total} registrati · nessuno interrotto`);
    }

    /**
     * A suspended turn is only a promise while something is running the lane.
     *
     * The two facts are useless apart, which is why they are read together: N
     * turns at `waiting` is normal and healthy on a machine with a gateway, and
     * is *work nobody will ever wake* on one without. Only the REPL and `muffin
     * run` can produce the second state — neither owns a lane (ADR-0035) — and
     * before this line nothing anywhere said so.
     */
    if (turns !== null && turns.waiting.count > 0) {
      const oldest = turns.waiting.oldestWakeAt;
      const due = oldest === null ? '' : ` · il più vecchio scade ${oldest.slice(0, 16).replace('T', ' ')}`;
      if (readGateway(db) === null) {
        warn(
          'turni sospesi',
          `${turns.waiting.count} in attesa e nessun gateway attivo: non li sveglia nessuno${due}`,
          'avvia il gateway (`muffin gateway install`, o `muffin gateway run` per vederlo) — la corsia dei turni gira solo lì',
        );
      } else {
        ok('turni sospesi', `${turns.waiting.count} in attesa · li riprende il gateway${due}`);
      }
    }

    /**
     * D2, judge round 2: `LaneEvent.undeliverable` was emitted and reached only
     * the gateway's own stderr — real inside that one process, invisible to
     * everything else, including this command opening a fresh handle on the
     * same database. `turn-lane.ts` now writes `delivery = 'undeliverable'` on
     * the row itself, which is what makes it a fact `doctor` can read back
     * instead of a message that existed for as long as one process's terminal
     * scrollback did.
     */
    if (turns !== null && turns.undeliverable.count > 0) {
      warn(
        'turni senza indirizzo',
        `${turns.undeliverable.count} turni con risposta senza indirizzo`,
        'la riga porta la risposta ma non un indirizzo: nessuno sa a chi appartiene — controlla chi ha aperto quella sessione',
      );
    }

    // B8's own guarantee, checked here rather than only claimed: a turn that
    // finished and whose delivery never settled — `pending` on a `done` row —
    // was reported failed by the surface, or crossed the remote boundary with
    // no readable response (`possibly_sent`). D3 (judge, PR #42): `undelivered()`
    // had no caller and no test before this; a job could say "inviato" to
    // nobody, forever, with nothing anywhere reading the query built to catch
    // it. Reported only when `turns` exists — an absent table already said so
    // above, and a second "nessun turno" line would be noise repeating itself.
    if (turns !== null) {
      const undelivered = readUndelivered(db);
      if (undelivered !== null && undelivered.length > 0) {
        // `undelivered()` orders most-recent-first; the owner wants the
        // oldest unresolved one, which is what has waited longest.
        const oldest = undelivered[undelivered.length - 1]!;
        const when = oldest.startedAt.slice(0, 16).replace('T', ' ');
        warn(
          'consegne',
          `${undelivered.length} turni con delivery non confermata nelle ultime 24h — la più vecchia: ` +
            `turno ${oldest.id.slice(0, 12)} su ${oldest.surface} (${when}), ${oldest.delivery}`,
          'il lavoro è stato fatto ma la consegna non è confermata: controlla la superficie; non ritentare alla cieca uno stato possibly_sent',
        );
      } else if (undelivered !== null) {
        ok('consegne', 'nessuna delivery mancante nelle ultime 24h');
      }
    }

    // Is anything running? Same shape of invisible fact as the cache dialect
    // and the policy source above: with the scheduler moved out of the REPL
    // (ADR-0035) a home with no gateway schedules *nothing*, and nothing in the
    // agent's output says so — the jobs are still listed, they simply never
    // fire. Constraint 5 of that ADR is "visibile e ammazzabile", and this is
    // the visible half.
    const gateway = readGateway(db);
    if (gateway) {
      const since = gateway.since.toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
      ok('gateway', `attivo · pid ${gateway.pid} · dal ${since} · ${gateway.status}`);
    } else {
      warn(
        'gateway',
        'nessun processo attivo: i job schedulati girano solo mentre una sessione `muffin` è aperta',
        'run `muffin gateway install` (o `muffin init`, che te lo propone)',
      );
    }

    // A5's own question asked of the *supervisor* rather than the process:
    // `readGateway` above is true for a `muffin gateway run` typed by hand,
    // which is exactly the state ADR-0035 (A1, owner's words) says continuity
    // must not depend on. Never `fail` (see supervisor.ts) — a missing unit is
    // a gap to close before trusting a reboot, not a broken install today.
    const supervisor = checkSupervisor(process.platform, home, gateway !== null, {
      ...realSupervisorProbes(),
      ...options.supervisorProbes,
    });
    if (supervisor.engaged) {
      ok('supervisore', supervisor.detail);
    } else {
      warn('supervisore', supervisor.detail, supervisor.remedy);
    }
    db.close();
  } catch (error) {
    fail('database', String(error), 'run `muffin init` to create it');
  }

  // `verify()`, not `probeSandbox()` directly: the probe alone proves bwrap/
  // sandbox-exec exist and hold on ITS OWN narrow invocation, which is not the
  // same claim as "the runtime's own execution path (SandboxManager) actually
  // contains a command" — a container was found (26/08/2026) where the two
  // disagreed, with the probe green and every real job script dying on a raw
  // `bwrap: Can't mount proc` inside its own exit. `verify()` pays for a real
  // init + one contained round trip so doctor tells the truth before a session
  // starts, not after a job's output turns out to carry an unsandboxed error.
  const sandboxExecutor = new SandboxExecutor({ denyWrite: [], denyRead: [] });
  const sandbox = await sandboxExecutor.verify();
  await sandboxExecutor.close();
  if (sandbox.available) {
    ok('sandbox', sandboxOkDetail(sandbox));
  } else {
    // Not a hard failure: the runtime still starts, execution capabilities just
    // degrade to ask. Silently unsandboxed is the one outcome we refuse.
    warn(
      'sandbox',
      `${sandbox.mechanism} unavailable (${sandbox.reason}): ${sandbox.detail} — execution capabilities degrade to ask`,
      sandbox.remedy,
    );
  }

  // #213 upstream (cited in ADR-0026): on Linux the sandbox bridges its
  // egress proxy through a Unix-domain socket inside TMPDIR, and a TMPDIR
  // over ~108 characters makes that socket's path too long to bind. The
  // failure that reaches the owner is `SandboxManager.initialize` throwing a
  // generic "Sandbox failed to initialize" — nothing in it says TMPDIR, so
  // without this check the only way to learn the cause is to already know
  // it. `tmpdir()` is the exact resolution `core/sandbox/executor.ts`'s
  // `scratch()` relies on (`TMPDIR` if set, else the platform default), so
  // this checks the value that will actually reach a sandboxed command, not
  // a guess at it.
  const tmpdirValue = tmpdir();
  const effectivePlatform = options.platform ?? process.platform;
  if (tmpdirBreaksSandboxSockets(effectivePlatform, tmpdirValue)) {
    // Il conto è sul path INTERO del socket, non su TMPDIR nudo: il runtime
    // aggiunge sotto questa directory lo scratch dell'executor più il socket
    // del bridge (SANDBOX_TMPDIR_OVERHEAD, misurato componente per componente
    // in probe.ts) — è la fascia in cui la prima versione diceva `ok` su una
    // macchina che a runtime sarebbe esplosa.
    warn(
      'tmpdir',
      `${tmpdirValue} è lungo ${tmpdirValue.length} caratteri: col percorso che il sandbox costruisce ` +
        `sotto (${SANDBOX_TMPDIR_OVERHEAD} caratteri misurati) supera il limite di ${TMPDIR_SUN_PATH_LIMIT} ` +
        `dei socket Unix su Linux (#213) — il sandbox può fallire a runtime con "Sandbox failed to ` +
        `initialize", un errore che non nomina TMPDIR`,
      `esporta un TMPDIR più corto (es. /tmp) prima di avviare muffin, o rimuovilo dall'ambiente per usare il default`,
    );
  } else if (effectivePlatform === 'linux') {
    ok(
      'tmpdir',
      `${tmpdirValue} (${tmpdirValue.length} caratteri: ${tmpdirValue.length}+${SANDBOX_TMPDIR_OVERHEAD} sotto il limite di ${TMPDIR_SUN_PATH_LIMIT})`,
    );
  }

  // Was `statSync(p.home)` with the result assigned and voided — the remains of
  // a disk-space check that was never written, which made the failure branch
  // unreachable and the check a decoration.
  if (existsSync(p.traces)) {
    ok('traces', `${p.traces}, retention ${config.traces.retentionDays} days`);
  } else {
    warn('traces', `${p.traces} does not exist yet`, 'it is created on the first turn');
  }

  return report(checks);
}

function report(checks: Check[]): DoctorReport {
  const worst: CheckLevel = checks.some((c) => c.level === 'fail')
    ? 'fail'
    : checks.some((c) => c.level === 'warn')
      ? 'warn'
      : 'ok';
  return { checks, exitCode: worst === 'fail' ? 2 : worst === 'warn' ? 1 : 0 };
}

export function formatReport(report: DoctorReport): string {
  const glyph: Record<CheckLevel, string> = { ok: '✓', warn: '!', fail: '✗' };
  const lines = report.checks.map((c) => {
    const head = `${glyph[c.level]} ${c.name.padEnd(18)} ${c.detail}`;
    return c.remedy ? `${head}\n  → ${c.remedy}` : head;
  });
  return lines.join('\n');
}

/**
 * One `DefaultDrift` (core/config/defaults-drift.ts) turned into one line.
 *
 * `'up-to-date'` and `'owner-modified'` are both `ok`: there is nothing to
 * do, in the second case *because* it is the owner's and must not be
 * touched — "dillo e basta", the research doc's own words. Only
 * `'adoptable'` and `'unknown'` carry a remedy — the first a real command,
 * the second an honest "I cannot tell" (ADR-0008: declared, never guessed).
 *
 * `'adoptable'` under `rot/` gets the safe-mode consequence stated BEFORE
 * the command, never silently: copying into a sealed path makes
 * `verify()`'s hash check diverge (`core/rot/verify.ts`), which drops the
 * install into safe mode until `muffin rot reseal` — an act of the owner's
 * own authority, so this only ever names it, never runs it (same posture as
 * `core/rot/harden.ts`'s printed plan).
 */
function defaultsDriftCheck(
  ok: (name: string, detail: string) => void,
  warn: (name: string, detail: string, remedy: string) => void,
  d: DefaultDrift,
): void {
  const name = `default ${d.path}`;
  switch (d.status) {
    case 'up-to-date':
    case 'owner-modified':
      ok(name, d.detail);
      return;
    case 'missing':
      warn(name, d.detail, "`muffin init` lo ricrea — oppure, se l'hai tolto di proposito, ignora questa riga");
      return;
    case 'unknown':
      warn(
        name,
        d.detail,
        `confronta a mano con defaults/${d.path} nel repository, oppure ignora se preferisci gestirlo tu`,
      );
      return;
    case 'adoptable': {
      const cmd = d.adoptCommand ?? '(comando non disponibile)';
      const remedy = d.sealed
        ? `questo file è dentro il sigillo (rot/): adottarlo fa divergere l'hash sigillato e manda l'installazione in ` +
          `safe mode — conseguenza da decidere tu, mai automatica. Se la vuoi: ${cmd} — quindi \`muffin rot reseal\` ` +
          "(atto della tua autorità: solo lui fa uscire l'installazione dalla safe mode)"
        : cmd;
      warn(name, d.detail, remedy);
      return;
    }
    default: {
      const _exhaustive: never = d.status;
      throw new Error(`defaults drift: stato non gestito (${String(_exhaustive)})`);
    }
  }
}

/**
 * The `ok('sandbox', …)` line, honest about which mechanism actually held.
 *
 * A green "sandbox: contained" reads as parity between platforms, and it is
 * not: `SandboxManager.baseConfig` (core/sandbox/executor.ts) sets
 * `allowAllUnixSockets: true` on Linux only — two open upstream bugs (#428,
 * #429) block the seccomp layer that would otherwise deny them — so bubblewrap
 * holding today says less than seatbelt holding does. One line, not the essay
 * this comment is: doctor.ts owns being read at a glance.
 */
export function sandboxOkDetail(sandbox: Extract<SandboxProbe, { available: true }>): string {
  const base = `${sandbox.mechanism}: a real containment ran and held`;
  return sandbox.mechanism === 'bubblewrap'
    ? `${base} — weaker than macOS: Unix-socket hardening is off on Linux (allowAllUnixSockets, #428/#429)`
    : base;
}

/** `null` means the table is not there, which is a different fact from "zero rows". */
function countOrNull(db: DatabaseCtor.Database, table: string): number | null {
  try {
    return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  } catch {
    return null;
  }
}

/** Quanto si aspetta un embedder che ha accettato la connessione e non risponde. */
const EMBEDDER_PROBE_MS = 1_500;

/**
 * `null` quando l'embedder ha risposto; il motivo, in parole, quando no.
 *
 * Una sola stringa da mettere in una riga, non un booleano: «connessione
 * rifiutata» e «non ha risposto entro un secondo e mezzo» mandano l'owner in
 * due posti diversi, e la riga che li appiattisce in "non disponibile" è la
 * stessa che ha tenuto ferma la corsia della memoria per due giorni.
 */
async function probeEmbedder(
  override?: () => Promise<void>,
  embedder?: Embedder,
): Promise<string | null> {
  // L'embedder **configurato**, non Ollama per definizione: se `doctor`
  // interroga un embedder diverso da quello che il runtime usa, misura una cosa
  // e ne riporta un'altra — ed è così che un `doctor` verde convive con una
  // memoria che non si indicizza.
  const run = override ?? (async (): Promise<void> => void (await (embedder ?? new OllamaEmbedder()).embed(['probe'])));
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`nessuna risposta entro ${EMBEDDER_PROBE_MS}ms`)), EMBEDDER_PROBE_MS);
        // Il tetto non deve tenere in vita il processo quando la sonda ha già
        // risposto: senza questo, ogni `muffin doctor` riuscito resterebbe
        // appeso al proprio timer.
        timer.unref();
      }),
    ]);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
