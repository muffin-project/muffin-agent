/**
 * Policy kernel contracts.
 *
 * This file is part of the Root of Trust (code tier): nothing at runtime writes
 * here, and changing it requires a build and a restart. See
 * docs/decisions/0003-root-of-trust.md and docs/decisions/0013-kernel-permessi-unificato.md.
 *
 * Historical contract lineage:
 * docs/history/rebuild-2026/09-contratti-m0-m1.md §1. The current executable
 * authority is this file and the shipped schema/config, per docs/README.md.
 */

/** Who is acting. Never inferred from message content — resolved before the loop. */
export type Principal =
  /**
   * `externalId` is not optional, deliberately. It used to be absent, and the
   * Telegram connector filled the gap by comparing the *chat* id — the room —
   * so anyone speaking in a chat that carried the owner's id arrived as the
   * owner. A type that permits an anonymous owner is a type that invites the
   * check to be made out of whatever is nearby. On the CLI the value is
   * `'local'`: authentication there is having a shell on the machine, and
   * saying so is better than leaving the field off.
   */
  | { kind: 'owner'; connector: ConnectorId; externalId: string }
  | { kind: 'member'; connector: ConnectorId; tenantId: TenantId; externalId: string }
  | { kind: 'system'; source: 'scheduler' | 'consolidation' | 'ratchet' }
  | { kind: 'agent'; role: 'dev' };

/** 'host' | `group:${connector}:${externalId}` | `community:${slug}` */
export type TenantId = string;
export type ConnectorId = string;

/**
 * Provenance tier of a piece of evidence, and — as the max over everything
 * currently in context — the taint of a turn. One scale for both data and
 * policy, deliberately (see blueprint 10-risoluzioni §2, rejected C2-#5).
 */
export type TrustTier = 0 | 1 | 2 | 3;

/** Dotted, stable, versioned with the repo. e.g. 'fs.write', 'sys.shell'. */
export type CapabilityId = string;

type Resource =
  | { kind: 'path'; value: string } // absolute, normalized, symlinks resolved
  /**
   * A URL this capability may reach in order to **act** — write, execute, send.
   * Gated by `rot/egress.json` (ADR-0066): off the allowlist is a hard refusal
   * (`ask` for the owner at low taint, `deny` for everyone else, never a silent
   * skip once taint has climbed), because acting somewhere the owner has not
   * named is the thing the allowlist exists to stop. No shipped capability uses
   * this today — `sys.http` is GET-only and moved to `url-read` — but the
   * branch stays for the next one that writes or executes through a
   * model-chosen host (`decide.ts`'s own comment names `outward.send`).
   */
  | { kind: 'url'; value: string }
  /**
   * A URL this capability may **read** — GET only, by construction of the tool
   * that declares it (`sys.http`). ADR-0066: reading a public page is not the
   * same authority as reaching a host to act on it, so this kind answers to a
   * different gate than `url` — no allowlist, because the owner already
   * decided that fetching bytes from wherever a page or a link points is not
   * an action that needs naming in advance. What still applies, unchanged:
   * the SSRF floor (`core/net/egress.ts#isForbiddenAddress`, enforced by the
   * tool itself on every redirect hop, DNS-resolved) and `paramsMaxTaint` on
   * a query string or fragment the model chose (`decide.ts`'s `gateParams`) —
   * the destination is open, the bytes riding along in it are not.
   */
  | { kind: 'url-read'; value: string }
  /**
   * The literal text a model-controlled search argument sends outbound, when
   * the destination is a constant the capability already pins (`sys.search`'s
   * endpoint, checked once at registration) rather than something the model
   * names per call. Not `url`: there is no host for the kernel to hold
   * against the allowlist, only bytes whose turn taint decides whether they
   * may leave at all (`decide.ts`, `gateParams` — mandato inv. 7, P04-2).
   */
  | { kind: 'query'; value: string }
  | { kind: 'tenant'; value: TenantId }
  | { kind: 'none' };

