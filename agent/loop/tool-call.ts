import { APPROVAL_WINDOW_MS } from '../../core/approvals/store.js';
import { sleep } from '../../core/net/sleep.js';
import type { PermissionSnapshot, TrustTier } from '../../core/policy/types.js';
import type { SessionMessage } from '../../core/session/store.js';
import { redactText } from '../../core/tracing/redact.js';
import type { SpanHandle } from '../../core/tracing/types.js';
import { ATTR } from '../../core/tracing/types.js';
import type { EffectDecision, EffectMetadata } from '../../core/turns/effects.js';
import type { ContentBlock } from '../providers/types.js';
import { denyText, resourceFor } from './permissions.js';
import {
  type ApprovalRequest,
  ApprovalRequired,
  assertNever,
  type LoopDeps,
  type RegisteredTool,
  type ToolContext,
  type ToolOutcome,
  type TurnEvent,
  type TurnInput,
} from './types.js';

/**
 * `runTool` and the cluster of helpers it alone uses — moved out of
 * `agent/loop.ts` in pure form (movement only, no behaviour change). See
 * `agent/loop.ts`'s own module docstring for what the loop is.
 */

/**
 * Render a tool call's arguments as the subject of an approval —
 * `command: rm -rf /tmp/x · cwd: /tmp` — for capabilities whose kernel
 * resource is `none`. Flat key: value pairs, no prose: the owner is deciding,
 * not reading.
 *
 * **Not capped.** Until 03/09/2026 this cut at 220 characters, on the
 * reasoning that "a question that scrolls is a question nobody reads to the
 * end of". The owner read one: a long command arrived truncated in the very
 * message that asked whether to run it, and the answer to «non voglio mai
 * testo tagliato, anche quando chiede cosa fare con un comando» is that the
 * thing being approved is shown whole. Where it goes is the surface's
 * problem — `cli/surface.ts` splits an over-long ASK across messages, the
 * terminal just prints — and hiding the tail here would have made both
 * surfaces lie the same way. `description` is left out: it has a field of
 * its own on `ApprovalRequest` and is shown above, not inside, the command.
 */
