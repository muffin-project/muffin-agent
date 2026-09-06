import { memoryWriteCapability } from '../../core/policy/doors.js';
import type { CapabilityId, Decision, DecisionRequest } from '../../core/policy/types.js';
import { recall, recallTaint, renderForPrompt } from '../../core/memory/recall.js';
import type { SessionRef } from '../../core/session/store.js';
import { isSensitiveResourceName } from '../../core/tracing/redact.js';
import { ATTR } from '../../core/tracing/types.js';
import type { SpanHandle } from '../../core/tracing/types.js';
import type { TurnRecord } from '../../core/turns/store.js';
import { planTaint } from '../../core/turns/todo.js';
import { decodeWaitFor, satisfied, wakeReport } from '../../core/turns/wait.js';
import { tenantClass, visibleTools } from '../context/assemble.js';
import { historyTaint, reinjectedHistory } from '../context/history-taint.js';
import { iterationCap } from '../profiles/profile.js';
import type { ContentBlock, Message } from '../providers/types.js';
import { buildContext, userAudios, userImages } from './context.js';
import { announceEnd, checkpoint, closeRecord, finish, reconcile } from './durability.js';
import { makeSnapshot } from './permissions.js';
import { runRounds, type RoundScope } from './round.js';
import { TurnRun } from './run-state.js';
import {
  assertNever,
  MAX_HISTORY_TURNS,
  type LoopDeps,
  type ToolContext,
  type TurnDelta,
  type TurnEvent,
  type TurnInput,
  type TurnResult,
} from './types.js';

/**
 * The engine of a turn: the deterministic pre-loop, and the round loop it hands
 * off to.
 *
 * Slices 2-8 took the pieces out one at a time — the stream, the context, the
 * permission snapshot, `runTool`, the mutable state, the durable writes, the
 * paid path — and each left the same residue behind in `agent/loop.ts`: the
 * *preamble*. That is what lives here. Nothing is generated before this file is
 * done deciding: the permission snapshot, the turn class, the four kernel
 * doors, which tools this principal may even see, the recall and its inherited
 * taint, the plan and the history and the ceilings they raise, and the context
 * itself. Then one `runRounds`, inside the `try` whose `catch` is the only
 * place a turn that *threw* still closes its row and announces its end.
 *
 * The half that is not here is the way in: `enqueueTurn`, `runTurn`,
 * `resumeTurn` and the funnel `drive()` live in `agent/loop/entry.ts`, and
 * `guidaIlTurno` is never called from anywhere else. `agent/loop.ts` is now a
 * barrel over the two.
 */

/**
 * `DriveOptions` — estratto perché adesso lo condividono due funzioni: il
 * guardiano (`drive`) e il motore (`guidaIlTurno`). Vedi il commento su
 * `drive` per il perché di questa separazione (ADR-0054 §2, emendamento
 * 03/09c — l'imbuto).
 */
export type DriveOptions = {
  signal?: AbortSignal | undefined;
  resumed?: boolean;
  wokenFromWait?: boolean;
  /** La barriera com'era prima del claim: vedi `resumeTurn`. */
  waitForAtWake?: string | null;
  /** The ref the caller already opened. Absent on a resume — see `input.session`. */
  session?: SessionRef | undefined;
  /**
   * The caller's `TurnInput.replyChannel`.
   *
   * Not persisted on `TurnRecord` as its own column — by design, per
   * `ToolContext.replyChannel`'s own docstring — but `runFresh` on both
   * surfaces already writes it *inside* `replyTo` (`{ chatId, messageId,
   * channel }`), so `resumeTurn` derives it from there rather than needing
   * a caller with a live stack. `runTurn` still passes its own live value
   * directly for a fresh turn; a resume reads the durable copy. `string |
   * undefined`, matching `TurnInput`'s own field exactly — `null` is
   * `ToolContext`'s vocabulary, applied once, where `toolContext` is built
   * below.
   */
  replyChannel?: string | undefined;
  /**
   * The surface's own live sink, when one is attached.
   *
   * Always present on a fresh turn (`runTurn`'s caller holds the surface
   * directly). On a resume it is present only when the caller of
   * `resumeTurn` built one — see `ResumeStream` and
   * `docs/evidence/forma-delle-superfici-2026-09-03.md` §4.3: a process
   * that picks a suspended turn back up (the gateway's lane) is not the
   * one that *received* the previous attempt's `onDelta`, but it can be
   * the one that opens a fresh sink addressed at the durable `replyTo` —
   * which is exactly what `agent/turn-lane.ts`'s `makeLaneRunner` now does
   * for Telegram. Still absent for a caller with no surface to attach (a
   * headless retry, a test), and that absence is silence, not a gap the
   * owner notices, because there was nothing streaming before either.
   */
  onDelta?: ((delta: TurnDelta) => void) | undefined;
  /** Same story as `onDelta`, immediately above. See `TurnInput.onProgress`. */
  onProgress?: ((event: TurnEvent) => void) | undefined;
  /**
   * Vivo solo su un turno fresco — a differenza di `onDelta`/`onProgress`
   * qui sopra, questo non ha un indirizzo durevole da cui ricostruirsi su
   * una ripresa: chi riprende un turno non ha la chat che lo corregge, solo
   * l'indirizzo dove mandare la risposta.
   */
  steer?: (() => string[]) | undefined;
};