type DenyCode =
  | 'no_capability'
  | 'taint_exceeded'
  | 'tenant_mismatch'
  | 'budget_exhausted'
  | 'rot_violation'
  | 'safe_mode'
  | 'resource_denied'
  | 'principal_forbidden';

export type Decision =
  | { effect: 'allow' }
  | { effect: 'ask'; ask: { audience: 'owner'; prompt: string } }
  | { effect: 'draft'; undo: { capability: CapabilityId; windowSeconds: number } }
  | { effect: 'deny'; code: DenyCode; detail?: string };

export type DecisionRequest = {
  principal: Principal;
  tenant: TenantId;
  capability: CapabilityId;
  resource: Resource;
  /** Already validated against the tool's input schema — never raw model output. */
  args: Readonly<Record<string, unknown>>;
  /** Recomputed at every call, never frozen for the turn (blueprint 03 §2). */
  taint: TrustTier;
  /**
   * Questi byte erano **già** nel turno prima che il modello li scrivesse?
   *
   * La domanda che `taint` da solo non sa fare, e la ragione per cui il gate
   * sui parametri si comportava come un guasto. `hasParams` non distingue una
   * query che il modello si è **inventato** — il canale di esfiltrazione — da
   * un URL che ha **copiato** da un risultato di ricerca, e nella ricerca vera
   * quasi ogni link ha un `?`. Risultato misurato: dopo la prima pagina letta,
   * seguire un link chiedeva un'approvazione ogni volta, per sempre.
   *
   * L'argomento di sicurezza è che questo *non* è una comodità. Non si può
   * esfiltrare un dato attraverso una stringa che esisteva già **prima** che
   * il dato fosse visto: chi ha scritto quella pagina non conosceva il
   * segreto quando l'ha scritta. Se il modello aggiunge un byte suo, la
   * stringa non è più citata e il cancello torna.
   *
   * Contano solo gli **ingressi** — il messaggio della persona e i risultati
   * dei tool — mai il testo che il modello ha prodotto: altrimenti basterebbe
   * scrivere l'URL in un turno e «citarlo» in quello dopo per lavarlo.
   *
   * `undefined` significa «chi chiama non lo sa», ed è trattato come `false`:
   * un chiamante che non misura la provenienza non guadagna niente.
   */
  quoted?: boolean | undefined;
};

export type RiskClass = 'low' | 'medium' | 'high';
type Reversibility = 'yes' | 'undoable' | 'no';

/**
 * **Where the bytes of this effect end up** — the row of the threat model's own
 * matrix (`docs/history/rebuild-2026/03-threat-model.md` §3) that this capability
 * belongs to.
 *
 * This exists because that matrix is normative and the kernel was not executing
 * it. The table's rows are effect classes and its columns are taint; the kernel
 * decided instead from `risk` plus a `maxTaint` pinned by hand on each
 * declaration, and the two drifted apart without anything going red. The
 * measured instance: the row *"Shell / filesystem host / processi"* reads `ASK`
 * at taint 2, the 2026-08-16 amendment moved that cell for `sys.shell` alone by
 * pinning a number on it, and `fs.write` — same row, same host, and the only
 * one of the two with a checkpoint and an undo — went on answering `deny`
 * because it inherited the medium class default of 1. Two doors to the same
 * sink, the safer one shut. See ADR-0053.
 *
 * `risk` and `effect` are different questions and both are needed: risk says how
 * bad it is to get this wrong, effect says where the result lands. The row
 * drives the ceiling and — since ADR-0074, via `RowPolicy.asksForIrreversible`
 * — whether an irreversible declaration on it is worth a human's confirmation.
 * `risk` still decides safe mode, the budget gate, whether an `undoable` write
 * is a `draft`, and the queue for autonomous principals; it no longer decides
 * the `ask`. A capability that answers only one of the two is the shape the
 * drift came in.
 *
 * `core/policy/effect-rows.test.ts` asserts every shipped declaration against
 * the printed matrix, cell by cell.
 */