function summarizeCallArgs(args: unknown): string | undefined {
  if (args === null || typeof args !== 'object') return undefined;
  const parts = Object.entries(args as Record<string, unknown>)
    .filter(([k, v]) => k !== 'description' && v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  if (parts.length === 0) return undefined;
  return parts.join(' · ');
}

/**
 * La provenienza del taint, aggiunta al testo che l'owner legge prima di
 * decidere — **ADR-0075 punto 4**.
 *
 * Il kernel produce la prima metà: *cosa* si perde e non torna
 * (`core/policy/decide.ts`, `IRREVERSIBILE`), o il numero sopra il soffitto
 * delle righe che escono dal tenant. Da un solo snapshot non può produrre la
 * seconda, perché *quale parte del turno* ha alzato il livello non è nella
 * `DecisionRequest`: è nel giro, ed è il giro a scriverla.
 *
 * La forma è quella che D12 ha già per l'effetto irreversibile — una riga in
 * più sotto la domanda, mai una domanda in più. E resta **contesto, non
 * causa**: dopo ADR-0074 il taint non produce nessun `ask` sulla riga `host`,
 * e dopo ADR-0075 non nega più nemmeno lì; questa riga dice all'owner perché
 * il turno è marcato adesso, non perché gli si sta chiedendo.
 *
 * A taint 0 non si aggiunge niente: non c'è nessuna provenienza da dichiarare,
 * e una riga fissa che dice «livello 0» sarebbe rumore su ogni singola
 * domanda. Senza un'origine nominata (un turno nato già a livello alto —
 * il messaggio stesso, o un turno ripreso da un record) resta il livello, che
 * è vero e verificabile, senza inventare una parte che non si sa quale sia.
 */
export function conProvenienza(prompt: string, taint: TrustTier, origine: string | null): string {
  if (taint === 0) return prompt;
  const da = origine === null ? '' : `: ${origine}`;
  return `${prompt}\n\nquesto turno contiene contenuto di livello ${taint}${da}`;
}

/** The model's one-line account of what a call does, when the tool has that field. */
function descriptionOf(args: unknown): string | undefined {
  if (args === null || typeof args !== 'object') return undefined;
  const d = (args as Record<string, unknown>)['description'];
  return typeof d === 'string' && d.trim() !== '' ? d.trim() : undefined;
}

/**
 * Quante volte si riprova, oltre al primo tentativo.
 *
 * Due, come `MAX_TRANSPORT_RETRIES`, e per la stessa ragione: tre tentativi
 * coprono il guasto transitorio vero (un 429 che passa, una connessione che
 * cade una volta) senza trasformare un servizio giu' in un turno che non
 * finisce piu'. Un tetto piu' alto sposta il costo su chi aspetta.
 */
const MAX_TOOL_RETRIES = 2;

/** Attesa prima del tentativo `n` (n=2 e' il primo ritentativo): 400ms, poi 1200ms. */
function attesaPrima(tentativo: number): number {
  return 400 * 3 ** (tentativo - 2);
}

/**
 * Il tool, riprovato quando il fallimento e' transitorio **e** ripeterlo e'
 * sicuro.
 *
 * Due condizioni, ed entrambe servono davvero:
 *
 * 1. `outcome.retryable === true` — il tool ha dichiarato che *questo*
 *    fallimento e' transitorio. Senza, si riprova un «file non trovato» tre
 *    volte per ottenere tre volte lo stesso errore.
 * 2. la capability dichiara **`rerunnable`** — rieseguire non raddoppia un
 *    effetto. E' la stessa dichiarazione che il ripristino dopo un crash gia'
 *    usa per decidere se una chiamata «forse fatta» si puo' rifare, e la
 *    domanda e' identica: quel campo esiste esattamente per questo.
 *
 * **Un `throw` non si riprova mai.** Un'eccezione non dichiara niente sulla
 * propria transitorieta', e riprovarla vorrebbe dire indovinare — nella
 * direzione in cui un handler morto a meta' di un effetto lo rifa'. Chi sa
 * distinguere un guasto di rete da un errore di programmazione e' il tool, e lo
 * dice tornando un outcome, non lanciando.
 *
 * L'Effect WAL non cambia: l'intento e' gia' scritto per questa `call.id`, e
 * dice «forse fatta». `rerunnable` e' precisamente cio' che rende quel «forse»
 * innocuo, quindi i tentativi vivono dentro un intento solo.
 *
 * L'attesa passa da `sleep(ms, signal)`, la stessa del retry di trasporto: un
 * ritentativo che ignora l'abort e' un Ctrl-C che sembra rotto.
 */
async function eseguiConRitentativi(
  tool: RegisteredTool,
  args: unknown,
  ctx: ToolContext,
  rerunnable: boolean,
  nome: string,
  onProgress: ((event: TurnEvent) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<ToolOutcome> {
  let outcome = await tool.handler(args, ctx);
  for (let tentativo = 2; tentativo <= MAX_TOOL_RETRIES + 1; tentativo += 1) {
    if (outcome.isError !== true || outcome.retryable !== true || !rerunnable) return outcome;
    // Un turno abbandonato non guadagna niente da un altro tentativo.
    if (signal?.aborted === true) return outcome;
    const inMs = attesaPrima(tentativo);
    // Annunciato **prima** dell'attesa: un retry dichiarato quando e' gia'
    // finito non serve a chi sta guardando lo spinner fermo, ed e' per quello
    // che l'evento esiste.
    onProgress?.({
      type: 'tool_retry',
      name: nome,
      attempt: tentativo,
      inMs,
      why: outcome.content,
      args,
    });
    await sleep(inMs, signal);
    outcome = await tool.handler(args, ctx);
  }
  return outcome;
}

export async function runTool(
  deps: LoopDeps,
  snapshot: PermissionSnapshot,
  parent: SpanHandle,
  call: { id: string; name: string; args: unknown },
  input: TurnInput,
  /** What this turn was actually shown — the only list it may be told about. */
  exposed: RegisteredTool[],
  /** The turn a handler is running in: identity, and the suspension barrier. */
  ctx: ToolContext,
): Promise<ContentBlock> {
  const span = deps.tracer.start(
    'muffin.tool_call',
    { [ATTR.toolName]: call.name, [ATTR.toolCallId]: call.id },
    parent,
  );
  // Resolved against every registered tool, not against `exposed`, and that is
  // the load-bearing half of "defence in depth, not replacement": a member who
  // names a host-only tool anyway must meet `decide.ts:132` and be refused
  // `principal_forbidden` — a policy denial, on the trace, with a code. Looking
  // it up in the filtered list instead would answer "that tool does not exist",
  // which is both a lie and the kernel branch going quietly unexercised.
  const tool = deps.tools.find((t) => t.spec.name === call.name);

  if (!tool) {
    // Not an exception: the model gets told, and gets to correct itself.
    //
    // Listing `exposed` and not `deps.tools`: this message used to enumerate
    // every registered tool by name, so one hallucinated call handed a group
    // member the full host inventory — the host-only tools it may not have,
    // plus whatever fell past the profile's exposure cap.
    span.end({ status: 'error', error: `unknown tool ${call.name}` });
    return {
      type: 'tool_result',
      toolCallId: call.id,
      content: `Tool "${call.name}" non esiste. Disponibili: ${exposed.map((t) => t.spec.name).join(', ')}.`,
      isError: true,
    };
  }

  const args = (call.args ?? {}) as Record<string, unknown>;
  const capability = tool.capability;
  // Reported only from here on — an unknown tool (`!tool` above) never gets a
  // `tool_start`, because it never had a `capability` to report and no call
  // was ever really attempted, so there is nothing for a `tool_end` to pair
  // with either. `toolCallStartedAt` is this function's own stopwatch, timed
  // the same way `chatCallStartedAt` is above: `SpanHandle` does not expose
  // `span`'s clock back to its caller, so `ms` below is measured at the same
  // call site that reports the start it is measuring from, not guessed at.
  const toolCallStartedAt = Date.now();
  input.onProgress?.({ type: 'tool_start', name: call.name, capability, args });
  const emitToolEnd = (isError: boolean): void => {
    input.onProgress?.({
      type: 'tool_end',
      name: call.name,
      ms: Date.now() - toolCallStartedAt,
      isError,
      args,
    });
  };
  // The kernel decides on a *resource*, so anything it is supposed to gate has
  // to be lifted out of the args here. `url` was missing, and the consequence
  // was not a weaker check but no check at all: the egress branch in decide.ts
  // fires on `resource.kind === 'url'`, every tool call arrived as `none`, and
  // `http_get` skips the allowlist on its first hop precisely because it
  // believes the kernel already ruled on it. Both halves were correct and each
  // was waiting for the other, so an empty allowlist permitted every public
  // host — verified against the assembled runtime before this line existed.
  const resource = resourceFor(deps.capabilities?.get(capability), args);
  /**
   * Il percorso risolto una volta sola dal ramo `draft`, per l'handler.
   * `undefined` per ogni altro verdetto: nessun altro ha preso una copia, e
   * un handler che leggesse un percorso qui senza che una copia esista starebbe
   * eseguendo un `draft` travestito da `allow`.
   */
  let risolto: string | undefined;

  const decisionSpan = deps.tracer.start(
    'muffin.policy_decision',
    { [ATTR.capability]: capability, [ATTR.taint]: snapshot.currentTaint() },
    span,
  );
  const decision = snapshot.check(capability, resource, args);
  decisionSpan.setAttributes({
    [ATTR.policyEffect]: decision.effect,
    ...(decision.effect === 'deny' ? { [ATTR.policyDenyCode]: decision.code } : {}),
  });
  decisionSpan.end();

  // A `switch` over `decision.effect` with an explicit `default`, not the
  // `if`-chain this used to be. The chain fell through to execution for
  // anything it did not have a branch for — which is exactly how `draft` used
  // to run as an implicit allow, before the case below existed (ADR-0022's
  // undo model landed after this file did). `Decision['effect']` is a closed
  // union, but a closed union is only as safe as its last consumer: nothing
  // stopped it from growing a fifth member with nobody touching this
  // function, and the chain would have handed that verdict the tool exactly
  // as it once handed `draft` the write. `assertNever` in `default` turns that
  // into a compile error the day the union grows, instead of a silent allow
  // the day someone forgets this file exists — the same guarantee
  // `core/policy/decide.ts`'s own `switch (decl.risk)` already gets for free
  // from its non-void return type; this one needs to say so, because `ask`'s
  // approved path does not return here, it falls through to execution below.
  switch (decision.effect) {
    case 'deny':
      span.end({ status: 'error', error: decision.code });
      emitToolEnd(true);
      return {
        type: 'tool_result',
        toolCallId: call.id,
        content: denyText(decision),
        isError: true,
      };
    case 'draft': {
      /**
       * `draft` significa «fallo, ma in modo reversibile, e dillo all'owner».
       * Per anni qui c'era un rifiuto, perché il registro di undo non esisteva:
       * il kernel emetteva un verdetto che nessuno implementava, e `fs_write`
       * veniva offerto al modello senza mai scrivere (DAY-1 requirement D2/D3/D11).
       *
       * Adesso il verdetto ha un'implementazione, e la sua forma è una sola
       * frase: **un checkpoint che non si può prendere è un effetto che non
       * deve avvenire.** Ogni ramo qui sotto rifiuta *dichiarando cosa manca*,
       * mai eseguendo lo stesso — perché eseguire senza copia è precisamente
       * trasformare `draft` in `allow`, che è il difetto da cui si veniva.
       */
      if (!deps.undo) {
        // Nessun journal cablato su questa superficie. Non è un caso di
        // produzione — `buildRuntime` lo passa sempre — ma un default che
        // esegue sarebbe la cosa peggiore che questo file possa fare.
        span.end({ status: 'error', error: 'draft_unavailable' });
        emitToolEnd(true);
        return {
          type: 'tool_result',
          toolCallId: call.id,
          content:
            `"${capability}" richiede una bozza revocabile e questo processo non ha un registro di undo. ` +
            `Non eseguito: dillo all'owner invece di riprovare.`,
          isError: true,
        };
      }
      if (tool.resolveEffectPath === undefined) {
        // Il journal sa fotografare un file, e solo il tool sa quale file è
        // (vedi `resolveEffectPath`). Una capability `undoable` il cui tool non
        // lo dichiara non è fotografabile, e va detto invece di eseguirla come
        // se lo fosse: chi dichiara `undoable` promette che si torna indietro.
        span.end({ status: 'error', error: 'draft_unsnapshottable' });
        emitToolEnd(true);
        return {
          type: 'tool_result',
          toolCallId: call.id,
          content:
            `"${capability}" è dichiarata reversibile ma il suo tool non dice quale file toccherà, ` +
            `quindi non se ne può salvare una copia. Non eseguito.`,
          isError: true,
        };
      }
      try {
        // Prima di `recordIntent`, di proposito. Se la copia fallisce si esce
        // di qui **senza** riga d'intento, cioè "mai partito" — lo stesso stato
        // di un deny. L'ordine opposto lascerebbe un intento aperto per una
        // chiamata che non è mai avvenuta, che è la bugia che il WAL esiste
        // per non dire. Una copia presa e poi un intento fallito lascia invece
        // una copia inutilizzata: rumore, non falsità.
        // Una sola risoluzione, e il suo risultato viaggia con la chiamata:
        // l'handler la riusa invece di rifarla (vedi `ToolContext.effectPath`).
        risolto = tool.resolveEffectPath(args, ctx);
        deps.undo.take(ctx.turnId, { callId: call.id, capability, path: risolto });
      } catch (error) {
        span.end({ status: 'error', error: 'draft_snapshot_failed' });
        emitToolEnd(true);
        return {
          type: 'tool_result',
          toolCallId: call.id,
          content:
            `Non ho potuto salvare una copia di quel file prima di modificarlo ` +
            `(${error instanceof Error ? error.message : String(error)}). Non eseguito: senza copia non si torna indietro.`,
          isError: true,
        };
      }
      void 0;
      span.setAttributes({ 'muffin.policy.undo_window_s': decision.undo.windowSeconds });
      break; // fotografato: si esegue, come 'allow'
    }
    case 'ask': {
      const request: ApprovalRequest = {
        capability,
        prompt: conProvenienza(
          decision.ask.prompt,
          snapshot.currentTaint(),
          snapshot.taintOrigin(),
        ),
        // `path` carried this alone; `url` and `query` joined it (mandato inv.
        // 7, egress-params) so approving a params-gated fetch or search shows
        // the exact bytes, not just the kernel's prose — the gap ADR-0044
        // §revisione named and left open ("l'URL che sys.http sta per
        // raggiungere ... non compaiono nel testo che l'owner vede"). `url-read`
        // (ADR-0066) joined the same set: its only way to reach `ask` is the
        // params gate, and that ask exists precisely to show the bytes. For a
        // `resourceKind: 'none'` capability the kernel has nothing to offer,
        // so the call's own arguments are the action — `sys.shell`'s
        // command+cwd, a pid+name — and hiding them made the ask
        // unanswerable (D12-min, RETURN S3).
        ...(resource.kind === 'path' ||
        resource.kind === 'url' ||
        resource.kind === 'url-read' ||
        resource.kind === 'query'
          ? { resource: resource.value }
          : { resource: summarizeCallArgs(call.args) }),
        ...(descriptionOf(call.args) === undefined
          ? {}
          : { description: descriptionOf(call.args) }),
        taint: snapshot.currentTaint(),
      };
      const nega = (): ContentBlock => {
        span.end({ status: 'error', error: 'ask_denied' });
        emitToolEnd(true);
        return {
          type: 'tool_result',
          toolCallId: call.id,
          content: `L'owner ha rifiutato "${capability}". Non insistere: prosegui senza, o spiega cosa ti manca.`,
          isError: true,
        };
      };

      /**
       * Una risposta già data, prima di chiederne un'altra.
       *
       * È il ramo che chiude il giro su una superficie a pulsanti: l'owner ha
       * premuto, il turno si è risvegliato, il modello rifà la chiamata, e qui
       * quella risposta viene **consumata** — una volta, per questa capability
       * su questa risorsa. Senza, si richiederebbe la stessa cosa all'infinito
       * e il sì dell'owner non arriverebbe mai a valere.
       */
      const gia = deps.approvals?.take(
        {
          turnId: ctx.turnId,
          capability,
          ...(request.resource === undefined ? {} : { resource: request.resource }),
        },
        (deps.now ?? (() => new Date()))(),
      );
      if (gia === 'deny') return nega();
      if (gia !== 'allow') {
        if (!deps.approve) {
          // No channel on this surface: the turn stops and says what it wanted,
          // rather than the tool reporting a failure it did not have.
          span.end({ status: 'error', error: 'ask_unavailable' });
          emitToolEnd(true);
          throw new ApprovalRequired(request);
        }

        /**
         * La riga si scrive **prima** di chiedere, e vale sia per chi risponde
         * subito sia per chi risponde domani.
         *
         * Su una superficie a pulsanti l'id viaggia dentro il pulsante, quindi
         * deve esistere prima che il messaggio parta. Sul terminale, dove la
         * risposta è immediata, la riga resta comunque come traccia: i requisiti DAY-1
         * D12 chiede una coda durevole degli ask, e una coda che registra solo
         * le domande scomode non è la coda delle domande.
         */
        const approvalId = deps.approvals?.ask(
          {
            turnId: ctx.turnId,
            capability,
            ...(request.resource === undefined ? {} : { resource: request.resource }),
            prompt: request.prompt,
            taint: request.taint,
          },
          (deps.now ?? (() => new Date()))(),
        );

        const answer = await deps.approve(request, {
          surface: input.surface,
          turnId: ctx.turnId,
          ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
          ...(approvalId === undefined ? {} : { approvalId }),
        });
        span.setAttributes({ 'muffin.policy.approval': answer });

        if (answer === 'unavailable') {
          span.end({ status: 'error', error: 'ask_unavailable' });
          emitToolEnd(true);
          throw new ApprovalRequired(request);
        }

        if (answer === 'asked') {
          if (deps.approvals === undefined || approvalId === undefined) {
            // Una superficie che dice «l'ho chiesto» senza un registro dove la
            // risposta possa tornare avrebbe sospeso il turno su una barriera
            // che nessuno può soddisfare: aspetterebbe la sua scadenza e basta.
            span.end({ status: 'error', error: 'ask_unavailable' });
            emitToolEnd(true);
            throw new ApprovalRequired(request);
          }
          // Armata, non immediata: come ogni sospensione, il loop la onora al
          // prossimo punto di sospensione, quando ogni `tool_use` di questo
          // giro ha il suo `tool_result` (`ToolContext.suspend`).
          ctx.suspend({
            wakeAt: new Date(
              (deps.now ?? (() => new Date()))().getTime() + APPROVAL_WINDOW_MS,
            ).toISOString(),
            waitFor: { kind: 'approval', id: approvalId },
          });
          span.end({ status: 'ok' });
          // Né `✓` né `✗`: la chiamata è ferma sull'owner, e le altre due
          // parole sarebbero tutte e due false (vedi `TurnEvent`).
          input.onProgress?.({ type: 'ask', name: call.name, capability });
          return {
            type: 'tool_result',
            toolCallId: call.id,
            content:
              `Ho chiesto la sua approvazione per "${capability}"${request.resource ? ` su ${request.resource}` : ''} ` +
              `e sto aspettando che risponda. Non l'ho fatto. Non richiederlo e non cercare un'altra strada per farlo ` +
              `lo stesso: il turno si sospende qui e riprende da solo quando arriva la risposta.`,
          };
        }

        // Risposta subito: la riga registra cosa è stato deciso e viene
        // consumata nello stesso momento, o un secondo `sys.shell` più avanti
        // nello stesso turno la troverebbe libera e passerebbe senza chiedere.
        if (deps.approvals !== undefined && approvalId !== undefined) {
          deps.approvals.decide(approvalId, answer, (deps.now ?? (() => new Date()))());
          deps.approvals.take(
            {
              turnId: ctx.turnId,
              capability,
              ...(request.resource === undefined ? {} : { resource: request.resource }),
            },
            (deps.now ?? (() => new Date()))(),
          );
        }
        if (answer === 'deny') return nega();
      }
      break; // approved: fall through to execution below, same as 'allow'
    }
    case 'allow':
      break;
    default:
      return assertNever(decision);
  }

  /**
   * Intent, written **before** the handler can touch the world.
   *
   * This is the half that does not exist today: the loop records the outcome
   * afterwards (the session append below), so an invocation that started and
   * died leaves no trace at all and a restart cannot tell "done" from "maybe
   * done". Two rows make three states — intent+outcome is *done*, intent alone
   * is *maybe done*, neither is *not started*.
   *
   * `rerunnable` is copied from the declaration as it reads right now, not
   * looked up at resume time: what the code says six months from now is not
   * what was true when the effect may have landed. Missing declarations answer
   * `false`, which is the direction that does not re-send a message.
   *
   * Written after the kernel has ruled, because a denied call never reaches the
   * world and an intent row for it would be a lie about what was attempted.
   */
  const decl = deps.capabilities?.get(capability);
  /**
   * Questo turno ha gia fatto questa identica chiamata?
   *
   * Letto **prima** di scrivere l'intento, cosi il conteggio non comprende la
   * riga di adesso e il numero e «quante volte prima», non «quante in tutto».
   *
   * Il guasto, misurato sul `muffin.db` dell'owner il 30/08/2026: il turno
   * a747ae67 (28/08) ha riletto gli stessi file con gli stessi argomenti e ha
   * riavuto risultati byte-identici — 32850, 25537, 46795, 36162, due o tre
   * volte ciascuno. Cinque letture ridondanti, ~141 KB reiniettati, 72 secondi,
   * e 14 chiamate su un tetto di 15: il turno ha speso il proprio budget per
   * rileggere cio che aveva gia.
   *
   * Nello stesso file, poco sopra, sta la misura del 28/08 che diceva
   * l'opposto — «nell'intero store non esiste una sola coppia (tool, args)
   * ripetuta». Era vera quando e stata scritta e non lo e piu: quel commento e
   * stato corretto insieme a questa riga, perche una misura vecchia lasciata
   * in piedi dice al prossimo che qui non c'e niente da guardare.
   *
   * Solo per le capability che lo dichiarano (`progress: 'idempotent_read'`), e
   * l'avviso non fa altro che comparire: non nega, non approva, non tocca il
   * taint. Vale come pavimento e non come soffitto — due chiamate quasi uguali
   * (stessa intenzione, argomenti riscritti) passano indenni, ed e il limite
   * noto di ogni confronto per uguaglianza esatta.
   */
  const giaFatte =
    decl?.progress === 'idempotent_read'
      ? deps.turns.identicalCallsDone(ctx.turnId, call.name, args)
      : 0;
  /**
   * Il registro degli effetti (D15), scritto sulla stessa riga d'intento.
   *
   * Qui e non altrove, e per due ragioni che sono la stessa. La prima: questo
   * è il punto in cui il verdetto del kernel esiste ed è ancora in mano —
   * `decision` è stato calcolato sopra e non sopravvive a questa funzione, e
   * ricostruirlo dopo vorrebbe dire richiamare `check()` su un taint che nel
   * frattempo può essere salito, cioè inventare un secondo verdetto. La
   * seconda: la riga d'intento si scrive **prima** che l'handler tocchi il
   * mondo, quindi un effetto che avviene ha per costruzione i suoi metadata
   * già a terra — un registro scritto dopo perderebbe esattamente le chiamate
   * che sono morte a metà, che sono quelle su cui l'owner ha più bisogno di
   * sapere cosa è passato.
   *
   * `decision.effect` è preso letteralmente e non ricalcolato: `deny` non può
   * arrivare qui (lo `switch` sopra ritorna), quindi ciò che resta è
   * esattamente `allow | draft | ask` — e un `ask` che arriva a questa riga è
   * un `ask` a cui l'owner ha già detto sì, perché il rifiuto e la sospensione
   * ritornano anche loro.
   *
   * La risorsa preferisce `risolto` al valore grezzo: per una scrittura di
   * file il kernel giudica l'argomento del modello (`note.md`) mentre il file
   * che viene toccato è quello che `resolveEffectPath` ha risolto, ed è quello
   * che l'owner cerca quando chiede cosa è stato scritto. `redactText` come su
   * ogni altro sink (ADR-0048): un URL può portarsi dietro un token, e questa
   * riga la rilegge una CLI.
   */
  const effect: EffectMetadata = {
    row: decl?.effect ?? null,
    reversible: decl?.reversible ?? null,
    resource:
      risolto !== undefined
        ? redactText(risolto)
        : resource.kind === 'none'
          ? null
          : redactText(resource.value),
    decision: decision.effect as EffectDecision,
  };
  const intentError = recordIntent(deps, ctx.turnId, span, {
    callId: call.id,
    tool: call.name,
    capability,
    rerunnable: decl?.rerunnable === true,
    args,
    effect,
  });
  if (intentError !== null) {
    // EFFECT WAL, a DAY-1 readiness invariant: the write above did not land, so
    // the handler must not run — a missing intent row has to mean "never
    // started", never "started, but its own receipt got lost". No byte has
    // left this process for this call, so nothing raises taint, and there is
    // no `recordOutcome` here either: there is no intent row for it to close.
    span.end({ status: 'error', error: intentError });
    emitToolEnd(true);
    return {
      type: 'tool_result',
      toolCallId: call.id,
      content: `Intento non registrabile sul record durevole: chiamata non eseguita — ${intentError}`,
      isError: true,
    };
  }

  try {
    // `ctx` carries everything `input.tenant`/`input.principal`/`replyChannel`
    // would have (it is built from exactly those, plus `turnId`, `sessionId`,
    // `taint` and `suspend` — see `toolContext` above), so the handler gets one
    // object with the whole contract rather than two overlapping ones.
    const outcome = await eseguiConRitentativi(
      tool,
      args,
      risolto === undefined ? ctx : { ...ctx, effectPath: risolto },
      decl?.rerunnable === true,
      call.name,
      input.onProgress,
      input.signal,
    );
    // Unconditional. The `!== undefined` guard that used to stand here was the
    // whole defect: it turned "this tool said nothing about provenance" into
    // "this tool brought nothing in". `raiseTaint` only ever raises, so a tool
    // that honestly reports 0 costs the turn nothing.
    //
    // Il nome accanto al numero (ADR-0075 punto 4): quando è *questo* risultato
    // ad alzare il livello, è questo il nome che comparirà nel prompt del
    // prossimo `ask`. Non è un secondo registro — vedi `PermissionSnapshot`.
    snapshot.raiseTaint(outcome.tier, `il risultato di ${call.name}`);
    // The write boundary (owner, 2026-08-17; ADR-0048): every sink a tool
    // result reaches from here — the durable record, the session JSONL, and
    // the `tool_result` that later gets persisted into `turns.messages` by
    // `closeRecord`/checkpoint — reads this one value. Redacting once, here,
    // before any of the three, is provably sufficient (P34-2): none of
    // `endToolCall`, `SessionStore.append` or `TurnStore.finish` transforms
    // `content` again, they store exactly what they are given. This is a
    // best-effort text scan (class 3, `redact.ts`), not the structural
    // guarantee — a backend-known secret never reaches this variable in the
    // first place, because no tool handler ever calls `readSecret`.
    const safeContent = redactText(outcome.content);
    // La provenienza, dalla stessa stringa che finisce nel prompt e nei tre
    // sink: se il modello vedrà questi byte, allora sono entrati nel turno, e
    // un URL copiato da qui non è un URL composto (`DecisionRequest.quoted`).
    // Da `safeContent` e non da `outcome.content`, così ciò che è stato
    // oscurato non può essere «citato» da una richiesta successiva.
    snapshot.recordInput(safeContent);
    /**
     * The failure twin of `giaFatte`, read **before** this call's own row is
     * written — same reason: the count has to mean "how many times before",
     * not "including now". Unlike `giaFatte` it cannot be read before the
     * handler runs, because "identical" here includes this call's own error
     * content (`identicalFailuresDone`'s own comment says why: two failures
     * with the same args can hit different walls, and only a matching
     * `content` says they are the same wall). `0` on a success, since there
     * is nothing to compare.
     */
    const fallimentiIdentici =
      outcome.isError === true
        ? deps.turns.identicalFailuresDone(ctx.turnId, call.name, args, safeContent)
        : 0;
    // The outcome and the taint it dragged in, in one transaction: a tier-3
    // result raises the turn's taint, and the two facts must not be able to
    // land apart — a record that had read the web at a tier saying it had not
    // is the privilege escalation this table exists to prevent.
    //
    // `ctx.turnId`, not `parent.traceId`: they agree on a fresh turn, but on a
    // **resumed** one the span is a child of a remote parent, so its trace id
    // names the trace and not the row (ADR-0047 §Reversibilità). And with
    // `tier` required on `ToolOutcome` (ADR-0044) the row can no longer be
    // written with the tier absent, which is the version of that same argument
    // one level down: a resumed turn cannot inherit a provenance nobody stated.
    recordOutcome(deps, ctx.turnId, span, call.id, {
      content: safeContent,
      isError: outcome.isError === true,
      tier: outcome.tier,
    });
    deps.sessions.append(input.session, {
      role: 'tool',
      content: safeContent,
      toolCallId: call.id,
      toolName: call.name,
      surface: input.surface,
      createdAt: (deps.now ?? (() => new Date()))().toISOString(),
      traceId: parent.traceId,
      // The outcome's own declared provenance — not reinjected as history by
      // `buildContext` today (it filters to user/assistant only), set anyway
      // so the row is never a silent "clean" for whatever reads it next.
      tier: outcome.tier,
    } satisfies SessionMessage);
    span.end({ status: outcome.isError ? 'error' : 'ok' });
    emitToolEnd(outcome.isError === true);
    if (giaFatte > 0 && outcome.isError !== true) {
      span.setAttributes({ 'muffin.tool.repeated': giaFatte });
    }
    if (fallimentiIdentici > 0) {
      span.setAttributes({ 'muffin.tool.repeated_failure': fallimentiIdentici });
    }
    return {
      type: 'tool_result',
      toolCallId: call.id,
      /**
       * L'avviso viaggia con il risultato, e **solo** con il risultato.
       *
       * `recordOutcome` e `sessions.append` qui sopra hanno gia ricevuto
       * `safeContent`: la riga durevole di `turn_tool_calls` e la sessione
       * restano quello che il tool ha davvero detto. Un avviso scritto li
       * dentro sarebbe testo che il tool non ha prodotto, in un registro il
       * cui unico compito e dire cosa ha prodotto.
       *
       * Attaccato al risultato e non spedito come messaggio a parte perche un
       * messaggio a parte non e trasportabile: sul percorso openai-compat il
       * testo di un messaggio utente viene emesso **prima** dei suoi
       * `tool_result` (`agent/providers/openai-compat.ts`), quindi finirebbe
       * fra la chiamata dell'assistente e le sue risposte — che quel protocollo
       * non ammette. Qui invece e dove il modello sta gia guardando.
       *
       * I due avvisi sono a esclusione reciproca per costruzione: `giaFatte`
       * conta solo righe con `is_error = 0`, `fallimentiIdentici` solo righe
       * con `is_error = 1`, e questa stessa chiamata e o l'uno o l'altro.
       */
      content:
        giaFatte > 0 && outcome.isError !== true
          ? `${safeContent}\n\n${avvisoRipetizione(call.name, giaFatte)}`
          : fallimentiIdentici > 0
            ? `${safeContent}\n\n${avvisoFallimentoRipetuto(call.name, fallimentiIdentici)}`
            : safeContent,
      ...(outcome.isError ? { isError: true } : {}),
    };
  } catch (error) {
    // A failing tool is information for the model, not a crash for the turn.
    // Redacted for the same reason and at the same boundary as the success
    // path above: an error can carry a header or a query string right back
    // out (`http_get` against a URL the model built), and this is the one
    // point that covers the durable record, the session and `turns.messages`
    // for the failure exit too.
    const detail = redactText(error instanceof Error ? error.message : String(error));
    // Same counter as the success path's error exit, read before this call's
    // own row lands, for the same reason: `identicalFailuresDone` compares
    // `content` too, and `detail` is this call's content.
    const fallimentiIdentici = deps.turns.identicalFailuresDone(
      ctx.turnId,
      call.name,
      args,
      detail,
    );
    // Unconditional, and the same call the success path makes a few lines up
    // — a judge's round-1 finding was that this branch never raised taint at
    // all, so a handler that threw was invisible to the ledger no matter whose
    // words `detail` carried. `tool.throwTier` is this tool's own declared
    // answer for its failure exit, the same way `outcome.tier` is its answer
    // for success; neither is guessed here.
    snapshot.raiseTaint(tool.throwTier, `l'errore di ${call.name}`);
    // And an outcome all the same: a handler that threw *came back*, so the
    // call is decided, not uncertain. Leaving the intent row open here would
    // make every failed tool call look like one that might still have landed.
    // `ctx.turnId` for the same reason as the success path above; `tier:
    // tool.throwTier`, never `undefined` — the record and the taint it
    // produced must agree, exactly as ADR-0044 requires of the success path.
    recordOutcome(deps, ctx.turnId, span, call.id, {
      content: detail,
      isError: true,
      tier: tool.throwTier,
    });
    span.end({ status: 'error', error: detail });
    emitToolEnd(true);
    if (fallimentiIdentici > 0) {
      span.setAttributes({ 'muffin.tool.repeated_failure': fallimentiIdentici });
    }
    return {
      type: 'tool_result',
      toolCallId: call.id,
      content:
        fallimentiIdentici > 0
          ? `${detail}\n\n${avvisoFallimentoRipetuto(call.name, fallimentiIdentici)}`
          : detail,
      isError: true,
    };
  }
}

/**
 * The write-ahead half — a gate now, not a courtesy.
 *
 * This used to swallow the failure the same way `checkpoint` swallows its
 * own, on the reasoning that a tool which goes on to work must not be turned
 * into a failed turn by a bookkeeping write. That reasoning missed what a lost
 * write actually costs here: with the handler left free to run anyway, a
 * missing intent row stopped meaning "never started" and started meaning
 * "started, but its own receipt did not survive" — for a non-rerunnable tool,
 * exactly the ambiguity this row exists to remove (ADR-0042). DAY-1 readiness
 * names this property "EFFECT WAL": no side effect may start unless its
 * intent is durable first, and "I tried to record it and carried on anyway"
 * does not satisfy that. So the failure is returned instead, and the caller
 * below refuses the call rather than guess which way is safe to fail.
 */
/**
 * L'avviso, in italiano e in una riga: e testo per il modello, non un log.
 *
 * Dice il numero perche «di nuovo» e «per la terza volta» chiedono due cose
 * diverse, e nomina l'uscita — cambiare argomenti o rispondere — perche un
 * avviso senza una via d'uscita e solo rumore in mezzo a un risultato.
 */
function avvisoRipetizione(tool: string, giaFatte: number): string {
  const volte = giaFatte === 1 ? 'una volta' : `${giaFatte} volte`;
  return (
    `[in questo turno hai gia chiamato \`${tool}\` ${volte} con gli stessi argomenti, ` +
    `e la risposta e la stessa. Se ti serve altro cambia argomenti; altrimenti rispondi con quello che hai.]`
  );
}

/**
 * La meta gemella per il fallimento — stessa forma, non lo stesso testo.
 *
 * Non ripete l'errore: il tool l'ha gia detto nel contenuto appena sopra
 * questo avviso, e ridirlo sarebbe rumore che nasconde l'unica cosa che
 * l'avviso deve aggiungere — che e gia successo, e cosa lo farebbe smettere.
 */
function avvisoFallimentoRipetuto(tool: string, fallimentiIdentici: number): string {
  const volte = fallimentiIdentici === 1 ? 'una volta' : `${fallimentiIdentici} volte`;
  return (
    `[in questo turno hai gia chiamato \`${tool}\` ${volte} con gli stessi argomenti e hai gia avuto ` +
    `questo stesso errore. Ripetere non lo cambia: cambia argomenti, prova un'altra via, o fermati e ` +
    `spiega il blocco invece di riprovare.]`
  );
}

function recordIntent(
  deps: LoopDeps,
  turnId: string,
  span: SpanHandle,
  call: {
    callId: string;
    tool: string;
    capability: string;
    rerunnable: boolean;
    args: unknown;
    effect: EffectMetadata;
  },
): string | null {
  try {
    deps.turns.startToolCall(turnId, call);
    return null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    span.setAttributes({ 'muffin.turn.record_error': detail });
    return detail;
  }
}

/**
 * The outcome write — failure still swallowed, deliberately asymmetric with
 * `recordIntent` above. A tool that already worked must not be turned into a
 * failed turn by a bookkeeping write on the way out, and what a lost write
 * costs here is stated where it lands: a missing outcome row reads as "maybe
 * done" (the resume is too careful, which is the harmless direction) —
 * never as "not started", which would be the false reading.
 */
function recordOutcome(
  deps: LoopDeps,
  turnId: string,
  span: SpanHandle,
  callId: string,
  // `tier` is never `undefined` at either call site any more (ADR-0044's own
  // field on success, `throwTier` on the catch path below) — narrowed to match
  // so a third call site could not reintroduce the omission silently.
  result: { content: string; isError: boolean; tier: TrustTier },
): void {
  try {
    deps.turns.endToolCall(turnId, callId, result);
  } catch (error) {
    span.setAttributes({
      'muffin.turn.record_error': error instanceof Error ? error.message : String(error),
    });
  }
}
