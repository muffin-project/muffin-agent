import type Database from 'better-sqlite3';

/**
 * Property-based invariants on the graph (05 §3.2).
 *
 * Plain SQL, no model, no network — cheap enough to run nightly and on every
 * `muffin memory check`. These are the checks that catch the class of failure
 * the previous system specialised in: damage that reports success. An extraction
 * that silently retires the wrong belief, a vector table that stays empty, a
 * fact that ends up more trusted than the sentence it came from — none of those
 * raise an error at the time. They show up months later as "it forgot", and by
 * then the evidence of when it started is gone.
 *
 * Two severities, and the difference matters:
 *
 *   error    the data model is violated. Something is wrong now.
 *   warning  the data is legal but wants a human decision (§4: threshold audit,
 *            escalation with a merge proposal — never enforcement that blocks
 *            the ingest, because refusing to record is worse than recording
 *            untidily).
 */

export type Severity = 'error' | 'warning';

export type Violation = {
  id: string;
  severity: Severity;
  /** What this protects, in the terms of the thing that goes wrong without it. */
  what: string;
  count: number;
  /** A handful of offending rows, enough to start debugging from. */
  sample: string[];
};

/**
 * When distinct predicates cross this, consolidation proposes merges to the
 * owner. Calibrated, not invented: the previous system's graph held **43
 * distinct predicates over 329 edges**, and **26 of the 43 were used exactly
 * once** — the tail is where synonyms live (`lives_in` / `resides_in`). 80 is
 * roughly twice the observed vocabulary, so it fires when the tail has really
 * grown rather than on the first unusual sentence.
 */
export const PREDICATE_VOCABULARY_THRESHOLD = 80;

type Check = {
  id: string;
  severity: Severity;
  what: string;
  /** Returns one row per violation; the first column is the sample label. */
  sql: string;
  params?: Record<string, unknown>;
};

const CHECKS: Check[] = [
  {
    id: 'active_fact_superseded',
    severity: 'error',
    what: 'un fatto attivo non può avere un successore: o è ritirato, o è corrente',
    sql: `SELECT 'fact ' || id || ' (superseded_by ' || superseded_by || ') ma expired_at NULL' AS label
          FROM facts WHERE expired_at IS NULL AND superseded_by IS NOT NULL`,
  },
  {
    id: 'supersede_dangling',
    severity: 'error',
    what: 'superseded_by deve puntare a un fatto che esiste',
    sql: `SELECT 'fact ' || f.id || ' → ' || f.superseded_by || ' inesistente' AS label
          FROM facts f
          WHERE f.superseded_by IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM facts s WHERE s.id = f.superseded_by)`,
  },
  {
    id: 'trust_tier_raised',
    severity: 'error',
    what: 'la fiducia non sale attraversando la pipeline: un fatto non può essere più affidabile della frase da cui viene',
    sql: `SELECT 'fact ' || f.id || ' tier ' || f.trust_tier || ' < episodio ' || e.id || ' tier ' || e.trust_tier AS label
          FROM facts f JOIN episodes e ON e.id = f.episode_id
          WHERE f.trust_tier < e.trust_tier`,
  },
  {
    id: 'tenant_crossed_provenance',
    severity: 'error',
    what: "un fatto e il suo episodio di provenienza stanno nello stesso tenant, sempre",
    sql: `SELECT 'fact ' || f.id || ' (' || f.tenant_id || ') da episodio ' || e.id || ' (' || e.tenant_id || ')' AS label
          FROM facts f JOIN episodes e ON e.id = f.episode_id
          WHERE f.tenant_id <> e.tenant_id`,
  },
  {
    id: 'tenant_crossed_subject',
    severity: 'error',
    what: "un fatto e la sua entità soggetto stanno nello stesso tenant, sempre",
    sql: `SELECT 'fact ' || f.id || ' (' || f.tenant_id || ') su entità ' || s.id || ' (' || s.tenant_id || ')' AS label
          FROM facts f JOIN entities s ON s.id = f.subject_id
          WHERE f.tenant_id <> s.tenant_id`,
  },
  {
    id: 'expired_before_recorded',
    severity: 'error',
    what: 'non si può ritirare un fatto prima di averlo imparato',
    sql: `SELECT 'fact ' || id || ' expired ' || expired_at || ' < recorded ' || recorded_at AS label
          FROM facts WHERE expired_at IS NOT NULL AND expired_at < recorded_at`,
  },
  {
    id: 'confirmed_without_evidence',
    severity: 'error',
    what: "un'identità confermata deve dire su quale episodio si è confermata (mai merge silenzioso)",
    sql: `SELECT 'identity ' || id || ' ' || connector || ':' || external_id AS label
          FROM identities WHERE link_status = 'confirmed' AND link_evidence IS NULL`,
  },
  {
    id: 'functional_predicate_multivalued',
    severity: 'error',
    what: 'un predicato dichiarato funzionale ha un solo valore corrente per soggetto',
    sql: `SELECT f.tenant_id || ' · entità ' || f.subject_id || ' · ' || f.predicate || ' = ' || count(*) || ' valori attivi' AS label
          FROM facts f JOIN functional_predicates p ON p.predicate = f.predicate
          WHERE f.expired_at IS NULL
          GROUP BY f.tenant_id, f.subject_id, f.predicate
          HAVING count(*) > 1`,
  },
  {
    id: 'vector_desync',
    severity: 'error',
    what: "ogni chunk ha il suo vettore: un indice mezzo vuoto degrada il recall senza mai dare errore",
    sql: `SELECT 'chunk ' || c.id || ' senza riga in chunks_vec' AS label
          FROM chunks c WHERE NOT EXISTS (SELECT 1 FROM chunks_vec v WHERE v.rowid = c.id)`,
  },
  {
    id: 'predicate_vocabulary',
    severity: 'warning',
    what: `il vocabolario ha passato ${PREDICATE_VOCABULARY_THRESHOLD} predicati distinti: il consolidamento propone i merge, non li impone`,
    sql: `SELECT count(*) || ' predicati distinti' AS label
          FROM (SELECT DISTINCT predicate FROM facts)
          HAVING count(*) > :threshold`,
    params: { threshold: PREDICATE_VOCABULARY_THRESHOLD },
  },
];

