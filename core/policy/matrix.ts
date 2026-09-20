import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { paths } from '../config/config.js';
import type { CapabilityId, EffectRow, RiskClass, TenantId, TrustTier } from './types.js';

/**
 * The permission matrix, read from the root of trust — the first real reader of
 * `rot/policy.json`.
 *
 * The file shipped with the RoT scaffold, was hashed by `verify` from day one,
 * and called itself binding: *"Part of the Root of Trust: the agent loop cannot
 * change this at runtime."* Nothing opened it. The three values it declares
 * lived as `const`s in `decide.ts`, which meant the sentence was false in the
 * only direction that matters — the owner could not change what a group may do
 * without editing TypeScript, and a sealed file was making a promise about
 * behaviour it had no connection to. Fifth instance of the house defect
 * (blueprint 03 §4 lists the matrix as RoT item 2; egress was item 3 and got
 * its reader first).
 *
 * The load happens once, where the kernel's context is built. `decide` stays
 * pure and synchronous: a decision must be explainable from a snapshot, never
 * from whatever was on disk at the microsecond it ran (ADR-0013).
 */

/** 0..3 as a schema, so the parse and the type cannot drift (PRACTICES.md#parse-at-boundaries-preserve-provenance). */
const Tier = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);

const PolicyFileSchema = z
  .object({
    _comment: z.string().optional(),
    schemaVersion: z.literal(1),
    /**
     * Partial on purpose: a file that only wants to lower `low` says so and
     * inherits the rest. Every band it omits comes from the floor below.
     */
    defaultMaxTaint: z
      .object({ low: Tier.optional(), medium: Tier.optional(), high: Tier.optional() })
      .optional(),
    /** See `PolicyMatrix.paramsMaxTaint` below for what this gates. */
    paramsMaxTaint: Tier.optional(),
    /** See `PolicyMatrix.searchMaxTaint` below. Tighten-only, unlike its sibling. */
    searchMaxTaint: Tier.optional(),
    neverAtRuntime: z.array(z.string().min(1)).optional(),
    forbiddenForSystem: z.array(z.string().min(1)).optional(),
    /**
     * The normative matrix's own rows. Partial, like `defaultMaxTaint`: a file
     * that wants to tighten one row says so and inherits the rest, and — same
     * clamp, same reason — it may only tighten.
     *
     * **`.strict()`, and that is the whole point of this object since
     * ADR-0074.** `askAbove` is gone from `RowPolicy`: the taint no longer turns
     * an `allow` or a `draft` into an `ask`. A sealed `policy.json` written
     * against the old vocabulary is therefore making a promise this build does
     * not keep — *"host asks above taint 1"* — and the one failure mode that
     * must not happen is the kernel reading the rest of that file, ignoring the
     * field in silence, and leaving the owner believing a gate that no longer
     * exists. Strict makes the unknown key an issue whose message carries the
     * key's own name, so `loadPolicyMatrix`'s fallback note says `askAbove` out
     * loud and `muffin doctor` prints it. Refusing the file is the fail-closed
     * direction here for the same reason the deny lists are unioned: the floor
     * is stricter than any row a file could have widened.
     */
    rows: z
      .record(
        z.string(),
        z
          .object({ asksForIrreversible: z.boolean().optional(), denyAbove: Tier.optional() })
          .strict(),
      )
      .optional(),
    /**
     * **Le stanze che ricevono qualcosa in più, per nome — ADR-0073 punto 1.**
     *
     * L'unico campo di questo file che *allarga*, e l'asimmetria è deliberata:
     * restringere non chiede mai (ogni altro campo qui sopra è tighten-only),
     * allargare si scrive nel sigillo, dove serve una modifica al file **e** un
     * `muffin rot reseal` dell'owner. È la forma di Progent, e la ragione per
     * cui esiste è misurata: senza, la sola manopola disponibile sarebbe
     * togliere `hostOnly` a una capability in TypeScript, cioè concederla a
     * *ogni* stanza in una volta.
     *
     * Un grant **aggiunge** a una stanza nominata (`group:…`, `community:…`) le
     * capability che in quella stanza smettono di essere `hostOnly`. Non toglie
     * mai niente a `host`, non nomina mai un insieme di stanze (`group:*` è
     * rifiutato), e non può nominare ciò che sta in `MAI_CONCEDIBILI`.
     * `.strict()` sul valore per la stessa ragione di `rows`: una chiave che
     * questa build non capisce, dentro un blocco che concede privilegi, deve
     * fermare il file invece di essere ignorata in silenzio.
     */
    tenants: z
      .record(z.string(), z.object({ grants: z.array(z.string().min(1)) }).strict())
      .optional(),
  })
  .superRefine((file, ctx) => {
    // Il rifiuto nomina **il campo**, come per `askAbove`: `loadPolicyMatrix`
    // costruisce la nota di fallback da `issue.path`, quindi `muffin doctor`
    // stampa `tenants.group:telegram:42.grants.0` e l'owner sa quale riga
    // riscrivere. Un grant rifiutato in silenzio sarebbe la stessa classe di
    // guasto di un `askAbove` letto e scartato: il file promette qualcosa che il
    // kernel non fa. Qui il verso è l'altro — il file promette *meno* di quel
    // che ha scritto — e il fallback è comunque la direzione chiusa, perché il
    // pavimento non concede niente a nessuna stanza.
    for (const [tenantId, entry] of Object.entries(file.tenants ?? {})) {
      const perche = tenantNonNominabile(tenantId);
      if (perche !== null) {
        ctx.addIssue({ code: 'custom', path: ['tenants', tenantId], message: perche });
        continue;
      }
      entry.grants.forEach((capability, index) => {
        const why = nonConcedibile(capability);
        if (why !== null) {
          ctx.addIssue({
            code: 'custom',
            path: ['tenants', tenantId, 'grants', index],
            message: why,
          });
        }
      });
    }
  });