export type EffectRow =
  /** Bytes enter the turn; nothing leaves, nothing on the host changes. */
  | 'context'
  /** The host machine: its filesystem, its shell, its processes. */
  | 'host'
  /** Back down the conversation already under way, to whoever opened it. */
  | 'reply'
  /** The network, where the allowlist and `paramsMaxTaint` own the columns. */
  | 'egress'
  /** A durable write to the tenant's own memory. */
  | 'memory'
  /** Third-party code or services outside the allowlist model (MCP). */
  | 'external'
  /** A **new** recipient: mail, a message to someone else, publication. */
  | 'outward'
  /** Configuration and voice, reachable only through the ratchet. */
  | 'config'
  /** The Root of Trust, which no principal reaches at runtime. */
  | 'rot';

/**
 * A tool without one of these does not exist for the runtime.
 * Lives next to the tool in its feature folder; core/policy only owns the type.
 */
export type CapabilityDecl = {
  readonly id: CapabilityId;
  /**
   * How bad it is to get this wrong. **Not** how hard it is to undo — that is
   * `reversible`, one field down, and conflating the two is what ADR-0074
   * unwound.
   *
   * What it still decides, exhaustively, so nobody has to guess whether the
   * field is dead: safe mode refuses anything above `low` when the root of
   * trust diverged; the budget gate is consulted for anything above `low`; an
   * `undoable` write becomes a `draft` only above `low` (a low-risk undoable
   * has no file for the loop to photograph); and a `high` request from a
   * `system`/`agent` principal is queued for a human instead of granted at
   * 3am. What it no longer decides is the `ask` — see `decide.ts`.
   */
  readonly risk: RiskClass;
  readonly reversible: Reversibility;
  /**
   * May this call be made a second time when nobody can say whether the first
   * one landed?
   *
   * **Not the same question as `reversible`, and the two axes are independent.**
   * `fs.write` is `undoable` and re-running it is harmless — writing the same
   * bytes twice gives the same file. Sending a message is neither reversible
   * nor re-runnable — it gives two messages. A design that reused `reversible`
   * to decide would refuse a resume that was safe, and would have nothing at
   * all to say about an `outward.send` someone later declared `undoable`.
   *
   * Required, not optional, and that is the point: a tool arriving without an
   * answer breaks the build instead of inheriting a default that is wrong half
   * the time. Adding this after five MCP servers are attached means auditing
   * every one of them — the design (`docs/evidence/turno-sospendibile.md` §Domanda 6)
   * rates it among the two most expensive things to get wrong here.
   *
   * The consumer is a resume: a call with an intent row and no outcome row is
   * re-executed only when this says so. Nothing resumes yet — the declaration
   * is made now because it is the half that cannot be added cheaply later.
   */
  readonly rerunnable: boolean;
  /**
   * Rifare questa chiamata **con gli stessi argomenti** dà al modello qualcosa
   * di nuovo?
   *
   * `'idempotent_read'` dichiara di no: una seconda lettura identica, nello
   * stesso turno, restituisce quel che il modello ha già davanti. È l'unica
   * cosa che autorizza il guardrail di `runTool` ad attaccare un avviso al
   * risultato — e non fa altro: non nega, non approva, non tocca il tetto di
   * taint né la decisione del kernel.
   *
   * **Opt-in, e mai dedotto da `rerunnable`.** Le due domande sembrano la
   * stessa e non lo sono: `rerunnable` parla di *effetti* («è innocuo rifarla
   * se nessuno sa se è andata»), questa di *informazione*. `sys.wait` è
   * `rerunnable: true` (`agent/tools/wait.ts:104`) e una seconda attesa
   * identica fa passare altro tempo, che è progresso; `fs.write` è
   * `rerunnable: true` (`agent/tools/fs.ts:179`) e riscrivere gli stessi byte
   * è un effetto, non una lettura. Dedurlo dall'altro campo avviserebbe su
   * tutte e due.
   *
   * Assente significa «non dichiarato», che è anche il default giusto: un tool
   * nuovo non eredita un avviso che nessuno ha pensato per lui.
   */
  readonly progress?: 'idempotent_read';
  /** Where this effect lands. See `EffectRow`: it owns the ceiling. */
  readonly effect: EffectRow;
  /**
   * A **tightening** of this capability's own row, and nothing else.
   *
   * It used to be the ceiling itself, `?? defaultMaxTaint[risk]`, and that is
   * the knob that produced the drift ADR-0053 repairs: widening one capability
   * at a time is how the printed matrix and the kernel stopped agreeing. The
   * kernel now takes the stricter of the two, so a value above the row's is
   * inert — and `effect-rows.test.ts` refuses it out loud rather than letting
   * it read as a decision someone made.
   */
  readonly maxTaint?: TrustTier;
  readonly resourceKind: Resource['kind'];
  /** Which fields of args the kernel is allowed to inspect. */
  readonly policyArgs: readonly string[];
  /** Never reachable from a remote tenant, by construction. */
  readonly hostOnly: boolean;
  readonly timeoutMs?: number;
};

