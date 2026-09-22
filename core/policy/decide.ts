import { denyListCovers, grantedTo, type PolicyMatrix } from './matrix.js';
import { DOORS } from './doors.js';
import type {
  CapabilityDecl,
  CapabilityId,
  Decide,
  Decision,
  DecisionRequest,
  EffectRow,
  Principal,
  TrustTier,
} from './types.js';

/**
 * The policy kernel: one place, deterministic, in code.
 *
 * Every capability request passes through here — tools, scheduled jobs, the
 * dev capability, rendering. A capability without a declaration does not exist
 * for the runtime. See docs/decisions/0013-kernel-permessi-unificato.md.
 */

export type PolicyContext = {
  capabilities: ReadonlyMap<CapabilityId, CapabilityDecl>;
  /**
   * The permission matrix, loaded from `rot/policy.json` where this context is
   * built (`agent/runtime.ts`) — never from here, so a decision stays pure and
   * synchronous and is explainable from a snapshot.
   *
   * Required, not optional with a default. Every one of these numbers used to
   * be a `const` in this file, and a matrix that quietly reappears when the
   * wiring is forgotten is how the file it comes from went unread for months.
   * Tests pass `POLICY_FLOOR`, which is those same constants under their own
   * name; production that forgets does not compile.
   *
   * On the ceiling: it comes from `matrix.rows[decl.effect]`, and a
   * declaration's own `maxTaint` may only narrow it (ADR-0053). The paragraph
   * that stood here until 2026-09-02 described the opposite arrangement — a
   * class default a declaration could widen in both directions — and that
   * arrangement is exactly what let the kernel and the threat model's printed
   * matrix disagree, one capability at a time, for a month. `defaultMaxTaint`
   * is still on `PolicyMatrix` and is read by nothing here.
   */
  matrix: PolicyMatrix;
  /**
   * Budget check, injected so the kernel stays pure and synchronous.
   *
   * It takes the tenant because there are two caps and the kernel has to be
   * able to ask about both. The nullary version could only ever ask the global
   * one, which meant a group tenant's daily ceiling was unreachable from here —
   * not unwired, *unaskable*, which is the version of this defect that survives
   * someone noticing it.
   */
  budgetExhausted: (tenant: string) => boolean;
  /**
   * Whether the Root of Trust is owned by another OS user, so tampering is
   * prevented and not merely detected (`core/rot/verify.ts`).
   *
   * **Since ADR-0074 nothing in this file reads it, and that is deliberate
   * rather than an oversight left to rot.** It used to buy the one shortcut
   * that could skip an approval entirely — `hardened && owner && taint === 0`
   * auto-allowed a high-risk capability — and the ADR removed it: that flag
   * answers *who may rewrite the rules*, not *can this command be undone*. A
   * hardened install and a single-user one now get the same verdict for the
   * same action, which is the point.
   *
   * It stays on the context, still required, still wired from
   * `agent/runtime.ts`, for two reasons and no third: the RoT mode is a real
   * fact this snapshot should carry (a decision must be explainable from it,
   * and "was prevention real when this ran" belongs in that explanation), and
   * ADR-0074 point 4 — the read-only shell — is a different slice that will
   * need to know whether the sandbox boundary is enforced. If that slice does
   * not use it, delete the field there rather than leaving a knob that decides
   * nothing.
   */
  hardened: boolean;
  /**
   * The root of trust diverged and we are running degraded. Everything above
   * low risk is refused until the owner reseals — which is what the CLI has
   * always told the user, and until now was the only claim in this system that
   * the code did not back.
   */
  safeMode?: boolean;
  /**
   * The egress allowlist from `rot/egress.json`, as a predicate. Optional in
   * the type so tests can build a minimal context — but ABSENT means nothing
   * is allowed, not everything: a runtime that forgets to wire it gets a
   * kernel that asks for every URL, which is the failure mode you notice.
   *
   * Consulted only for a `url` resource — reaching a host to **act**. A
   * `url-read` resource (`sys.http`, GET-only) never calls this: ADR-0066
   * decided that fetching a public page is not the same authority as acting
   * on one, and left it open. This predicate's absence is still fail-closed
   * for the capability it does govern.
   */
  egressAllowed?: (host: string) => boolean;
};