/**
 * **La lista chiusa di ciò che nessun sigillo può concedere a una stanza.**
 *
 * Scritta qui, in codice sotto revisione, e non nel file che la userebbe: il
 * file sigillato e la dichiarazione non sono lo stesso dominio di fiducia
 * (`merge` sotto lo argomenta per `defaultMaxTaint`), e una lista di divieti
 * che vive nello stesso file che concede è una lista che chi concede può
 * accorciare.
 *
 * Le voci, e perché ciascuna:
 *
 * - `sys.shell`, `sys.shell.*` — direzione owner del 04/09, alla lettera:
 *   *«shell no»*. Una stanza non ha una macchina.
 * - `sys.process.*` — gli stessi processi, dalla porta accanto.
 * - `fs.*` — non esiste uno spazio su disco *della stanza*: `resolveWorkspace`
 *   ne conosce uno per installazione (ADR-0059), quindi concedere `fs.write` a
 *   un gruppo vorrebbe dire dargli il disco dell'owner. Lo spazio della stanza
 *   è il suo vault (`vault.write`).
 * - `rot.*` — già in `neverAtRuntime`: qui è la cintura, perché un grant che
 *   la nominasse sarebbe un file che prova a concedere la propria riscrittura.
 * - `outward.*` — un destinatario nuovo non è dentro il confine della stanza,
 *   ed è la riga che `forbiddenForSystem` già protegge dagli autonomi.
 * - `config.*` — ADR-0070: il modello non cambia le impostazioni, e a maggior
 *   ragione non lo fa un membro.
 *
 * Un grant nomina **una capability**, mai un insieme: `sys.*` o un qualunque
 * id con `*` dentro è rifiutato anche quando il prefisso non è in questa
 * lista. Concedere per famiglia significherebbe concedere in anticipo ciò che
 * qualcuno spedirà domani sotto lo stesso prefisso — che è esattamente
 * l'argomento per cui `denyListCovers` esiste, letto al contrario.
 */
export const MAI_CONCEDIBILI: readonly CapabilityId[] = [
  /**
   * Il registro degli effetti (D15). `hostOnly: true` da solo non basta: dopo
   * ADR-0073 quel campo è condizionato a `!grantedTo(...)` (`decide.ts`),
   * quindi un grant sigillato lo aprirebbe a una stanza — e `readEffects` non
   * ha nessun filtro per tenant, quindi quella stanza riceverebbe la giornata
   * **intera** dell'installazione: percorsi sul disco dell'owner, URL
   * raggiunti, comandi eseguiti per qualcun altro.
   *
   * La lista chiusa è la risposta giusta finché il registro non sa dire «cosa
   * ho fatto **in questa stanza**», che è una domanda diversa e che D15 non
   * fa. Il giorno che la sapesse, questa riga si toglie insieme al filtro che
   * la rende inutile — non prima.
   */
  'sys.effects',
  'sys.shell',
  'sys.shell.*',
  'sys.process.*',
  'fs.*',
  'rot.*',
  'outward.*',
  'config.*',
];

const MAI_CONCEDIBILI_SET: ReadonlySet<CapabilityId> = new Set(MAI_CONCEDIBILI);

/** `null` se la capability si può concedere; altrimenti la frase che dice perché no. */
export function nonConcedibile(capability: string): string | null {
  if (capability.includes('*')) {
    return `"${capability}": un grant nomina una capability, mai una famiglia`;
  }
  if (denyListCovers(MAI_CONCEDIBILI_SET, capability)) {
    return `"${capability}" non è concedibile a una stanza (lista chiusa in core/policy/matrix.ts)`;
  }
  return null;
}