/**
 * Synchronous and pure: no I/O, no network, no await. Reads only the policy
 * already loaded at boot, so a decision is always explainable from a snapshot.
 */
export type Decide = (req: DecisionRequest) => Decision;

/**
 * Per-turn permission view. principal/tenant are fixed for the turn; taint is
 * not — a tier-3 tool result raises it for every decision that follows.
 *
 * **Ceiling vs intrinsic (ADR-0044 §Riconciliazione 2026-08-28).** Two turns
 * asked the same question two days apart — `il taint muore col turno` (15/08)
 * and `la history non lava la provenienza` (17/08) — and both were right about
 * a different half of it. What a turn may **do** has to reflect everything
 * physically in its prompt, reinjected history included, or a turn sitting on
 * top of tainted context acts as if it were clean (the 17/08 laundering
 * probe). What a turn's **own freshly-written output** gets stamped with, for
 * a *later* turn to reinject, has to reflect only what this turn itself
 * touched — or a single old, aged-out event never actually ages out: every
 * turn downstream re-stamps its own clean text at the inherited ceiling,
 * refilling the reinjection window forever, which is the ratchet the 17/08
 * revision's own "Cosa NON copre" named and never closed. `currentTaint` is
 * the first; `intrinsicTaint` is the second, and they diverge only for taint
 * that arrived via `raiseCeiling` — content reinjected from a *past* turn
 * (session history, an open plan item), never something this turn itself did.
 */
export interface PermissionSnapshot {
  readonly principal: Principal;
  readonly tenant: TenantId;
  currentTaint(): TrustTier;
  /** What this turn is gated on right now — every raise, ceiling-only included. */
  raiseTaint(tier: TrustTier): void;
  /**
   * Raises the ceiling `currentTaint` reads, without raising what
   * `intrinsicTaint` reports — for taint that is reinjected from a *past*
   * turn's own recorded provenance rather than something this turn itself
   * produced or observed. The turn still may not act freely on it (the
   * ceiling gates every `check()` below); its own new output does not inherit
   * it as if this turn had caused it.
   */
  raiseCeiling(tier: TrustTier): void;
  /**
   * What this turn's own newly-written content should be stamped with, for a
   * later turn's reinjection to read back — the ceiling, minus whatever
   * arrived only through `raiseCeiling`. Never lower than the turn started at
   * (a fresh turn's own principal/content tier is always intrinsic to it).
   */
  intrinsicTaint(): TrustTier;
  /**
   * Throws away memoised decisions. The taint does this for itself; the budget
   * is the other input the kernel reads and it can change mid-turn, in which
   * case a cached `allow` from before the cap was reached would outlive the
   * condition that produced it.
   */
  invalidate(): void;
  check(capability: CapabilityId, resource: Resource, args: Readonly<Record<string, unknown>>): Decision;
  /**
   * Registra byte che sono **entrati** nel turno: il messaggio della persona,
   * il risultato di un tool. Mai l'output del modello — vedi
   * `DecisionRequest.quoted` per perché quella distinzione è il meccanismo e
   * non un dettaglio.
   */
  recordInput(text: string): void;
}