function isOwnerPrincipal(p: Principal): boolean {
  return p.kind === 'owner';
}

function tenantOf(p: Principal): string | null {
  if (p.kind === 'member') return p.tenantId;
  if (p.kind === 'owner' || p.kind === 'agent') return 'host';
  return null; // system principals act within the tenant they were armed for
}

function ask(prompt: string): Decision {
  return { effect: 'ask', ask: { audience: 'owner', prompt } };
}

export function createDecide(ctx: PolicyContext): Decide {
  /**
   * The kernel's own vocabulary, consulted **under** whatever the runtime
   * declared — a fallback, never a merge.
   *
   * The two doors (`doors.ts`) are not tools a feature registers: they are the
   * acts the loop performs by itself — answering, remembering — and the kernel
   * has to be able to rule on them wherever it is built, a test harness with
   * three declarations included. A runtime that had to remember to register
   * them would answer `no_capability` on every reply the day it forgot; a
   * kernel that owns them cannot forget. A caller's own declaration under the
   * same id still wins, so a harness can tighten a door on purpose.
   *
   * **`ctx.capabilities` is read live, on every request, and copying it is a
   * defect.** `agent/runtime.ts` hands the same `Map` to `createDecide` and to
   * `Runtime.register`, which mutates it: every MCP tool, and every tool a
   * test registers after boot, is declared *after* this function ran. A
   * snapshot taken here makes the kernel answer `no_capability` to all of
   * them — which is what the first draft of this door did, and what
   * `agent/todo-wiring.test.ts` and `agent/crash-resume.test.ts` caught.
   */
  const doors = new Map<CapabilityId, CapabilityDecl>(DOORS.map((d) => [d.id, d]));
  return function decide(req: DecisionRequest): Decision {
    const { principal, tenant, capability, resource, taint } = req;

    const decl = ctx.capabilities.get(capability) ?? doors.get(capability);
    if (!decl) {
      return { effect: 'deny', code: 'no_capability', detail: `undeclared capability: ${capability}` };
    }

    // Before anything else that could allow: a diverged root of trust means the
    // rules themselves are in question, so this is not the moment to apply them
    // generously.
    if (ctx.safeMode === true && decl.risk !== 'low') {
      return {
        effect: 'deny',
        code: 'safe_mode',
        detail: `root of trust diverged: "${capability}" is ${decl.risk} risk — \`muffin rot verify\``,
      };
    }

    if (denyListCovers(ctx.matrix.neverAtRuntime, capability)) {
      return {
        effect: 'deny',
        code: 'rot_violation',
        detail: 'the root of trust has no runtime write path; change it via repo and restart',
      };
    }

    // Guard against a caller assembling an incoherent request.
    const expected = tenantOf(principal);
    if (expected !== null && expected !== tenant) {
      return { effect: 'deny', code: 'tenant_mismatch', detail: `${expected} != ${tenant}` };
    }

    /**
     * host-only excludes *remote tenants*, not autonomous local principals: the
     * scheduler runs on the host. Denying it here would have hidden the queueing
     * rule below behind a wrong refusal.
     *
     * **`&& !grantedTo(...)` è tutta ADR-0073 nel kernel.** Fino al 06/09 la
     * riga finiva un carattere prima, e con essa finiva la sola dimensione
     * disponibile: `hostOnly` è una proprietà della *capability*, quindi
     * l'unico modo di dare qualcosa a una stanza era toglierlo a `host` per
     * tutte le stanze insieme. Il grant sposta la domanda dove l'owner può
     * rispondere per nome — questa stanza, questa capability, scritto nel
     * sigillo — senza che nient'altro del kernel si muova: soffitti,
     * ADR-0071 (composto + non-owner → deny), ADR-0072, ADR-0074, ADR-0075
     * sono tutti *sotto* questa riga e la attraversano identici. Una stanza
     * con grant su `sys.search` resta soggetta a `gateParams` e a
     * `perTenantDailyUsd`; una stanza con grant su `vault.write` resta
     * soggetta a `budgetExhausted` e a `safeMode`.
     *
     * `tenant` e non `principal.tenantId`: sono lo stesso valore per
     * costruzione (il controllo `tenant_mismatch` sopra è già passato), e
     * leggere quello della *richiesta* è ciò che rende impossibile a un
     * chiamante di nominare una stanza diversa da quella per cui il principal
     * è stato risolto.
     *
     * La mutazione che deve far cadere una prova per stanza: cancellare il
     * `&& !grantedTo(...)`. Allora un membro di una stanza **con** grant
     * riceve `principal_forbidden` su `vault.write`, e
     * `core/policy/solo-irreversibile.test.ts (describe «una stanza con grant»)` lo dice con il nome della
     * capability.
     */
    if (decl.hostOnly && principal.kind === 'member' && !grantedTo(ctx.matrix, tenant, capability)) {
      return { effect: 'deny', code: 'principal_forbidden', detail: 'host-only capability' };
    }

    if (principal.kind === 'system' && denyListCovers(ctx.matrix.forbiddenForSystem, capability)) {
      return { effect: 'deny', code: 'principal_forbidden', detail: 'not available to autonomous principals' };
    }

    // The ceiling comes from the capability's **effect row** — where the bytes
    // land — and not from its risk class. ADR-0053: the risk class default was
    // a per-capability knob, and widening it one capability at a time is how
    // the kernel and the threat model's printed matrix stopped agreeing on the
    // row that reads `ASK` at taint 2. A declaration may still tighten its own
    // row and never widen it; `core/policy/effect-rows.test.ts` asserts every
    // shipped cell against the document.
    const row = ctx.matrix.rows[decl.effect];
    const ceiling = Math.min(row.denyAbove, decl.maxTaint ?? 3);
    if (taint > ceiling) {
      /**
       * **ADR-0075 punto 3: verso l'esterno il taint chiede all'owner e nega
       * agli altri.**
       *
       * Sopra il soffitto delle due righe che portano byte *fuori dal tenant*
       * — `external` (codice di terzi) e `outward` (un destinatario nuovo) —
       * il muro era la forma sbagliata per l'unico principal che può
       * rispondere: a taint 3 l'owner non poteva nemmeno chiedere «cerca X e
       * mandalo a Y», che è la richiesta più ordinaria che esista. È la
       * stessa forma di `gateParams` (ADR-0071) per i parametri composti: la
       * decisione resta a chi può prenderla, e resta una decisione, perché i
       * byte usciti non tornano.
       *
       * Per chiunque altro il ramo non si muove di un carattere. In un gruppo
       * un `ask` non raggiunge nessuno che possa rispondere, quindi degradare
       * il divieto a domanda lì non sarebbe una difesa: sarebbe un `allow`
       * scritto in un'altra lingua. Stessa asimmetria, stessa ragione, di
       * `gateParams`.
       *
       * Le altre righe restano com'erano: `host` non arriva più qui (il suo
       * soffitto è 3 da ADR-0075), `config` e `rot` negano — la seconda con
       * `denyAbove: -1`, cioè a qualunque taint e per chiunque — e un
       * soffitto **ristretto da un `policy.json` sigillato o da un
       * `maxTaint`** nega esattamente come prima, perché è la riga a
       * decidere il ramo e non il numero.
       */
      const chiedeSopraIlSoffitto = decl.effect === 'external' || decl.effect === 'outward';
      if (chiedeSopraIlSoffitto && isOwnerPrincipal(principal)) {
        // «taint N» e non la frase intera: la *ragione* in parole («questo
        // turno contiene contenuto di livello 3: il risultato di web_search»)
        // la aggiunge il loop, che è l'unico posto dove si sa **quale parte**
        // ha alzato il livello (`PermissionSnapshot.taintOrigin`). Il kernel
        // dice il numero, che è tutto ciò che vede da un solo snapshot.
        return ask(`taint ${taint}: ${describe(capability, resource, decl.effect)}`);
      }
      return {
        effect: 'deny',
        code: 'taint_exceeded',
        detail: `context taint ${taint} exceeds ${ceiling} for ${capability} (${decl.effect})`,
      };
    }

    if (decl.risk !== 'low' && ctx.budgetExhausted(tenant)) {
      return { effect: 'deny', code: 'budget_exhausted' };
    }

    // Egress. ADR-0066 splits what used to be one branch into two authorities
    // over the same shape of resource: `url` is reaching a host to **act** —
    // write, execute, send — and answers to the allowlist in the root of trust
    // (03 §3, riga egress) exactly as before. `url-read` is fetching bytes from
    // a public page — `sys.http` is GET-only by construction — and reading is
    // not the same authority as acting: the owner decided the allowlist should
    // not gate it at all. Both still answer to `paramsMaxTaint` below, because
    // the bytes the model puts in a query string are exactly as chosen either
    // way, and both still fail closed on a resource mismatch, for the same
    // reason the single branch used to: a caller that produced anything else
    // used to skip the gate entirely and fall through to the risk class —
    // measured as `http_get({url, path:'x'})` fetching an off-allowlist host
    // for a taint-2 group member, deny without the extra key, allow with it.
    if (decl.resourceKind === 'url' || decl.resourceKind === 'url-read') {
      if (resource.kind !== decl.resourceKind) {
        return {
          effect: 'deny',
          code: 'resource_denied',
          detail: `${capability} declares a ${decl.resourceKind} resource but received ${resource.kind} — refusing rather than skipping the gate`,
        };
      }
      const host = hostOf(resource.value);
      if (host === null) {
        return { effect: 'deny', code: 'resource_denied', detail: `unparseable url` };
      }
      // The allowlist speaks only for `url` — reaching a host to act on it.
      // Off the list, the owner in a clean context gets asked, everyone and
      // everything else is refused: a tainted turn must not be able to
      // *nominate* the exfiltration endpoint, which is exactly what
      // ask-then-approve would let a poisoned context do at 2am. `url-read`
      // never reaches this: there is no list to be off of, by decision — the
      // SSRF floor under it (`core/net/egress.ts#isForbiddenAddress`, DNS-
      // resolved, enforced by the tool on every hop) is what stands between an
      // open read and the machine's own network.
      if (decl.resourceKind === 'url') {
        const allowed = ctx.egressAllowed?.(host) ?? false;
        if (!allowed) {
          if (isOwnerPrincipal(principal) && taint <= 1) {
            return ask(`egress fuori allowlist: ${host}`);
          }
          return {
            effect: 'deny',
            code: 'resource_denied',
            detail: `${host} is not in the egress allowlist (taint ${taint})`,
          };
        }
      }
      // The allowlist (or, for `url-read`, the open destination) only ever
      // says something about the HOST, so a turn that had read tier-2+
      // content could still put those bytes in the query string or fragment
      // and nothing here noticed (audit 2026-08-16, P04-1). A clean
      // destination is not the same claim as a clean request: the model chose
      // everything after it.
      // Lane #624 + #641 (2026-09-22) closed the two halves that were left:
      // the pathname was never inspected at all (an explicitly declared open
      // hole since ADR-0066 — `https://evil/<segreto>` met no gate), and the
      // ceiling sat at 2, so tier-2 disk content — attacker-influenced by the
      // current threat model, not owner-authored — composed query/fragment
      // bytes silently. `hasComposedBytes` now covers every canonical URL
      // component the model chooses and the wire carries: path, userinfo,
      // query, and fragment. The fragment is gated conservatively even though
      // the transport drops it before connect (`agent/tools/http.ts`
      // sends `pathname + search` only): the policy must not use a
      // representation that disagrees with what leaves, in either direction.
      // Userinfo rides the wire as the request's credentials, so it gates
      // with the rest. A bare host (`https://h`, `https://h/`) carries no
      // model-chosen bytes and stays silent — reading is still open.
      if (hasComposedBytes(resource.value)) {
        const gated = gateParams(
          principal,
          taint,
          ctx.matrix.paramsMaxTaint,
          decl.resourceKind === 'url-read'
            ? `lettura con parametri scelti dal contenuto: ${resource.value}`
            : `egress con parametri verso host allowlisted: ${resource.value}`,
          // Solo qui, e solo sull'URL **intero**. Un aggressore che
          // concatena un suo prefisso con byte letti altrove non produce una
          // stringa che era già presente; uno che pubblica l'URL completo
          // conosceva già ciò che ci ha messo dentro.
          req.quoted === true,
        );
        if (gated) return gated;
      }
    }

    // `sys.search`'s destination is a constant checked once at registration —
    // there is no host here for the allowlist above to hold against — but the
    // query text is exactly as model-controlled as a URL's query string, and
    // until now it never reached this file at all: `resourceKind: 'none'`
    // meant the egress branch above never even ran (audit 2026-08-16, P04-2).
    // Same threshold as the url branch's params check, because it is the same
    // question: did this turn's taint just choose these bytes?
    if (decl.resourceKind === 'query') {
      if (resource.kind !== 'query') {
        return {
          effect: 'deny',
          code: 'resource_denied',
          detail: `${capability} declares a query resource but received ${resource.kind} — refusing rather than skipping the check`,
        };
      }
      // `quoted: false`, sempre e per costruzione. Una query di ricerca è
      // **scritta** dal modello: è linguaggio naturale, non un indirizzo che
      // si copia. Passare qui la provenienza aprirebbe l'esfiltrazione che
      // questo gate esiste per fermare — misurato: `read-then-egress.test.ts`
      // legge un segreto da un file avvelenato e lo cerca *letteralmente*,
      // quindi «era già negli ingressi» è vero ed è vero **perché** è il
      // segreto. La citazione regge per un URL (l'indirizzo esisteva prima
      // che il dato fosse visto) e non regge per un payload.
      // `searchMaxTaint`, non `paramsMaxTaint`: dal 04/09 sono due numeri
      // (ADR-0072). Il *dove* di una ricerca e' una costante allowlisted che
      // un contesto avvelenato non puo' nominare, e su un processo headless
      // un `ask` e' un `exit 3` — un divieto travestito per un'azione a
      // basso rischio.
      const gated = gateParams(principal, taint, ctx.matrix.searchMaxTaint, `ricerca: "${resource.value}"`, false);
      if (gated) return gated;
    }

    // Autonomous principals never auto-approve what a human would be asked for:
    // the job queues and waits instead. Fail-safe is the mandated direction.
    //
    // Unchanged by ADR-0074, deliberately, and one of the three things `risk`
    // still decides. The question here is not "can this be taken back" but
    // "may a process nobody is watching grant itself this at 3am", and the
    // declared class is the answer the threat model already gives it. (The ADR
    // words point 3 as *"un principal system/agent su un'azione irreversibile
    // resta ask in coda"*; the code keeps the wider `risk === 'high'` gate it
    // already had, because narrowing a fail-safe was not part of this slice.)
    if (principal.kind === 'system' || principal.kind === 'agent') {
      if (decl.risk === 'high') return ask(`queued: ${capability} requested by ${principal.kind}`);
    }

    /**
     * **The rule, since ADR-0074: an `ask` is for what cannot be taken back,
     * and for nothing else.**
     *
     * Two conditions, both necessary. The capability declares
     * `reversible: 'no'` — no undo, no journal, no re-run that lands on the
     * same state — and its effect row is one where that matters
     * (`asksForIrreversible`: the host machine, third-party code, a new
     * recipient). `surface.reply` and `memory.write` are `'no'` too and never
     * ask: the reply *is* the conversation, and an approval prompt that gates
     * replies cannot be delivered.
     *
     * What this replaced, and why, one line each:
     *
     * - **`risk: 'high'` asked.** Severity is not reversibility, and the two
     *   are different axes — `types.ts` already argues exactly this about
     *   `rerunnable`. `risk` still decides safe mode, the budget gate and the
     *   queue above; it no longer decides an ask.
     * - **`taint > row.askAbove` asked.** Ambient taint measures *who
     *   influenced this turn*, not what an action costs to undo. It turned
     *   `fs.write` — checkpointed, with `muffin undo` behind it — into a
     *   confirmation for the rest of any turn that had read a web page. The
     *   ceiling (`denyAbove`) was untouched then; ADR-0075 moved it a second
     *   time, in the branch above — on `host` it no longer refuses at all, and
     *   on `external`/`outward` it asks the owner and refuses everyone else.
     * - **`hardened && owner && taint === 0 → allow`.** The one shortcut that
     *   could skip an irreversible act entirely, and the ADR names its own
     *   falsifier: an owner killing a process on a hardened install at taint 0
     *   without an `ask` means the shortcut is back.
     */
    if (decl.reversible === 'no' && row.asksForIrreversible) {
      return ask(describe(capability, resource, decl.effect));
    }

    // Everything reachable that is not irreversible either takes an undo
    // before the effect, or has nothing to take back.
    //
    // `risk !== 'low'` is the gate `draft` has always had, kept rather than
    // widened: a low-risk `undoable` (`turn.todo` — a row in our own table,
    // scoped to the caller's tenant and session) has no file for
    // `agent/loop/tool-call.ts` to photograph, and promising a checkpoint the
    // loop does not take is the exact shape ADR-0022's draft path refuses.
    if (decl.reversible === 'undoable' && decl.risk !== 'low') {
      return { effect: 'draft', undo: { capability, windowSeconds: 300 } };
    }
    return { effect: 'allow' };
  };
}

