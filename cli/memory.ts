import DatabaseCtor from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { loadConfig, paths } from '../core/config/config.js';
import { readConsolidation } from '../core/memory/consolidator.js';
import { formatConsolidationLines } from '../core/memory/ingest.js';
import { checkInvariants, formatCheck } from '../core/memory/invariants.js';
import { EVERY_INSTANT, recall } from '../core/memory/recall.js';
import { resolveContradiction, reviewLine, reviewSummary } from '../core/memory/maintenance.js';
import type { FactOrigin } from '../core/memory/schema.js';
import { makeEmbedder, OllamaEmbedder } from '../core/memory/embed.js';
import { MemoryStore, type Fact } from '../core/memory/store.js';
import { quantiNonIndicizzati } from '../core/memory/vectors.js';
import type { TrustTier } from '../core/policy/types.js';

/**
 * `muffin memory` — reading the memory without asking the agent about it.
 *
 * The point of `why` is that the answer is not generated. It is the episode,
 * verbatim, with its time and its tier: an agent asked to explain its own belief
 * will produce a fluent story whether or not one exists, and that story is the
 * least trustworthy artefact in the system. Here the provenance is a foreign key.
 *
 * `check` deliberately opens nothing but the database — no provider, no key, no
 * network. A health check that needs the thing it is checking to be configured
 * is a health check you cannot run when it matters.
 */

const TENANT = 'host';

export const MEMORY_USAGE = `usage:
  muffin memory why <fact-id>          l'episodio da cui viene un fatto
  muffin memory search "<query>" [-n N] [--history] [--as-of <data>]
                                 [--surface <connettore>] [--since <data>] [--until <data>] [--around K]
       --history      ogni istante: anche ciò che è stato superato, con cosa l'ha sostituito
       --as-of        il grafo com'era a quella data ("chi era X a maggio")
       --surface      solo ciò che è stato appreso su quel connettore
       --since/--until  solo evidenza in quella finestra
       --around K     K episodi prima e dopo ogni risultato, nel suo thread
  muffin memory extract [--limit N]    drena l'arretrato a mano (di norma parte da solo)
  muffin memory review [keep <fact-id>] [--verbose]
                                 le contraddizioni e i problemi della pipeline
                                 che aspettano te. --verbose aggiunge la
                                 risposta grezza del giudice quando non era leggibile
  muffin memory stats
  muffin memory check [--json]         invarianti del grafo (nessun modello, nessuna rete)
  muffin memory pin <fact-id>          il fatto entra in OGNI turno, senza dipendere dalla somiglianza
  muffin memory unpin <fact-id>        torna alla sola pesca per somiglianza
`;

function openStore(home: string): { db: DatabaseCtor.Database; store: MemoryStore } {
  const db = new DatabaseCtor(paths(home).db);
  db.pragma('busy_timeout = 5000');
  // Without the extension, `chunks_vec` reads as "no such module" and the vector
  // half of the checks would quietly skip — reporting a healthy index precisely
  // when nobody can see it.
  try {
    sqliteVec.load(db);
  } catch {
    /* the checks that need it degrade explicitly */
  }
  return { db, store: new MemoryStore(db) };
}

const TIER_LABEL = ['owner', 'contatto noto', 'gruppo/sconosciuto', 'web/tool esterno'] as const;

function tierName(tier: TrustTier): string {
  return `tier ${tier} · ${TIER_LABEL[tier]}`;
}

/** Said, inferred or imported — deliberately not folded into the tier label. */
function originName(origin: FactOrigin): string {
  return origin === 'said' ? 'detto' : origin === 'inferred' ? 'dedotto' : 'importato';
}

/** Spelled out rather than shown as 0/1/2: a bare integer invites averaging. */
function importanceName(importance: number): string {
  return importance >= 2 ? 'carico' : importance === 1 ? 'conta' : 'routine';
}

function factLine(f: Fact): string {
  const object = f.objectName ?? f.objectValue ?? '?';
  const state = f.expiredAt ? `ritirato il ${f.expiredAt.slice(0, 10)}` : 'attivo';
  const world =
    f.validFrom || f.validTo
      ? ` · valido ${f.validFrom?.slice(0, 10) ?? '?'} → ${f.validTo?.slice(0, 10) ?? 'oggi'}`
      : '';
  return `#${f.id} ${f.subjectName} ${f.predicate} ${object} — ${state}${world}`;
}

