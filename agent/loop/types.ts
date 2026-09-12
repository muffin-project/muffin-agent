import type { MemoryStore } from '../../core/memory/store.js';
import type { RecallDeps } from '../../core/memory/recall.js';
import type { Decide, Principal, TenantId, TrustTier } from '../../core/policy/types.js';
import type { CapabilityDecl, CapabilityId, Decision, DecisionRequest } from '../../core/policy/types.js';
import type { SessionRef, SessionStore } from '../../core/session/store.js';
import type { UndoJournal } from '../../core/undo/journal.js';
import type { TurnStopped, TurnStore } from '../../core/turns/store.js';
import type { TodoStore } from '../../core/turns/todo.js';
import type { WaitSpec } from '../../core/turns/wait.js';
import type { ApprovalStore } from '../../core/approvals/store.js';
import type { Tracer } from '../../core/tracing/types.js';
import type { IstanzaFacts, SystemPrompts } from '../context/assemble.js';
import type { Profile } from '../profiles/profile.js';
import type { AudioBlock, ImageBlock, Provider, ToolSpec } from '../providers/types.js';

/**
 * Types and constants for the agent loop, moved out of `agent/loop.ts` in pure
 * form — same names, same shapes, same docstrings. `agent/loop.ts` re-exports
 * every name that was public before this split, so its 35 importers see no
 * difference. See `agent/loop.ts`'s own module docstring for what the loop is.
 *
 * Rule for everything under `agent/loop/`: import from `./types.js`, never
 * from `../loop.js` — a file in this directory that reached back into the
 * barrel would be exactly the cycle this decomposition exists to avoid.
 */

/**
 * What a handler is allowed to know about the turn it is running in.
 *
 * This exists because it was missing, and its absence was a cross-tenant leak
 * waiting for the second connector: the memory tool was registered with the
 * tenant baked in at wiring time, so a group member calling it would have been
 * served the owner's memory. A handler cannot read the tenant of the turn if
 * nobody hands it one — the comment claiming it did was aspirational.
 */
export type ToolContext = {
  tenant: string;
  principal: Principal;
  /**
   * The row this call belongs to — `TurnResult.turnId`, and the trace id of the
   * turn that created it. A handler that wants durable state attached to the
   * turn it is running in has somewhere to attach it.
   */
  turnId: string;
  /**
   * The conversation. Multi-step work is scoped to this and never to the turn:
   * a plan that died with the turn that wrote it would not be a plan.
   */
  sessionId: string;
  /**
   * The turn's taint **right now**.
   *
   * A function and not a value, because it can still rise: a handler running
   * second in a batch may run after one that dragged in tier-3 bytes, and a
   * snapshot taken when the context object was built would be stale exactly
   * there. Every durable thing a handler writes on the turn's behalf has to
   * carry this — trust never rises, and a table is not a bath (ADR-0047).
   */
  taint: () => TrustTier;
  /**
   * Come `taint`, ma il tetto tolto: cosa questo turno ha realmente prodotto o
   * osservato, mai un tetto ereditato da una storia reiniettata o da un piano
   * aperto (`PermissionSnapshot.intrinsicTaint`, ADR-0044 §Riconciliazione
   * 2026-08-28).
   *
   * Esiste per un solo chiamante, `agent/tools/todo.ts`: una riga scritta in
   * una tabella che sopravvive al turno non può stampare il tetto ereditato,
   * o la finestra di reiniezione del taint non si richiude mai (esattamente
   * il difetto che quella riconciliazione ha chiuso per `historyTaint`, qui
   * per `planTaint`). Ogni altro handler resta su `taint()` — il tetto è
   * ciò che un gate a metà turno deve vedere, non ciò che sta per scrivere.
   */
  intrinsicTaint: () => TrustTier;
  /**
   * **Il file già risolto** che questa chiamata sta per toccare, quando il
   * kernel ha giudicato `draft` e il registro di undo ne ha appena preso la
   * copia. Assente per ogni altro verdetto.
   *
   * Esiste perché il judge di questa slice ha trovato il difetto che il
   * docstring di `resolveEffectPath` diceva di voler evitare: risolvevo il
   * percorso una volta per la fotografia e l'handler lo risolveva **di nuovo**
   * dal suo argomento grezzo, con in mezzo un commit SQLite e un `await`. Due
   * risoluzioni della stessa cosa sono libere di essere in disaccordo, e il
   * momento in cui contano è esattamente il momento in cui qualcuno sostituisce
   * il file: la copia sarebbe dell'inode A e la scrittura andrebbe sull'inode B,
   * quindi un `muffin undo` rimetterebbe il contenuto di A sopra B.
   *
   * Una sola risoluzione, e poi una sola `open` con `O_NOFOLLOW` su quel
   * percorso. Non chiude la finestra per magia — la rende una finestra sola.
   */
  effectPath?: string;
  /**
   * Arm the runtime's suspension barrier.
   *
   * **Armed, never immediate**, and that is the contract: the loop honours it
   * at the next suspension point — after the current batch of tool calls has
   * finished and every `tool_use` has its `tool_result`. A handler that could
   * suspend the turn from inside itself would leave the rest of its batch
   * unanswered, which is a malformed request to the next provider call; and it
   * is the same semantics the prior art landed on independently (Hermes parks
   * the *next* turn, ADR-0035's `steer` injects after the next tool call).
   *
   * Only `wait` calls it. It is on every context rather than injected into one
   * tool because a tool is registered once at boot and shared by every turn,
   * so the barrier has to travel with the turn — not with the tool.
   */
  suspend: (spec: WaitSpec) => void;
  /**
   * Where a mid-turn tool can address a follow-up delivery — the registry
   * channel this turn's conversation arrived on (`telegram:<chatId>`,
   * `discord:<channelId>`, `cli`), or absent/`null` when there is none (a job
   * turn with no `replyChannel`, a surface that never set one, or — every
   * call site that existed before this field did — a handler that never reads
   * it and has no reason to construct it).
   *
   * Optional, deliberately, and not the same argument as `ToolOutcome.tier`'s
   * required field one file over: an omitted `tier` was a *silent* security
   * default (a tool that said nothing about provenance was read as spotless).
   * An omitted `replyChannel` has no default to be silent about — the one
   * handler that reads it (`send_file`, DAY-1 requirement B14) must branch on
   * absence/`null` explicitly either way, and forcing the other dozen tool
   * handlers in this tree to state a channel they never touch would be noise
   * bolted onto call sites the field has nothing to say to.
   *
   * Separate from `TurnInput.replyTo`, which stays opaque to the loop on
   * purpose (see its docstring): `replyTo` is a connector's own reply
   * metadata, read only by that connector after the turn returns.
   * `replyChannel` is the one piece of it every surface already expresses in
   * the same shape — the `SurfaceRegistry` address — so a tool can ask the
   * registry for a delivery without the loop having to learn what a chat id
   * is.
   */
  replyChannel?: string | null | undefined;
};