/**
 * What the row loses that cannot be got back — the first half of the sentence
 * the owner reads before deciding.
 *
 * ADR-0074 point 2: the prompt says **what cannot be undone**, not *"serve la
 * tua approvazione per sys.shell"*. A capability id is a fact about our code;
 * "questa macchina cambia e non si torna indietro" is the thing being decided.
 * The row is the only part of that the kernel knows — the concrete act comes
 * from the call's own arguments, which `agent/loop/tool-call.ts` puts on
 * `ApprovalRequest.resource` and every surface prints under this line.
 *
 * Only the four rows with `asksForIrreversible: true` can reach this. The
 * fallback exists so a row added later arrives as a sentence rather than as
 * `undefined`.
 */
const IRREVERSIBILE: Partial<Record<EffectRow, string>> = {
  host: 'non si torna indietro: cambia questa macchina',
  external: 'non si torna indietro: chiama un servizio di terzi',
  outward: 'non si ritira: esce verso un destinatario nuovo',
  config: 'non si torna indietro: cambia la configurazione',
  rot: 'non si torna indietro: tocca la radice di fiducia',
};

/**
 * The sentence the owner reads before deciding.
 *
 * A capability with `resourceKind: 'none'` used to render as `sys.shell on
 * (no resource)` — a placeholder that is true here (the kernel genuinely has
 * no resource for it) and useless there (a person is being asked to approve
 * something). Worse, once `agent/loop.ts` learned to derive the concrete
 * action from the call's own arguments (D12-min), the two lines contradicted
 * each other on screen:
 *
 *     ⚠ sys.shell on (no resource)
 *        su: command: ls -1 *.md
 *
 * So the kernel says only what it knows: **why** this is a question at all
 * (the row's irreversibility, ADR-0074), then the capability, then the
 * resource when it has one. The surface supplies the action and — when the
 * turn is above taint 0 — the context line that says untrusted content is
 * already in the turn. That line is context and never the cause: since
 * ADR-0074 the taint does not produce an `ask`.
 */
