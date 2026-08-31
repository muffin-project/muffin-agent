import type Database from 'better-sqlite3';
import { OPEN_CONTRADICTION_FROM } from './store.js';
import type { Fact, MemoryStore } from './store.js';

/**
 * Periodic maintenance — the second of the two mechanisms M5-bis row 1 asks for.
 *
 * ADR-0038 built the first: a trailing-edge debounce that consolidates a
 * conversation twenty seconds after it stops. That handles the **flow**. This
 * file and the drain in `consolidator.ts` handle the **stock**: what accumulates
 * behind the flow, and what the flow leaves for a human.
 *
 * ## The cost rule this is built under, and it is the load-bearing one
 *
 * In the old system the dream ran on top of the work queue and was the *small*
 * half: **100 dream reports against 2 438 work-queue rows** over the same four
 * months (⬤ measured on `~/dev/Muffin/muffin.dev.db`) — 4%. A maintenance pass
 * that costs more than the lane it maintains is a worse thing than no
 * maintenance pass.
 *
 * So everything in **this file spends nothing**: no model call, no embedding,
 * no network. It is SQL over rows the lane has already produced. The one part
 * of maintenance that does call a model — the backlog drain — pays for
 * extractions the live lane would have paid for anyway, one per episode, just
 * earlier. Its total is unchanged; only its schedule moves.
 *
 * ## Why there is no time-driven pass here
 *
 * The roadmap line says "manutenzione **periodica**", and building it made the
 * word wrong. Every job named under it turns out to be driven by data, not by
 * the clock: a backlog exists or it does not, a duplicate pair exists or it does
 * not, a review row is open or it is settled. Nothing in this schema changes
 * because a day passed. A nightly cron would therefore be a timer with nothing
 * that depends on time — and the twelve systems surveyed in
 * `research/consolidamento-due-meccanismi.md` include **zero** that run a pure
 * nightly cron. The trigger stays where ADR-0038 put it: the same trailing edge,
 * in the runtime, so every process that runs turns has one.
 *
 * What a clock-driven pass *would* be for is confidence decay, and that is
 * deliberately not built — see `docs/decisions/0040-la-manutenzione-e-guidata-dai-dati.md`.
 */

/**
 * The normalisation used to decide that two beliefs are the same belief.
 *
 * Case, surrounding and internal whitespace, and trailing sentence punctuation.
 * **Nothing else**, and the omissions are the design:
 *
 *  - No diacritic folding. The FTS tokenizer strips accents because a *search*
 *    that misses a hit costs a retry; a *merge* that is wrong retires a belief,
 *    and this repo's rule is that accumulating wrongly is visible and repairable
 *    while retiring wrongly is neither.
 *  - No stemming, no stopword removal, no article stripping. "Cagliari" and "a
 *    Cagliari" stay two beliefs here. That pair is exactly the drift
 *    `research/consolidamento-due-meccanismi.md` names, and folding it away is a
 *    similarity threshold wearing a normalisation costume — the same decision,
 *    with the calibration hidden instead of stated.
 *  - No embedding, no cosine, and therefore **no threshold**. The old system's
 *    0.85 cannot be ported: per-model optima measured across five embedders span
 *    0.7 to 0.93, and at a naive 0.7 two common models produced **99.00% false
 *    positives**. Miscalibration there is catastrophic rather than gradual, and
 *    a bad merge corrupts a cluster rather than a row (arXiv:2607.26298 on
 *    transitive merge chaining). The cheapest step of Graphiti's cascade —
 *    exact normalised key — is the step that needs no calibration, so it is the
 *    only step taken.
 *
 * ⬤ **And it is the step the corpus asked for.** Over the old system's four
 * months, the graph held **2** (subject, predicate) groups with more than one
 * active value, holding 5 rows — and **both** were exact duplicates under this
 * normalisation (in fact byte-identical). Every multi-valued group that really
 * occurred was a duplicate; not one needed a similarity judgement. The
 * normalisation above is margin, not a measured need.
 */
export function normaliseObject(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/[.,;:!?\s]+$/, '');
}

/** One merge the sweep performed: the survivor, and what it retired. */
type Merge = {
  subject: string;
  predicate: string;
  object: string;
  keptFactId: number;
  retiredFactIds: number[];
};

