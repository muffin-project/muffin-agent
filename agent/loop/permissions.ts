import type { Decide, DecisionRequest, Decision, PermissionSnapshot, Principal, TenantId, TrustTier } from '../../core/policy/types.js';
import type { CapabilityDecl } from '../../core/policy/types.js';
import { tierOf } from '../../core/surface/types.js';
import type { TurnInput } from './types.js';

/**
 * The kernel-facing half of the loop, moved out of `agent/loop.ts` in pure
 * form: how much of the budget a resume spends, a turn's starting taint, the
 * refusal text the model reads, the kernel's own resource lookup, and the
 * permission snapshot itself (`makeSnapshot`/`citato`). See `agent/loop.ts`'s
 * own module docstring for what the loop is.
 */

/**
 * Questa ripresa spende il budget, o no?
 *
 * `MAX_RESUMES` e un circuit breaker su una **recovery che continua a uccidere
 * il processo**, non un tetto a quante volte un turno lungo puo legittimamente
 * aspettare. `resumed` da solo non lo distingue: dice «questo turno era gia
 * partito», che e vero tanto per un crash quanto per un `wait` andato a buon
 * fine. Misurato in dogfood il 29/08/2026: un turno che aspetta quattro volte
 * muore col messaggio dei crash, e all owner quel turno non e mai andato storto
 * — ha solo aspettato lui.
 *
 * `wokenFromWait` e il discriminante, e viaggia gia fin qui per un altro
 * motivo: la barriera (`waitFor`/`wakeAt`) e ancora sulla riga quando la si
 * legge, perche e `claim` a spegnerla. Un timer e un'approvazione la scrivono
 * entrambi, quindi copre tutte e due le sospensioni volute.
 *
 * **Il bound resta un bound**, ed e la parte da leggere due volte prima di
 * toccarla: una riga uccisa mentre girava torna `interrupted`, senza barriera,
 * quindi ogni recovery paga come prima e il contatore resta **monotono**
 * attraverso i crash. E la ragione per cui questa e una regola qui e non un
 * `resumes: 0` dentro `TurnStore.suspend` (la forma proposta in #241):
 * azzerare a ogni sospensione riuscita cancella anche l'evidenza dei crash che
 * stanno in mezzo, e un turno che alterna sospensione e crash non scatterebbe
 * mai. `agent/resume-checkpoint-budget.test.ts` tiene ferme tutte e due le
 * meta, e la seconda muore se si reintroduce quell'azzeramento.
 *
 * E la stessa semantica dei runtime di durable execution, dove il tetto ai
 * tentativi conta i **fallimenti**: timer e signal sospendono senza consumarlo
 * (Temporal, retry policies — "maximum number of execution attempts *in the
 * presence of failures*").
 *
 * Perche non riusare `resumed` restringendolo: quel flag ha un secondo
 * consumatore, la riparazione del transcript (`else if (options.resumed ===
 * true)`), che ricuce un `tool_use` rimasto senza `tool_result` ed emette il
 * rapporto di risveglio. Sono due domande diverse — «questo turno riparte» e
 * «questa ripresa e sospetta» — e collassarle su un flag solo fa saltare la
 * riparazione a ogni risveglio voluto. Provato: restringere `resumed` rende
 * rossi cinque test fra `suspend-resume`, `approvazione-differita` e
 * `lane-wiring`.
 */
export function spendeIlBudget(resumed: boolean, wokenFromWait: boolean): boolean {
  return resumed && !wokenFromWait;
}

/**
 * `max(the principal's own tier, whatever content-taint the caller measured)`
 * — the one formula `enqueueTurn`, `runTurn` and the episode/session writes
 * inside `drive` all have to agree on. Before `TurnInput.contentTaint`
 * existed the four of them each wrote `principal.kind === 'member' ? 2 : 0`
 * separately (`core/surface/types.ts`'s own `tierOf` docstring already named
 * the risk of a fourth copy); a fifth copy here would have been exactly the
 * kind of seam a forwarded message could land on the wrong side of, at
 * whichever one of the four someone forgot to update.
 */