/** `null` se questa chiave è una stanza nominata; altrimenti perché non lo è. */
export function tenantNonNominabile(tenantId: string): string | null {
  if (tenantId.includes('*')) {
    return `"${tenantId}": un grant nomina una stanza, mai un insieme di stanze`;
  }
  if (!tenantId.startsWith('group:') && !tenantId.startsWith('community:')) {
    return `"${tenantId}" non è una stanza: un grant vale solo per group:… o community:…`;
  }
  return null;
}

/**
 * One row of the threat model's matrix: a ceiling over the taint columns, and
 * the answer to *does irreversibility matter here*.
 *
 * `denyAbove` is unchanged since ADR-0044 — above it the row is out of reach,
 * `3` means the matrix does not constrain that column, `-1` means never at any
 * taint. It is the ceiling, and the ceiling is still the taint's job.
 *
 * `asksForIrreversible` replaced `askAbove` in ADR-0074. The old field said
 * *"above this taint nothing on this row may run unattended"*, which made the
 * turn's ambient taint a reason to ask about an action that has an undo:
 * after reading one web page, `fs.write` — journalled, with `muffin undo`
 * behind it — asked. Measured on the real installation, all 35 approvals ever
 * requested were `sys.shell` at taint 2, granted 32 times: a gate conceded
 * nine times out of ten is a reflex, not a decision. The taint still denies
 * above `denyAbove` and still stamps episodes; it no longer converts an
 * `allow` or a `draft` into an `ask`.
 *
 * What is left is the question the confirmation was always for: **can this be
 * taken back?** `true` on the rows where the answer decides something — the
 * host machine, third-party code, a new recipient — and `false` where an
 * irreversible-by-declaration effect is still the conversation itself
 * (`reply`), an episode that can be deleted (`memory`), bytes merely entering
 * the turn (`context`), or a destination the allowlist and `gateParams`
 * already own (`egress`).
 */
export type RowPolicy = { readonly asksForIrreversible: boolean; readonly denyAbove: number };

