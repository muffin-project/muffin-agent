import DatabaseCtor from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
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
import { loadSealedOwner } from '../core/rot/owner.js';
import { loadPolicyMatrix } from '../core/policy/matrix.js';
import { readGateway } from '../core/gateway/lock.js';
import { PLAIN, type Style } from './ui.js';
import { askGateway } from '../core/gateway/control-socket.js';
import { checkSupervisor, realSupervisorProbes, type SupervisorProbes } from '../core/gateway/supervisor.js';
import { describeInterrupted, readTurnHealth, readUndelivered } from '../core/turns/store.js';
import { readConsolidation } from '../core/memory/consolidator.js';
import { makeEmbedder, OllamaEmbedder, type Embedder } from '../core/memory/embed.js';
import { quantiNonIndicizzati } from '../core/memory/vectors.js';
import { readOpenContradictions } from '../core/memory/maintenance.js';
import { CREDSTORE_ENCRYPTED_DIR, loadConfig, locateSecretAll, paths, readSecret, secretsBackend, secretDir, ConfigError, type Config } from '../core/config/config.js';
import { listLegacySecretNames, requiredSecretRefs, secretExists } from '../core/config/systemd.js';
import { describeWorkspace } from '../core/config/workspace.js';
import { loadSealedBudgets } from '../core/rot/budgets.js';
import { diagnoseDefaultsDrift, type DefaultDrift } from '../core/config/defaults-drift.js';
import { ALL_API_KEY_NAMES } from '../core/config/providers.js';
import { describeBuild, findCheckoutRoot, type BuildStamp } from './update.js';
import type { StatoSuperficie } from '../core/surface/salute.js';
import { audioAccettato } from '../agent/providers/modalita.js';
import { prerequisitiTrascrizione, type Prerequisito } from '../core/audio/trascrivi.js';
import { loadEgress, type EgressPolicy } from '../core/net/egress.js';
import { diagnoseRoutingStaleness } from '../core/config/model-resolve.js';
import { diagnoseSearch } from '../agent/tools/search.js';
import { baseToolOrder } from '../agent/runtime.js';
import { Vault, type VaultAudit, type VaultStore } from '../core/vault/vault.js';
import type { TrustTier } from '../core/policy/types.js';

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
  /**
   * Test-only: the two probes of the `note vocali` check — whether the
   * configured model accepts audio (a question to the provider, see
   * `agent/providers/modalita.ts`) and the PATH the transcription binaries
   * are looked up in. A test that let the real PATH answer would be proving
   * the developer's machine, not the product.
   */
  voce?: { accettaAudio?: () => Promise<boolean>; path?: string };
};

/**
 * Sotto quanto un guasto e' ancora un lampo.
 *
 * La soglia sta qui e non nel registro perche' e' una domanda su chi legge, non
 * su cosa e' successo: il connettore registra i fatti, `doctor` decide cosa
 * merita di svegliare l'owner. Il battito ritenta ogni 5 secondi, quindi un
 * minuto sono gia' una dozzina di tentativi andati a vuoto — largo abbastanza
 * da non allarmare per un `ECONNRESET` fra due long poll, stretto abbastanza da
 * non lasciar passare in silenzio niente che l'owner chiamerebbe un guasto.
 *
 * La soglia esiste perche' il caso vero non si sapeva classificare: 3187
 * fallimenti registrati e nessun modo di dire se fossero una tempesta di blip o
 * un'interruzione, dato che `gateway.err` conta i fallimenti e non li data.
 * `da` risponde a quella domanda, e questa costante decide dove sta il confine.
 */
export const GUASTO_DOPO_MS = 60_000;

/**
 * Oltre quanto un avvio smette di essere un avvio.
 *
 * `inAvvio` e' un silenzio, ed era l'unico dei tre senza limite superiore: una
 * superficie che entra in avvio e non emette mai ne' `connessa` ne' `caduta`
 * resterebbe invisibile per sempre. Oggi i timeout di `fetch` la limitano quasi
 * ovunque — Telegram ~131s (65s piu' un ritentativo di trasporto), Discord 30s
 * per due chiamate — tranne un segmento: fra `gatewayUrl()` riuscita e HELLO,
 * `connectOnce` si risolve solo su `close` o `error`, e il `WebSocket` di Node
 * non impone un timeout di upgrade. Un handshake che stalla li' non produce
 * nessuna riga, mai.
 *
 * Tre minuti stanno sopra ogni stretta di mano legittima e sotto qualunque cosa
 * l'owner chiamerebbe «sta partendo». Il rimedio non e' riavviare — riavviare
 * rifa' partire proprio l'handshake che non finisce: e' guardarlo.
 */
export const AVVIO_TROPPO_LUNGO_MS = 180_000;

/**
 * L'unico modo per accorciare quella soglia senza toccare il sorgente.
 *
 * Stessa forma e stessa disciplina di `tickMsFromEnv` (`cli/gateway.ts`), e per
 * la stessa ragione: `evals/acceptance/` non importa `runDoctor`, lancia il
 * binario vero come processo figlio. Senza questa manopola uno scenario che
 * verifica la soglia dovrebbe **aspettare un minuto vero**, e uno scenario che
 * costa un minuto e' uno scenario che prima o poi qualcuno toglie.
 *
 * Non c'e' installazione reale che la imposti: un valore assente, non numerico
 * o non positivo lascia il default, invece di far uscire `doctor` per un refuso
 * nell'ambiente.
 */
export function guastoDopoMsDaEnv(raw: string | undefined): number {
  if (!raw) return GUASTO_DOPO_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : GUASTO_DOPO_MS;
}

/**
 * Da quanto dura uno stato, in parole.
 *
 * Serve a una distinzione sola, ed e quella che decide se la riga vale la pena
 * di essere letta: un lampo di rete e un guasto che dura non devono
 * somigliarsi. Grana grossa di proposito — «19 ore» dice tutto quello che
 * serve, «19 ore 3 minuti 12 secondi» chiede al lettore di fare la sottrazione.
 */