export function initialTaint(input: TurnInput): TrustTier {
  const base = tierOf(input.principal);
  const content = input.contentTaint ?? 0;
  return content > base ? content : base;
}

/**
 * The sentence the model reads when the kernel refuses.
 *
 * Until 2026-09-02 every refusal said the same thing — «serve una decisione
 * dell'owner» — and for `taint_exceeded` that sentence is false: no approval
 * exists at runtime for a ceiling the turn's taint has already crossed, and
 * the owner cannot grant one. The dogfood review of 2026-08-29
 * (`docs/evidence/dogfood-autonomia-2026-08-29.md` §9, item 1) ordered this
 * first, and the owner's database shows the price of leaving it: episode 310,
 * where the model explained a refusal as «è la policy, non un bug» and sent
 * the owner to look for a setting that does not exist. A refusal names its
 * cause, says what would change it, and never promises a permission.
 */
export function denyText(decision: Extract<Decision, { effect: 'deny' }>): string {
  if (decision.code === 'taint_exceeded') {
    return (
      `Rifiutato dal kernel dei permessi (taint_exceeded): ${decision.detail ?? 'il taint del turno supera il soffitto'}. ` +
      "Nessuna approvazione lo sblocca in questo turno: non chiedere all'owner un permesso che non esiste. " +
      'Dillo, e se serve davvero spiega che una conversazione nuova riparte con il contesto pulito.'
    );
  }
  return `Rifiutato dal kernel dei permessi (${decision.code}). Non insistere: serve una decisione dell'owner.`;
}

/**
 * The resource the kernel will decide on, taken from the capability's own
 * declaration rather than guessed from argument names.
 *
 * The guess was a second, divergent copy of something the declarations already
 * carried: `resourceKind` says what kind of thing this capability acts on and
 * `policyArgs` says which argument holds it. Both were documented as *the*
 * mechanism and read by nobody, while the loop hardcoded `path` then `url` —
 * and two places doing one job had already diverged. `outward.send` declares
 * `policyArgs: ['to']`, which the hardcoded chain would never have read, so the
 * highest-risk capability in the matrix was going to arrive with a gate that
 * silently did not fire.
 *
 * `url`, `path` and `query` are lifted. `query` joined the other two so that
 * `sys.search` could stop declaring `resourceKind: 'none'` — the mechanism
 * this function already provides needed no new case, only a wider guard
 * (mandato inv. 7, P04-2). `url-read` (ADR-0066, `sys.http`) is the same
 * shape as `url` — a string argument naming the resource — and needs no new
 * case either, only the same wider guard. A `tenant` resource is not in the
 * args — it is the turn's tenant — and inventing one here would change what
 * the kernel decides for every memory read.
 */
export function resourceFor(
  decl: CapabilityDecl | undefined,
  args: Record<string, unknown>,
): DecisionRequest['resource'] {
  if (
    !decl ||
    (decl.resourceKind !== 'url' &&
      decl.resourceKind !== 'url-read' &&
      decl.resourceKind !== 'path' &&
      decl.resourceKind !== 'query')
  ) {
    return { kind: 'none' };
  }
  for (const name of decl.policyArgs) {
    const value = args[name];
    if (typeof value === 'string') return { kind: decl.resourceKind, value };
  }
  // Declared but absent. Returning `none` is deliberate: for a url capability
  // the kernel now refuses on exactly this, which is the visible failure.
  return { kind: 'none' };
}

/**
 * `from` is the turn's recorded taint, and it is a parameter rather than a
 * derivation for the reason ADR-0042 gives: a resume that rebuilt the taint
 * from the principal would restart at tier 0 a turn that had already
 * downloaded a web page — the fetch-then-act pattern the kernel exists to
 * close, reopened by a new door. On a fresh turn it equals what the old
 * derivation produced, which is exactly why deriving it looked safe for as long
 * as nothing resumed.
 */