export type PolicyMatrix = {
  /**
   * The ceiling and the unattended-floor **by effect row** — where the bytes
   * land — which is how `docs/history/rebuild-2026/03-threat-model.md` §3 has
   * always printed it. This replaced `defaultMaxTaint[risk]` as the ceiling in
   * ADR-0053, after the two were measured to disagree on a row the document
   * calls `ASK` and the kernel answered `deny`.
   */
  readonly rows: Readonly<Record<EffectRow, RowPolicy>>;
  /**
   * Ceiling by risk class. **Inert since ADR-0053: nothing reads it as a
   * ceiling.** `rows` owns that, and `decide.ts` never touches this field.
   *
   * It is still parsed, still merged with the same downward clamp, and still
   * shown by `muffin config --all`, because a home sealed before ADR-0053 must
   * keep parsing and because this inventory answers "which file holds this
   * value", not "which value won". Do not read the two facts as one: an owner
   * who had **tightened** a class in a resealed `policy.json` loses that
   * tightening here, silently, and that residual is declared in ADR-0053
   * §Conseguenze. A tightening written today goes in `rows`, which is the
   * vocabulary the kernel reads.
   */
  readonly defaultMaxTaint: Readonly<Record<RiskClass, TrustTier>>;
  /**
   * Ceiling for model-chosen bytes riding out in a resource the model
   * controls: a `url` resource's query/fragment once its host has already
   * cleared the egress allowlist, and the full text of a `query` resource
   * (`sys.search`). One scalar for both, because `decide.ts`'s `gateParams`
   * asks the identical question of each — is this turn's taint low enough
   * that a destination already fixed (by the allowlist, or by the search
   * endpoint's own registration) may also carry bytes the model chose? Above
   * the ceiling: `ask` for the owner, showing the exact bytes
   * (`ApprovalRequest.resource`, `agent/loop.ts`); `deny` for anyone else,
   * always — never a silent allow, the shape `sys.shell` already uses above
   * its own ceiling (ADR-0044 §revisione).
   *
   * Unlike `defaultMaxTaint`, the sealed file may RAISE this, not only lower
   * it (`merge()` reads it directly, no `tighter()` clamp). Deliberate, not
   * an oversight of the tighten-only rule one field up: `defaultMaxTaint` is
   * inherited by every capability that pins no `maxTaint` of its own, so one
   * widened number in a resealed file silently loosens capabilities nobody
   * reviewed for it (the `mcp.*` measurement in this file's docstring).
   * `paramsMaxTaint` has exactly two callers, both named above, and raising
   * it never grants anyone but the owner anything — it only moves the taint
   * value at which the owner starts being asked.
   *
   * **Ships 2** (decisione owner, 2026-08-17): tier 2 is the owner's own disk
   * and local data, and asking about every search that follows a file read
   * would make the ASK a reflex to dismiss rather than a decision — the
   * failure mode the mandate's §D12 names. Tier 3 is the outside world (web,
   * search results, MCP, forwarded content), and that is the taint at which
   * model-chosen bytes in a query stop being the owner's own words. Whichever
   * the value, a non-owner principal is refused, never asked.
   */
  readonly paramsMaxTaint: TrustTier;
  /**
   * Lo stesso cancello, ma per il testo di una **ricerca** — separato dal
   * numero sopra il 04/09/2026, e spedito a **3**, cioè mai.
   *
   * Era la stessa soglia, e il commento qui sopra aveva già scritto metà
   * della ragione per cui non poteva restarlo: *«asking about every search
   * that follows a file read would make the ASK a reflex to dismiss»*. Quella
   * frase valeva per il tier 2. Al tier 3 succede la stessa cosa, e succede
   * nel giro più normale che esista: cerca → leggi una pagina → cerca ancora.
   * Il secondo `web_search` chiedeva **sempre**, perché una pagina letta
   * porta il turno a 3 per costruzione.
   *
   * La ragione decisiva non è la comodità, ed è la differenza fra un agente
   * che gira davanti a qualcuno e uno che gira da solo: **un'approvazione che
   * nessuno può dare è un divieto travestito.** Su un processo headless — la
   * VPS, un job dello scheduler — quell'`ask` è un `exit 3`, cioè il turno si
   * ferma per un'azione a basso rischio. Il modo di fallire giusto lì non è
   * fermarsi.
   *
   * Cosa **resta** in piedi, ed è il motivo per cui il rischio è accettabile:
   * il *dove* non lo sceglie il modello. La destinazione di `sys.search` è
   * una costante verificata alla registrazione e in `rot/egress.json`, non un
   * host che un contesto avvelenato possa nominare — al contrario di un URL,
   * dove il gate sui parametri resta a 2. E `sys.search` è `hostOnly`, quindi
   * questo numero non concede niente a nessuno tranne l'owner.
   *
   * Cosa si **perde**, detto invece che nascosto: un turno che ha letto un
   * segreto e lo cerca letteralmente non chiede più. Quei byte escono verso
   * il motore di ricerca configurato, non verso un endpoint scelto da chi ha
   * scritto la pagina. Decisione owner, 04/09/2026 — ADR-0072.
   *
   * Tighten-only nel merge, a differenza di `paramsMaxTaint`: il pavimento è
   * già il massimo, quindi un file sigillato può solo rimetterlo giù.
   */
  readonly searchMaxTaint: TrustTier;
  readonly neverAtRuntime: ReadonlySet<CapabilityId>;
  readonly forbiddenForSystem: ReadonlySet<CapabilityId>;
  /**
   * **Stanza → capability che lì smettono di essere `hostOnly`** — la
   * dimensione che ADR-0073 punto 1 aggiunge al kernel, e la sola cosa che
   * un `policy.json` sigillato può *allargare*.
   *
   * Vuota nel pavimento, sempre: se il file non si legge — assente, corrotto,
   * o rifiutato per un grant che nomina `sys.shell` — nessuna stanza riceve
   * niente, che è la direzione chiusa. Si legge da `grantedTo`, non a mano,
   * perché la chiave è esatta e la corrispondenza per prefisso qui sarebbe
   * una concessione per famiglia scritta di straforo.
   */
  readonly grants: ReadonlyMap<TenantId, ReadonlySet<CapabilityId>>;
  /** Which of the two produced these numbers. Surfaced by `doctor`. */
  readonly source: 'sealed' | 'fallback';
  /** Why the fallback answered. `null` whenever the sealed file did. */
  readonly note: string | null;
};