function describe(capability: string, resource: DecisionRequest['resource'], row: EffectRow): string {
  const what = resource.kind === 'none' ? capability : `${capability} on ${resource.kind}:${resource.value}`;
  const perche = IRREVERSIBILE[row];
  return perche === undefined ? what : `${perche} — ${what}`;
}

/** Pure: URL parsing only, no I/O. `null` for anything that is not http(s). */
function hostOf(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname;
  } catch {
    return null;
  }
}

/**
 * Model-chosen bytes above a taint ceiling answer to one rule, whichever
 * capability carries them: the owner is ASKED and shown the exact bytes
 * (`prompt` carries them verbatim, so `ApprovalRequest.resource` — built from
 * this decision's `resource` in `agent/loop.ts` — can show them too); every
 * other principal is refused outright, same as `sys.shell` above its own
 * ceiling (ADR-0044 §revisione). Both callers below are the params gate found
 * missing by the 2026-08-16 audit: P04-1 (`http_get`'s query string was never
 * inspected once the host cleared the allowlist) and P04-2 (`sys.search`
 * never reached this file at all) — mandato inv. 7.
 *
 * Returns `null` for "no restriction from this gate", not "allow": the caller
 * still falls through to the risk-class switch below, exactly as the url
 * branch already did once the allowlist cleared.
 */