export type CheckOptions = {
  /** Rows kept per violation for the report. */
  sampleSize?: number;
};

export type CheckResult = {
  violations: Violation[];
  /**
   * Checks that could not run, and why.
   *
   * These used to `continue` in silence, which produced the worst possible
   * output: `vector_desync` is the invariant written for the incident where
   * every vector table sat empty for weeks, and it is skipped in exactly the
   * configuration where that incident happens — no `chunks_vec` table, or a
   * caller that opened the database without the extension. The report then said
   * "all invariants respected" and exited zero. A check that did not run is not
   * a check that passed.
   */
  skipped: { id: string; why: string }[];
};

export function checkInvariants(db: Database.Database, options: CheckOptions = {}): CheckResult {
  const sampleSize = options.sampleSize ?? 5;
  const violations: Violation[] = [];
  const skipped: { id: string; why: string }[] = [];

  for (const check of CHECKS) {
    let rows: { label: string }[];
    try {
      rows = db.prepare(check.sql).all(check.params ?? {}) as { label: string }[];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no such table/.test(message)) {
        skipped.push({ id: check.id, why: 'tabella assente: nulla da controllare ancora' });
        continue;
      }
      if (/no such module/.test(message)) {
        skipped.push({ id: check.id, why: 'estensione sqlite-vec non caricata da chi ha aperto il db' });
        continue;
      }
      // Anything else is a broken check, and a broken check must be loud.
      throw error;
    }
    if (rows.length === 0) continue;
    violations.push({
      id: check.id,
      severity: check.severity,
      what: check.what,
      count: rows.length,
      sample: rows.slice(0, sampleSize).map((r) => r.label),
    });
  }

  return { violations, skipped };
}

/** Human-readable report. Empty graph and clean graph read differently on purpose. */
export function formatCheck(result: CheckResult, factCount: number): string {
  const parts: string[] = [];

  if (result.violations.length === 0) {
    parts.push(
      factCount === 0
        ? 'grafo vuoto — nessun invariante da violare (ancora)'
        : `${factCount} fatti, ${CHECKS.length - result.skipped.length}/${CHECKS.length} invarianti verificati e rispettati`,
    );
  } else {
    parts.push(
      result.violations
        .map((v) => {
          const head = `${v.severity === 'error' ? '✗' : '!'} ${v.id} (${v.count})\n  ${v.what}`;
          return `${head}\n${v.sample.map((s) => `    ${s}`).join('\n')}`;
        })
        .join('\n\n'),
    );
  }

  // Never folded into the "all respected" line: the whole point is that these
  // are not results.
  for (const s of result.skipped) parts.push(`? ${s.id} NON verificato — ${s.why}`);
  return parts.join('\n');
}