/**
 * The compiled floor: the values `decide.ts` hardcoded, and the answer when the
 * sealed file cannot be used.
 *
 * **Why falling back here is fail-closed, stated exactly, because "it is the
 * strictest sensible" is a claim and not an axiom.**
 *
 * The two deny lists are *unioned* with whatever the file says, never replaced
 * (see `merge` below). So no file — corrupt, absent, or hostile — can shorten
 * them: `rot.write` stays unreachable at runtime and `outward.send` stays out
 * of reach of autonomous principals whatever `policy.json` contains. That is
 * ADR-0013's monotone confinement applied where it means something: the file
 * may add prohibitions, it may not remove them.
 *
 * `defaultMaxTaint` **is** clamped downward — the file lowers, never raises.
 * The first version of this file argued the opposite (a declaration overrides
 * the default in both directions anyway, so why constrain the file), and a
 * judge measured what that bought: `{"medium":3}` in a resealed policy.json
 * turned `mcp.*` from "a tainted turn cannot reach a third-party server at
 * all" into a silent `allow`, because that capability — like `fs.write` and
 * `sys.shell` — inherits the class default rather than pinning its own. The
 * declaration layer and the file are not the same trust domain: one is a
 * reviewed commit, the other is a write plus a reseal. So the file is a
 * tightening knob only, exactly like the deny lists below.
 *
 * Refusing to boot instead of falling back was the other option and is worse: a
 * home installed before `policy.json` existed would be bricked by an upgrade,
 * and a bricked agent is one the owner switches off — after which nothing gets
 * investigated. `egress.json` took the same decision for the same reason
 * (`agent/runtime.ts`, the empty-allowlist path), and `decide.ts` takes it again
 * in safe mode by letting low-risk reads through.
 *
 * **The residual, named.** An owner who *tightened* a ceiling and then lost the
 * file gets the shipped ceiling back. The fallback does not cover that case —
 * the seal does: a file the manifest lists and disk no longer matches diverges,
 * which is safe mode in single-user and a refused boot in hardened, and safe
 * mode already denies everything above low risk. So the exposure is precisely
 * "low-risk capabilities, in a home that is already shouting that its root of
 * trust diverged", and `doctor` names the fallback in the same breath.
 */
/**
 * The printed matrix, transcribed — with one honest exception. Each entry cites
 * the row it comes from, and the cell-by-cell assertion lives in
 * `core/policy/effect-rows.test.ts`.
 *
 * `context` and `external` are **not** transcriptions: the document prints no
 * "reads" row, and MCP lives in prose (`docs/architecture/SECURITY.md` §10) rather than in
 * the table. `context` follows ADR-0044's own summary that reading is not
 * acting — a turn that read from disk still reads and answers — and `external`
 * keeps exactly the ceiling those capabilities already had. Both are argued in
 * ADR-0053 rather than quoted, and neither changed any behaviour.
 */