/**
 * Clearable tool-result payload kept per turn, in characters (~4 per token, so
 * roughly 15k tokens). Hardcoded rather than configured: it is a property of how
 * much of a window is worth spending on results the model has already used, not
 * a preference, and a value in the environment is one that differs between the
 * laptop and the server and is discovered wrong months later.
 */
export const TOOL_RESULT_BUDGET_CHARS = 60_000;

/**
 * Prior messages of the session replayed verbatim. Beyond this, recall is the
 * mechanism for reaching further back — that is what it is for.
 */
export const MAX_HISTORY_TURNS = 40;

/**
 * Re-attempts for a failure of the *transport* — 429, 502, a reset socket.
 *
 * A constant, and not `profile.recovery.length` as it used to be, because how
 * often to retry a rate limit is a property of the endpoint and never was a
 * crutch for a weak model. Tying the two together had one visible consequence
 * and one invisible one: a profile with the crutches off (`recovery: []`, the
 * neutral profile of 07 §3) got **zero** retries on a 502 — resilience removed
 * along with the scaffolding — and any transport hiccup silently ate a step of
 * the model-recovery cascade, so the empty turn that followed had nothing left
 * to spend.
 *
 * Two, matching what the shortest declared cascade bought before this split,
 * and small on purpose. The provider constructors set `maxRetries: 0`, so this
 * is now the only transport retry budget: on a persistent 502 it means three
 * wire attempts total, with two loop-owned backoff gaps. Keeping that ownership
 * here prevents a model deadline or a transport retry from multiplying inside
 * an SDK.
 */
export const MAX_TRANSPORT_RETRIES = 2;

/**
 * How a surface asks the owner.
 *
 * The kernel can answer `ask`, and until now no surface could carry the
 * question: the loop turned every `ask` into a tool error saying it could not be
 * asked here. That made one of the four verdicts unreachable, which means the
 * matrix said things the runtime could not do.
 *
 * A surface that cannot ask does not get a placeholder that guesses. It gets no
 * approver, and the turn stops with `stopped: 'ask'` carrying what was wanted —
 * so a script exits 3 and a person can decide, instead of an agent quietly
 * doing nothing and reporting an error it invented.
 */
export type ApprovalRequest = {
  capability: string;
  /** The kernel's own wording, not a paraphrase. */
  prompt: string;
  /**
   * The concrete subject of the call: the kernel's resource when it has one
   * (path, URL, query bytes), otherwise a render of the call's own arguments —
   * a shell command with its cwd, a pid with its name. An approval whose
   * subject is invisible is theater (D12): "approvi sys.shell?" is not a
   * question anyone can answer.
   */
  resource?: string | undefined;
  /**
   * What the call does, in the model's own words — `shell_run`'s
   * `description` argument (03/09/2026, owner: «mi piacerebbe un riassunto
   * testuale che dice cosa fa quel comando»). Same mechanism as Claude
   * Code's `Bash` tool: a schema field the model fills, shown above the
   * command it is asking to run. Absent when the tool has no such field, or
   * a scripted call left it out. Model-written: surfaces escape it.
   */
  description?: string | undefined;
  /**
   * The turn's taint when the ask fired — "why am I being asked" is half of
   * the answer. 0 = owner speaking directly; higher tiers mean untrusted
   * content has already entered the turn, so the surface should say so.
   */
  taint: TrustTier;
};

/**
 * Dove sta il turno che chiede, e con che nome chiamare questa domanda.
 *
 * Serve perché **un approvatore solo non basta**: `runtime.deps.approve` è uno
 * per processo, e finché lo era davvero un turno arrivato da Telegram faceva
 * comparire la domanda nel terminale — cioè la chiedeva a chi non l'aveva
 * fatta, in un posto che l'owner col telefono in mano non sta guardando.
 * `surface` è la riga che permette di instradarla dove il turno è nato.
 *
 * `replyTo` è l'indirizzo **durevole** scritto sulla riga del turno, non un
 * canale vivo: sopravvive al riavvio, che è la condizione perché una domanda
 * possa aspettare una risposta.
 */
export type ApprovalWhere = {
  surface: string;
  turnId: string;
  replyTo?: Record<string, unknown> | undefined;
  /**
   * L'id già scritto nel registro delle approvazioni.
   *
   * Coniato **prima** di chiedere, perché su una superficie a pulsanti l'id
   * viaggia dentro il pulsante: senza, la risposta tornerebbe senza sapere a
   * quale domanda appartiene. Assente quando non c'è un registro (un test, un
   * runtime senza database delle approvazioni), e in quel caso una superficie
   * asincrona non può chiedere e lo dice tornando `unavailable`.
   */
  approvalId?: string | undefined;
};