export type SweepReport = {
  /** Groups examined — (subject, predicate) pairs holding more than one belief. */
  examined: number;
  merges: Merge[];
};

/**
 * Retires exact duplicates among the beliefs that are current right now.
 *
 * **Never deletes.** A duplicate is retired with `supersede`, which sets
 * `expired_at` and `superseded_by` and leaves the row where it was — so `muffin
 * memory why` still answers on it, `factHistory` still shows it, and a merge
 * this got wrong is visible instead of gone. That is not caution about this
 * sweep in particular: a maintenance pass is the single most dangerous place in
 * this codebase for a DELETE, because it operates in bulk with nobody watching.
 *
 * ## Why the live path cannot do this on its own
 *
 * `reconcile` compares an incoming fact against **`candidate`** — the most
 * recently recorded active belief for that (subject, predicate) — and only
 * against it. That is correct there and is itself a fix: comparing against every
 * active row used to let a correction that happened to repeat an *older* value
 * return early, before the judge ever saw the belief it was actually replacing.
 * The cost of the narrower comparison is exactly this residue: with two active
 * values already standing, a third that duplicates the non-candidate one is
 * written as a new row. The judge's `coexist` verdict and the at-least-once
 * marker (a replayed episode whose wording drifted) are the two ways a second
 * active value gets there in the first place.
 *
 * ## Determinism is what makes it safe to run twice
 *
 * The survivor is the most recently recorded row, ties broken by the larger id
 * — a total order, computed from the rows alone. Two processes sweeping at once
 * therefore choose the *same* survivor and issue the same retirements, and
 * `supersede`'s own `AND expired_at IS NULL` makes the loser's write a no-op.
 * No lock is taken and none is needed.
 *
 * The newest wins rather than the oldest because `recorded_at` is when we
 * learned it: keeping the latest telling preserves the provenance chain the
 * conversation actually produced, and the older rows keep pointing at it.
 */