export const ROW_FLOOR: Readonly<Record<EffectRow, RowPolicy>> = {
  /**
   * Reading is not acting: ADR-0044's own summary — a turn that read from disk
   * still reads and answers. Nothing on this row leaves a trace to take back.
   */
  context: { asksForIrreversible: false, denyAbove: 3 },
  /**
   * "Shell / filesystem host / processi". **`3`, cioè su questa riga il taint
   * non nega più — ADR-0075.**
   *
   * ADR-0074 aveva già tolto al taint la facoltà di *chiedere* qui: la cella
   * `ASK` a taint 2 valeva per tutta la riga, quindi `fs.write` (con copia e
   * `muffin undo`) chiedeva per la stessa ragione di `sys.shell.write` (che
   * non ha nessun ritorno). Restava la facoltà di *negare* sopra 2, ed è
   * quella che il 06/09 è stata misurata sull'installazione dell'owner: nove
   * turni su quattordici in privato a taint 3, l'ultima shell vera il 03/09,
   * l'ultimo turno chiuso da `context taint 3 exceeds 2 for sys.shell (host)`.
   * Dopo una ricerca web niente shell e niente scrittura fino a una
   * conversazione nuova — e il modello lo raccontava come «non ho la shell».
   *
   * Il divieto non comprava sicurezza dove stava, perché dopo ADR-0074 ogni
   * capability di questa riga è già coperta da un'altra difesa: `fs.write` è
   * `draft` con giornale e undo, `sys.shell` è la corsia in sola lettura senza
   * rete e senza scrittura fuori dallo scratch, `sys.shell.write` e
   * `sys.process.kill` sono `reversible: 'no'` e quindi chiedono **sempre**, a
   * taint 0 come a taint 3. Ciò che il soffitto toglieva era solo la
   * possibilità, per l'owner, di dire sì. Il taint resta nel prompt dell'`ask`
   * come ragione visibile (`decide.ts`, `agent/loop/tool-call.ts`).
   *
   * Un `policy.json` sigillato può ancora rimettere `2`: `tighterRows` stringe
   * e non allarga, ed è la stessa manopola che ADR-0072 lascia su
   * `searchMaxTaint`.
   */
  host: { asksForIrreversible: true, denyAbove: 3 },
  /**
   * "Reply sul canale di origine": ALLOW · ALLOW · ALLOW. `false`, and the
   * declarations are why it has to be said: `surface.reply` and
   * `surface.send_file` are both `reversible: 'no'` — bytes on the wire cannot
   * be recalled — and an approval prompt that gates the reply is an approval
   * prompt that cannot be delivered. The row the matrix prints as ALLOW at
   * every taint stays ALLOW at every taint.
   */
  reply: { asksForIrreversible: false, denyAbove: 3 },
  /**
   * "Egress rete": the allowlist and `paramsMaxTaint`/`searchMaxTaint` own
   * these columns, not this row — ADR-0071 and ADR-0072 are untouched by
   * ADR-0074, and they are where an egress `ask` still comes from.
   */
  egress: { asksForIrreversible: false, denyAbove: 3 },
  /**
   * "Scrittura memoria": ALLOW · ALLOW nel tenant, tier ereditato · ALLOW,
   * tier 3. `memory.write` declares `reversible: 'no'` because nothing
   * journals it, not because an episode is unrecoverable: a row can be
   * deleted and consolidation rewrites what it derives from.
   */
  memory: { asksForIrreversible: false, denyAbove: 3 },
  /**
   * **«Scrivere nel vault del proprio tenant» — ADR-0073 punto 2, e il
   * soffitto è alto per dichiarazione, non per distrazione.**
   *
   * `denyAbove: 3` e `asksForIrreversible: false` dicono la stessa cosa da
   * due lati: una scrittura che resta **dentro** il confine del tenant che la
   * scrive non attraversa mai un `ask`, a nessun taint. Non perché chi scrive
   * sia fidato — un membro di gruppo è tier 2 per costruzione, e in un gruppo
   * un `ask` non raggiunge nessuno che possa rispondere, quindi qui una
   * domanda sarebbe un divieto travestito — ma perché il *confine* è ciò che
   * rende la scrittura sicura: nessuna lettura cross-tenant, nessun host
   * esterno, un giornale e `muffin undo` dietro (`agent/loop/tool-call.ts`,
   * ramo `draft`).
   *
   * **La mutazione che questa riga deve far cadere**, ed è nominata perché è
   * l'unico modo di sbagliarla senza accorgersene: portarla al livello delle
   * righe che escono dal tenant (`external`/`outward`: `denyAbove: 1`,
   * `asksForIrreversible: true`). Un membro a tier 2 sarebbe negato per
   * taint, e la frase dell'ADR — *«un membro salva, nessun ask»* — sarebbe
   * falsa senza che niente nel kernel lo dica.
   *
   * Ciò che il numero **non** compra, detto qui perché la riga da sola
   * sembrerebbe generosa: la capability su questa riga è `hostOnly: true`,
   * quindi la stanza la riceve solo se il `policy.json` sigillato la nomina
   * (`tenants`, sopra). La riga decide cosa succede *quando* si arriva; il
   * grant decide *se* si arriva.
   */
  vault: { asksForIrreversible: false, denyAbove: 3 },
  /**
   * Third-party code and services outside the allowlist model. The one row the
   * document does not print: MCP is covered in prose (`docs/architecture/SECURITY.md` §10),
   * and this keeps the number those capabilities already had rather than
   * inventing a widening nobody reviewed.
   *
   * `true`: we do not own the semantics on the other side of the pipe, so a
   * call that may have landed cannot be taken back. Today every MCP
   * declaration is `reversible: 'no'` by hand, so every MCP call asks — which
   * is ADR-0074 point 5's own starting position, and the thing point 5 (a
   * different slice) fixes by reading the protocol's `readOnlyHint`.
   *
   * **Sopra questo soffitto, da ADR-0075, l'owner è *chiesto* e chiunque
   * altro è negato** (`decide.ts`): dove il taint conta davvero — i byte che
   * escono dal tenant — il muro resta la forma sbagliata, perché a taint 3
   * l'owner non poteva nemmeno chiedere «cerca X e mandalo a Y». Il numero non
   * si muove: è il ramo sopra di esso che distingue chi può decidere da chi
   * non c'è.
   */
  external: { asksForIrreversible: true, denyAbove: 1 },
  /**
   * "Outward (mail, messaggi a terzi, pubblicazione)": DRAFT di default · DENY
   * · DENY. Un messaggio spedito non si ritira — e sopra il soffitto vale la
   * stessa distinzione di `external` (ADR-0075): `ask` all'owner con la
   * ragione, `deny` a tutti gli altri.
   */
  outward: { asksForIrreversible: true, denyAbove: 1 },
  /**
   * "Scrittura config/voice (cricchetto)": ALLOW solo via ratchet-API · DENY ·
   * DENY. Unchanged in effect, and inert by construction: no shipped
   * `CapabilityDecl` declares this row (ADR-0070, asserted in
   * `effect-rows.test.ts`), so the ratchet — not this boolean — is what keeps
   * the model out of the configuration. `true` is what the row would answer if
   * one ever arrived.
   */
  config: { asksForIrreversible: true, denyAbove: 1 },
  /** "Root of Trust: DENY a runtime per chiunque" — `neverAtRuntime` refuses it first; this is the belt. */
  rot: { asksForIrreversible: true, denyAbove: -1 },
};