/**
 * Le quattro risposte possibili a una richiesta di approvazione.
 *
 * `asked` è quella nuova, ed è il motivo per cui questo tipo è cambiato: su
 * Telegram la domanda parte e la risposta arriva **dopo**, forse dopo un
 * riavvio. `asked` vuol dire «l'ho chiesto davvero, il turno si sospenda»;
 * `unavailable` vuol dire «qui non c'è nessun canale per chiederlo», che è la
 * cosa che il turno deve dire invece di fingere un errore del tool.
 */
type ApprovalAnswer = 'allow' | 'deny' | 'asked' | 'unavailable';

export type Approver = (request: ApprovalRequest, where: ApprovalWhere) => Promise<ApprovalAnswer>;

/** Thrown by a tool call that needs an approval this surface cannot obtain. */
export class ApprovalRequired extends Error {
  constructor(readonly request: ApprovalRequest) {
    super(`approvazione richiesta per ${request.capability}`);
    this.name = 'ApprovalRequired';
  }
}

export type SpendEntry = {
  tenant: string;
  capability: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * The scheduled job this call belongs to, threaded from `TurnInput.jobId`.
   *
   * Absent on every interactive turn. It is what makes a per-job ceiling a
   * question the ledger can answer at all: without a key, "how much has THIS
   * job spent" is not a query, it is an inference from session-name prefixes.
   */
  jobId?: string | undefined;
};

type ToolHandler = (args: unknown, ctx: ToolContext) => Promise<ToolOutcome> | ToolOutcome;

export type ToolOutcome = {
  content: string;
  isError?: boolean;
  /**
   * Tier of whatever this result dragged into the turn. Web and third-party
   * tools are 3; the local filesystem is 2 (ADR-0044); a result made only of
   * the tool's own words — *"wrote 41 bytes"*, *"invalid arguments"* — is 0.
   *
   * **Required, and that is the fix.** It was `tier?`, and `runTool` raised the
   * turn's taint only when the field was present, so *not answering* the
   * provenance question meant "this context is as clean as when the owner
   * typed". Four tools never answered — `fs_read`, `fs_list`, `shell_run`,
   * `process_list` — and every one of them carries bytes somebody else wrote.
   * The consequence was not local: `core/policy/decide.ts` reads the turn's
   * taint to decide egress, so a turn could swallow an injected file and still
   * reach an off-allowlist host as an `ask` the owner might approve.
   *
   * Optional-with-a-safe-default was the other candidate and is weaker in the
   * way that matters: it makes the omission harmless *today* without making it
   * visible, and `agent/tools/skill.ts:114-121` is the record of how long an
   * invisible omission survives here — months, in a file whose own docstring
   * claimed the missing value. A required field is the same guarantee
   * `assertNever` gives the decision switch below: the day a new tool arrives,
   * the compiler asks it where its bytes came from.
   */
  tier: TrustTier;
  /**
   * Questo fallimento vale la pena riprovarlo?
   *
   * Solo il tool lo sa. Un 429, un 503, una connessione caduta a metà sono
   * transitori; «file non trovato», «schema non valido», «host non in
   * allowlist» non lo saranno mai, e riprovarli è tempo speso a ottenere lo
   * stesso errore tre volte.
   *
   * **Opzionale, dove `tier` è obbligatorio, e la differenza non è pigrizia.**
   * `tier` è obbligatorio perché ogni tool *ha* una provenienza: non
   * rispondere significa mentire su una cosa che si sa. La riprovabilità
   * invece per la maggior parte dei fallimenti **non esiste**: un errore di
   * validazione non è né transitorio né permanente-per-caso, è permanente per
   * costruzione, e obbligare ogni tool a scrivere `retryable: false` su ogni
   * ramo di errore produrrebbe rumore, non informazione. L'assenza qui ha un
   * significato vero — «non ho motivo di credere che riprovare cambi
   * qualcosa» — che l'assenza di `tier` non aveva.
   *
   * Da sola non basta: `runTool` riprova solo se **anche** la capability
   * dichiara `rerunnable`, perché un effetto già partito non si ripete.
   */
  retryable?: boolean;
};

export type RegisteredTool = {
  spec: ToolSpec;
  capability: string;
  handler: ToolHandler;
  /**
   * The tier of whatever a THROWN failure from this tool's handler can bring
   * into the turn — the question `ToolOutcome.tier` asks of a returned result,
   * asked here of the handler's other exit.
   *
   * **Required, for the reason `tier` is required, one level up.** A judge's
   * round-1 review of this PR found the same shape of gap it closed still open
   * in `runTool`'s `catch`: it put `error.message` into the session as a tool
   * result the model reads, called `raiseTaint` never, and recorded `tier:
   * undefined` in the turn record. A handler that answered "0" on success but
   * *threw* was invisible to the taint ledger no matter whose words the
   * message carried — and `agent/tools/mcp.ts` (`connection.call` →
   * `client.callTool`) is a production handler that can throw with a
   * third-party MCP server's own text (`McpError.message`, lifted from the
   * server's JSON-RPC `error.message` field). That gave a compromised server a
   * second channel next to the one ADR-0044 closed, and a cheaper one: a
   * successful tier-3 call raises the taint and (at the shipped medium
   * ceiling) closes egress after one round-trip, but a *failing* call cost the
   * server nothing and could be retried without limit — returning an error is
   * more powerful than returning a result.
   *
   * 0 for every tool whose thrown text is provably ours — see the comment on
   * each tool's declaration for the internal boundary that makes it true (a
   * validation message, a path, an errno, never a byte the handler did not
   * write itself). 3 for every `mcp.*` tool: the words on the other side of
   * that particular throw belong to a third party, fenced or not, so the
   * ceiling matches the one its successful calls already declare.
   */
  throwTier: TrustTier;
  /**
   * This tool's output must survive context compaction.
   *
   * Set it for tools whose result *is* the grounding rather than something the
   * model can fetch again on a whim — recalled memory being the case that
   * matters. Declared next to the tool, like its capability, so adding a tool
   * means answering the question rather than discovering the answer later.
   */
  keepResult?: boolean;
  /**
   * **Il file assoluto che questa chiamata sta per toccare**, per il registro
   * di undo. Obbligatorio di fatto per ogni tool la cui capability il kernel
   * giudica `draft`: senza, il ramo `draft` rifiuta.
   *
   * Non è ridondante con `resourceKind: 'path'`. Quello che il kernel riceve è
   * l'argomento del modello — `note.md` — mentre il file che viene scritto è
   * `resolveInScope(scope, 'note.md')`, cioè un percorso che solo il tool
   * conosce, perché solo il tool conosce lo scope. Fotografare l'argomento
   * grezzo vorrebbe dire copiare un file relativo alla cwd del processo e
   * ripristinarlo lì: un undo che tocca il file sbagliato è peggio di nessun
   * undo. Ricalcolare lo scope dal loop sarebbe una seconda copia di
   * `resolveInScope`, libera di essere in disaccordo con la prima proprio nel
   * caso in cui il disaccordo costa.
   *
   * Può lanciare: se il percorso non è risolvibile (fuori scope, symlink,
   * negato dalla root of trust) non c'è niente da fotografare e non c'è niente
   * da eseguire, e il messaggio del lancio è la ragione da mostrare.
   */
  /**
   * `ctx` è il secondo argomento **da ADR-0073**, e non è una comodità.
   * `vault_save` scrive in `salvati/<slug del tenant>/…`, quindi il file che
   * questa chiamata tocca dipende dal tenant del turno e non solo dagli
   * argomenti del modello — che è esattamente la proprietà che rende quel
   * tool incapace di scrivere nella stanza di qualcun altro. Senza il
   * contesto qui, la fotografia si prenderebbe su un percorso derivato da
   * ciò che il modello ha scritto, cioè su un file diverso da quello che
   * l'handler scriverà: un undo che ripristina il file sbagliato è peggio di
   * nessun undo (vedi il paragrafo sopra). `fs.ts` lo ignora, come faceva.
   */
  resolveEffectPath?: (args: Record<string, unknown>, ctx: ToolContext) => string;
};

