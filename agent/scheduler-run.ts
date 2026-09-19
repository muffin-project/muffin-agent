import { randomBytes } from 'node:crypto';
import type { JobFireStore } from '../core/scheduler/job-fires.js';
import { jobPayload, type Job } from '../core/scheduler/jobs.js';
import type { FireDeferred, FireSettleOnly, JobOutcome, RunJob } from '../core/scheduler/scheduler.js';
import type { ExecResult } from '../core/sandbox/executor.js';
import type { TrustTier } from '../core/policy/types.js';
import { CAPPED_MODEL, SCRIPT_MODEL, type TurnCounters, type TurnOutcome } from '../core/turns/store.js';
import { runTurn, type LoopDeps, type TurnResult } from './loop.js';
import { recoveredText } from './recovered-text.js';

/**
 * The bridge from a scheduled job to a real turn.
 *
 * A job runs as the scheduler principal — `{ kind: 'system', source:
 * 'scheduler' }` — so the kernel treats it as itself, not as the owner: a
 * high-risk capability it would ask the owner for becomes an ASK queued for the
 * owner's return (threat model §3), and `outward.*` / `config.ratchet` are
 * denied outright. It never inherits the owner's column. Each fire gets a fresh
 * session: a daily brief is not one growing conversation.
 *
 * It does get the **owner-class context** (`agent/context/assemble.ts`), and
 * that is not the same statement as inheriting the owner's column: the job runs
 * on the host tenant, over the owner's own memory, and its output is for the
 * owner. Handing it the group prompt would produce a daily brief written by a
 * guest in someone else's room. The class follows from the pair it already
 * passes — `system` principal, `host` tenant — so there is nothing to keep in
 * sync here; a job ever armed for a group tenant moves to the group class on
 * its own.
 *
 * ## B7 — the one decision this file makes
 *
 * This is also where `job_fires` (`core/scheduler/job-fires.ts`) turns into a
 * choice of what to run, which is the "one piece with a decision in it" this
 * docstring already claimed before there was a decision to make. Owner
 * directive, verbatim: *"ogni occorrenza stabile `(job_id, scheduled_for)`
 * deve mappare a UNA sola identità durevole di lavoro/turno; dopo crash Muffin
 * continua o conclude quella stessa identità, non crea un secondo turn e non
 * abbandona il primo."*
 *
 * `makeJobRunner` resolves the fire *before* it decides whether to touch the
 * model at all:
 *
 *  1. `fires.claim` — the occurrence exists, idempotently (fault point 1).
 *  2. Already bound to a turn? Look it up.
 *     - Missing (a crash landed between the bind and the turn actually being
 *       written) → finish creating it, with the *same* id (fault point 2).
 *     - `done` → the model already ran; recover the outcome and hand
 *       `Scheduler` either a normal delivery or a settle-only sentinel,
 *       depending on whether something already delivered it (fault points 5
 *       and 6).
 *     - anything else (`runnable`/`running`/`waiting`/`interrupted`) → not
 *       this call's turn to touch; say so and let the turn lane's own
 *       machinery finish it (fault point 4, unchanged).
 *  3. Not yet bound → mint an id, bind it *before* the turn is created or the
 *     model is ever called (fault point 3's precondition), then run.
 */

/**
 * Il taint con cui gira un'occasione: quello della riga, non un letterale.
 *
 * Era `0` scritto a mano in tre punti di questo file, e `cli/jobs.ts` diceva
 * da dove sarebbe dovuto venire — «il primo cambiamento è quel `taint: 0`
 * che diventa un valore letto dalla riga». Un intento scritto da un turno a
 * taint 2 non diventa un giro futuro pulito: il kernel vede gli stessi tool
 * con lo stesso soffitto del turno che ha chiesto la ricorrenza. Sulle righe
 * legacy (`tier` 0) niente cambia, per costruzione.
 */
function fireTaint(job: Job): TrustTier {
  return job.tier;
}

/**
 * Il tenant in cui gira un'occasione: quello che ha chiesto la ricorrenza.
 *
 * Stessa direzione del taint qui sopra — il giro torna dove è nato, non
 * guadagna un tenant che nessuno ha nominato. Sulle righe legacy è `host`,
 * ed è ciò che il codice faceva già.
 */