export function sweepDuplicates(store: MemoryStore, tenantId: string, now: Date): SweepReport {
  const groups = store.multiValuedActiveFacts(tenantId);
  const merges: Merge[] = [];

  for (const group of groups) {
    const byObject = new Map<string, Fact[]>();
    for (const fact of group.facts) {
      // An entity-valued object is keyed on the entity id, not on its name:
      // two entities can share a name (`upsertEntity` resolves by name, so in
      // practice they do not, but the key must not depend on that holding), and
      // a rename must not merge two beliefs that were never the same one.
      const key = fact.objectId !== null ? `#${fact.objectId}` : normaliseObject(fact.objectValue ?? '');
      const bucket = byObject.get(key);
      if (bucket) bucket.push(fact);
      else byObject.set(key, [fact]);
    }

    for (const bucket of byObject.values()) {
      if (bucket.length < 2) continue;
      const ordered = [...bucket].sort(
        (a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.id - a.id,
      );
      const keep = ordered[0]!;
      const retired = ordered.slice(1);
      for (const fact of retired) {
        // `null`, not omitted, and the difference is the whole point: omitting
        // it closes world time at today's date, which for a duplicate would be
        // a claim that something stopped being true out there. It did not — the
        // duplicate was never a separate truth. Only system time moves here.
        // `schema.ts` forbids guessing `valid_from` because *"a fabricated
        // timestamp is indistinguishable from a real one a month later"*, and
        // the closing end is no different.
        store.supersede(tenantId, fact.id, keep.id, now.toISOString(), null);
      }
      merges.push({
        subject: keep.subjectName,
        predicate: keep.predicate,
        object: keep.objectName ?? keep.objectValue ?? '',
        keptFactId: keep.id,
        retiredFactIds: retired.map((f) => f.id),
      });
    }
  }

  return { examined: groups.length, merges };
}

/**
 * A contradiction the judge handed to a human, still waiting for one.
 *
 * `existing` and `incoming` are the two beliefs, both still current. `why` is
 * the judge's own reasoning, recorded at the time — not regenerated now, which
 * would be a fluent story about a decision nobody made.
 */
export type OpenContradiction = {
  reviewId: number;
  createdAt: string;
  why: string;
  existing: Fact;
  incoming: Fact;
};

/**
 * The judge's `review` verdicts that are still open, derived rather than stored.
 *
 * **`memory_review` has no status column and is not getting one.** The schema
 * says why: a register that tracked whether a human had looked yet would be the
 * workflow engine this was explicitly asked not to become. So "open" is computed
 * from the facts themselves — a contradiction is open exactly while **both** of
 * its facts are still active. The moment either one is superseded, by the owner
 * answering it or by the conversation moving past it, the question stops being
 * a question and the row becomes history without anything writing to it.
 *
 * That derivation is also what makes the register survive being read. It has
 * been append-only and write-only since it was built: `pendingReview` had zero
 * production callers, and the only thing anywhere on the read side was a bare
 * count in `muffin memory stats` that included every row ever written. With the
 * lane now running unattended, that count grows and never falls, which is the
 * fastest way to make a number stop being read.
 */
export function openContradictions(store: MemoryStore, tenantId: string, limit = 50): OpenContradiction[] {
  const open: OpenContradiction[] = [];
  // The join has already discarded the settled ones, so the two lookups below
  // are paid per *open* item — a set that is small by definition, because every
  // member of it is a question waiting on a person.
  for (const row of store.openContradictions(tenantId, limit)) {
    const existing = store.factById(tenantId, row.existingFactId);
    const incoming = store.factById(tenantId, row.incomingFactId);
    // Unreachable while the join holds; kept because "open" must never mean a
    // row that cannot be shown and therefore cannot be answered.
    if (!existing || !incoming) continue;
    open.push({ reviewId: row.id, createdAt: row.createdAt, why: row.detail, existing, incoming });
  }
  return open;
}

/** One pipeline failure, with how often it has happened and when it last did. */
export type ErrorGroup = { detail: string; count: number; firstAt: string; lastAt: string };

/**
 * Pipeline errors, folded by (subject, predicate) when the row has one,
 * otherwise by message.
 *
 * Folded and not listed, because of a repeat this register makes possible: an
 * episode whose extraction fails **permanently** is deliberately left unmarked
 * so it is retried, and it writes one `error` row on every fire that reaches it.
 * At the observed fire rate that is roughly one row per turn-cluster, for ever,
 * from a single bad episode — which would bury the contradictions this register
 * exists for under a wall of the same sentence.
 *
 * Folding is done here, on the read side, and not by suppressing the write. The
 * write is the honest record of what happened and how often; a reader that
 * cannot see "this failed 400 times since June" is missing the finding.
 *
 * **Why the key is not always `detail`.** A judge-unavailable row's `detail`
 * carries the model's own raw response (`ingest.ts`), which is free to differ
 * on every call even for the exact same recurring failure — three unreadable
 * answers on `owner/interest` are not required to be the same three
 * characters. Folding on that text verbatim would stop grouping the one kind
 * of row this register most needs to group. `subject`/`predicate` are stable
 * for the same pair regardless of what the model said this time, and
 * `recordReview` already writes them as columns for exactly this case, so the
 * key is available without parsing `detail`. Rows with neither — a failed
 * extraction, a dead vector index — keep folding on the message, unchanged:
 * that text is deterministic per failure (the episode id and the error are
 * both fixed), which is what made folding on it correct in the first place.
 */
export function errorGroups(store: MemoryStore, tenantId: string, limit = 20): ErrorGroup[] {
  const groups = new Map<string, ErrorGroup>();
  for (const item of store.pendingReview(tenantId, 500)) {
    if (item.kind !== 'error') continue;
    const key = item.subject && item.predicate ? `${item.subject}\t${item.predicate}` : item.detail;
    const seen = groups.get(key);
    if (seen) {
      seen.count += 1;
      // `pendingReview` returns newest first, so a later row is always older.
      seen.firstAt = item.createdAt;
    } else {
      groups.set(key, {
        // The newest occurrence's text — the freshest raw response, when
        // there is one — since this is the first (and therefore most recent,
        // per the newest-first order above) row seen for this key.
        detail: item.detail,
        count: 1,
        firstAt: item.createdAt,
        lastAt: item.createdAt,
      });
    }
  }
  return [...groups.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, limit);
}

/**
 * Answering a contradiction: keep one belief, retire the other.
 *
 * The whole action, and it is a `supersede` — the operation that already exists
 * and already never deletes. The retired row keeps `superseded_by` pointing at
 * the survivor, so `muffin memory why` reads the owner's decision back as a
 * chain rather than as an absence.
 *
 * Two things it deliberately is not. It is **not a new store table**: the answer
 * lives in the facts, where the question lived. And it is **not the model
 * writing memory** — this is the owner deciding, by hand, on a row the pipeline
 * put in front of them, so it leaves ADR-0032 (*"il contributo del modello al
 * contenuto della memoria è zero, non indiretto"*) exactly where it was. The
 * open question about a `ricorda` tool that writes is a different question and
 * this does not touch it.
 *
 * Returns the review rows it answered. Zero means the id was not one of the two
 * facts in any open contradiction — which is a caller error worth reporting, not
 * a silent no-op.
 */
export function resolveContradiction(
  store: MemoryStore,
  tenantId: string,
  keepFactId: number,
  now: Date,
): OpenContradiction[] {
  const answered: OpenContradiction[] = [];
  for (const open of openContradictions(store, tenantId, 500)) {
    const drop =
      open.existing.id === keepFactId
        ? open.incoming
        : open.incoming.id === keepFactId
          ? open.existing
          : null;
    if (!drop) continue;
    store.supersede(tenantId, drop.id, keepFactId, now.toISOString());
    answered.push(open);
  }
  return answered;
}

/**
 * What the surfaces say about the register, in one place.
 *
 * Same argument as `consolidationBootLine`: two vocabularies for one state is
 * how "is it working" stops having an answer.
 */
export function reviewLine(open: number, errors: number, total: number): string {
  if (total === 0) return 'niente in sospeso';
  const parts: string[] = [];
  if (open > 0) parts.push(`${open} da decidere`);
  if (errors > 0) parts.push(`${errors} problemi ricorrenti`);
  if (parts.length === 0) return `niente da decidere (${total} righe in archivio)`;
  return `${parts.join(' · ')} — \`muffin memory review\``;
}

/**
 * What a surface says at boot when the judge is waiting on the owner — and
 * `null` when it is not.
 *
 * Null rather than a cheerful "0 da decidere" for the reason ADR-0038 gives for
 * the consolidation line being the opposite way round: that one is always
 * printed because a *silent* lane cannot be told from a dead one, whereas this
 * one is a request for the owner's attention, and a request printed at every
 * boot when there is nothing to attend to is how a line stops being read. The
 * old system's proactivity was a firehose of *"ho notato X, ho notato Y"* and
 * ADR-0028 exists because of it; a banner that fires on the empty case is the
 * same mistake in a smaller costume.
 */
export function reviewBootLine(db: Database.Database, tenantId: string): string | null {
  const open = readOpenContradictions(db, tenantId);
  if (open === null || open === 0) return null;
  return `memoria: ${open} contraddizion${open === 1 ? 'e' : 'i'} aspetta${open === 1 ? '' : 'no'} te — \`muffin memory review\``;
}

/** Everything the read side of the register needs, in one pass. */
export type ReviewSummary = {
  open: OpenContradiction[];
  errors: ErrorGroup[];
  /** Every row ever recorded. Never falls: the register is append-only. */
  total: number;
};

/**
 * How many contradictions are open, read without being able to write.
 *
 * The `readConsolidation` shape, for the same reason: `muffin doctor` opens the
 * database **readonly** so that looking at Muffin can never create or migrate
 * anything, and `new MemoryStore(db)` runs DDL in its constructor. Null means
 * the register is not there yet — an install from before it existed — which is
 * silence, not "nothing to decide".
 */
export function readOpenContradictions(db: Database.Database, tenantId: string): number | null {
  try {
    const row = db.prepare(`SELECT count(*) AS n ${OPEN_CONTRADICTION_FROM}`).get(tenantId) as {
      n: number;
    };
    return row.n;
  } catch {
    return null;
  }
}

export function reviewSummary(store: MemoryStore, tenantId: string): ReviewSummary {
  return {
    open: openContradictions(store, tenantId),
    errors: errorGroups(store, tenantId),
    total: store.stats(tenantId).needsReview,
  };
}