export type LoopDeps = {
  provider: Provider;
  profile: Profile;
  /** Optional experimental sampling override used by evaluation harnesses. */
  samplingOverride?: NonNullable<import('../providers/types.js').ChatCall['sampling']> | undefined;
  model: string;
  tools: RegisteredTool[];
  decide: Decide;
  tracer: Tracer;
  sessions: SessionStore;
  /**
   * Where the turn lives while it is happening.
   *
   * **Required, and that is the decision.** Every other durable seam in this
   * type is optional with a documented degradation, and every optional one has
   * at some point been left unwired in production while the tests stayed green
   * — `recordSpend` and `capabilities` both say so a few lines from here. A
   * turn without a record is not a degraded turn: it is a turn that cannot be
   * seen, resumed, or told apart from one that died mid-effect. So the type
   * refuses it, and a construction site that forgets it fails to build rather
   * than failing in six months on somebody's laptop.
   *
   * See `core/turns/store.ts` for the shape and why it is not the session file.
   */
  turns: TurnStore;
  /**
   * The plan. **Required, for the reason `turns` is.**
   *
   * A todo list is only a mechanism if every turn of the session is shown it
   * (`buildContext` below reads this on every turn, unconditionally). Made
   * optional it would be unwired on some surface, the tool would still write
   * rows, the tests would still be green, and the model would keep re-deriving
   * its plan from its own prose — which is the exact failure this store exists
   * to remove. So a construction site that forgets it fails to build.
   */
  todos: TodoStore;
  /**
   * Takes the tenant, and that is the whole fix: the signature used to be
   * `() => boolean`, so the per-tenant daily cap could not be consulted through
   * it even by someone trying. It was sealed, loaded, tested, reported healthy
   * by `doctor` — and asked by nobody.
   */
  budgetExhausted: (tenant: TenantId) => boolean;
  /**
   * Asks the owner. Absent on a surface that cannot: the turn then stops with
   * `stopped: 'ask'` rather than pretending the tool failed.
   */
  approve?: Approver | undefined;
  /**
   * Il registro delle approvazioni chieste, e la loro risposta.
   *
   * Assente vuol dire che questa installazione può solo chiedere **subito**:
   * `approve` risponde sincrono o non risponde. Con il registro esiste anche
   * la terza strada — chiedere e sospendersi — che è l'unica che funziona su
   * una superficie dove l'owner non è davanti allo schermo.
   */
  approvals?: ApprovalStore | undefined;
  /**
   * Bills a model call and returns what it cost. Absent in tests; absent in
   * production means the caps are decorative, which is why `doctor` reports it.
   */
  recordSpend?: ((entry: SpendEntry) => number) | undefined;
  /**
   * Stable identity and persona, one per tenant class, each cached as its own
   * prefix. Assembled once (`agent/context/assemble.ts`); the turn selects.
   *
   * A single string was the defect: it took no tenant, so a group turn was
   * handed the owner's `identity.md` and the persona block that tells the agent
   * to elicit personal facts.
   */
  systemPrompts: SystemPrompts;
  /**
   * I fatti d'istanza di `docs/evidence/orizzonte-del-turno-2026-09-03.md`
   * Parte 0 — `cwd`, il primo livello del workspace, provider, job attivi,
   * RoT — nella **coda volatile** (`ambienteSection`), mai qui accanto a
   * `systemPrompts`: quei valori cambiano da installazione a installazione e
   * da sessione a sessione, e infilarli nel prefisso cacheable lo
   * invaliderebbe alla prima differenza.
   *
   * Una funzione e non un valore statico: letta a ogni turno da
   * `buildContext`, come `deps.now`, così una directory che guadagna un file o
   * un job aggiunto a metà sessione non restano un fatto stantio finché
   * qualcuno non riavvia. Assente = `ambienteSection` non aggiunge le due
   * righe (comportamento identico a prima di questa slice); `agent/runtime.ts`
   * la cabla leggendo le stesse fonti di `sys_inspect` — nessun ricalcolo,
   * nessuna seconda fonte.
   */
  istanza?: (() => IstanzaFacts) | undefined;
  /**
   * Il fuso dell'owner, dal root of trust sigillato — mai quello del processo.
   *
   * `ambienteSection` (`agent/context/assemble.ts`) cade su
   * `Intl.DateTimeFormat().resolvedOptions().timeZone` quando questo campo
   * manca, cioè sul fuso di **chi esegue il processo** — la VPS, non l'owner.
   * `core/scheduler/commitments.ts` e `cli/jobs.ts` calcolano già "che ora è
   * per l'owner" dallo stesso `budgets.quietHours.timezone` con la stessa
   * frase nel commento — "mai quello dell'host" — ma prima di questo campo
   * nessuno lo portava fin qui: il turno diceva al modello l'ora della
   * macchina, non quella dell'owner, ogni volta che le due differiscono.
   * `agent/runtime.ts` la cabla da `budgets.quietHours.timezone`, la stessa
   * lettura di `Runtime.quietHours` — nessuna seconda fonte.
   */
  timeZone?: string | undefined;
  /**
   * Absent in tests and before M2 is configured. When present the turn both
   * remembers what was said and recalls what is relevant — and inherits the
   * taint of whatever it recalled.
   */
  memory?: { store: MemoryStore; recall: RecallDeps } | undefined;
  /**
   * The capability declarations, so the resource handed to the kernel comes
   * from `resourceKind`/`policyArgs` instead of a hardcoded argument name, and
   * so `visibleTools` can filter a member's tool menu by the same `hostOnly`
   * field the kernel reads.
   *
   * **Required, and that is the decision** — same reasoning as `turns` and
   * `todos` above, which name this field as the one that used to get the
   * optional treatment instead. It used to be optional "so existing tests can
   * build a minimal deps object", on the claim that both consumers degrade
   * safely on absence. They do not: the kernel's own resource lookup refuses a
   * url capability whose resource never arrived, but `visibleTools` used to
   * treat "no declarations" as "no filtering" and hand a member a menu that
   * named every host-only tool by capability — a leaky menu, not an unguarded
   * allow (the kernel still refuses the call), but a defect in its own right.
   * A construction site that forgets this now fails to build rather than
   * shipping the leaky menu to whichever install runs it. See
   * `visibleTools` in `agent/context/assemble.ts`.
   */
  capabilities: ReadonlyMap<CapabilityId, CapabilityDecl>;
  /**
   * **Stanza → capability concesse**, dalla `rot/policy.json` sigillata
   * (`PolicyMatrix.grants`, ADR-0073 punto 1). Serve a una cosa sola:
   * `visibleTools`, perché il menu del modello e il kernel devono rispondere
   * la stessa cosa su cosa una stanza raggiunge.
   *
   * Opzionale, a differenza di `capabilities` qui sopra, e la ragione è la
   * direzione in cui degrada: dimenticarla nasconde al membro una capability
   * che il sigillo gli ha concesso — la stanza non la usa mai — mentre
   * dimenticare `capabilities` gliele mostrava tutte. Il primo è un menu
   * povero, il secondo era un menu che mente. Ciò che rende accettabile
   * l'opzionale è che il cablaggio vero è provato sul binario: lo scenario di
   * accettazione F7 fa salvare qualcosa a un membro, e senza questa riga il
   * tool non comparirebbe nel suo menu.
   */
  grants?: ReadonlyMap<TenantId, ReadonlySet<CapabilityId>>;
  /**
   * Il registro di undo, cioè l'implementazione del verdetto `draft`.
   *
   * Assente = `draft` rifiuta. È il verso giusto in cui degradare: un runtime
   * che si dimentica di passarlo perde la scrittura di file, non la
   * reversibilità di una scrittura già avvenuta. Il verso opposto — eseguire
   * senza copia — è esattamente ciò che il kernel aveva escluso decidendo
   * `draft` invece di `allow`.
   */
  undo?: UndoJournal | undefined;
  /**
   * The turn ended. **Synchronous, and it must not block.**
   *
   * The loop had no way to hand a finished turn to anything, which is why the
   * memory lane never started: `ingestPending` was correct and had one caller,
   * a person typing `muffin memory extract`. This is that missing seam, and its
   * contract is narrow on purpose — it is called from `finish`, microseconds
   * before the caller writes the reply, so anything that awaits here is
   * something the owner waits for. The implementation
   * (`core/memory/consolidator.ts`) arms a timer and returns.
   *
   * Deliberately **not** the closure-handed-back shape of
   * `agent/observe-run.ts`. There the write is withheld until delivery
   * succeeded, because an episode recorded for a message nobody received is
   * memory of something that did not happen. Here the episode is written at the
   * top of this function, before the model is called, so the trigger's input
   * exists whether or not the reply lands — withholding the notification would
   * only delay work already owed.
   *
   * Fires on every ending, `error` and `aborted` included: the owner's words
   * were recorded before the model was asked anything, so they are owed
   * extraction regardless of how the turn went.
   */
  onTurnEnd?: ((info: { tenant: TenantId; principal: Principal; stopped: TurnResult['stopped'] }) => void) | undefined;
  now?: () => Date;
};