export const POLICY_FLOOR: PolicyMatrix = {
  rows: ROW_FLOOR,
  defaultMaxTaint: { low: 3, medium: 1, high: 1 },
  paramsMaxTaint: 2,
  /** 3 = mai. Vedi `PolicyMatrix.searchMaxTaint` e ADR-0072. */
  searchMaxTaint: 3,
  /** No principal may ever exercise these at runtime, whatever the taint. */
  neverAtRuntime: new Set<CapabilityId>(['rot.write', 'rot.*']),
  /** Excluded from autonomous principals regardless of taint (blueprint 03 §3). */
  forbiddenForSystem: new Set<CapabilityId>([
    'outward.send',
    'outward.*',
    'config.ratchet',
    /**
     * Un fire gira con il runtime completo: senza questa riga il kernel
     * risponderebbe `allow` e un job creerebbe nuovi recurring job —
     * un'autonomia delegata che crea nuova autonomia durevole: cardinalità,
     * durata e spesa senza una nuova decisione owner. L'owner resta libero di
     * creare ricorrenze; i grant di stanza restano la manopola per i member
     * (questa lista non tocca `hostOnly`).
     */
    'jobs.schedule',
  ]),
  /**
   * **Il pavimento non concede niente a nessuna stanza**, e questa riga è
   * quella che rende il fallback fail-closed nel senso di ADR-0073: se il
   * file è assente, corrotto, o rifiutato perché un grant nominava
   * `sys.shell`, ogni stanza torna a essere `hostOnly` su tutto. Il residuo
   * dichiarato è simmetrico a quello di `defaultMaxTaint`, ma nella direzione
   * innocua: un owner che aveva **concesso** e poi perde il file perde la
   * concessione, non ne guadagna una.
   */
  grants: new Map<TenantId, ReadonlySet<CapabilityId>>(),
  source: 'fallback',
  note: null,
};

/**
 * Questa stanza ha ricevuto questa capability, per nome?
 *
 * Corrispondenza **esatta**, e non `denyListCovers`: quello espande i
 * namespace perché un *divieto* deve coprire ciò che nessuno ha ancora
 * scritto, mentre una *concessione* che si espandesse per prefisso
 * concederebbe in anticipo la prossima capability spedita sotto lo stesso
 * nome. Le due liste guardano nella stessa direzione (verso ciò che non
 * esiste ancora) e devono rispondere in modo opposto.
 *
 * `tenant` è quello della richiesta, che il kernel ha già verificato contro
 * il principal (`tenantOf`, `tenant_mismatch`) prima di arrivare qui: quindi
 * un membro non può nominare la stanza di qualcun altro per ereditarne i
 * grant.
 */
export function grantedTo(
  matrix: PolicyMatrix,
  tenant: TenantId,
  capability: CapabilityId,
): boolean {
  return matrix.grants.get(tenant)?.has(capability) === true;
}

/**
 * Does a deny list cover this capability? Exact id, or a namespace entry.
 *
 * Both lists are quotations from the threat model, and one of them was
 * mis-transcribed in the direction that matters. 03 §3 says *"le capability
 * `outward.*` … sono escluse del tutto da `system@scheduler` a qualunque
 * taint"* — the star is in the guarantee. The lists held bare ids and the
 * lookup was `Set.has`, so the sentence was true of exactly the one id someone
 * had thought to write down. Nothing was wrong today only because
 * `outward.send` does not exist yet: the deny was guarding an unbuilt
 * capability, and the first sibling to ship under that prefix
 * (`outward.publish`, `outward.email.send`) would have arrived as an `ask` the
 * owner can approve — for a class of action the threat model says an
 * autonomous principal must never reach at all.
 *
 * A namespace entry is `prefix.*`, matched on dotted segments and never on raw
 * string prefix: `outward.*` covers `outward.email.send` and does not cover a
 * capability that merely begins with the same letters. `rot.*` is here for the
 * same reason, one row up in the same table — *"Root of Trust | DENY a runtime
 * per chiunque"* — where `rot.write` alone would let a `rot.reseal` through.
 */
export function denyListCovers(list: ReadonlySet<CapabilityId>, capability: CapabilityId): boolean {
  if (list.has(capability)) return true;
  const parts = capability.split('.');
  for (let i = 1; i < parts.length; i += 1) {
    if (list.has(`${parts.slice(0, i).join('.')}.*`)) return true;
  }
  return false;
}

const fallback = (note: string): PolicyMatrix => ({ ...POLICY_FLOOR, note });