function gateParams(
  principal: Principal,
  taint: TrustTier,
  ceiling: TrustTier,
  prompt: string,
  quoted: boolean,
): Decision | null {
  // Byte che erano già nel turno prima che il modello scrivesse: nessuno li
  // ha *scelti* qui, quindi non c'è niente da mostrare a nessuno. È il ramo
  // che rende utilizzabile un giro di ricerca — cerca, apri un link, apri il
  // prossimo — senza chiedere il permesso a ogni passo per un URL che Muffin
  // ha copiato invece di comporre. Vedi `DecisionRequest.quoted` per perché
  // regge come argomento di sicurezza e non solo di comodità.
  if (quoted) return null;

  if (isOwnerPrincipal(principal)) {
    return taint <= ceiling ? null : ask(prompt);
  }

  // Un principal che non è l'owner e ha **composto** byte in uscita: qui non
  // c'è nessuno a cui chiedere. In un gruppo `ask` non raggiunge nessuno che
  // possa rispondere, quindi degradare a domanda non sarebbe una difesa.
  //
  // Questo chiude il buco misurato in `muffin-nei-gruppi-2026-09-04.md` §6.1:
  // `taint <= ceiling` era vero **per costruzione** per ogni turno di gruppo
  // (`tierOf(member)` è 2, `paramsMaxTaint` era 2), quindi la prima query
  // inventata usciva sempre senza che nessuno la vedesse. Con la provenienza
  // il criterio smette di essere un numero che i gruppi hanno già raggiunto
  // in partenza e diventa una domanda a cui si può rispondere: questi byte
  // vengono da qualche parte, o se li è inventati adesso? (Lane #624 + #641:
  // il soffitto è 1, quindi la distinzione per provenienza vale anche per
  // l'owner a taint >= 2.)
  return {
    effect: 'deny',
    code: 'resource_denied',
    detail: `params composed by the model, not quoted from this turn (taint ${taint}, ceiling ${ceiling})`,
  };
}