export type TurnInput = {
  principal: Principal;
  tenant: TenantId;
  surface: string;
  session: SessionRef;
  text: string;
  /**
   * What `text` carries **beyond** the principal's own tier — content a
   * surface had to type out separately from the sender's own prose to keep it
   * honest (ADR-0046 §2: a forwarded message's original content, chiefly).
   * Absent/`0` is indistinguishable from "this surface has no such concept
   * yet", which is every caller but Telegram's connector today.
   *
   * The turn's starting taint is `max(tierOf(principal), contentTaint)`
   * (`initialTaint` below), computed once and reused at `enqueueTurn`,
   * `runTurn` and the episode/session writes inside `drive` — one number, so
   * a forwarded message cannot enter memory at the sender's tier from one of
   * those call sites while the turn itself starts higher from another
   * (DAY-1 requirement B16).
   */
  contentTaint?: TrustTier;
  /**
   * Le immagini che questo turno porta con sé, già caricate (`agent/images.ts`).
   *
   * Entrano nel **primo messaggio utente**, prima del testo: entrambe le API lo
   * raccomandano nello stesso modo, e a costo zero.
   *
   * Finiscono nel record del turno come tutto il resto, e quindi sul disco.
   * Non è gratis — una foto di telefono sono qualche centinaio di KB, in base64
   * un terzo in più — ed è comunque la forma giusta: un turno ripreso dopo un
   * crash deve poter rivedere l'immagine su cui stava ragionando, e una
   * *referenza* a un file del vault non lo garantisce (il file può non esserci
   * più). Il tetto per immagine sta in `MAX_IMAGE_BYTES`, controllato prima di
   * leggere i byte.
   */
  images?: ImageBlock[];
  /**
   * Le note vocali che questo turno porta con sé, già caricate
   * (`agent/audio.ts`) — e **solo** quando il modello accetta audio in
   * ingresso.
   *
   * Chi riempie questo campo ha già fatto la domanda a cui risponde
   * `agent/providers/modalita.ts`: se la risposta era no, qui non arriva
   * niente, perché la nota vocale è diventata testo trascritto in casa
   * (`core/audio/trascrivi.ts`) ed è entrata da `text` come qualunque altra
   * parola. Il loop non rifà quella scelta: la vede già fatta.
   *
   * Viaggiano come le immagini, e per le stesse ragioni — nel primo messaggio
   * utente, dentro il record, quindi sul disco. Il costo qui è più alto (una
   * nota vocale è più grossa di una foto) e la conclusione è la stessa: un
   * turno ripreso dopo un crash deve poter risentire ciò su cui stava
   * ragionando, e una referenza a un file del vault non lo garantisce.
   */
  audios?: AudioBlock[];
  signal?: AbortSignal;
  /**
   * Le correzioni dell'owner arrivate mentre il turno gira (`/steer`,
   * ADR-0054 §2), consegnate al prossimo confine di giro: chiamata all'inizio
   * di ogni iterazione, restituisce quelle non ancora consegnate e le svuota.
   * Assente = nessuna superficie sa correggere questo turno. Testo
   * dell'owner, al suo tier: non è contenuto esterno.
   */
  steer?: (() => string[]) | undefined;
  /**
   * Mint the row under this identity instead of a fresh random one.
   *
   * Absent on every caller that predates it (a REPL turn, a Telegram message):
   * `runTurn` keeps generating its own id, unchanged. It exists for a caller
   * that must know the turn's identity *before* the model is ever called —
   * B7's `job_fires` bridge binds `(job.id, job.nextFireAt)` to a turn id and
   * only then calls `runTurn`, so that a crash between the bind and this call
   * has somewhere durable to point at rather than a turn that never got made.
   * `deps.turns.create` already takes any caller-supplied id (`enqueueTurn`
   * does the same, for the same store); this only threads one in from the one
   * caller that has to pick it first.
   */
  id?: string | undefined;
  /**
   * The scheduled job this turn is a fire of, when it is one.
   *
   * Absent on a REPL turn, a Telegram message, a commitment — everything an
   * `undefined` here correctly describes as "not a job". Its only effect is on
   * the spend rows this turn writes: they carry the job id, so the per-job
   * ceiling in `agent/scheduler-run.ts` has a counter to read on the *next*
   * fire. It changes nothing inside this turn — a turn already running is not
   * stopped mid-flight by the per-job cap, because the cap's whole shape is
   * "do not start", and a mid-turn abort would leave paid-for work undelivered.
   */
  jobId?: string | undefined;
  /**
   * Where the answer has to go, for a surface that delivers **out of band**.
   *
   * Opaque here on purpose: the loop must not learn what a chat id is — that is
   * the boundary the previous system lost when its gateway started building
   * Telegram-shaped footers. Each surface owns the shape and validates its own.
   * Absent means the caller of `runTurn` is holding the answer itself, and
   * there is no second step that can fail.
   */
  replyTo?: Record<string, unknown> | undefined;
  /**
   * The `SurfaceRegistry` address of this turn's conversation — see
   * `ToolContext.replyChannel`, which is exactly this value, threaded through
   * unopened. A string, not `Record<string, unknown>` like `replyTo`: every
   * surface already produces this exact shape for `Deliver`/`Scheduler`
   * (`telegram:<chatId>`, `discord:<channelId>`, the bare surface id), so there
   * is nothing here for the loop to parse — it hands the string to
   * `SurfaceRegistry.deliver`/`deliverFile` unchanged, same as `job.channel`
   * always has.
   */
  replyChannel?: string | undefined;
  /**
   * Where the *final* answer's text arrives while it is still forming — DAY-1
   * B11. Per-turn, not per-runtime: a REPL prints to its own stdout, a
   * Telegram chat edits its own draft, and a job with no live surface passes
   * nothing at all, which is also the default that keeps `stream: false` on
   * the wire exactly as before this field existed (see `drive`, the call to
   * `deps.provider.chatStream`).
   *
   * **Text arrives while it is being written.** Every `text_delta` is
   * forwarded the moment it lands, and a `boundary` afterwards says what the
   * text that preceded it turned out to be. That is the opposite of what this
   * sink did until 28/08/2026, and the reversal was measured rather than
   * argued: every round was buffered and flushed only once
   * `result.toolCalls.length === 0` was already known, so a 2.278-token answer
   * appeared **all at once** at the end of a 46,7 s turn. "Late" was not
   * slightly late — it was the whole turn, which is the entire value of the
   * mechanism. A sink whose only purpose is liveness, called after the wait is
   * over, is a sink with a caller and no effect.
   *
   * The rejected alternative was "stream, then retract", and it is still
   * rejected: nothing here ever asks a surface to un-show what it printed.
   * A `boundary` is additive — it closes what came before and names it:
   *
   * - `'tool-call'` — that was the model thinking aloud on its way to a tool
   *   call, not the answer. It is *not* a retraction: the model really wrote
   *   it, a tool line follows it (`onProgress`), and until this existed that
   *   text was discarded without ever being shown or recorded, so the owner
   *   never learned why the agent did what it did.
   * - `'superseded'` — that attempt was replaced: a completion-gate nudge, a
   *   transport retry, or a stream that broke and fell back to `chat()`. Rare,
   *   and stated instead of hidden. The old design bought silence on this case
   *   by paying with the liveness of every other turn.
   *
   * **The guarantee survives.** Concatenating the `text` deltas since the last
   * boundary still gives exactly `result.text` — see `edgeTrimmer`, which does
   * character-by-character what `String.prototype.trim` does when you have the
   * whole string and a live stream never does.
   *
   * A round that answers is the one branch that immediately finishes the turn
   * — a suspend can only be armed by a tool call — so text that no boundary
   * ever closes is, and stays, the answer.
   */
  onDelta?: ((delta: TurnDelta) => void) | undefined;
  /**
   * A fact about this turn's own progress, fired the moment it becomes true
   * — a round starting, a model call finishing, a tool call starting or
   * ending. DAY-1 requirement B13: a long turn saying it is alive *structurally*, not
   * cosmetically (`turns.updated_at` is the structural data B13 names as
   * already existing with no reader; this is the reader, and the
   * surface-facing half B13 was still missing).
   *
   * **A second sink, not a wider `onDelta`.** The two exist for opposite
   * invariants, and merging them would put progress under a buffering rule
   * built for a different problem. `onDelta` carries the final answer's own
   * text, which a surface must never have to *un-show* once printed — so
   * every round is buffered internally and only the one that turns out to
   * be terminal ever reaches it (see `onDelta`'s own docstring immediately
   * above). A progress event reports something that has **already
   * happened** — the round already started, the call already finished, the
   * tool already began or ended — so nothing later can contradict it and
   * there is nothing to retract. It is emitted immediately, every round,
   * tool calls included, whether or not that round turns out to be the one
   * that answers.
   *
   * Absent on a resume for the same reason `onDelta` is (see `drive`'s
   * `options.onDelta` docstring): no live surface is holding the previous
   * attempt.
   */
  onProgress?: ((event: TurnEvent) => void) | undefined;
};