export function quantoDura(daIso: string, ora: Date): string {
  const inizio = new Date(daIso).getTime();
  if (Number.isNaN(inizio)) return 'un tempo non registrato';
  const secondi = Math.max(0, Math.round((ora.getTime() - inizio) / 1000));
  if (secondi < 60) return 'meno di un minuto';
  const minuti = Math.floor(secondi / 60);
  if (minuti < 60) return `${String(minuti)} ${minuti === 1 ? 'minuto' : 'minuti'}`;
  const ore = Math.floor(minuti / 60);
  if (ore < 48) return `${String(ore)} ${ore === 1 ? 'ora' : 'ore'}`;
  return `${String(Math.floor(ore / 24))} giorni`;
}

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

  // ADR-0059: dove atterra il lavoro di un turno, non la casa dell'installazione
  // — sono due domande diverse da quando `resolveWorkspace` le ha separate, e
  // fino a questa riga nessuna delle due porte che l'owner guarda (un turno,
  // `muffin doctor`) rispondeva alla seconda. `describeWorkspace` legge, non
  // decide: la stessa cartella di default che `resolveWorkspace` userebbe, mai
  // creata qui — un `mkdirSync` dentro una diagnosi renderebbe "esiste già" e
  // "non esiste ancora" la stessa risposta.
  const workspace = describeWorkspace(home);
  if (workspace.envRejected) {
    warn(
      'workspace',
      `${workspace.workspace} — MUFFIN_WORKSPACE puntava a ${workspace.envRejected.requested}, dentro l'installazione: ignorato, ` +
        "perché dentro ~/.muffin ci sono memoria, sessioni e il sigillo, non è uno spazio di lavoro e nessun turno ci scrive",
      `indica una cartella fuori dall'installazione con MUFFIN_WORKSPACE, oppure togli la variabile e lascia il default`,
    );
  } else if (!workspace.exists) {
    // Non un warn: non c'è niente da fare qui, e un warn senza un'azione è
    // come si insegna a scorrere oltre gli avvisi — questo repository ha già
    // pagato il prezzo del testo di sicurezza che nessuno legge più. La nota
    // resta, dentro la riga verde.
    ok('workspace', `${workspace.workspace} — qui atterrano le scritture di un turno (si crea da sola al primo turno che ci scrive)`);
  } else {
    ok('workspace', `${workspace.workspace} — qui atterrano le scritture di un turno`);
  }

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
        // Due numeri distinti e per questo confondibili se non nominati per ciò che sono:
        // `maxToolsExposed` è quanti tool il modello *vede*, `maxToolCallsPerTurn`
        // è quante *chiamate* può fare; `null` lascia il conteggio libero e
        // sono tempo e spesa a porre il limite.
        `${resolvedProfile.maxToolsExposed} tool esposti, ${resolvedProfile.maxToolCallsPerTurn === null ? 'nessun tetto numerico di tool call' : `${resolvedProfile.maxToolCallsPerTurn} call/turno`}, ` +
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

  // I pin di routing che derivano da un'altra era del modello (issue #501):
  // confronto offline contro il marcatore, senza rete. Quando non lo si può
  // provare si tace — un avviso che piange al lupo insegna a ignorare doctor.
  const routingDiag = diagnoseRoutingStaleness(config);
  if (routingDiag !== null) {
    warn('model routing', routingDiag.detail, routingDiag.remedy);
  } else {
    const pins = [...(config.provider.routing?.only ?? []), ...(config.provider.routing?.order ?? []), ...(config.provider.routing?.ignore ?? [])];
    if (pins.length > 0 && config.provider.routingForFamily !== undefined) {
      ok('model routing', `pin validati per la famiglia "${config.provider.routingForFamily}"`);
    }
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
  ownerBindingCheck(ok, warn, fail, home, config);

  // Where the permission matrix came from. Same shape of invisible fact as the
  // cache dialect above: the sealed file and the compiled fallback behave
  // identically on a default install, so nothing in the agent's output tells
  // the owner which one answered — and the difference is whether their edits to
  // `rot/policy.json` mean anything.
  const matrix = loadPolicyMatrix(home);
  // The rows, not `defaultMaxTaint`: since ADR-0053 the ceiling comes from the
  // capability's effect row, and printing the class defaults here would name a
  // number that no longer decides anything — the exact shape of invisible fact
  // this check exists to remove. Three rows are shown because they are the ones
  // an owner meets: the host row is the ask they will see for an action with no
  // undo, and the other two are the refusals.
  //
  // `askAbove` used to be printed here as "host chiede sopra taint N". ADR-0074
  // removed the field: the taint no longer produces an ask, so a doctor line
  // naming a taint threshold for asking would be exactly the invisible-fact
  // defect this check exists against, one field later.
  const rows = matrix.rows;
  if (matrix.source === 'sealed') {
    ok(
      'policy matrix',
      `rot/policy.json — righe di effetto: host ${rows.host.asksForIrreversible ? 'chiede per ciò che non si annulla' : 'non chiede'} e nega sopra taint ${rows.host.denyAbove}, ` +
        `esterni (MCP) negano sopra ${rows.external.denyAbove}, outward nega sopra ${rows.outward.denyAbove}; ` +
        `${matrix.neverAtRuntime.size} mai a runtime, ${matrix.forbiddenForSystem.size} vietate agli autonomi`,
    );
  } else {
    warn(
      'policy matrix',
      `fallback ai valori compilati (${matrix.note}) — le modifiche a rot/policy.json non hanno effetto`,
      'ripristina il file dai default del repo e rifai `muffin rot reseal`',
    );
  }

  /**
   * **Quali stanze ricevono qualcosa in più, per nome — ADR-0073 punto 1.**
   *
   * Un grant è l'unica cosa che questo file *allarga*, quindi è l'unica che
   * l'owner deve poter rileggere senza aprire il JSON: «cosa può fare Muffin
   * in quel gruppo» è la domanda, e finché la risposta viveva solo dentro il
   * sigillo era una manopola che nessuno poteva verificare di aver girato.
   * Stessa ragione della riga sopra sulla provenienza della matrice: un fatto
   * invisibile che decide il comportamento.
   *
   * Silenzioso quando non c'è nessun grant: un `doctor` che stampa «nessuna
   * stanza» su ogni installazione insegna a saltare la riga.
   */
  if (matrix.grants.size > 0) {
    const stanze = [...matrix.grants.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tenant, grants]) => `${tenant} → ${[...grants].sort().join(', ')}`);
    ok('stanze con grant', stanze.join(' · '));
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
      "sembra vincolante ma non lo è, perché nessun modulo lo legge davvero: dagli un lettore, oppure toglilo da rot/ " +
        '— poi rifai `muffin rot reseal` (è dentro il sigillo: per questo serve la tua conferma)',
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
      'ogni capability ad alto rischio (`sys.shell` in testa) ti chiede sempre conferma e non diventa mai un allow ' +
        'silenzioso: se qualcosa modifica questi file mentre gira come te, Muffin se ne accorge solo dopo, non lo ' +
        "impedisce prima — è la modalità single-user: le manomissioni sono rilevate, non impedite",
      '`muffin rot harden` stampa i comandi per rendere vero il blocco su questa macchina, e cosa cambia una volta fatto',
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
  // owner's own machine (docs/evidence/deriva-defaults-2026-08-26.md):
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
    // Several sealed files drifting together get one grouped remedy instead
    // of the same "dentro il sigillo" paragraph once per file — see
    // `sealedDriftGroupCheck`. A single one still goes through
    // `defaultsDriftCheck`, which already produces that same shape for one
    // file.
    const sealedAdoptable = drift.filter((d) => d.sealed && d.status === 'adoptable');
    const rest = sealedAdoptable.length >= 2 ? drift.filter((d) => !(d.sealed && d.status === 'adoptable')) : drift;
    for (const d of rest) defaultsDriftCheck(ok, warn, d);
    if (sealedAdoptable.length >= 2) sealedDriftGroupCheck(warn, sealedAdoptable);
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

  // Key presence. Which backend answers is part of the check, not decoration:
  // the read chain has two links, and a chain that does not say which one
  // spoke is how an install that believes it has moved its key keeps reading
  // the old copy forever.
  //
  // Doctor reports facts without resolving secret bytes. On the file backend
  // the value is at hand (length/empty checks, never content); on the systemd
  // backend this process runs outside the service and must not hold the host
  // key, so presence is ciphertext existence — and emptiness is refused at
  // provisioning time, which is what makes presence imply usable.
  if (secretsBackend(home) === 'systemd') {
    ok('segreti', `backend systemd — encrypted credentials in ${CREDSTORE_ENCRYPTED_DIR}, mai in file`);
    if (secretExists(config.provider.apiKeyRef, home)) {
      const shadows = locateSecretAll(config.provider.apiKeyRef, home);
      if (shadows.length > 0) {
        fail(
          'api key',
          `${config.provider.apiKeyRef} provisionato, ma esiste un'ombra in chiaro in ${shadows.map((s) => s.path).join(' e ')} — con backend systemd non viene mai letta`,
          'cancella le copie in chiaro, così resta una sola chiave da ruotare',
        );
      } else {
        ok('api key', `${config.provider.apiKeyRef} provisionato (systemd encrypted credential), mai stampata`);
      }
    } else {
      fail(
        'api key',
        `${config.provider.apiKeyRef} non provisionato come systemd credential`,
        `provisiona: \`muffin secret set --systemd <nome>\`; poi riavvia: \`sudo systemctl restart muffin-gateway.service\``,
      );
    }
    const legacy = listLegacySecretNames(home);
    if (legacy.length > 0) {
      fail(
        'api key (nomi)',
        `copie in chiaro legacy (${legacy.join(', ')}) — con backend systemd non vengono mai lette, e alla rotazione restano indietro`,
        '`muffin secret migrate --yes`, oppure cancellale a mano',
      );
    }
    const missing = requiredSecretRefs(home).filter((r) => !secretExists(r, home));
    if (missing.length > 0) {
      warn(
        'segreti (mancanti)',
        `riferimenti senza credential provisionata: ${missing.join(', ')}`,
        'provisiona ciascuno (`muffin secret set --systemd <nome>`), poi rigenera la unit (`muffin gateway install --write --force`) e riavvia',
      );
    }
  } else {
    ok('segreti', `backend file — 0600 in ${secretDir('home', home)} e ${secretDir('persistent', home)}`);
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
    // Una copia sotto un **altro nome**, che è il caso che il rename di
    // `provider_api_key` -> `<provider>_api_key` crea e che il controllo qui
    // sopra non può vedere: quello guarda i backend di *un* riferimento, questo
    // guarda i nomi. Una chiave dimenticata sotto un nome che nessuno legge più
    // è comunque una credenziale valida da qualche parte sul disco, ed è quella
    // che alla rotazione successiva resta indietro.
    const altriNomi = ALL_API_KEY_NAMES.filter((n) => `secret://${n}` !== config.provider.apiKeyRef).flatMap((n) =>
      locateSecretAll(`secret://${n}`, home).map((l) => ({ nome: n, path: l.path })),
    );
    if (altriNomi.length > 0) {
      warn(
        'api key (nomi)',
        `esiste una chiave anche col nome ${altriNomi.map((a) => `\`${a.nome}\` (${a.path})`).join(', ')} — ` +
          `questa installazione legge ${config.provider.apiKeyRef} e quella non la usa mai`,
        'cancella la copia che non serve più: una chiave valida che nessuno legge è una che alla rotazione resta indietro',
      );
    }
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

    // **Prima** dei conteggi, non dentro il ramo dei conteggi coerenti.
    //
    // Il calcolo stava sotto `chunks > 0`, quindi su un'installazione fresca —
    // `chunks` esistente e vuota — il ramo `chunks === 0` scattava per primo e
    // la config non veniva mai costruita. Misurato, con `config.embedder`
    // `openai-compat` a cui manca `dimensions`: `warn | empty: recall is
    // full-text only | run \`muffin memory extract\``. La stessa home con **un**
    // chunk: `fail | mancano dimensions in config.json | correggi
    // config.embedder`.
    //
    // Ed è proprio l'installazione che questa slice dice di servire: VPS senza
    // Ollama, `makeEmbedder` lancia, `agent/runtime.ts:352` inghiotte,
    // `vectors = undefined`, quindi `chunks` resta 0 **per sempre** — e
    // `doctor` dava la colpa a «empty» prescrivendo `muffin memory extract`,
    // che ripassa da `makeEmbedder`, rilancia e non indicizza niente. Ciclo
    // permanente, causa sbagliata, rimedio inerte.
    //
    // Una config non costruibile è la causa di tutti i rami sotto, quindi si
    // dice per prima e li sostituisce: nessun rimedio più in basso può
    // funzionare finché quella riga di config.json è com'è.
    let configurato: Embedder | undefined;
    let configRotta: string | undefined;
    try {
      configurato = config === null ? undefined : makeEmbedder(config.embedder, (ref) => readSecret(ref, home));
    } catch (error) {
      // Una config di embedder incompleta non deve far cadere `doctor`: è
      // proprio il momento in cui serve. Ma nemmeno sparire: qui stava un
      // `catch {}` che lasciava `configurato = undefined`, e `undefined`
      // faceva cadere la sonda sul default Ollama. Su una macchina con Ollama
      // vivo la sonda rispondeva e `doctor` diceva «1 chunks, 1 vectors, in
      // sync» — verde — mentre `agent/runtime.ts:352` inghiottiva lo stesso
      // errore e girava con `vectors === undefined`.
      //
      // Il messaggio di `makeEmbedder` esiste apposta per nominare i campi che
      // mancano: qui è l'unico posto che lo legge.
      configRotta = error instanceof Error ? error.message : String(error);
    }

    if (configRotta !== undefined) {
      fail(
        'vector index',
        `${chunks === null ? 'nessuna tabella chunks' : `${chunks} chunks`}, e config.embedder non è ` +
          `costruibile (${configRotta}): niente viene indicizzato e il recall è solo testuale`,
        'correggi config.embedder',
      );
    } else if (chunks === null) {
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
        // A tempo e non dietro `--online`. Sul default — Ollama — è una porta
        // su 127.0.0.1 che rifiuta subito quando è chiusa, e il tetto serve per
        // il caso opposto: un server che accetta la connessione e non risponde,
        // perché `doctor` è ciò che si lancia quando la macchina è già strana.
        // Con `openai-compat` in config non è più una porta locale: la sonda
        // diventa una chiamata autenticata a terzi, un embedding della parola
        // «probe» e nulla della memoria dell'owner. È la config a deciderlo, e
        // resta da decidere se meriti il flag.
        //
        // L'embedder configurato, costruito qui e non assunto: se la config
        // dice `openai-compat` e `doctor` interroga Ollama, dice «giù» su una
        // macchina sana e «su» su una rotta.
        const embedderError = await probeEmbedder(options.embedderProbe, configurato);
        // Contare `chunks` contro `chunks_vec` non è chiedere se il recall vede
        // tutto: dice solo che ciò che è **già** indicizzato è coerente. Dopo un
        // cambio di embedder il backlog si drena a scaglioni di `limit = 200`,
        // quindi «200 chunks, 200 vectors, in sync» convive benissimo con 50
        // episodi che il recall semantico non vede — misurato, su 250 episodi.
        const pendenti = quantiNonIndicizzatiSafe(db, configurato);
        if (embedderError !== null) {
          // Il rimedio segue la config, non l'abitudine. Dire «avvia ollama»
          // a chi ha configurato `openai-compat` manda a riparare la cosa
          // sbagliata, e la seconda metà era pure inerte: `makeEmbedder`
          // lascia vincere `config.embedder.baseUrl` su `OLLAMA_URL`.
          warn(
            'vector index',
            `${chunks} chunks, ${vectors} vectors coerenti, ma l'embedder non risponde (${embedderError}): ` +
              'niente di nuovo viene indicizzato e il recall è solo testuale',
            rimedioEmbedder(config),
          );
        } else if (pendenti > 0) {
          warn(
            'vector index',
            `${chunks} chunks, ${vectors} vectors coerenti, ma ${pendenti} sorgenti non hanno ancora ` +
              "un vettore per l'embedder di adesso: il recall semantico non le vede",
            'run `muffin memory extract` to drain the backlog',
          );
        } else {
          ok('vector index', `${chunks} chunks, ${vectors} vectors, in sync`);
        }
      }
    }
    // Il vault: la directory è la fonte, l'indice è derivato — e finché il
    // watcher (DT-09, `core/vault/watcher.ts`) non gira dentro un processo
    // longevo, ogni modifica a mano resta disallineata fino al prossimo
    // `reindex` esplicito. Questa riga è l'etichetta stale di quel disegno:
    // dice che il recall sta rispondendo da un indice vecchio, e con cosa lo
    // si riallinea. Solo il tenant `host`, come `muffin vault check` — il
    // drift di una stanza lo vede la stanza, non questa riga.
    await vaultDriftCheck(ok, warn, db, p.vault);
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
      /**
       * Il socket di controllo, chiesto **oltre** alla riga, non al suo posto.
       *
       * v1 è sola osservazione (`core/gateway/control-socket.ts`), e questa
       * riga è dove si osserva: la riga `gateway_lock` dice quello che l'ultimo
       * scrittore ha lasciato scritto, il socket risponde solo se c'è ancora
       * qualcuno. Vederli **affiancati** è il modo di scoprire il caso che
       * questa migrazione esiste per chiudere — un pid vivo che non è più il
       * nostro — prima di far dipendere qualcosa dal socket.
       *
       * Un silenzio non è un guasto: su un gateway avviato prima di questa
       * versione il socket semplicemente non c'è.
       */
      const identita = (await askGateway(home, 'identify')) as { pid?: number } | null;
      const canale =
        identita === null
          ? ' · socket muto (gateway di prima di questa versione, o non aperto)'
          : identita.pid === gateway.pid
            ? ' · socket concorde'
            : ` · socket risponde pid ${String(identita.pid)}, la riga dice ${gateway.pid}`;
      ok('gateway', `attivo · pid ${gateway.pid} · dal ${since} · ${gateway.status}${canale}`);

      /**
       * Se le superfici **abilitate** stiano rispondendo, adesso.
       *
       * Il difetto che questa riga esiste per chiudere, misurato il 30/08/2026:
       * Telegram era abilitata e aveva portato 44 turni veri, e nell'arco di
       * vita di una sola istanza del gateway il polling era fallito **3187
       * volte**. `doctor` stampava `gateway attivo · socket concorde` e
       * `nessuna delivery mancante`. Vere tutte e due, e **cieche per
       * costruzione**: una superficie che non riceve non produce turni, quindi
       * non produce consegne, quindi non ne mancano. Quei numeri restano
       * identici che il guasto duri cinque secondi o un giorno — e nemmeno
       * `gateway.err` sapeva dirlo, perche' registra solo i fallimenti e non li
       * data: conta *quanti*, mai *per quanto*.
       *
       * Si chiede al gateway e non al database perche' «sta rispondendo
       * adesso» e' una domanda che non sopravvive al processo che la risponde:
       * una riga durevole lasciata da un gateway morto direbbe com'era il
       * mondo l'ultima volta che qualcuno ha guardato — la stessa classe di
       * bugia. Un silenzio non e' un guasto: un gateway avviato prima di
       * questa versione non conosce il verbo, e le superfici salgono dopo il
       * socket.
       */
      const abilitate = config.surfaces.enabled.filter((id) => id !== 'cli');
      if (abilitate.length > 0) {
        const risposta = (await askGateway(home, 'superfici')) as { superfici?: StatoSuperficie[] } | null;
        const stato = risposta?.superfici;
        if (stato !== undefined) {
          const perId = new Map(stato.map((r) => [r.id, r]));
          const vive: string[] = [];
          for (const id of abilitate) {
            const riga = perId.get(id);
            if (riga === undefined) {
              warn(
                `superficie ${id}`,
                'abilitata, ma il gateway non ne ha notizia: non e stata nemmeno tentata',
                `controlla \`surfaces.enabled\` e riavvia il gateway`,
              );
            } else if (riga.connessa) {
              vive.push(id);
            } else if (riga.inAvvio === true) {
              // Sta aspettando il primo battito. Non e' un guasto e non e' una
              // conferma: finche' dura poco, l'unica risposta onesta e'
              // silenzio. Ma «in avvio da tre ore» non e' un «non lo so»
              // onesto — e' un guasto che ha trovato il modo di non dirsi.
              if (Date.now() - new Date(riga.da).getTime() >= AVVIO_TROPPO_LUNGO_MS) {
                warn(
                  `superficie ${id}`,
                  `in avvio da ${quantoDura(riga.da, new Date())}: non ha ancora ne risposto ne fallito, ` +
                    `quindi non riceve niente e non lo dichiara nessuno`,
                  '`muffin gateway run` in primo piano mostra a che punto si e fermata la stretta di mano — riavviare la rifa partire da capo',
                );
              }
            } else if (Date.now() - new Date(riga.da).getTime() >= guastoDopoMsDaEnv(process.env['MUFFIN_GUASTO_DOPO_MS'])) {
              warn(
                `superficie ${id}`,
                `non risponde da ${quantoDura(riga.da, new Date())} (${String(riga.fallimentiDiFila)} tentativi di fila): ${riga.causa ?? 'causa non registrata'} — ` +
                  `finche dura, quello che ti scrivono di li non arriva, e ne le consegne ne i turni lo dicono: restano verdi perche non arriva niente`,
                riga.rimedio ??
                  'riavvia il gateway; se non basta, `muffin gateway run` in primo piano mostra ogni tentativo',
              );
            }
          }
          // «Connesse», non «in ascolto», perche' le due superfici invecchiano
          // in modo diverso e la parola deve reggere per la piu' debole. Per
          // Telegram `connessa` vuol dire un `getUpdates` riuscito da poco: il
          // battito successivo la conferma o la ritira. Per Discord vuol dire
          // l'ultimo READY/RESUMED senza chiusure da allora, che il rilevamento
          // zombie di `startHeartbeat` limita a circa due `heartbeat_interval`
          // — chiude il socket, e la chiusura passa da `stato(false)`. Nessuno
          // dei due ✓ puo' invecchiare senza limite, ma «in ascolto» direbbe
          // «adesso», e per Discord «adesso» ha una tolleranza di un minuto e
          // mezzo.
          if (vive.length > 0) ok('superfici', `${vive.join(', ')} — connesse`);
        }
      }
    } else if (existsSync(paths(home).gatewayStopped)) {
      // Fermo **di proposito** non è un guasto, ed è la distinzione che decide
      // se questa riga vale la pena di essere letta. Un `!` giallo su uno stato
      // che l'owner ha voluto è il modo più rapido per insegnargli a scorrere
      // oltre `doctor` — la stessa ragione per cui `stopCaveat` non allarma
      // quando nessun LaunchAgent è installato.
      //
      // `ok` e non `warn`, ma la conseguenza si dice lo stesso: chi ha fermato
      // il gateway tre settimane fa non ricorda di averlo fatto.
      ok(
        'gateway',
        'fermo di proposito (`muffin gateway stop`) — resta giù anche dopo un riavvio, ' +
          'e i job schedulati girano solo mentre una sessione `muffin` è aperta. `muffin gateway start` lo riaccende',
      );
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
    //
    // serviceUser is always the user doctor itself runs as: the Linux system
    // unit must run as the Home user, and anyone else (including root, which
    // arrives here as an empty User=) is a mismatch worth a warning.
    const supervisor = checkSupervisor(
      process.platform,
      home,
      gateway !== null,
      {
        ...realSupervisorProbes(),
        ...options.supervisorProbes,
      },
      undefined,
      undefined,
      process.platform === 'linux' ? userInfo().username : undefined,
    );
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

  // `web_search`: stesso produttore di `agent/runtime.ts`, non una seconda
  // lettura. Prima di questa riga il motivo per cui il tool mancava viveva
  // solo in una riga di `gateway.err` scritta all'avvio — misurato il
  // 03/09/2026: l'owner ha riprovato tre turni contro «api.tavily.com non è
  // in rot/egress.json», ragione già presente nel log dal boot precedente, e
  // ha finito per grepparselo a mano. `diagnoseSearch` (agent/tools/
  // search.ts) è la funzione che decide anche in `buildRuntime`: un motore
  // qui e uno là sarebbero due modi di saperlo.
  let egressPerRicerca: EgressPolicy;
  try {
    egressPerRicerca = loadEgress(home);
  } catch {
    egressPerRicerca = { allow: [] };
  }
  const ricerca = diagnoseSearch(config, egressPerRicerca, (ref) => readSecret(ref, home));
  if (config.search !== undefined) {
    if (ricerca.on) {
      ok('capacità: web_search', `${ricerca.backend.id} — attivo`);
    } else if (ricerca.gap) {
      warn(
        'capacità: web_search',
        ricerca.gap.reason,
        ricerca.gap.remedy ?? 'correggi search.provider/apiKeyRef in config.json e riavvia',
      );
    }
  }

  // `shell_run`/`sys.shell`: la stessa sonda del check `sandbox` sopra, letta
  // di nuovo qui solo per darle un nome di capacità — mai una seconda scelta
  // di come si prova la sandbox.
  if (!sandbox.available) {
    warn(
      'capacità: shell_run',
      `${sandbox.mechanism} non disponibile (${sandbox.reason}): ${sandbox.detail}`,
      sandbox.remedy,
    );
  } else {
    ok('capacità: shell_run', 'attivo');
  }

  // Il tetto del profilo: quali tool, fra quelli che questa installazione
  // registrerebbe, cadono oltre `maxToolsExposed`. `baseToolOrder`
  // (agent/runtime.ts) è la stessa lista ordinata che il boot usa per
  // `capabilityGaps` e che `runtime-exposure.test.ts` tiene allineata al
  // registro reale — non un secondo elenco scritto qui a mano.
  //
  // `sendFileAvailable: true` perché `doctor` non costruisce un runtime intero
  // e non sa se questa invocazione precede un gateway o un REPL — ma
  // entrambi i processi persistenti lo allegano sempre (`cli/surface.ts#
  // attachSendFile`, DAY-1 B14), e solo `muffin run` non lo fa mai. Ometterlo
  // qui era esattamente il difetto misurato altrove (`agent/runtime.ts`): il
  // tool più a rischio di un taglio silenzioso reso invisibile alla diagnosi
  // che dovrebbe segnalarlo.
  const ordineBase = baseToolOrder({ sandboxAvailable: sandbox.available, searchOn: ricerca.on, sendFileAvailable: true });
  const tagliatiDalTetto = ordineBase.slice(resolvedProfile.maxToolsExposed);
  if (tagliatiDalTetto.length === 0) {
    ok(
      'capacità: tetto tool',
      `${ordineBase.length} tool entro il tetto di ${resolvedProfile.maxToolsExposed} del profilo "${resolvedProfile.name}"`,
    );
  } else {
    warn(
      'capacità: tetto tool',
      `${tagliatiDalTetto.length} tool oltre il tetto di ${resolvedProfile.maxToolsExposed} del profilo "${resolvedProfile.name}" e quindi invisibili al modello — ${tagliatiDalTetto.join(', ')}`,
      `alza maxToolsExposed in agent/profiles/${resolvedProfile.name}.json, oppure riduci quanti tool sono registrati prima di questi`,
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

  // Le note vocali: il modello le ascolta, oppure whisper.cpp le legge in
  // casa — `core/audio/voce.ts` sceglie a runtime, e fino a qui il primo
  // momento in cui l'owner scopriva che il secondo ramo non era pronto era la
  // prima nota vocale, con il rimedio stampato a cose fatte. Misurato il
  // 02/09/2026 sull'installazione dell'owner: `qwen/qwen3.8-27b` dichiara
  // `["text","image","video"]`, `whisper-cli` e `ffmpeg` assenti, nessun
  // modello, e questo report tutto verde.
  //
  // Stesse fonti del runtime, non una copia: `audioAccettato` è la funzione
  // che `decidiVoce` chiama, e i prerequisiti sono letti dalla stessa config
  // e dallo stesso default di percorso che `voceFor` (`cli/surface.ts`) passa
  // a `trascrivi`. A tempo, come la sonda dell'embedder: un provider che
  // accetta la connessione e non risponde non deve tenere `doctor` appeso, e
  // «non ha risposto» prende il ramo che il runtime prenderebbe — trascrivere
  // in casa — perché è l'unico che non manda niente fuori.
  //
  // Solo quando una superficie che porta voce è abilitata: le note vocali
  // arrivano da Telegram e Discord, non dal terminale. Su un'installazione
  // con la sola CLI questa riga sarebbe un avviso su un problema che non
  // può presentarsi — e A10 (`e2e-giro-owner.accept.ts`) lo ha misurato
  // subito: «WARN non dichiarato» su una home appena inizializzata.
  const modello = config.models.main;
  const superficiVocali = config.surfaces.enabled.filter((id) => id === 'telegram' || id === 'discord');
  const ascolta =
    superficiVocali.length === 0 ? false : await probeAudio(options.voce?.accettaAudio, config.provider.baseUrl, modello);
  if (superficiVocali.length === 0) {
    ok('note vocali', 'nessuna superficie vocale abilitata (telegram, discord): niente da preparare');
  } else if (ascolta) {
    ok('note vocali', `${modello} accetta audio: le note vocali vanno al modello`);
  } else {
    const audio = config.audio;
    const prerequisiti = prerequisitiTrascrizione(
      {
        whisperModel: audio?.whisperModel ?? p.whisperModel,
        ...(audio?.whisperBin === undefined ? {} : { whisperBin: audio.whisperBin }),
        ...(audio?.ffmpegBin === undefined ? {} : { ffmpegBin: audio.ffmpegBin }),
      },
      options.voce?.path,
    );
    const mancanti = prerequisiti.filter((x): x is Extract<Prerequisito, { ok: false }> => !x.ok);
    if (mancanti.length === 0) {
      ok(
        'note vocali',
        `${modello} non accetta audio: si trascrive in casa — ` +
          prerequisiti.map((x) => (x.ok ? `${x.cosa} ${x.dove}` : x.cosa)).join(' · '),
      );
    } else {
      warn(
        'note vocali',
        `${modello} non accetta audio e la trascrizione in casa non è pronta: ` +
          `${mancanti.map((x) => x.why).join(' · ')} — la prima nota vocale fallirebbe`,
        mancanti.map((x) => x.rimedio).join('\n  → '),
      );
    }
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

export function formatReport(report: DoctorReport, style: Style = PLAIN): string {
  const glyph: Record<CheckLevel, string> = { ok: '✓', warn: '!', fail: '✗' };
  const vesti: Record<CheckLevel, (s: string) => string> = {
    ok: style.ok,
    warn: style.warn,
    fail: style.fail,
  };
  const lines = report.checks.map((c) => {
    // Il segno prende il colore, **il nome prende il grassetto, il dettaglio
    // resta nudo**: colorare anche il dettaglio farebbe venti righe verdi in cui
    // trovare l'unica gialla e' di nuovo un lavoro dell'occhio. Quello che deve
    // saltare fuori e' la colonna dei segni.
    const head = `${vesti[c.level](glyph[c.level])} ${style.bold(c.name.padEnd(18))} ${c.detail}`;
    // Il rimedio e' smorzato di proposito: e' la riga che leggi **dopo** aver
    // deciso che quella sopra ti riguarda, e a piena intensita' raddoppia il
    // rumore in un report dove la maggioranza dei check e' verde.
    return c.remedy ? `${head}\n${style.dim(`  → ${c.remedy}`)}` : head;
  });
  return lines.join('\n');
}

/**
 * The remedy text for one or more sealed (`rot/`) files that are both
 * safe to adopt: what happens, what to type, only then the word for it.
 *
 * Consequence first, action second, vocabulary last — an owner who does not
 * know what "the seal" is must still know what to do, per the 03/09/2026 UX
 * pass (he called this exact line confusing while reading real `doctor`
 * output). Truthful, not softened: adopting genuinely drops the install into
 * `safe mode` until `muffin rot reseal`, and that word is who decides — never
 * automatic, same posture as `core/rot/harden.ts`'s printed-not-run plan.
 *
 * Takes a list so `sealedDriftGroupCheck` below can reuse it for several
 * files at once: one explanation, one list, one command sequence — not the
 * same paragraph repeated per file.
 */
function sealedAdoptRemedy(files: { path: string; cmd: string }[]): string {
  const commands = files.map((f) => f.cmd).join(' — poi ');
  return (
    `aggiornarl${files.length === 1 ? 'o' : 'i'} blocca l'installazione in safe mode finché non dici tu che va bene ` +
    `così — mai in automatico. Per farlo, in ordine: ${commands} — quindi \`muffin rot reseal\` una sola volta, alla ` +
    `fine (${files.length === 1 ? 'questo file è' : 'sono'} dentro il sigillo, rot/: per questo serve la tua parola esplicita)`
  );
}

/**
 * Several sealed files drifting at once used to print the same explanation
 * N times over — one `defaultsDriftCheck` call per file, each opening with
 * "questo file è dentro il sigillo" again. Same consequence, same remedy
 * shape every time, so one grouped check replaces the repetition: one
 * explanation, one list of files, one command sequence in the order the
 * owner runs it, `muffin rot reseal` exactly once at the end.
 *
 * Only called for 2+ files (see the call site in `runDoctor`) — a single
 * diverging sealed file already gets this shape from `defaultsDriftCheck`
 * itself, unrepeated by construction.
 */
function sealedDriftGroupCheck(warn: (name: string, detail: string, remedy: string) => void, group: DefaultDrift[]): void {
  const files = group.map((d) => ({ path: d.path, cmd: d.adoptCommand ?? `(comando non disponibile per ${d.path})` }));
  warn(
    'default rot/*',
    `${String(group.length)} file dentro il sigillo sono cambiati da come li ha copiati \`muffin init\`, e HEAD è ` +
      `andato avanti: ${files.map((f) => f.path).join(', ')}`,
    sealedAdoptRemedy(files),
  );
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
 * `core/rot/harden.ts`'s printed plan). When several such files drift
 * together, the caller in `runDoctor` routes them to `sealedDriftGroupCheck`
 * instead of calling this once per file — see there for why.
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
      // Il rimedio nomina il verbo che **registra** (`cli/adopt.ts`), non
      // `muffin init`: init lo ricrea davvero, ma rifa' anche config, database
      // e sigillo per un file che manca. Sotto `rot/` il verbo giusto resta
      // init, perche' e' l'unico che copia dentro il sigillo e risigilla nello
      // stesso giro — altrimenti l'installazione resta in safe mode.
      //
      // Un default che manca non e' quasi mai una scelta: e' una casa nata
      // prima che quel default esistesse (misurato sull'installazione
      // dell'owner il 03/09/2026 — il suo registro elencava `persona.md` e
      // basta, e le skill di serie non erano mai arrivate). `muffin update` ora
      // lo ripara da solo; questa riga esiste per chi non lo ha ancora lanciato.
      warn(
        name,
        d.detail,
        d.sealed
          ? "`muffin init` lo ricopia dentro il sigillo e risigilla — oppure, se l'hai tolto di proposito, ignora questa riga"
          : "`muffin adopt " + d.path + "` (o `muffin adopt --tutto`) lo installa e lo registra; `muffin update` lo fa da sé — oppure, se l'hai tolto di proposito, ignora questa riga",
      );
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
      // Fuori dal sigillo il rimedio è un **verbo**, non un `cp` da incollare.
      // Il `cp` funziona e resta scritto qui accanto, ma non aggiorna il
      // registro d'installazione: chi lo incolla si ritrova il file marchiato
      // `owner-modified` al giro dopo, e non più adottabile — vedi
      // `cli/adopt.ts`. Nominare per primo il comando che fa la cosa giusta è
      // l'unico modo per cui la cosa giusta è anche quella comoda.
      const remedy = d.sealed
        ? sealedAdoptRemedy([{ path: d.path, cmd }])
        : `\`muffin adopt ${d.path}\` (o \`muffin adopt --tutto\`) — copia e registra. Il ${cmd} equivalente copia e basta.`;
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

/**
 * `audit()` sopra un handle di sola lettura.
 *
 * `new MemoryStore(db)` esegue DDL nel costruttore, quindi non si può
 * costruire su questo handle — e una diagnosi non deve poter scrivere
 * comunque. L'adattatore risponde alle due letture che `audit()` fa
 * (`episodesForVaultPath`, `vaultPaths`, più `maxTierForContent` che il tipo
 * chiede) con le stesse SELECT di `core/memory/store.ts`: se quelle cambiano,
 * queste le devono seguire. Le scritture lanciano: `audit()` non le chiama
 * mai, e se un giorno lo facesse, `doctor` deve cadere in modo visibile, non
 * scrivere in silenzio.
 */
function readOnlyVaultStore(db: DatabaseCtor.Database): VaultStore {
  const solaLettura = (cosa: string): never => {
    throw new Error(`doctor legge il vault, non lo scrive (${cosa})`);
  };
  return {
    episodesForVaultPath: (tenantId, vaultPath) =>
      db
        .prepare(
          `SELECT id, media_meta AS mediaMeta FROM episodes
           WHERE tenant_id = ? AND vault_path = ? AND superseded_at IS NULL ORDER BY id`,
        )
        .all(tenantId, vaultPath) as { id: number; mediaMeta: string | null }[],
    vaultPaths: (tenantId) =>
      db
        .prepare(
          `SELECT vault_path AS vaultPath, count(*) AS chunks, max(trust_tier) AS trustTier
           FROM episodes
           WHERE tenant_id = ? AND vault_path IS NOT NULL AND superseded_at IS NULL
           GROUP BY vault_path ORDER BY vault_path`,
        )
        .all(tenantId) as { vaultPath: string; chunks: number; trustTier: TrustTier }[],
    maxTierForContent: (tenantId, hash) =>
      (
        db
          .prepare(
            `SELECT max(trust_tier) AS tier FROM episodes
             WHERE tenant_id = ? AND json_extract(media_meta, '$.hash') = ?`,
          )
          .get(tenantId, hash) as { tier: TrustTier | null }
      ).tier,
    tenantsForVaultPath: (vaultPath) =>
      (
        db
          .prepare(
            `SELECT DISTINCT tenant_id AS tenantId FROM episodes
             WHERE vault_path = ? AND superseded_at IS NULL ORDER BY tenant_id`,
          )
          .all(vaultPath) as { tenantId: string }[]
      ).map((r) => r.tenantId),
    addEpisode: () => solaLettura('addEpisode'),
    supersedeEpisodes: () => solaLettura('supersedeEpisodes'),
  };
}

/**
 * Il drift del vault, in una riga: file cambiati a mano e non reindicizzati.
 *
 * `warn` e mai `fail` di proposito: finché il watcher non è cablato nel
 * gateway, *ogni* modifica a mano fa drift fino al prossimo reindex esplicito
 * — un `fail` sarebbe rosso di default, e un rosso di default insegna a
 * scorrere oltre `doctor`. Il rimedio nomina il verbo, non la spiegazione:
 * `muffin vault check` elenca, `muffin vault reindex` riallinea.
 */
async function vaultDriftCheck(
  ok: (name: string, detail: string) => void,
  warn: (name: string, detail: string, remedy: string) => void,
  db: DatabaseCtor.Database,
  root: string,
): Promise<void> {
  if (!existsSync(root)) {
    ok('vault', 'nessuna cartella vault — niente da indicizzare');
    return;
  }
  const vault = new Vault(readOnlyVaultStore(db), root);
  // Senza la tabella `episodes` nessun runtime ha mai costruito un indice qui:
  // `audit()` lancerebbe sulla tabella che manca, e "mai indicizzato" non è
  // drift — è uno stato che ha il suo rimedio.
  if (countOrNull(db, 'episodes') === null) {
    const files = vault.list().files.length;
    if (files === 0) {
      ok('vault', 'vuoto — niente da indicizzare');
    } else {
      warn(
        'vault',
        `${files} file sul disco, mai indicizzati (tenant host) — il recall non li vede`,
        'run `muffin vault reindex`',
      );
    }
    return;
  }
  let audit: VaultAudit;
  try {
    audit = await vault.audit('host');
  } catch (error) {
    warn(
      'vault',
      `non verificabile: ${error instanceof Error ? error.message : String(error)}`,
      'run `muffin vault check` per il dettaglio',
    );
    return;
  }
  const drift = audit.missing.length + audit.stale.length + audit.orphaned.length + audit.unreadable.length;
  if (drift === 0) {
    ok('vault', `${audit.files} file · indice allineato (tenant host)`);
    return;
  }
  const parts: string[] = [];
  if (audit.missing.length > 0) parts.push(`${audit.missing.length} sul disco, non indicizzati`);
  if (audit.stale.length > 0) parts.push(`${audit.stale.length} cambiati dopo l'indice`);
  if (audit.orphaned.length > 0) parts.push(`${audit.orphaned.length} indicizzati, file spariti`);
  if (audit.unreadable.length > 0) parts.push(`${audit.unreadable.length} illeggibili ora`);
  warn(
    'vault',
    `${drift} disallineamenti (tenant host): ${parts.join(' · ')} — il recall risponde da un indice vecchio`,
    '`muffin vault reindex` li risolve (`muffin vault check` li elenca)',
  );
}

/** `null` means the table is not there, which is a different fact from "zero rows". */
function countOrNull(db: DatabaseCtor.Database, table: string): number | null {
  try {
    return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  } catch {
    return null;
  }
}

/**
 * Il rimedio giusto per l'embedder che questa installazione ha scelto.
 *
 * «avvia ollama … oppure `OLLAMA_URL`» a chi ha configurato `openai-compat`
 * manda a riparare la cosa sbagliata, e la seconda metà è pure inerte:
 * `makeEmbedder` lascia vincere `config.embedder.baseUrl` su `OLLAMA_URL`.
 */
function rimedioEmbedder(config: { embedder?: { kind?: string } | undefined } | null): string {
  return config?.embedder?.kind === 'openai-compat'
    ? "controlla l'endpoint e la chiave in config.embedder (baseUrl, apiKeyRef)"
    : 'avvia ollama (`ollama serve`) oppure indica un embedder raggiungibile con OLLAMA_URL';
}

/**
 * Il backlog, senza mai costruire un `VectorIndex`.
 *
 * Costruirne uno esegue il costruttore, e il costruttore può fare DROP+DELETE
 * quando la dimensione o l'id sono cambiati: un check di salute non deve poter
 * cancellare l'indice che sta misurando. Da qui la funzione libera in
 * `core/memory/vectors.ts` invece del metodo.
 *
 * Un DB senza le tabelle della memoria non è un guasto da riportare qui — lo
 * dicono già i rami sopra — quindi vale zero invece di far cadere `doctor`.
 */
function quantiNonIndicizzatiSafe(db: DatabaseCtor.Database, embedder: Embedder | undefined): number {
  try {
    return quantiNonIndicizzati(db, (embedder ?? new OllamaEmbedder()).id);
  } catch {
    return 0;
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
/**
 * Il modello configurato accetta audio in ingresso? Con un tetto, perché
 * `audioAccettato` non ne ha uno suo: nel gateway una nota vocale può
 * aspettare, `doctor` no.
 */
export const AUDIO_PROBE_MS = 5_000;

async function probeAudio(
  override: (() => Promise<boolean>) | undefined,
  baseUrl: string | undefined,
  model: string,
): Promise<boolean> {
  const run = override ?? (() => audioAccettato(baseUrl, model));
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), AUDIO_PROBE_MS);
        timer.unref();
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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

/**
 * Chi è l'owner, e **da dove viene quel legame** — DAY-1 B15, la metà
 * «protetto».
 *
 * Stessa classe di fatto invisibile del tetto di spesa qui sopra: per mesi
 * `rot/budgets.json` e `config.json` hanno portato gli stessi numeri, e niente
 * distingueva «il sigillo tiene il tetto» da «il sigillo tiene una copia del
 * tetto». Qui la posta è più alta di un numero: `surfaces.telegram.ownerUserId`
 * decide chi ha autorità di owner, e in un `config.json` ordinario lo riscrive
 * qualunque processo che gira come l'owner — senza che niente, da nessuna
 * parte, lo dica.
 *
 * Quattro esiti, uno per stato reale, perché confonderli è il difetto:
 * sigillato; sigillato ma diverso da `config.json` (chi vince, e perché);
 * solo in `config.json` (legacy: il rimedio, non un allarme); sigillato e non
 * verificabile (nessuno è owner — questo è un `fail`).
 */
function ownerBindingCheck(
  ok: (name: string, detail: string) => void,
  warn: (name: string, detail: string, remedy: string) => void,
  fail: (name: string, detail: string, remedy: string) => void,
  home: string,
  config: Config,
): void {
  const sealed = loadSealedOwner(home);
  const tgConfig = config.surfaces.telegram?.ownerUserId;
  const dcConfig = config.surfaces.discord?.ownerUserId;

  if (sealed.source === 'refused') {
    fail(
      'owner binding',
      `${sealed.note ?? 'il legame sigillato non si verifica'} — nessuna superficie riconosce più un owner`,
      'guarda cosa è cambiato in rot/owner.json; se la modifica è tua `muffin rot reseal`, altrimenti rifai `muffin surface enable telegram --owner <id>`',
    );
    return;
  }

  const tgSealed = sealed.binding?.telegram?.userId;
  const dcSealed = sealed.binding?.discord?.userId;
  const sigillati: string[] = [];
  if (tgSealed !== undefined) sigillati.push(`telegram ${tgSealed}`);
  if (dcSealed !== undefined) sigillati.push(`discord ${dcSealed}`);

  // Divergenza: il file sigillato e `config.json` nominano owner diversi per
  // la stessa superficie. Non è un dettaglio di pulizia — è la domanda «quale
  // dei due mi riconosce», e la risposta va detta, non dedotta.
  const diverse: string[] = [];
  if (tgSealed !== undefined && tgConfig !== undefined && tgSealed !== tgConfig) {
    diverse.push(`telegram: sigillo ${tgSealed}, config.json ${tgConfig}`);
  }
  if (dcSealed !== undefined && dcConfig !== undefined && dcSealed !== dcConfig) {
    diverse.push(`discord: sigillo ${dcSealed}, config.json ${dcConfig}`);
  }

  if (sigillati.length > 0 && diverse.length > 0) {
    warn(
      'owner binding',
      `${diverse.join(' · ')} — vince il sigillo, e il campo in config.json non viene nemmeno letto`,
      'se l\'owner giusto è quello sigillato non devi fare niente; se non lo è, `muffin surface enable telegram --owner <id>` lo riscrive e risigilla',
    );
    return;
  }

  if (sigillati.length > 0) {
    ok('owner binding', `rot/owner.json — ${sigillati.join(', ')}, dentro il sigillo`);
    // Una superficie legata solo in config.json accanto a una già sigillata
    // resta legacy: va detta lo stesso, o la riga verde qui sopra coprirebbe
    // metà della verità.
  }

  const legacy: string[] = [];
  if (tgSealed === undefined && tgConfig !== undefined) legacy.push(`telegram ${tgConfig}`);
  if (dcSealed === undefined && dcConfig !== undefined) legacy.push(`discord ${dcConfig}`);
  if (legacy.length === 0) return;

  warn(
    'owner binding legacy',
    `${legacy.join(', ')} — il legame vive solo in config.json, fuori dal sigillo: qualunque processo che gira come te ` +
      'può riscriverlo e diventare owner, e nessun hash se ne accorgerebbe' +
      (sealed.note === undefined ? '' : ` (${sealed.note})`),
    'rifai `muffin surface enable telegram` (o `discord`): scrive rot/owner.json e risigilla nello stesso giro',
  );
}