export function cmdMemoryWhy(home: string, factId: number): number {
  const { db, store } = openStore(home);
  try {
    const fact = store.factById(TENANT, factId);
    if (!fact) {
      process.stderr.write(`nessun fatto #${factId}\n`);
      return 1;
    }
    const episode = store.episodeById(TENANT, fact.episodeId);

    const out: string[] = [factLine(fact)];
    // `why` is the one place the two axes must not blur into each other: the
    // tier says who it came from, the origin says how we got from them to this.
    out.push(
      `  fiducia ${fact.confidence.toFixed(2)} · ${tierName(fact.trustTier)} · ` +
        `${originName(fact.origin)} · ${importanceName(fact.importance)}`,
    );
    out.push(`  imparato il ${fact.recordedAt.slice(0, 16).replace('T', ' ')}`);

    if (fact.supersededBy !== null) {
      const successor = store.factById(TENANT, fact.supersededBy);
      out.push(`  sostituito da: ${successor ? factLine(successor) : `#${fact.supersededBy} (mancante)`}`);
    }
    const replaced = db
      .prepare(`SELECT id FROM facts WHERE tenant_id = ? AND superseded_by = ?`)
      .all(TENANT, factId) as { id: number }[];
    for (const r of replaced) {
      const old = store.factById(TENANT, r.id);
      if (old) out.push(`  ha sostituito: ${factLine(old)}`);
    }

    out.push('');
    if (!episode) {
      // Impossible while the foreign key holds; worth saying out loud if it ever
      // does not, because a fact without provenance is not a fact here.
      out.push(`episodio #${fact.episodeId} MANCANTE — provenienza rotta`);
    } else {
      const where = episode.vaultPath ?? `${episode.connector}:${episode.threadKey}`;
      out.push(`da episodio #${episode.id} · ${episode.role} · ${where}`);
      out.push(`   ${episode.createdAt.slice(0, 16).replace('T', ' ')} · ${tierName(episode.trustTier)}`);
      out.push('');
      for (const line of (episode.content ?? '(nessun testo)').split('\n')) out.push(`   │ ${line}`);

      const siblings = store.factsFromEpisode(TENANT, episode.id).filter((f) => f.id !== fact.id);
      if (siblings.length > 0) {
        out.push('');
        out.push(`dallo stesso episodio:`);
        for (const s of siblings) out.push(`   ${factLine(s)}`);
      }
    }

    process.stdout.write(`${out.join('\n')}\n`);
    return 0;
  } finally {
    db.close();
  }
}

export async function cmdMemorySearch(
  home: string,
  query: string,
  options: {
    limit?: number;
    history?: boolean;
    asOf?: string;
    surface?: string;
    since?: string;
    until?: string;
    around?: number;
  },
): Promise<number> {
  // Search is the one subcommand that wants the full runtime: the embedder and
  // the reranker live there, and a search that silently skips them would report
  // a worse memory than the one you have.
  const { buildRuntime } = await import('../agent/runtime.js');
  const runtime = buildRuntime(home);
  try {
    // `--as-of` and `--history` are two spellings of one parameter, and the
    // explicit date wins: asking for both is asking for an instant, and the
    // instant is the more specific of the two.
    const when = options.asOf ?? (options.history ? EVERY_INSTANT : undefined);
    const result = await recall(runtime.memory.recall, TENANT, query, {
      ...(options.limit ? { limit: options.limit } : {}),
      ...(when === undefined ? {} : { asOf: when }),
      ...(options.surface ? { surface: options.surface } : {}),
      ...(options.since ? { since: options.since } : {}),
      ...(options.until ? { until: options.until } : {}),
      ...(options.around ? { neighbours: options.around } : {}),
    });
    // Printed before the early return, because a gap is the answer to a
    // temporal question the memory cannot reach — and the run where it is the
    // *only* output is exactly the run where it matters most.
    for (const gap of result.gaps) {
      process.stdout.write(
        `su ${gap.entity} non ho niente che valga per il ${gap.asOf.slice(0, 10)}` +
          (gap.nearest
            ? `; il più vicino è del ${gap.nearest.recordedAt.slice(0, 10)}: ${gap.nearest.text}`
            : '') +
          '\n',
      );
    }
    if (result.items.length === 0) {
      process.stderr.write(`nessun risultato · strategie: ${result.strategies.join(', ') || 'nessuna'}\n`);
      // A gap is a finding, not an empty search: exit 0 so a script can tell
      // "the memory answered, and the answer is that it does not know" from
      // "the memory found nothing at all".
      return result.gaps.length > 0 ? 0 : 1;
    }
    const lines = result.items.map((item) => {
      const marks = [
        item.expired ? 'RITIRATO' : '',
        item.neighbourOf === undefined ? '' : `intorno a #${item.neighbourOf}`,
        item.validFrom || item.validTo
          ? `valido ${item.validFrom?.slice(0, 10) ?? '?'} → ${item.validTo?.slice(0, 10) ?? 'oggi'}`
          : '',
      ].filter((m) => m !== '');
      const head = `[${item.kind} #${item.id}] ${item.source}${marks.length > 0 ? ` · ${marks.join(' · ')}` : ''}`;
      const body = `   ${item.text.replace(/\n/g, '\n   ')}`;
      // The successor is what turns "Marco, retired" into an answer: without it
      // the owner reads a name and has to run `why` to find out what replaced it.
      const successor = item.replacedBy ? `\n   ↳ sostituito da #${item.replacedBy.id} ${item.replacedBy.text}` : '';
      return `${head}\n${body}${successor}`;
    });
    process.stdout.write(`${lines.join('\n\n')}\n`);
    process.stderr.write(`\n${result.items.length} risultati · strategie: ${result.strategies.join(', ')}\n`);
    return 0;
  } finally {
    runtime.close();
  }
}

/**
 * Runs the ingestion batch by hand.
 *
 * No longer the *only* trigger: ADR-0038 gave the lane a trailing-edge debounce
 * armed by the end of every turn, so this is the drain, not the pump. It goes
 * through `runtime.consolidation` rather than calling `ingestPending` directly,
 * so a hand-typed run and an automatic one cannot diverge — same budget gate,
 * same lane lock, and the same row in the run log, which is what lets `memory
 * stats` say "it ran" without asking who started it.
 */
/**
 * Se il giro appena fatto ha prodotto progresso, e quindi vale rifarlo.
 *
 * Esportata perché è la condizione, non un dettaglio del ciclo: dentro il `for`
 * l'unico modo di provarla sarebbe costruire un runtime vero con un provider
 * vero, cioè non provarla.
 *
 * `indexed` accanto a `marked` è la riparazione. Il drenaggio dell'indice è
 * progresso quanto un'estrazione, e dopo un cambio di embedder è l'**unico**
 * progresso possibile: un wipe non lascia episodi *pending*, quindi `marked` è
 * 0 al primo giro mentre `indexed` è 200 — il `limit` di `indexBacklog`.
 * Misurato su 250 episodi: si usciva lì, con 50 sorgenti fuori dal recall
 * semantico e `doctor` che diceva «200 chunks, 200 vectors, in sync».
 *
 * Il tetto su `rounds` resta l'unico che vale sempre: è ciò che impedisce a un
 * indice enorme di trasformare un comando in una nottata.
 */
export function valeUnAltroGiro(
  report: { marked: number; indexed: number; fetched: number },
  rounds: number,
  limit: number,
): boolean {
  if (report.marked === 0 && report.indexed === 0) return false;
  // Solo quando è l'estrazione a essere a corto di lavoro: con `marked` a 0 e
  // l'indice ancora da drenare, `fetched` è 0 per costruzione, e questa riga
  // fermerebbe proprio il giro che serve.
  if (report.marked > 0 && report.fetched < Math.min(limit, 25)) return false;
  return rounds * 25 < limit;
}

export async function cmdMemoryExtract(home: string, limit: number): Promise<number> {
  const { buildRuntime } = await import('../agent/runtime.js');
  const runtime = buildRuntime(home);
  try {
    let rounds = 0;
    const total = {
      episodes: 0,
      facts: 0,
      superseded: 0,
      skipped: 0,
      skippedEmpty: 0,
      indexed: 0,
      review: 0,
      errors: 0,
    };
    for (;;) {
      const outcome = await runtime.consolidation.runNow('manual', Math.min(limit, 25));
      const report = outcome.report;
      if (!report) {
        // Budget refused it, or the batch threw. `Consolidator` has already
        // said which on stderr and written the row; there is nothing here to
        // aggregate and nothing gained by looping into the same wall.
        process.stderr.write(`  ! consolidamento non eseguito (${outcome.run.outcome})\n`);
        return 1;
      }
      total.episodes += report.episodes;
      total.facts += report.factsAdded;
      total.superseded += report.superseded;
      total.skipped += report.skippedAgentOutput;
      total.skippedEmpty += report.skippedEmpty;
      total.indexed += report.indexed;
      total.review += report.needsReview.length;
      // Both counts, same reasoning as `consolidator.ts`: a judge failure is
      // a problem this round exactly as much as anything in `errors`, and
      // the exit code below has to see the whole total, not half of it.
      total.errors += report.errors.length + report.judgeUnavailable.length;
      for (const r of report.needsReview) {
        process.stderr.write(`  ? ${r.subject} ${r.predicate}: "${r.existing}" vs "${r.incoming}" — ${r.why}\n`);
      }
      // Grouped by (subject, predicate), same renderer the automatic lane
      // uses (`consolidator.ts`) — a hand-typed run should not see three
      // copies of the same judge failure just because it was not automatic.
      for (const line of formatConsolidationLines(report)) process.stderr.write(`  ! ${line}\n`);
      rounds += 1;
      // The same stop condition as the automatic drain, from the same two
      // fields — and that is the point of it being the same. This used to be a
      // four-way test over the skip counters, which had to be kept in step with
      // every reason an episode can be marked (it already had one correction
      // for `skippedEmpty`) and still could not see the one case that matters:
      // a page whose head fails extraction permanently raises `episodes`,
      // touches no skip counter, and would have looped here until `limit` was
      // exhausted, re-paying the same failing model call each round.
      // `marked` counts the marker itself, so it cannot drift from what
      // progress means.
      if (!valeUnAltroGiro(report, rounds, limit)) break;
    }
    process.stdout.write(
      `${total.episodes} episodi estratti · ${total.facts} fatti · ${total.superseded} ritirati · ` +
        `${total.skipped} dell'agente tenuti come evidenza · ${total.indexed} chunk indicizzati` +
        `${total.skippedEmpty > 0 ? ` · ${total.skippedEmpty} vuoti segnati` : ''}` +
        `${total.review > 0 ? ` · ${total.review} da rivedere` : ''}\n`,
    );
    return total.errors > 0 ? 1 : 0;
  } finally {
    runtime.close();
  }
}

/**
 * `detail`'s first line is the summary every reader sees; a judge-unavailable
 * row appends the model's raw response after it (`ingest.ts`) — free text,
 * not a second column, per `store.ts`'s `ReviewItemInput.detail`. A row with
 * nothing appended (every other kind of pipeline error) yields an empty
 * `rawResponse`, which prints nothing extra either way.
 */
function splitReviewDetail(detail: string): { headline: string; rawResponse: string[] } {
  const [headline, ...rest] = detail.split('\n');
  return { headline: headline ?? detail, rawResponse: rest };
}

/**
 * The read side of `memory_review`, which had none.
 *
 * The judge's `review` verdict — the deliberate *"a human should decide"* — has
 * had a durable register since `6ddba7c` and, until this command, **no reader
 * anywhere in production**: `store.pendingReview` was called only by tests, and
 * the single number that surfaced (`da rivedere` in `memory stats`) counted
 * every row ever written, including the ones the conversation had long since
 * settled. That is the register in this repo's most familiar failure shape —
 * written, tested, documented, reached by nothing — and it matters more now
 * than it did, because a lane that runs unattended is precisely one whose
 * "ask a human" outcomes nobody is standing next to.
 *
 * Opens nothing but the database: no provider, no key, no network. Same
 * argument as `check` — the moment you need this is not a moment to require the
 * model to be configured.
 *
 * `verbose` reveals the judge's raw response on a row it could not read
 * (`ingest.ts` writes it as everything in `detail` after the first line) —
 * off by default because a light model's answer can run to hundreds of
 * characters, and the summary line already names the typed reason
 * (`describeFailureReason` in `judge.ts`: "vuota" · "non-json" · "schema: …").
 */
export function cmdMemoryReview(home: string, verbose = false): number {
  const { db, store } = openStore(home);
  try {
    const summary = reviewSummary(store, TENANT);
    const out: string[] = [];

    for (const item of summary.open) {
      const when = item.createdAt.slice(0, 16).replace('T', ' ');
      out.push(`#${item.reviewId} ${item.existing.subjectName} ${item.existing.predicate} — ${when}`);
      // Both spelled out with their ids, because the id is what the owner types
      // back. Printing the two values without them would be a question with no
      // way to answer it.
      out.push(`   tengo   #${item.existing.id} "${objectOf(item.existing)}" (${item.existing.recordedAt.slice(0, 10)})`);
      out.push(`   oppure  #${item.incoming.id} "${objectOf(item.incoming)}" (${item.incoming.recordedAt.slice(0, 10)})`);
      out.push(`   il giudice: ${item.why}`);
      out.push(`   → muffin memory review keep ${item.incoming.id}`);
      out.push('');
    }

    if (summary.errors.length > 0) {
      out.push('problemi della pipeline (raggruppati per messaggio):');
      for (const e of summary.errors) {
        const span =
          e.count === 1
            ? e.lastAt.slice(0, 10)
            : `${e.count}× · ${e.firstAt.slice(0, 10)} → ${e.lastAt.slice(0, 10)}`;
        const { headline, rawResponse } = splitReviewDetail(e.detail);
        out.push(`   ${span}  ${headline}`);
        if (verbose) {
          for (const line of rawResponse) out.push(`        ${line}`);
        }
      }
      out.push('');
    }

    // Not a problem awaiting a decision — the pinned core is informational,
    // shown here because `review` is already the place a human looks to see
    // what memory is doing beyond the last search, and nothing more natural
    // exists yet. Never affects the exit code below, which stays keyed on
    // `summary.open` alone.
    const pinned = store.pinnedFacts(TENANT);
    if (pinned.length > 0) {
      out.push('appuntati — sempre nel contesto, a prescindere dal recall:');
      for (const f of pinned) out.push(`   ${factLine(f)}`);
      out.push('');
    }

    if (out.length === 0) {
      // Told apart from "the register is empty", because they are different
      // findings: nothing recorded means the lane has never had to ask, and
      // nothing open means every question it asked has been answered by the
      // conversation moving on.
      process.stdout.write(
        summary.total === 0
          ? 'niente in sospeso — il giudice non ha mai dovuto chiedere\n'
          : `niente da decidere · ${summary.total} righe in archivio (mai cancellate)\n`,
      );
      return 0;
    }

    process.stdout.write(`${out.join('\n')}\n`);
    process.stderr.write(
      `${summary.open.length} da decidere · ${summary.total} righe in archivio\n`,
    );
    // Exit 1, like `check` with warnings: "someone should look". Scriptable, and
    // it is the exit code that lets a shell tell an install with open questions
    // from one without.
    return summary.open.length > 0 ? 1 : 0;
  } finally {
    db.close();
  }
}

/**
 * Answering one: keep this fact, retire the other.
 *
 * A `supersede`, which is the operation the store already has and which never
 * deletes — so the retired belief keeps `superseded_by` pointing here and
 * `muffin memory why` reads the decision back as a chain. The owner is deciding
 * by hand on a row the pipeline put in front of them, which is why this does not
 * touch the open ADR-0032 question about the model writing memory: nothing
 * here is the model.
 */
export function cmdMemoryReviewKeep(home: string, factId: number): number {
  const { db, store } = openStore(home);
  try {
    const answered = resolveContradiction(store, TENANT, factId, new Date());
    if (answered.length === 0) {
      process.stderr.write(
        `#${factId} non è uno dei due fatti di una contraddizione aperta — \`muffin memory review\` per la lista\n`,
      );
      return 1;
    }
    for (const item of answered) {
      const dropped = item.existing.id === factId ? item.incoming : item.existing;
      process.stdout.write(
        `#${item.reviewId} deciso: tengo #${factId}, ritiro #${dropped.id} "${objectOf(dropped)}"\n`,
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

function objectOf(f: Fact): string {
  return f.objectName ?? f.objectValue ?? '?';
}

/**
 * `muffin memory pin <fact-id>` / `unpin <fact-id>` — the owner's own always-
 * honoured channel onto `MemoryStore.setPinned` (see that method's own
 * comment: a terminal on the owner's machine is the trust tier `addFact`'s
 * gate is checking for, so there is no further gate to apply here).
 *
 * Dispatched from `cli/main.ts`'s `cmdMemory` like every other subcommand
 * here; id validation lives there, next to `why`'s.
 */
export function cmdMemoryPin(home: string, factId: number): number {
  const { db, store } = openStore(home);
  try {
    const fact = store.factById(TENANT, factId);
    if (!fact) {
      process.stderr.write(`nessun fatto #${factId}\n`);
      return 1;
    }
    store.setPinned(TENANT, factId, true);
    process.stdout.write(
      `#${factId} appuntato — resta nel contesto ad ogni turno, anche quando il recall non lo trova.\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}

export function cmdMemoryUnpin(home: string, factId: number): number {
  const { db, store } = openStore(home);
  try {
    const fact = store.factById(TENANT, factId);
    if (!fact) {
      process.stderr.write(`nessun fatto #${factId}\n`);
      return 1;
    }
    store.setPinned(TENANT, factId, false);
    process.stdout.write(`#${factId} non è più appuntato — torna al recall ordinario.\n`);
    return 0;
  } finally {
    db.close();
  }
}

export function cmdMemoryStats(home: string): number {
  const { db, store } = openStore(home);
  try {
    const s = store.stats(TENANT);
    const span =
      s.span.from_ && s.span.to_ ? `${s.span.from_.slice(0, 10)} → ${s.span.to_.slice(0, 10)}` : 'vuota';
    const vectorRows = tableCount(db, 'chunks');
    const vectorIndexed = tableCount(db, 'chunks_vec');
    const pendenti = sorgentiSenzaVettore(db, home);
    // `needsReview` alone was the whole read side of the register, and it counts
    // every row ever written — a number that only ever grows, on an append-only
    // table, is a number that stops being read within a week. What is *open* is
    // derived from the facts (see `maintenance.ts`), so it falls on its own when
    // the conversation settles a question.
    const review = reviewSummary(store, TENANT);

    process.stdout.write(
      [
        // "tuoi" was true of the old query, which counted only `role='user'`,
        // and false of what the lane does. The word went rather than the number:
        // this line is read to answer "è in pari?", and the honest answer counts
        // everything the lane still owes.
        `episodi        ${s.episodes} (${s.pending} da estrarre)`,
        `finestra       ${span}`,
        `entità         ${s.entities}`,
        `fatti          ${s.activeFacts} attivi · ${s.retiredFacts} ritirati`,
        `da rivedere    ${reviewLine(review.open.length, review.errors.length, review.total)}`,
        `predicati      ${s.predicates} distinti`,
        `indice vett.   ${rigaIndice(vectorRows, vectorIndexed, pendenti)}`,
        `consolidam.    ${consolidationLine(db)}`,
        '',
        ...s.topPredicates.map((p) => `  ${String(p.n).padStart(4)}  ${p.predicate}`),
      ].join('\n') + '\n',
    );
    return 0;
  } finally {
    db.close();
  }
}

/**
 * Whether the lane that fills all of the above has ever run, and when.
 *
 * Without this line the numbers cannot be read: zero facts is the correct
 * output of a working lane on a quiet week (the measured yield is one fact per
 * thirty turns) *and* the output of a lane that never starts, which is exactly
 * what this install shipped with. Distinguishing them is the whole reason the
 * run log exists — a lane that runs unattended and says nothing is
 * indistinguishable from one that does not run.
 */
function consolidationLine(db: DatabaseCtor.Database): string {
  const seen = readConsolidation(db);
  if (!seen) return `mai — parte da solo a fine turno, o \`muffin memory extract\``;
  const last = seen.last;
  const when = last.ranAt.toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
  const outcome =
    last.outcome === 'ran'
      ? `${last.episodes} episodi · ${last.facts} fatti in ${(last.ms / 1000).toFixed(1)}s`
      : last.outcome === 'budget'
        ? 'saltato: budget esaurito'
        : last.outcome === 'busy'
          ? "saltato: un'altra estrazione in corso"
          : 'fallito';
  return `${when} (${last.trigger}) · ${outcome} — ${seen.runs} run, ${seen.facts} fatti in totale`;
}

export function cmdMemoryCheck(home: string, json: boolean): number {
  const { db, store } = openStore(home);
  try {
    const result = checkInvariants(db);
    if (json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatCheck(result, store.stats(TENANT).activeFacts)}\n`);
    }
    // Errors are exit 2 because they mean the data is wrong now. Warnings and
    // unrun checks are both 1: "someone should look". A check that could not run
    // must never contribute to a zero — that is how the report said everything
    // was fine while the vector half of recall was dead.
    if (result.violations.some((v) => v.severity === 'error')) return 2;
    return result.violations.length > 0 || result.skipped.length > 0 ? 1 : 0;
  } finally {
    db.close();
  }
}

/**
 * Quante sorgenti aspettano ancora un vettore, o `null` se non si puo dire.
 *
 * `null` e non 0: «non lo so» e «non ne manca nessuna» sono due frasi diverse, e
 * scriverle uguali e il difetto che questa funzione esiste per non ripetere.
 * Un database senza le tabelle della memoria, o una config illeggibile, cadono
 * qui — non sono guasti che `memory stats` debba diagnosticare, ma non
 * autorizzano nemmeno a dire «in pari».
 *
 * L'embedder si costruisce dalla config e non si assume: se la config dice
 * `openai-compat` e questa riga contasse per Ollama, direbbe che manca tutto su
 * una macchina sana. Non lo interroga — la raggiungibilita e una domanda di
 * rete, e la fa `doctor`.
 */
function sorgentiSenzaVettore(db: DatabaseCtor.Database, home: string): number | null {
  // Due guasti diversi, e solo il secondo autorizza il silenzio.
  //
  // Una config illeggibile non impedisce di contare: `doctor` in quel caso
  // ricade sull'embedder di default (`quantiNonIndicizzatiSafe`), e questa e la
  // seconda porta dello stesso meccanismo — se le due ricadessero in modo
  // diverso, due comandi darebbero due numeri sullo stesso disco. Una config
  // illeggibile ha gia il suo allarme, e non e questo.
  let embedderId: string;
  try {
    const config = loadConfig(home, () => {});
    // **Nessun segreto viene letto qui, ed e deliberato.** Serve solo l'`id`
    // dell'embedder configurato, che e una funzione del modello e non della
    // chiave (`openai-compat:${model}`, `core/memory/embed.ts`). Costruirlo con
    // `readSecret` vorrebbe dire leggere la chiave API dell'owner per stampare
    // un conteggio — un allargamento del confine dei segreti in cambio di
    // niente, e `core/config/secret-boundary.test.ts` lo dice per nome: un
    // chiamante nuovo di `readSecret` e una decisione, non una deriva.
    //
    // La stringa vuota al posto della chiave, e non una derivazione dell'`id`
    // scritta a mano qui: cosi l'`id` continua a venire dal costruttore vero e
    // non puo divergere da quello che l'indicizzazione usa davvero. L'oggetto
    // che ne esce non e utilizzabile per embeddare, e nessuno lo usa: vive tre
    // righe e restituisce un campo.
    embedderId = makeEmbedder(config.embedder, () => '').id;
  } catch {
    embedderId = new OllamaEmbedder().id;
  }
  // Qui invece si tace: senza le tabelle della memoria la domanda non ha una
  // risposta, e «non lo so» non si scrive «zero».
  try {
    return quantiNonIndicizzati(db, embedderId);
  } catch {
    return null;
  }
}

/**
 * La riga dell'indice, che non deve poter leggersi «in pari» quando non lo e.
 *
 * Il difetto, misurato sul `muffin.db` dell'owner il 30/08/2026: la riga diceva
 * `285 chunk · 285 vettori` mentre **120 sorgenti** non avevano un vettore per
 * l'embedder configurato — cioe fuori dal recall semantico. I due numeri
 * confrontano l'indice con se stesso: dicono che quel che e gia indicizzato e
 * coerente, mai se manca qualcosa. E la stessa forma che `core/memory/vectors.ts`
 * chiama «vero e fuorviante» e che `doctor` gia evita; qui non c'era, e
 * `memory stats` e il comando che si legge per chiedere «la memoria sta bene?».
 *
 * `doctor` resta l'unico che sa dire se l'embedder **risponde**: quella e una
 * domanda di rete, e un comando di statistiche non deve farla di nascosto.
 * Questa riga ci manda, invece di tacere.
 */
function rigaIndice(chunk: number | null, vettori: number | null, pendenti: number | null): string {
  if (chunk === null) return 'assente';
  const base = `${chunk} chunk · ${vettori ?? 0} vettori`;
  if (pendenti === null) return base;
  if (pendenti === 0) return `${base}, in pari`;
  return `${base} · ${pendenti} sorgenti senza vettore, fuori dal recall semantico — \`muffin doctor\``;
}

function tableCount(db: DatabaseCtor.Database, table: string): number | null {
  try {
    return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  } catch {
    return null;
  }
}