/**
 * One increment of the answer as it is being written, or the line under what
 * came before it. See `TurnInput.onDelta` for what each boundary means and for
 * the invariant a surface can rely on: the `text` deltas since the last
 * boundary concatenate to exactly `result.text`.
 */
export type TurnDelta =
  | { type: 'text'; text: string }
  | { type: 'boundary'; reason: 'tool-call' | 'superseded' };

/**
 * One fact about a turn's own progress, already true by the time it is
 * emitted — see `TurnInput.onProgress`. A discriminated union so each
 * variant declares exactly the fields it has, rather than one shape wide
 * enough for all four with the unused ones silently `undefined`.
 *
 * Every field here is read from the same values the sibling
 * `muffin.chat_call`/`muffin.tool_call` spans are given, at the same call
 * site that creates or ends them — never recomputed, so the trace and this
 * channel cannot silently disagree about what happened.
 */
export type TurnEvent =
  | { type: 'round'; n: number }
  | {
      type: 'model_status';
      status: 'waiting_for_model' | 'thinking' | 'receiving' | 'stalled';
      elapsedMs: number;
      idleMs: number;
    }
  | {
      type: 'model';
      model: string;
      ms: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      stopReason: string;
    }
  /**
   * `args` sono gli argomenti **come il modello li ha chiesti**, non ripuliti.
   *
   * Ci sono perché senza, una superficie può dire solo *quale* tool è partito,
   * mai su cosa: sette `memory_search` con sette query diverse stampavano sette
   * righe identiche («✓ cerco in memoria»), e a schermo si legge come un giro a
   * vuoto. Non lo era — misurato sul WAL il 28/08/2026, sette `args_digest`
   * diversi. Il difetto era la riga, non il loop.
   *
   * La seconda meta di quella misura — «nell'intero store non esiste una sola
   * coppia (tool, args) ripetuta» — **non vale piu**, ed e stata tolta invece
   * che lasciata a dire di no a chi la rilegge. Sul `muffin.db` dell'owner il
   * 30/08/2026 il turno a747ae67 (del 28/08 stesso) ne ha quattro, con
   * risultati byte-identici. Il giro a vuoto esiste, ed e per quello che
   * `runTool` guarda `identicalCallsDone`.
   *
   * Il loop li passa e basta: **quale** campo valga la pena mostrare, e come
   * accorciarlo, è una decisione di chi disegna — la stessa ragione per cui la
   * frase in italiano vive in `cli/repl.ts` e non su `ToolSpec`. Chi li stampa
   * li tratta come non fidati: dentro c'è testo scritto dal modello.
   */
  | { type: 'tool_start'; name: string; capability: string; args?: unknown }
  /**
   * La chiamata non è finita e non è fallita: **è ferma su di te**.
   *
   * Esiste perché le altre due parole erano tutte e due false. Chiudere con
   * `tool_end` e `isError: false` mette una spunta accanto a un comando che
   * non è partito; con `isError: true` mette una croce accanto a qualcosa che
   * non si è rotto. Chi guarda lo schermo in quel momento sta cercando di
   * capire se deve fare qualcosa lui — ed è esattamente quello che deve fare.
   */
  | { type: 'ask'; name: string; capability: string }
  /**
   * Un tentativo transitorio è andato male e se ne fa un altro.
   *
   * Esiste perché un retry silenzioso è indistinguibile da uno stallo: chi
   * guarda vede lo spinner fermo per il doppio del tempo e non sa se stia
   * succedendo qualcosa. `attempt` è il numero del tentativo che sta per
   * partire (2 = il primo ritentativo).
   */
  | { type: 'tool_retry'; name: string; attempt: number; inMs: number; why: string; args?: unknown }
  | { type: 'tool_end'; name: string; ms: number; isError: boolean; args?: unknown };