/**
 * The engine, over a row that is already claimed.
 *
 * One body for a fresh turn and for a resumed one, because two would drift and
 * the resumed one is the one nobody watches. What differs is only the *start
 * state*: a fresh turn assembles its context here, a resumed one restores it
 * from the record and repairs whatever the crash left half-said.
 *
 * Non si chiama mai direttamente: si entra da `drive`, che è l'imbuto — vedi
 * il suo commento in `agent/loop/entry.ts`.
 */
export async function guidaIlTurno(
  deps: LoopDeps,
  record: TurnRecord,
  turn: SpanHandle,
  options: DriveOptions,
  /** Ciò che è già uscito dalla porta di steer e non ha trovato una riga (vedi `drive`). */
  recupero: string[],
): Promise<TurnResult> {
  const now = deps.now ?? (() => new Date());
  const input: TurnInput = {
    principal: record.principal,
    tenant: record.tenant,
    surface: record.surface,
    /**
     * The caller's own ref when there is one, reopened from the id when there
     * is not — and **never** rebuilt by hand.
     *
     * A `SessionRef` is `{ id, file }` and only `SessionStore.open` knows the
     * second half. This line used to be `{ id: record.sessionId } as
     * SessionRef`: a cast, which is a claim and not a check, and the claim was
     * false — every `sessions.append` in the turn then wrote to `undefined` and
     * threw. A resume has no caller holding a ref, so it derives one; a fresh
     * turn passes the ref it already opened, which is the stronger of the two
     * because it cannot disagree with the caller about where the transcript is.
     */
    session: options.session ?? deps.sessions.open(record.sessionId),
    text: lastUserText(record.messages),
    // Riprese **dal record**, esattamente come il testo qui sopra, e per la
    // stessa ragione: `drive` non riceve il `TurnInput` originale — lo
    // ricostruisce — quindi tutto cio' che il modello deve vedere deve essere
    // passato dal record. Metterle solo nel `TurnInput` di `runTurn` le faceva
    // sparire fra le due funzioni, senza errori: il modello rispondeva «non
    // vedo nessuna immagine» a una domanda su una foto arrivata davvero
    // (misurato contro il modello vero il 28/08/2026). Passare dal record e'
    // anche cio' che fa sopravvivere l'immagine a una ripresa dopo un crash.
    ...(userImages(record.messages).length > 0 ? { images: userImages(record.messages) } : {}),
    // Stessa strada delle immagini, e non per simmetria: e' la riga che quel
    // commento qui sopra dice di non dimenticare. Un audio passato solo nel
    // `TurnInput` di `runTurn` sparirebbe fra le due funzioni senza un errore,
    // e il modello risponderebbe a una nota vocale che non ha mai sentito.
    ...(userAudios(record.messages).length > 0 ? { audios: userAudios(record.messages) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    // **Dal record**, come il testo e le immagini qui sopra, e non dal
    // `TurnInput` di `runTurn`: `drive` ricostruisce l'input, quindi un
    // `jobId` passato solo là sparirebbe qui in silenzio — e le righe di
    // `spend` di questo turno non apparterrebbero a nessun job. È il guasto
    // che il test «la spesa di un giro di job finisce nel registro attribuita
    // a QUEL job» ha misurato prima che questa riga esistesse; passare dal
    // record è anche ciò che fa sopravvivere l'attribuzione a una ripresa.
    ...(record.jobId === null ? {} : { jobId: record.jobId }),
    ...(record.replyTo === null ? {} : { replyTo: record.replyTo }),
    ...(options.replyChannel !== undefined ? { replyChannel: options.replyChannel } : {}),
    ...(options.onDelta ? { onDelta: options.onDelta } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.steer ? { steer: options.steer } : {}),
  };

  // ---- Pre-loop: deterministic, no model call. ------------------------------
  // Permissions, taint and *which context this turn gets* are resolved before
  // anything is generated, so none of them can depend on what the model just
  // said. The class is a pure function of the principal and the tenant the
  // gateway already resolved — the same two values the kernel decides on.
  //
  // The taint comes from the **record**, not from the principal: see
  // `resumeTurn` §2. On a fresh turn the two agree by construction, which is
  // exactly why deriving it looked safe for as long as nothing resumed.
  const snapshot = makeSnapshot(deps.decide, input.principal, input.tenant, record.taint);
  // La prima cosa entrata in questo turno: le parole della persona. Un URL che
  // l'owner incolla lui stesso non è «scelto dal modello», ed è il caso più
  // ovvio che il gate sui parametri trattava come tale.
  snapshot.recordInput(input.text);
  const turnClass = tenantClass(input.principal, input.tenant);

  /**
   * The two doors the turn walks through without a tool — the reply and the
   * episode — asked of the kernel the same way a tool call is (ADR-0055).
   *
   * Same span name and attributes as `runTool`'s decision below, so a trace
   * reader sees one vocabulary: `muffin.policy_decision` with the capability,
   * the taint it was decided at, and the effect. The shipped floor answers
   * `allow` on both rows at every taint, and the memoised `check` makes the
   * per-round question free; what this buys is a decision that *exists* — a
   * sealed policy.json that tightens the row is obeyed, and the eval seam can
   * put a sink scene on a capability production really declares.
   */
  const door = (capability: CapabilityId, resource: DecisionRequest['resource']): Decision => {
    const span = deps.tracer.start(
      'muffin.policy_decision',
      { [ATTR.capability]: capability, [ATTR.taint]: snapshot.currentTaint() },
      turn,
    );
    const decision = snapshot.check(capability, resource, {});
    span.setAttributes({
      [ATTR.policyEffect]: decision.effect,
      ...(decision.effect === 'deny' ? { [ATTR.policyDenyCode]: decision.code } : {}),
    });
    span.end();
    return decision;
  };
  /**
   * Open, or the refusal that closed it — a `switch` over the closed union,
   * with `assertNever` in `default`, exactly like `runTool`'s.
   *
   * Anything but `allow` is a no: neither `draft` nor `ask` has a meaning on
   * these two rows (see `doors.ts`), so both refuse. What the `switch` buys
   * over `decision.effect !== 'allow'` is the fifth verdict: an inequality
   * treats a variant nobody wrote a branch for as a refusal and carries on,
   * which is the same silent fall-through — one sign flipped — that let
   * `draft` run as an implicit allow for a year. Here it breaks the build the
   * day the union grows, and throws if a value ever reaches it having
   * bypassed the type checker.
   */
  const doorRefusal = (decision: Decision): Exclude<Decision, { effect: 'allow' }> | undefined => {
    switch (decision.effect) {
      case 'allow':
        return undefined;
      case 'deny':
      case 'ask':
      case 'draft':
        return decision;
      default:
        return assertNever(decision);
    }
  };
  /** What a refusal is called on a span: the deny code when there is one, the verdict otherwise. */
  const refusalLabel = (refusal: Exclude<Decision, { effect: 'allow' }>): string =>
    refusal.effect === 'deny' ? refusal.code : refusal.effect;
  /**
   * May this turn write an episode into its tenant's memory right now?
   *
   * The refusal is counted on the turn, not swallowed: an episode that was
   * not written is a fact about this turn a reader of the trace must be able
   * to see.
   */
  const memoryDoorOpen = (): boolean => {
    const refusal = doorRefusal(door(memoryWriteCapability.id, { kind: 'tenant', value: input.tenant }));
    if (refusal === undefined) return true;
    turn.setAttributes({ 'muffin.memory.write_refused': refusalLabel(refusal) });
    return false;
  };

  /**
   * Tutto cio' che cambia dentro questo turno, in un oggetto solo.
   *
   * Era una dozzina di `let` tenuti insieme dalla chiusura di questa funzione;
   * e' un oggetto perche' le prossime fette portano `checkpoint`/`suspendHere`
   * e il corpo di giro **fuori** da qui, e una chiusura non attraversa un
   * confine di modulo — una firma a dieci parametri si', ed e' il posto dove
   * si scambia un contatore con un altro senza che niente diventi rosso.
   *
   * Le garanzie (`resumes` in sola lettura, `counters()` che copia,
   * `contextBuilt` che viene dai contatori e non dallo status) stanno su
   * `agent/loop/run-state.ts`, dove il test gemello le misura.
   */
  const run = new TurnRun(record, {
    resumed: options.resumed === true,
    wokenFromWait: options.wokenFromWait === true,
  });
  const cap = iterationCap(deps.profile);

  /**
   * What every handler is told about the turn it is running in — built once,
   * because the barrier has to be the same object across the whole turn.
   *
   * Declared **here**, above every use, and not next to the closures at the
   * bottom of this function: `const` is not hoisted the way a `function`
   * declaration is, so a copy sitting after the loop would sit in its temporal
   * dead zone for the entire turn and throw `ReferenceError` on the first tool
   * call. The build said so; the runtime would have said so on message one.
   */
  const toolContext: ToolContext = {
    tenant: input.tenant,
    principal: input.principal,
    turnId: record.id,
    sessionId: input.session.id,
    taint: () => snapshot.currentTaint(),
    intrinsicTaint: () => snapshot.intrinsicTaint(),
    suspend: (spec) => {
      run.barrier = spec;
    },
    // `input.replyChannel` threaded through, per `ToolContext.replyChannel`'s
    // own docstring: the one field `send_file` (DAY-1 requirement B14) reads, absent
    // everywhere else.
    replyChannel: input.replyChannel ?? null,
  };

  /**
   * Tool names whose single argument (`path` or `url`) names one resource
   * and whose successful result *is* that resource's content — as opposed to
   * `fs_write` (same `path` shape, opposite direction: nothing to echo from
   * an argument the tool never reads back) or `fs_search`/`web_search` (many
   * results, no single resource this call named).
   */
  const RESOURCE_READ_TOOLS = new Set(['fs_read', 'http_get', 'document_read', 'skill_read']);
  const noteSensitiveResourceEcho = (call: { name: string; args: unknown }, outcome: ContentBlock): void => {
    if (!RESOURCE_READ_TOOLS.has(call.name)) return;
    if (outcome.type !== 'tool_result' || outcome.isError) return;
    const args = (call.args ?? {}) as Record<string, unknown>;
    const resourceId = typeof args.path === 'string' ? args.path : typeof args.url === 'string' ? args.url : undefined;
    if (resourceId === undefined || !isSensitiveResourceName(resourceId)) return;
    if (typeof outcome.content === 'string') run.sensitiveResourceEchoes.push(outcome.content);
  };

  // What this turn is shown, decided from who is speaking and where — never
  // from what they said. Filter first, cap second: `slice` on registration
  // order applied to the full list would spend a weak model's ten slots on
  // tools the kernel is going to refuse this principal anyway.
  //
  // Recomputed on a resume rather than persisted, and it is correct to: it is a
  // pure function of the principal and the profile, and the profile follows the
  // model, which the row pins. The legitimate direction of change in between —
  // a tightened permission matrix — is one a resume should *inherit*, not one
  // it should carry a stale copy past.
  const exposed = visibleTools(
    deps.tools,
    input.principal,
    deps.capabilities,
    // `input.tenant` e non il tenant del principal: sono lo stesso valore, e
    // questo è quello su cui il kernel deciderà fra due righe.
    deps.grants?.get(input.tenant),
  ).slice(
    0,
    deps.profile.maxToolsExposed,
  );
  turn.setAttributes({ 'muffin.context.class': turnClass, 'muffin.context.tools_exposed': exposed.length });

  /**
   * Ciò che le scritture durevoli e il corpo del giro leggevano per chiusura,
   * in un valore solo.
   *
   * `checkpoint`, `suspendHere`, `reconcile`, `closeRecord`, `announceEnd` e
   * `finish` vivono in `agent/loop/durability.ts`; `runRounds` e `recover` in
   * `agent/loop/round.ts`. Nessuno dei due vede più questa funzione: ricevono
   * questo oggetto. Nulla qui è copiato — `run` è lo stesso `TurnRun` che il
   * corpo del giro muta, `recupero` lo stesso array che `drive` svuota —
   * perché il punto è che le due metà restino la stessa cosa.
   *
   * Un oggetto solo, non due: `RoundScope` **estende** `TurnScope` con i sette
   * binding che il pre-loop risolve e che solo il giro legge, così la porta di
   * risposta che il giro chiede e la riga che `finish` scrive non possono
   * guardare due copie diverse dello stesso turno.
   */
  const scope: RoundScope = {
    deps,
    record,
    turn,
    input,
    run,
    snapshot,
    recupero,
    exposed,
    toolContext,
    noteSensitiveResourceEcho,
    cap,
    turnClass,
    now,
    door,
    doorRefusal,
    refusalLabel,
    memoryDoorOpen,
  };

  if (!run.contextBuilt) {
    /**
     * La finestra di history, letta **prima** del recall e non dopo.
     *
     * E lo stesso taglio che `buildContext` renderizza piu sotto — calcolato
     * una volta sola perche i due non possano mai dissentire su cosa voglia
     * dire "reinjected" (`agent/context/history-taint.ts`). Sale qui, e non
     * cambia di contenuto salendo: la riga dell owner di questo turno viene
     * appesa alla sessione piu sotto, quindi `spoken` non l ha mai vista.
     *
     * Cosa ci guadagna il recall: i `traceId` che questa finestra porta sono
     * esattamente i turni che il modello ha gia davanti, e sono cio che il
     * recall deve smettere di ripescare.
     */
    const spoken = reinjectedHistory(deps.sessions.read(input.session), MAX_HISTORY_TURNS);
    /**
     * I turni gia nel contesto: quelli della finestra, piu **questo**.
     *
     * `record.id` e nell elenco perche gli episodi di questo turno sono gia
     * scritti quando il recall gira — quello dell owner un attimo fa, e al
     * resume anche quello dell agente. Ripescarli sarebbe far rileggere al
     * modello cio che ha appena detto come se qualcun altro l avesse
     * confermato.
     */
    const turniInContesto = [
      record.id,
      ...spoken.kept.map((m) => m.traceId).filter((id): id is string => id !== undefined),
    ];

    // Evidence first: what was said is recorded before anything is generated, so
    // a crash mid-turn cannot lose the input that caused it.
    let currentEpisodeId: number | undefined;
    if (deps.memory && memoryDoorOpen()) {
      currentEpisodeId = deps.memory.store.addEpisode({
        tenantId: input.tenant,
        connector: input.surface,
        threadKey: input.session.id,
        role: 'user',
        kind: 'message',
        content: input.text,
        // `record.taint`, not `initialTaint(input)`: the `input` in scope
        // here is `drive`'s own reconstruction from `record` a few dozen
        // lines up, which has no `contentTaint` to read (resume has none to
        // reconstruct, so it is not carried). `record.taint` is the value
        // `enqueueTurn`/`runTurn` already computed with `initialTaint` at
        // creation — a forwarded message's episode is the exact "enters
        // memory at the owner's tier" step the audit named (DAY-1 requirement B16), and
        // this is the row this slice exists to stop writing at tier 0 for
        // content nobody at tier 0 actually said.
        trustTier: record.taint,
        createdAt: now().toISOString(),
        // Il turno che l ha prodotto — lo stesso valore che la history porta
        // come `traceId`, cosi "l ho gia davanti" e un confronto di identita e
        // non di testo.
        turnId: record.id,
      });
    }

    // Recall is deterministic and happens before the model sees anything. Its
    // taint is folded into the snapshot here, which is what closes the
    // remember-then-act path: a fact a stranger planted months ago raises the
    // taint of this turn exactly as if they had just spoken.
    const recalled: ContentBlock[] = [];
    if (deps.memory) {
      const recallSpan = deps.tracer.start('muffin.tool_call', { [ATTR.operationName]: 'memory.recall' }, turn);
      try {
        const result = await recall(
          deps.memory.recall,
          input.tenant,
          input.text,
          {
            excludeTurnIds: turniInContesto,
            // Tenuto accanto al lineage e non sostituito da lui: e la garanzia
            // che non dipende dalla colonna nuova, quindi vale anche su una
            // riga che il lineage non ce l ha.
            ...(currentEpisodeId !== undefined ? { excludeEpisodeId: currentEpisodeId } : {}),
          },
        );
        const inherited = recallTaint(result);
        // Il nome accanto al numero (ADR-0075 punto 4): un fatto che uno
        // sconosciuto ha piantato mesi fa alza questo turno esattamente come se
        // avesse appena parlato, e il prompt di un `ask` successivo deve poterlo
        // dire invece di mostrare solo un livello.
        snapshot.raiseTaint(inherited, 'la memoria richiamata');
        recallSpan.setAttributes({
          'muffin.memory.items': result.items.length,
          'muffin.memory.strategies': result.strategies.join(','),
          [ATTR.taint]: inherited,
          // Il reranker chiama il modello dentro questo span, e fino a qui non
          // compariva da nessuna parte: un recall lento si leggeva come un
          // recall lento, mai come «dentro c'è un giro di modello». Sale col
          // risultato invece che da un tracer perché `recall()` non ne ha uno,
          // e darglielo sarebbe plumbing attraverso quattro file per un numero.
          ...(result.rerankUsage === undefined
            ? {}
            : {
                [ATTR.usageInputTokens]: result.rerankUsage.inputTokens,
                [ATTR.usageOutputTokens]: result.rerankUsage.outputTokens,
                [ATTR.cacheReadTokens]: result.rerankUsage.cacheReadTokens,
              }),
        });
        const rendered = renderForPrompt(result);
        if (rendered !== '') recalled.push({ type: 'text', text: rendered });
        recallSpan.end();
      } catch (error) {
        // Recall is an improvement, not a precondition: a turn without memory is
        // worse, a turn that refuses to start is broken.
        recallSpan.end({ error });
      }
    }

    /**
     * The plan, and the taint that comes with it — in that order.
     *
     * `raiseCeiling` **before** the rows reach the transcript, because the
     * whole property is that the turn is *decided* at the tier of everything in
     * its context — a plan written by a turn that had read the web is model
     * text shaped by that page, and this turn may not act as if it were not.
     *
     * `raiseCeiling`, not `raiseTaint` (ADR-0044 §Riconciliazione 2026-08-28):
     * the plan item is *this turn's own reinjected past*, not something this
     * turn did. Stamping this turn's own fresh output at the plan's inherited
     * tier is what kept a session dirty long after the item that dirtied it —
     * every clean answer re-poisoning the window it was meant to age out of.
     */
    const open = deps.todos.open(input.tenant, input.session.id);
    snapshot.raiseCeiling(planTaint(open), 'un promemoria aperto di questa sessione');

    /**
     * The session transcript, and the taint that comes with it — same order,
     * same reason, one line down from the plan above (ADR-0044 §Revisione,
     * "la history non lava la provenienza"; a DAY-1 readiness invariant).
     *
     * `reinjectedHistory` is the same cut `buildContext` renders — computed
     * once here so the two can never disagree about what "reinjected" means
     * (`agent/context/history-taint.ts`'s own docstring). `taintForIds` is one
     * query for every `traceId` this window carries, not one per message: a
     * long session can hand this dozens of rows to resolve.
     *
     * `raiseCeiling`, same reasoning as the plan above, and the exact gap the
     * 17/08 revision's own "Cosa NON copre" named and left open: without it, a
     * clean turn two messages after a `fs_read` was still marked as tainted as
     * the read that never aged out of the window, because every turn's own
     * reply re-entered as new history at the tier it had merely *inherited*.
     * The 17/08 fix stays — a turn sitting on tainted reinjected history still
     * cannot act as if it were clean, `currentTaint()` still says so to every
     * `check()` below — only the *stamp this turn leaves for the next one* no
     * longer inherits a tier this turn did not itself produce.
     */
    const traceIdsInWindow = spoken.kept.map((m) => m.traceId).filter((id): id is string => id !== undefined);
    const taintByTrace = deps.turns.taintForIds(traceIdsInWindow);
    snapshot.raiseCeiling(historyTaint(spoken.kept, taintByTrace), 'la conversazione precedente, riletta in questo turno');

    /**
     * D11's other half: which turns in this window `muffin undo` has already
     * put back. Resolved through the same `traceId` join as `taintByTrace`
     * immediately above, one query for the whole window, and read by
     * `buildContext` so a turn re-reading its own past does not believe an
     * effect that is no longer on disk (`docs/work/day1/critical-path.md`
     * §"Chiudere la compensazione, non solo il restore").
     */
    const undoneTraceIds = deps.turns.undoneTraceIds(traceIdsInWindow);

    run.messages.length = 0;
    run.messages.push(
      ...buildContext(
        input,
        recalled,
        open,
        spoken,
        now(),
        deps.model,
        deps.profile.name,
        deps.istanza?.(),
        deps.timeZone,
        undoneTraceIds,
      ),
    );

    // `record.taint`, the same substitution and for the same reason as the
    // episode write above: `initialTaint(input)` here would read `drive`'s
    // own reconstructed `input`, which never carries `contentTaint`.
    // `record.taint` is what `enqueueTurn`/`runTurn` already computed with
    // `initialTaint` at creation — never a literal 0 that would make a group
    // turn's own user line, or a forwarded message's (DAY-1 requirement B16), read as
    // clean once a later turn in the same conversation reinjects it
    // (`agent/context/history-taint.ts`, ADR-0044 §"la history non lava la
    // provenienza").
    deps.sessions.append(input.session, {
      role: 'user',
      content: input.text,
      surface: input.surface,
      createdAt: now().toISOString(),
      traceId: turn.traceId,
      tier: record.taint,
    });
    // Marked before the first model call, so a crash inside recall replays the
    // preamble (one duplicated episode, absorbed by consolidation) while a
    // crash anywhere after it does not. The window is the microseconds between
    // two synchronous SQLite writes.
    run.contextBuilt = true;
    // Lost the claim before the turn even got going — reachable only if
    // `resumeTurn`'s own `claim()` won a row a steal then immediately took
    // back, a vanishingly narrow window. `finish` re-attempts its own fenced
    // write, finds the same fencing failure, and returns the honest
    // lost-claim result without pretending anything was said.
    if (!checkpoint(scope)) return finish(scope, 'error', '');
  } else if (options.resumed === true) {
    // A resumed turn re-enters a transcript that a crash may have left with a
    // question and no answer. Repairing it is not optional: a `tool_use` block
    // without its `tool_result` is a malformed request, and the provider says
    // so on the very first call.
    const lostClaim = await reconcile(scope);
    if (lostClaim !== null) return lostClaim;
    if (options.wokenFromWait === true) {
      const waitFor = decodeWaitFor(options.waitForAtWake ?? record.waitFor);
      // Lo stesso giudizio che dà la lane quando sceglie chi svegliare, con lo
      // stesso registro sotto: senza `answered` una barriera d'approvazione
      // risulterebbe non soddisfatta qui, e il turno si risveglierebbe con
      // «non hai risposto» proprio nel momento in cui la risposta è arrivata.
      const why =
        waitFor !== null &&
        satisfied(waitFor, {
          ...(deps.approvals === undefined ? {} : { answered: (id: string) => deps.approvals?.answered(id) === true }),
        })
          ? 'event'
          : 'timer';
      turn.setAttributes({ 'muffin.turn.woken_by': why });
      run.messages.push({ role: 'user', content: [{ type: 'text', text: wakeReport(waitFor, why) }] });
    }
  }

  try {
    return await runRounds(scope);
  } catch (error) {
    turn.end({ error });
    // Same reason `announceEnd` is repeated here: a provider that exhausted its
    // retries never reaches `finish`, and a row left `running` by a turn that
    // is definitely over would be reclaimed as *interrupted* — "we do not know
    // whether it ran" — when we know exactly how it ended.
    closeRecord(scope, 'error');
    // A turn that threw still recorded the owner's words at the top of this
    // function, so they are still owed extraction. Announced here as well as in
    // `finish` because a provider that exhausted its retries never reaches
    // `finish` at all, and "the memory lane starts only when the model behaves"
    // is not a property anyone would have chosen.
    announceEnd(scope, 'error');
    throw error;
  }
}

/** The words the turn was started with — the last thing the owner said. */

function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== 'user') continue;
    const text = message.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (text !== '') return text;
  }
  return '';
}