export function loadPolicyMatrix(home: string): PolicyMatrix {
  const file = join(paths(home).rot, 'policy.json');
  if (!existsSync(file)) return fallback(`${file} assente`);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return fallback(
      `${file} non è JSON valido: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Version before schema, like the config loader: a file from a future build
  // fails validation for reasons that have nothing to do with the real problem.
  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (version !== 1) {
    return fallback(`schemaVersion ${String(version)}, questa build ne capisce 1`);
  }

  const parsed = PolicyFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fallback(
      `${file} non valido — ${issue?.path.join('.') ?? '(root)'}: ${issue?.message ?? 'illeggibile'}`,
    );
  }
  return merge(parsed.data);
}

/** The stricter of the two, always — the file's only direction is down. */
function tighter(fromFile: TrustTier | undefined, floor: TrustTier): TrustTier {
  return fromFile !== undefined && fromFile < floor ? fromFile : floor;
}

/**
 * Same direction as `tighter`, applied to a row: the file may lower a
 * threshold, never raise one. An unknown row name in the file is ignored
 * rather than added — a row the code does not know cannot gate anything, and
 * inventing one from a sealed file would be the file granting itself a
 * vocabulary the kernel never reviewed.
 */
function tighterRows(
  fromFile:
    | Record<
        string,
        { asksForIrreversible?: boolean | undefined; denyAbove?: TrustTier | undefined }
      >
    | undefined,
): Readonly<Record<EffectRow, RowPolicy>> {
  const out = {} as Record<EffectRow, RowPolicy>;
  for (const [name, floor] of Object.entries(ROW_FLOOR) as Array<[EffectRow, RowPolicy]>) {
    const said = fromFile?.[name];
    out[name] = {
      // Tighten-only in the boolean's own direction: `true` (ask about what
      // cannot be undone on this row) is the strict value, so a file may turn
      // a `false` row on and may never turn a `true` row off. An owner who
      // wants an approval on every reply can have it; a file write plus a
      // reseal cannot silence the ask on `sys.shell`.
      asksForIrreversible: said?.asksForIrreversible === true || floor.asksForIrreversible,
      denyAbove:
        said?.denyAbove !== undefined && said.denyAbove < floor.denyAbove
          ? said.denyAbove
          : floor.denyAbove,
    };
  }
  return out;
}

function merge(file: z.infer<typeof PolicyFileSchema>): PolicyMatrix {
  return {
    rows: tighterRows(file.rows),
    // Clamped DOWNWARD, symmetric with the union below: the file may lower a
    // ceiling, never raise one. The first version left it unclamped, reasoning
    // that declarations already override in both directions — true, and a
    // different trust domain: a declaration change is a repo commit under
    // review, a policy.json change is a file write plus `muffin rot reseal`.
    // Measured on a real home before this line existed: `{"defaultMaxTaint":
    // {"medium":3}}` took `mcp.*` from "a tainted turn cannot reach a
    // third-party server at all" to a silent allow at taint 3, because
    // `mcpCapabilityFor`, `fs.write` and `sys.shell` all inherit the class
    // default instead of pinning one. Widening belongs in the declaration
    // layer, where it is reviewed; ADR-0013's monotone confinement is the rule
    // this restores.
    defaultMaxTaint: {
      low: tighter(file.defaultMaxTaint?.low, POLICY_FLOOR.defaultMaxTaint.low),
      medium: tighter(file.defaultMaxTaint?.medium, POLICY_FLOOR.defaultMaxTaint.medium),
      high: tighter(file.defaultMaxTaint?.high, POLICY_FLOOR.defaultMaxTaint.high),
    },
    // NOT `tighter()` — see the field's own doc comment on `PolicyMatrix` for
    // why this one threshold may move in both directions from the file.
    paramsMaxTaint: file.paramsMaxTaint ?? POLICY_FLOOR.paramsMaxTaint,
    // `tighter()` qui sì: il pavimento è già il massimo, quindi l'unico
    // movimento possibile da un file sigillato è rimettere il cancello.
    searchMaxTaint: tighter(file.searchMaxTaint, POLICY_FLOOR.searchMaxTaint),
    // Union, never assignment. Drop the spread of the floor and an owner — or
    // anything that can write one line into a resealed file — deletes the
    // runtime's only prohibition against writing its own root of trust.
    neverAtRuntime: new Set([...POLICY_FLOOR.neverAtRuntime, ...(file.neverAtRuntime ?? [])]),
    forbiddenForSystem: new Set([
      ...POLICY_FLOOR.forbiddenForSystem,
      ...(file.forbiddenForSystem ?? []),
    ]),
    // L'unico campo che il file **aggiunge** invece di stringere, e il solo
    // punto in cui non c'è un pavimento da unire: il pavimento è vuoto, quindi
    // qui non si perde niente. Ciò che impedisce a questa riga di essere il
    // buco che `defaultMaxTaint` è stato è `superRefine` sopra — un grant
    // fuori dalla lista chiusa non arriva qui, fa cadere il file intero.
    grants: new Map<TenantId, ReadonlySet<CapabilityId>>(
      Object.entries(file.tenants ?? {}).map(([tenantId, entry]) => [
        tenantId,
        new Set<CapabilityId>(entry.grants),
      ]),
    ),
    source: 'sealed',
    note: null,
  };
}