export type TurnResult = {
  text: string;
  iterations: number;
  traceId: string;
  /**
   * The turn's row, which is also `traceId` — one identity, so "what did it do"
   * and "why did it do that" are a join rather than a correlation. Returned so
   * a surface can record how the *delivery* went, which is a second outcome and
   * never the same one as `stopped`.
   */
  turnId: string;
  /**
   * Referenced, not re-declared. This union had three literal copies — here,
   * `core/turns/store.ts` and `core/scheduler/scheduler.ts` — and the design
   * that produced the record named the divergence as this repo's typical defect
   * before it happened. `suspended` is the arm this slice adds, and adding it in
   * one place is how every consumer had to answer for it.
   */
  stopped: TurnStopped;
  /** Fine-grained reason for a non-success stop; tracing carries the same value. */
  reason?: string;
  /**
   * The taint the turn ended at — the max tier of everything that was physically
   * in its context (03 §2).
   *
   * Returned because the caller may have to **write something derived from this
   * turn**, and until this field existed it had no way to ask. `makeSnapshot`
   * keeps the taint in a closure that dies with the call, so every caller
   * holding the reply text was left guessing, and the two that guessed both
   * guessed `0`: the laundering this field closes was written *outside* the loop
   * as often as inside it (`agent/observe-run.ts`).
   *
   * Not the same value as the row's — `core/turns/store.ts` has its own column,
   * written from the same accessor. That one is state a resume reads; this one
   * is a fact the caller needs in the same breath as `text`.
   */
  taint: TrustTier;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  /** Present when `stopped` is 'ask': what the turn wanted permission for. */
  pending?: ApprovalRequest;
  /** Present when `stopped` is 'suspended': when it comes back, and why. */
  suspendedUntil?: WaitSpec;
};