function fireTenant(job: Job): string {
  return job.origin.tenant;
}

/**
 * Map a turn's end to a delivery. Kept pure and separate from the runner so the
 * one piece with a decision in it — what the owner sees when the kernel queued
 * an ASK — is tested without a model.
 */
export function jobOutcomeFromTurn(result: TurnResult): JobOutcome {
  /**
   * A job's turn may now suspend, and that is neither an answer nor a failure.
   *
   * The row is `waiting`, the lane owns it, and it will come back and deliver
   * on its own. The text is written even though `Scheduler` does not deliver it
   * (see the guard there), because the day something does deliver it the string
   * must already be true rather than empty — an empty answer sent to the owner
   * reads as a job that produced nothing.
   */
  if (result.stopped === 'suspended') {
    return {
      stopped: 'suspended',
      text:
        `Il job si è sospeso fino a ${result.suspendedUntil?.wakeAt ?? '?'}: ` +
        `il turno resta registrato e riprende da solo.`,
      // Required on `JobOutcome` since PR #42 landed on dev — `Scheduler`
      // reads it to write the delivery outcome onto the same row `finish`
      // wrote. A suspended turn is not delivered here (see the guard in
      // `Scheduler.run`), but the id still identifies which row this fire was.
      turnId: result.turnId,
    };
  }
  if (result.stopped === 'ask' && result.pending) {
    const on = result.pending.resource ? ` su ${result.pending.resource}` : '';
    // Same two facts the REPL approver shows (D12-min): the concrete action,
    // and — when untrusted content already steered the turn — why the ask
    // deserves suspicion. Taint 0 stays silent; it is the unremarkable case.
    const why = result.pending.taint > 0 ? ` (turno a taint ${result.pending.taint})` : '';
    return {
      stopped: 'ask',
      text: `In coda per te: "${result.pending.capability}"${on}${why} — ${result.pending.prompt}`,
      turnId: result.turnId,
    };
  }
  return { stopped: result.stopped, text: result.text, turnId: result.turnId };
}

/**
 * Test-only pause, a no-op unless a scenario sets the env var — the same
 * precedent as `MUFFIN_GATEWAY_TICK_MS` (`cli/gateway.ts`). The two windows it
 * can widen are real production races (a real `SIGKILL` between two writes),
 * but each is microseconds wide in normal operation: too narrow for an
 * external test process to land a kill on reliably without this. Never set
 * outside `evals/acceptance`.
 */