/**
 * True when a URL carries model-chosen bytes beyond its host: a non-trivial
 * path, userinfo, a non-empty query, or a fragment — read off the canonical
 * parse, not the raw string.
 *
 * Lane #624 put the pathname here: gating only `search`/`hash` left
 * `https://evil/<segreto>` with no gate at any taint. Lane #641 lowered the
 * ceiling so the gate actually fires at tier 2. Userinfo joins the same
 * predicate because it reaches the wire as request credentials
 * (`agent/tools/http.ts` derives the auth header from it): same seam, same
 * exfiltration class, no new architecture.
 *
 * The parse is `new URL` — the same parser the tool executes
 * (`agent/tools/http.ts` builds the request from `new URL(url)`), so the
 * decision and the executed resource cannot disagree on which component a
 * byte sits in. Detection is encoding-agnostic on purpose: percent-encoded
 * path bytes (`/%73ecret`), dot segments (`/a/../x`, normalised by the
 * parser to `/x`), repeated slashes, and encoded separators (`%2F`) are all
 * still pathname bytes, and any non-trivial pathname gates. No second
 * canonicalization is introduced or duplicated.
 *
 * What this does NOT do, deliberately: compare canonically for the `quoted`
 * exception. Quoting stays a whole-URL byte-literal match
 * (`agent/loop/permissions.ts`): a canonically-equivalent-but-byte-different
 * URL misses and costs one approval, while a tolerant match would open the
 * splice channel the gate exists to close.
 */
function hasComposedBytes(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.search !== '' || parsed.hash !== '') return true;
    if (parsed.username !== '' || parsed.password !== '') return true;
    // `new URL('https://h').pathname` is `/`: the bare host — the only shape
    // with no model-chosen bytes — is exactly `'/'` (or `''` for a
    // non-special scheme, unreachable here since `hostOf` already refused
    // anything but http(s)).
    return parsed.pathname !== '' && parsed.pathname !== '/';
  } catch {
    return false; // unreachable here: hostOf() above already refused an unparseable url
  }
}