/**
 * How many times a row may be picked back up before we stop trying.
 *
 * Three (ADR-0047 §1), and the bound exists because the failure it guards is
 * one this record makes *more* likely, not less: a turn whose resume kills the process would be
 * retried by every boot for ever, and the process that dies is never the one
 * that can count. Three is enough to survive a laptop closing, a `systemctl
 * restart` and one genuine crash; a fourth attempt is evidence about the turn,
 * not about the infrastructure.
 */
export const MAX_RESUMES = 3;

/** Why a resume could not happen. Never a throw: the caller has to be able to say so. */
export type ResumeRefusal = {
  turnId: string;
  why: 'not_found' | 'claimed' | 'model_changed' | 'exhausted' | 'finished';
  detail: string;
};

/**
 * A live sink for a resumed turn, handed in by whoever is picking the row
 * back up.
 *
 * Until `docs/evidence/forma-delle-superfici-2026-09-03.md` this did not
 * exist as a parameter at all, and `drive` already supported both fields —
 * the gap was never the engine, it was that nothing upstream of `resumeTurn`
 * ever *had* a sink to hand it. A turn suspended on an approval now resumes
 * on the same process that owns the lane (`agent/turn-lane.ts`'s
 * `makeLaneRunner`), and that process is exactly the one already holding the
 * durable address (`record.replyTo`) a fresh `onDelta`/`onProgress` can be
 * built against — see `ResumeStream` there for how.
 */
export type ResumeStream = {
  onDelta?: ((delta: TurnDelta) => void) | undefined;
  onProgress?: ((event: TurnEvent) => void) | undefined;
  /**
   * `/stop` and `/steer` for a turn the LANE is running, not a fresh
   * `runTurn` call — `drive` below has accepted both since before this
   * comment, `runTurn`'s own `TurnInput.signal`/`.steer` (ADR-0054) already
   * forward into it, and until now nothing upstream of `resumeTurn` ever HAD
   * a lever to hand it: the same shape of gap `onDelta`/`onProgress` were,
   * closed the same way.
   *
   * Measured 2026-09-04: a turn resumed after an ASK approval (a lane run
   * that can take as long as the tool call it is waiting on) was invisible
   * to the surface's own "is a turn live for this chat" bookkeeping
   * (`connectors/telegram/connector.ts`'s `vivi`), which is populated only
   * by `runTurn`'s call site — so `/steer` sent while that lane run was in
   * flight answered "nessun turno in corso", which was false: a turn WAS
   * running, just not through the door that ever registered one. Wiring
   * these two through is what lets a connector register the SAME `vivi`
   * entry for a resumed turn that it already does for a fresh one, so the
   * answer is honest in both directions — reachable, not just theoretically
   * plumbed.
   */
  signal?: AbortSignal | undefined;
  steer?: (() => string[]) | undefined;
};

/**
 * Compile-time exhaustiveness, not a runtime nicety.
 *
 * Called only from a `switch`'s `default` after every real case of a closed
 * union has its own `case`. If the switch stays exhaustive, TypeScript
 * narrows the switched value to `never` at that `default`, so `x` type-checks
 * against the `never` parameter here and the file compiles. The day a case is
 * added to the union without a matching `case` in that switch, `x` is no
 * longer `never` there and the build breaks — on the addition, not on
 * whatever depended on the branch nobody wrote. If it is somehow still
 * reached at runtime (a value that bypassed the type checker: a cast, a
 * dependency built from a different commit, a persisted record replayed after
 * a schema change), it throws loudly instead of letting the caller silently
 * treat the unrecognised value as whichever branch happens to be last.
 *
 * Shared between `agent/loop.ts` (the pre-loop decision switch) and
 * `agent/loop/tool-call.ts` (`runTool`'s own decision switch) — moved here,
 * not duplicated, because both switch over the same `Decision['effect']`
 * union and a second copy would be free to drift the day that union grows.
 */
export function assertNever(x: never): never {
  throw new Error(`unreachable: unhandled variant ${JSON.stringify(x)}`);
}