async function testStall(envVar: string): Promise<void> {
  const ms = Number(process.env[envVar]);
  if (Number.isFinite(ms) && ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create (or finish creating) the turn for an occurrence whose fire is
 * already bound to `turnId`, and run it. The only path in this file that ever
 * calls the model.
 */
async function runFresh(
  deps: LoopDeps,
  job: Job,
  turnId: string,
  signal: AbortSignal | undefined,
  exec: JobExec | null,
  scope: ScriptScope | null,
  jobBudget: JobBudget | null,
): Promise<JobOutcome> {
  /**
   * **Il tetto per-job, e sta qui perché qui è l'unico punto che chiama il
   * modello** (DAY-1 E1, ADR-0035 emendamento №2).
   *
   * Prima del ramo `script`, prima della sessione, prima del prompt: la
   * domanda «questo job ha già speso il suo?» va fatta quando la risposta può
   * ancora impedire la spesa. Un controllo dopo `runTurn` misurerebbe un
   * addebito già avvenuto.
   *
   * `null` come tetto è «l'owner non ne ha messo uno» e non passa di qui.
   * `null` come `jobBudget` è invece un cablaggio mancante, e viene trattato
   * come `exec === null` poche righe più in basso: se il job dichiara un
   * tetto e nessuno può misurarlo, il job **non parte**. Fail-open qui
   * sarebbe la forma esatta del guasto che questa slice chiude — un limite
   * che l'owner ha scritto e che il sistema ignora in silenzio.
   */
  if (job.perJobUsd !== null) {
    if (jobBudget === null) {
      return skipForBudget(deps, job, turnId, null, job.perJobUsd);
    }
    const spent = jobBudget.jobMonthUsd(job.id);
    if (spent >= job.perJobUsd) return skipForBudget(deps, job, turnId, spent, job.perJobUsd);
  }
  // Un job `script` non passa di qui sotto: nessuna sessione, nessun prompt,
  // nessuna chiamata al modello. Il turno durevole viene scritto lo stesso —
  // è ciò che tiene l'esattamente-una-volta, la visibilità in `doctor` e la
  // consegna — ma il modello non lo vede mai.
  if (job.kind === 'script') return runScript(deps, job, turnId, exec, scope);
  // Fault point 2, made observable: a real `SIGKILL` here lands after the
  // fire is bound and before the turn row exists at all.
  await testStall('MUFFIN_JOB_FIRES_STALL_AFTER_BIND_MS');
  const session = deps.sessions.open(`job-${job.id.slice(0, 8)}-${randomBytes(3).toString('hex')}`);
  const result = await runTurn(deps, {
    principal: { kind: 'system', source: 'scheduler' },
    tenant: fireTenant(job),
    surface: job.channel,
    session,
    text: job.goal,
    /**
     * Il taint della riga, oltre quello del principal: il testo dell'obiettivo
     * porta la provenance del turno che ha chiesto la ricorrenza, ed è ciò
     * che alza il taint iniziale del giro futuro. Assente/0 sulle righe
     * legacy — indistinguibile da prima, per dichiarazione del campo stesso.
     */
    contentTaint: fireTaint(job),
    // L'attribuzione della spesa, e non un'etichetta: ogni riga di `spend`
    // che questo turno scrive porta questo id, ed è ciò che il gate qui sopra
    // legge al giro successivo. Toglierla non rompe niente oggi e rende il
    // tetto per-job un numero che non scende mai — il guasto silenzioso che
    // questa slice esiste per chiudere.
    jobId: job.id,
    // The identity `fires.bind` already committed, threaded in so the row
    // this call writes is the row the fire is already pointing at — never a
    // second, competing one.
    id: turnId,
    /**
     * Every job turn delivers **out of band**, including one whose channel is
     * `cli`, and the address is the channel itself.
     *
     * This is the field that makes B8 checkable rather than a promise, and it
     * is also what `slice/turno-sospeso` needed for its own reason: a job
     * whose turn calls `wait` returns `suspended`, the scheduler stops (it
     * has nothing to say yet), and the lane finishes the turn later — in a
     * process with no stack to return to. With no address on the row,
     * `agent/turn-lane.ts` had nothing to deliver to and dropped the answer
     * in silence. A turn created without `replyTo` gets `delivery = NULL`,
     * which `core/turns/store.ts` defines as *"this surface delivers in band
     * — the caller of `runTurn` has the text in its hand and there is no
     * separate step that can fail"*. For a job that is simply false:
     * `Scheduler.run` calls `deliver` afterwards and that call can fail. So
     * the row started out asserting the one thing that made the failure
     * invisible. With the address on it the row starts at `pending`, and a
     * fire whose delivery is never settled stays `pending` where `muffin
     * doctor` can see it — which is a different and more useful fact than
     * "no record either way".
     */
    replyTo: { channel: job.channel },
    // `job.channel` is already a `SurfaceRegistry` address — the exact same
    // string `Deliver` uses — so a tool call mid-job (`send_file`) reaches
    // the same destination the job's own text answer will.
    replyChannel: job.channel,
    ...(signal ? { signal } : {}),
  });
  // Fault point 5, made observable: a real `SIGKILL` here lands after the
  // turn reaches `done` and before `Scheduler` ever calls `deliver`/`markRan`.
  // Skipped for a turn that suspended — there is nothing "done" about it yet,
  // and `Scheduler`'s own suspended branch does not call `deliver` either.
  if (result.stopped !== 'suspended') await testStall('MUFFIN_JOB_FIRES_STALL_AFTER_DONE_MS');
  return jobOutcomeFromTurn(result);
}

/**
 * Resolve a `turn_id` already bound to this occurrence — whether `job_fires`
 * has carried it since a previous tick, or this call just won the bind race a
 * moment ago.
 */
async function resolveBound(
  deps: LoopDeps,
  job: Job,
  turnId: string,
  signal: AbortSignal | undefined,
  exec: JobExec | null,
  scope: ScriptScope | null,
  jobBudget: JobBudget | null,
): Promise<JobOutcome | FireDeferred | FireSettleOnly> {
  const existing = deps.turns.get(turnId);
  // The bind landed, but the row it points at does not exist — a crash
  // between the two (fault point 2). Nothing has run yet, so this is not a
  // duplicate: finish exactly what was interrupted, with the same identity.
  if (existing === null) return runFresh(deps, job, turnId, signal, exec, scope, jobBudget);
  if (existing.status !== 'done') return { deferred: true };
  // `done`, and delivery already resolved by someone else (a live run's own
  // `Scheduler.settle`, or a completed one this same check is re-observing) —
  // never call `deliver` again for text that already went out or already
  // failed for a recorded reason (fault point 6).
  if (existing.delivery !== null && existing.delivery !== 'pending') {
    return {
      settleOnly: true,
      turnId: existing.id,
      outcome: existing.outcome ?? 'error',
      delivered: existing.delivery === 'sent',
    };
  }
  // `done`, delivery still `pending` — the model already ran and produced an
  // outcome, but nothing has told the channel yet (fault point 5, the crash
  // between a turn finishing and `Scheduler.settle` running at all). Recover
  // the text and hand back a normal outcome: `Scheduler` delivers and settles
  // exactly as it would for a live run, never calling `runJob` a second time.
  return { stopped: existing.outcome ?? 'error', text: recoveredText(deps.sessions, existing), turnId: existing.id };
}

/**
 * Cosa serve per eseguire uno script: solo `run`. Un finto con quel metodo è
 * un esecutore valido, come per `makeShellTool`.
 */
export type JobExec = {
  run(req: { command: string; cwd: string; writeScope: readonly string[]; timeoutMs?: number }): Promise<ExecResult>;
};

/** Dove gira uno script di job, e per quanto al massimo. */
export type ScriptScope = { cwd: string; timeoutMs?: number };

/**
 * Cosa serve per far rispettare un tetto per-job: sapere quanto quel job ha
 * speso questo mese. `BudgetEngine` lo implementa; un finto con quel metodo è
 * un contatore valido, come `JobExec` per l'esecutore.
 *
 * Un'interfaccia e non `BudgetEngine`: `agent/scheduler-run.ts` non ha
 * bisogno di poter *registrare* spesa, e un tipo che gliene desse la
 * possibilità renderebbe possibile un secondo scrittore del registro proprio
 * nel file che deve solo leggerlo.
 */
export type JobBudget = { jobMonthUsd(jobId: string): number };

export function makeJobRunner(
  deps: LoopDeps,
  fires: JobFireStore,
  /**
   * L'esecutore sandboxato, e `null` quando il contenimento non è
   * disponibile su questa macchina.
   *
   * `null` non è "esegui senza sandbox": un job `script` gira **senza nessuno
   * che guardi**, a orario, con l'autorità del processo. È esattamente la
   * situazione in cui un contenimento assente non va aggirato ma dichiarato —
   * lo script non parte e il turno registra perché. La stessa scelta che
   * `agent/runtime.ts` fa per `sys.shell`, che non viene nemmeno esposto se
   * il probe della sandbox fallisce.
   */
  exec: JobExec | null = null,
  /**
   * Dove gira uno script, e `null` quando nessuno l'ha detto.
   *
   * Il default era `{ cwd: process.cwd() }`, e sotto launchd/systemd quella
   * directory è la home di Muffin: uno script schedulato — che gira **senza
   * nessuno che guardi**, a orario — avrebbe avuto in scrittura memoria,
   * sessioni e il sigillo. Oggi i due chiamanti di produzione passano
   * `runtime.workspace`, che non è mai l'installazione
   * (`core/config/workspace.ts`); questo `null` è la ragione per cui un terzo
   * chiamante che se ne dimenticasse non erediterebbe di nuovo la cwd del
   * processo. Stessa scelta di `exec` qui sopra, per lo stesso motivo: chiude
   * invece di indovinare.
   */
  scope: ScriptScope | null = null,
  /**
   * Il contatore che il tetto per-job consuma, e `null` quando nessuno l'ha
   * cablato.
   *
   * Stessa disciplina di `exec`/`scope` qui sopra, e per la stessa ragione: un
   * default che *finge* di misurare — `{ jobMonthUsd: () => 0 }` — farebbe
   * passare ogni tetto per non ancora raggiunto, per sempre, e la suite
   * resterebbe verde su un limite che non limita. `null` invece chiude:
   * `runFresh` rifiuta di far partire un job che dichiara un tetto quando non
   * c'è modo di leggerne il conto. I due chiamanti di produzione
   * (`cli/gateway.ts`, `cli/repl.ts`) passano `runtime.budget`.
   */
  jobBudget: JobBudget | null = null,
): RunJob {
  return async (job: Job, signal): Promise<JobOutcome | FireDeferred | FireSettleOnly> => {
    // The occurrence that is due, not the moment this process noticed it —
    // `job.nextFireAt` as `due()` returned it, read once here and never
    // recomputed later in this call.
    const scheduledFor = job.nextFireAt.toISOString();
    const fire = fires.claim(job.id, scheduledFor);
    if (fire.turnId !== null) return resolveBound(deps, job, fire.turnId, signal, exec, scope, jobBudget);

    const minted = randomBytes(16).toString('hex');
    const winner = fires.bind(job.id, scheduledFor, minted);
    // Lost the race: some other bind landed first. There is no turn to run —
    // `minted` was never written anywhere — so this resolves the winner's id
    // exactly as if it had found it already bound at the top of this call.
    if (winner !== minted) return resolveBound(deps, job, winner, signal, exec, scope, jobBudget);
    return runFresh(deps, job, winner, signal, exec, scope, jobBudget);
  };
}


/**
 * Il tetto ha detto no: il giro non parte, e resta scritto perché.
 *
 * Tre cose insieme, e nessuna delle tre da sola basterebbe:
 *
 *  1. **Il modello non viene chiamato.** Nessuna sessione, nessun prompt,
 *     nessun contesto assemblato. È il punto: il tetto esiste per non
 *     spendere, non per spendere e poi dirlo.
 *  2. **La riga durevole si scrive lo stesso**, con esito `budget` e i
 *     contatori a zero — la stessa disciplina di `runScript`. È ciò su cui
 *     poggiano l'esattamente-una-volta di `job_fires`, la visibilità in
 *     `muffin doctor` e la consegna: senza riga, un job che ha smesso di
 *     girare è indistinguibile da uno che gira e non trova niente da dire.
 *  3. **L'owner lo sente.** Il testo non è vuoto, quindi `Scheduler` lo
 *     consegna sul canale del job. Un job spento in silenzio *sembra verde*, ed
 *     è la forma di guasto che `core/scheduler/scheduler.ts` nomina già in
 *     proprio ("un controllo che fallisce in silenzio è peggio di un controllo
 *     che non esiste"). Il costo dichiarato: un job a cadenza fitta lo ripete a
 *     ogni occorrenza finché l'owner non alza il tetto (`muffin jobs cap`) o
 *     finché non cambia il mese. Ripetere è la direzione recuperabile; tacere
 *     no.
 */
function skipForBudget(
  deps: LoopDeps,
  job: Job,
  turnId: string,
  /** Quanto ha speso questo mese, o `null` quando non c'è modo di misurarlo. */
  spentUsd: number | null,
  capUsd: number,
): JobOutcome {
  const session = deps.sessions.open(`job-${job.id.slice(0, 8)}-${randomBytes(3).toString('hex')}`);
  // Tutti a zero, e sono la prova: nessun giro, nessuna tool call, nessun
  // token, nessuna spesa. La riga *dichiara* che il modello non è stato
  // chiamato invece di lasciarlo dedurre.
  const counters: TurnCounters = {
    iterations: 0,
    recoveriesUsed: 0,
    transportRetriesLeft: 0,
    toolCallsMade: 0,
    nudgedForCompletion: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    spentUsd: 0,
    resumes: 0,
    // `true` come in `runScript`, e non "false perché non è stato costruito
    // niente": `agent/loop.ts` usa questo flag per riconoscere un primo
    // tentativo mai partito (riga `firstAttempt`), e una riga che dichiara di
    // non aver ancora costruito il contesto è una riga che un boot successivo
    // può decidere di riprendere. Qui non c'è niente da riprendere.
    contextBuilt: true,
  };
  const breve = job.id.slice(0, 8);
  const testo =
    spentUsd === null
      ? `Job "${breve}" non eseguito: dichiara un tetto di $${capUsd} al mese e questo processo non ha modo ` +
        `di leggerne la spesa. Non lo faccio partire senza poter contare. \`muffin doctor\` dice cosa manca.`
      : `Job "${breve}" non eseguito: ha già speso $${spentUsd.toFixed(2)} questo mese, sul tetto per-job di ` +
        `$${capUsd}. Il modello non è stato chiamato. \`muffin jobs cap ${breve} <dollari>\` per cambiarlo, ` +
        `\`muffin jobs cap ${breve} none\` per toglierlo.`;
  // La riga prima dell'esito, come ovunque in questo file: `create` apre e
  // conia il claim token, `finish` chiude solo la riga di cui è titolare.
  const aperta = deps.turns.create({
    id: turnId,
    principal: { kind: 'system', source: 'scheduler' },
    tenant: fireTenant(job),
    surface: job.channel,
    sessionId: session.id,
    // `CAPPED_MODEL`, non `SCRIPT_MODEL` e non una stringa a mano: dice quale
    // dei due motivi «senza modello» è questo, e `agent/loop.ts` la legge per
    // non riprendere col modello un turno nato dal rifiuto di chiamarlo.
    model: CAPPED_MODEL,
    // La riga porta il job anche quando il modello non è stato chiamato: è
    // ciò che rende «quali giri di questo job sono stati rifiutati» una
    // query invece di una deduzione dal nome della sessione.
    jobId: job.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: jobPayload(job) }] }],
    // Il taint della riga, non un letterale: anche un giro che non parte
    // resta attribuito alla provenance che l'ha chiesto.
    taint: fireTaint(job),
    counters,
    replyTo: { channel: job.channel },
  });
  deps.turns.finish(
    turnId,
    {
      outcome: 'budget',
      messages: [
        { role: 'user', content: [{ type: 'text', text: jobPayload(job) }] },
        { role: 'assistant', content: [{ type: 'text', text: testo }] },
      ],
      taint: fireTaint(job),
      counters,
    },
    aperta.claimToken,
  );
  return { stopped: 'budget', text: testo, turnId };
}