export function makeSnapshot(
  decide: Decide,
  principal: Principal,
  tenant: TenantId,
  from: TrustTier,
): PermissionSnapshot {
  // Taint starts from where the record says the turn had climbed to; on a turn
  // that has not started, that is who is speaking. From M2 the recall raises it
  // too, and a tool result raises it further — monotonically, never down.
  let taint: TrustTier = from;
  /**
   * Il nome di ciò che ha portato il turno al livello che `taint` riporta —
   * ADR-0075 punto 4, letto dal prompt di ogni `ask`.
   *
   * Parte da `null` e non da una frase su `from`: il livello con cui un turno
   * *nasce* è chi sta parlando o il contenuto che gli è stato spedito, e non
   * c'è nessuna «parte che l'ha alzato» da nominare. Il primo `raiseTaint` che
   * lo supera scrive la sua.
   */
  let origine: string | null = null;
  /**
   * The ceiling, minus whatever `raiseCeiling` alone contributed — ADR-0044
   * §Riconciliazione 2026-08-28. Starts equal to `taint`: a fresh turn's own
   * `from` (its principal, or the content it was sent) is intrinsic to it by
   * construction, and so is a resumed turn's — a crash mid-turn does not get to
   * un-happen whatever this turn itself had already climbed to before it died.
   */
  let intrinsic: TrustTier = from;
  const cache = new Map<string, ReturnType<Decide>>();
  /**
   * Tutto ciò che è **entrato** in questo turno: il messaggio della persona e
   * i risultati dei tool. Mai l'output del modello — vedi
   * `DecisionRequest.quoted`: se il testo che il modello produce contasse
   * come provenienza, basterebbe scrivere un URL e citarlo un passo dopo per
   * lavarlo, e il criterio non proverebbe piu' niente.
   *
   * Un array e non un `Set`: la domanda non e' «e' uguale a» ma «e' contenuto
   * in», perche' un URL vive dentro una pagina, non da solo.
   */
  const ingressi: string[] = [];
  /**
   * Questi byte erano gia' qui prima che il modello scrivesse?
   *
   * Confronto letterale, di proposito. Una versione tollerante (normalizzare
   * l'escaping, riordinare i parametri) allargherebbe la finestra a cose che
   * *somigliano* a un ingresso, ed e' esattamente il posto dove un aggressore
   * lavora. Un falso negativo qui costa un'approvazione in piu'; un falso
   * positivo aprirebbe il canale che questo gate esiste per chiudere.
   */
  const citato = (valore: string): boolean =>
    valore !== '' && ingressi.some((testo) => testo.includes(valore));
  return {
    principal,
    tenant,
    currentTaint: () => taint,
    intrinsicTaint: () => intrinsic,
    taintOrigin: () => origine,
    raiseTaint(tier, origin) {
      if (tier > taint) {
        taint = tier;
        // L'etichetta cambia **solo** quando cambia il numero: è ciò che le
        // impedisce di raccontare una provenienza che non è quella per cui il
        // turno è gated adesso. Una salita senza nome cancella un nome vecchio
        // che sarebbe diventato falso — meglio nessuna ragione che una
        // sbagliata (ADR-0075 punto 4).
        origine = origin ?? null;
        cache.clear(); // decisions taken at a lower taint no longer apply
      }
      if (tier > intrinsic) intrinsic = tier;
    },
    raiseCeiling(tier, origin) {
      if (tier > taint) {
        taint = tier;
        origine = origin ?? null;
        cache.clear();
      }
      // `intrinsic` is deliberately left alone: this is exactly the raise that
      // must not reach it.
    },
    invalidate: () => cache.clear(),
    recordInput(text) {
      if (text !== '') ingressi.push(text);
    },
    check(capability, resource, args) {
      const quoted = 'value' in resource && citato(resource.value);
      // `quoted` sta nella chiave: la provenienza puo' solo crescere durante
      // un turno, quindi una decisione presa quando quei byte non erano
      // ancora arrivati non deve sopravvivere al momento in cui arrivano.
      const key = `${capability}:${resource.kind}:${'value' in resource ? resource.value : ''}:${taint}:${quoted}`;
      const cached = cache.get(key);
      if (cached) return cached;
      const decision = decide({ principal, tenant, capability, resource, args, taint, quoted });
      cache.set(key, decision);
      return decision;
    },
  };
}