/**
 * Un'occorrenza che esegue invece di ragionare.
 *
 * Il modello non viene chiamato: non c'è sessione, non c'è prompt, non c'è
 * contesto assemblato, non ci sono tool. È il punto della cosa — un controllo
 * ogni cinque minuti costa zero token nei giorni in cui non trova niente, e
 * questo è ciò che rende tenibile un controllo che altrimenti si finisce per
 * spegnere.
 *
 * Il **turno durevole si scrive lo stesso**, e non è una formalità: è la riga
 * su cui poggiano l'esattamente-una-volta di `job_fires`, la visibilità in
 * `muffin doctor`, la consegna e il suo esito. Toglierla renderebbe i job
 * script l'unico lavoro di Muffin senza identità durevole — cioè l'unico che
 * dopo un crash nessuno sa se è girato.
 */
async function runScript(
  deps: LoopDeps,
  job: Job,
  turnId: string,
  exec: JobExec | null,
  scope: ScriptScope | null,
): Promise<JobOutcome> {
  await testStall('MUFFIN_JOB_FIRES_STALL_AFTER_BIND_MS');
  const session = deps.sessions.open(`job-${job.id.slice(0, 8)}-${randomBytes(3).toString('hex')}`);
  // Tutti a zero, e sono la prova: nessuna iterazione, nessuna tool call,
  // nessun token — né in ingresso né in uscita — e nessuna spesa. La riga del
  // turno *dichiara* che il modello non è stato chiamato, invece di lasciarlo
  // dedurre a chi legge.
  const counters: TurnCounters = {
    iterations: 0,
    recoveriesUsed: 0,
    transportRetriesLeft: 0,
    toolCallsMade: 0,
    nudgedForCompletion: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    spentUsd: 0,
    resumes: 0,
    contextBuilt: true,
  };

  const comando = job.script ?? '';

  /**
   * La riga **prima** dell'effetto, e non dopo.
   *
   * Era il contrario, e il judge di questa slice l'ha rotto con un probe: un
   * crash a metà script non lasciava nessuna riga, `resolveBound` legge
   * l'assenza di riga come *"nothing has run yet, so this is not a
   * duplicate"*, e al riavvio lo script ripartiva. `exec.run()` chiamato due
   * volte, osservato. Uno script che manda una mail o addebita qualcosa lo
   * farebbe due volte, e la riga finale mostrerebbe un'esecuzione sola,
   * ordinaria: la duplicazione non lascia traccia.
   *
   * È la stessa disciplina che `agent/loop.ts` si dà per il percorso a
   * obiettivo — *"The record, before anything happens — and not inside a
   * try"* — e `sys.shell` dichiara già `rerunnable: false` proprio perché un
   * comando "may have sent something, moved something, or charged something".
   * Con la riga scritta prima, un crash lascia uno stato `running` che
   * `resolveBound` rinvia invece di rieseguire.
   */
  const aperta = deps.turns.create({
    id: turnId,
    principal: { kind: 'system', source: 'scheduler' },
    tenant: fireTenant(job),
    surface: job.channel,
    sessionId: session.id,
    // `SCRIPT_MODEL`, non una stringa scritta a mano: `agent/loop.ts` la legge
    // per rifiutarsi di riprendere attraverso il modello un turno che il
    // modello non ha mai visto.
    model: SCRIPT_MODEL,
    jobId: job.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: `script: ${comando}` }] }],
    taint: fireTaint(job),
    counters,
    replyTo: { channel: job.channel },
  });

  const chiudi = (outcome: TurnOutcome, text: string): JobOutcome => {
    // Il token di claim che `create` ha appena scritto: `finish` chiude solo
    // la riga di cui si è titolari, ed è la stessa fence che impedisce a un
    // secondo processo di chiudere il lavoro di un altro.
    deps.turns.finish(
      turnId,
      {
        outcome,
        messages: [
          { role: 'user', content: [{ type: 'text', text: `script: ${comando}` }] },
          { role: 'assistant', content: [{ type: 'text', text }] },
        ],
        taint: fireTaint(job),
        counters,
      },
      aperta.claimToken,
    );
    return { stopped: outcome, text, turnId };
  };

  if (exec === null) {
    // Fail closed. Uno script gira senza nessuno che guardi: se il
    // contenimento non c'è, non è il momento di fare a meno del contenimento.
    return chiudi(
      'error',
      `Job "${job.id.slice(0, 8)}" non eseguito: la sandbox non è disponibile su questa macchina, ` +
        `e uno script schedulato non gira senza contenimento. \`muffin doctor\` dice cosa manca.`,
    );
  }

  if (scope === null) {
    // Stesso fail-closed, per l'altra metà della stessa domanda: senza una
    // cartella di lavoro dichiarata non si ripiega sulla cwd del processo, che
    // sotto un supervisore è la home di Muffin.
    return chiudi(
      'error',
      `Job "${job.id.slice(0, 8)}" non eseguito: nessuna cartella di lavoro dichiarata per gli script, ` +
        `e uno script schedulato non gira nell'installazione.`,
    );
  }

  let result: ExecResult;
  try {
    result = await exec.run({
      command: comando,
      cwd: scope.cwd,
      // La stessa radice che `makeShellTool` concede a `sys.shell`: uno script
      // schedulato non ottiene più autorità sul filesystem di quanta ne
      // otterrebbe lo stesso comando chiesto a Muffin da una persona.
      writeScope: [scope.cwd],
      ...(scope.timeoutMs === undefined ? {} : { timeoutMs: scope.timeoutMs }),
    });
  } catch (error) {
    return chiudi('error', `Job "${job.id.slice(0, 8)}" non è partito: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Cosa dice, e quando. Lo stdout è la voce dello script — vuoto significa
  // silenzio, e il silenzio non si consegna (`core/scheduler/scheduler.ts`).
  // Un'uscita diversa da zero invece parla sempre: un controllo che fallisce
  // in silenzio è peggio di un controllo che non esiste, perché sembra verde.
  const out = result.stdout.trim();
  if (result.timedOut) {
    return chiudi('error', `Job "${job.id.slice(0, 8)}": lo script ha superato il tempo massimo.${out ? `\n${out}` : ''}`);
  }
  if (result.code !== 0) {
    const err = result.stderr.trim();
    return chiudi(
      'error',
      `Job "${job.id.slice(0, 8)}": uscita ${result.code}.${out ? `\n${out}` : ''}${err ? `\n${err}` : ''}`,
    );
  }
  return chiudi('answered', out);
}
