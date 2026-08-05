import DatabaseCtor from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { paths } from '../core/config/config.js';
import { checkInvariants, formatViolations } from '../core/memory/invariants.js';
import { recall } from '../core/memory/recall.js';
import { MemoryStore, type Fact } from '../core/memory/store.js';
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
  muffin memory search "<query>" [-n N] [--history]
  muffin memory extract [--limit N]    lancia estrazione + indicizzazione (M5 lo schedula)
  muffin memory stats
  muffin memory check [--json]         invarianti del grafo (nessun modello, nessuna rete)
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
    out.push(`  fiducia ${fact.confidence.toFixed(2)} · ${tierName(fact.trustTier)}`);
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
  options: { limit?: number; history?: boolean },
): Promise<number> {
  // Search is the one subcommand that wants the full runtime: the embedder and
  // the reranker live there, and a search that silently skips them would report
  // a worse memory than the one you have.
  const { buildRuntime } = await import('../agent/runtime.js');
  const runtime = buildRuntime(home);
  try {
    const result = await recall(runtime.memory.recall, TENANT, query, {
      ...(options.limit ? { limit: options.limit } : {}),
      ...(options.history ? { includeHistory: true } : {}),
    });
    if (result.items.length === 0) {
      process.stderr.write(`nessun risultato · strategie: ${result.strategies.join(', ') || 'nessuna'}\n`);
      return 1;
    }
    const lines = result.items.map((item) => {
      const head = `[${item.kind} #${item.id}] ${item.source}${item.expired ? ' · RITIRATO' : ''}`;
      return `${head}\n   ${item.text.replace(/\n/g, '\n   ')}`;
    });
    process.stdout.write(`${lines.join('\n\n')}\n`);
    process.stderr.write(`\n${result.items.length} risultati · strategie: ${result.strategies.join(', ')}\n`);
    return 0;
  } finally {
    runtime.close();
  }
}

/**
 * Runs the ingestion job by hand.
 *
 * M5 schedules this; until then it needs a trigger, and having one is not a
 * stopgap — the scheduler will call exactly this function, so whatever the eval
 * exercises here is the code that runs at 3am.
 */
export async function cmdMemoryExtract(home: string, limit: number): Promise<number> {
  const { buildRuntime } = await import('../agent/runtime.js');
  const { ingestPending } = await import('../core/memory/ingest.js');
  const runtime = buildRuntime(home);
  try {
    let rounds = 0;
    const total = { episodes: 0, facts: 0, superseded: 0, skipped: 0, indexed: 0, review: 0, errors: 0 };
    for (;;) {
      const report = await ingestPending(
        {
          store: runtime.memory.store,
          provider: runtime.light.provider,
          model: runtime.light.model,
          tracer: runtime.deps.tracer,
          vectors: runtime.memory.recall.vectors,
        },
        TENANT,
        Math.min(limit, 25),
      );
      total.episodes += report.episodes;
      total.facts += report.factsAdded;
      total.superseded += report.superseded;
      total.skipped += report.skippedAgentOutput;
      total.indexed += report.indexed;
      total.review += report.needsReview.length;
      total.errors += report.errors.length;
      for (const r of report.needsReview) {
        process.stderr.write(`  ? ${r.subject} ${r.predicate}: "${r.existing}" vs "${r.incoming}" — ${r.why}\n`);
      }
      for (const e of report.errors) process.stderr.write(`  ! ${e}\n`);
      rounds += 1;
      // Nothing left to do, or the caller asked for a bounded run.
      if (report.episodes === 0 && report.skippedAgentOutput === 0 && report.skippedDocuments === 0) break;
      if (rounds * 25 >= limit) break;
    }
    process.stdout.write(
      `${total.episodes} episodi estratti · ${total.facts} fatti · ${total.superseded} ritirati · ` +
        `${total.skipped} dell'agente tenuti come evidenza · ${total.indexed} chunk indicizzati` +
        `${total.review > 0 ? ` · ${total.review} da rivedere` : ''}\n`,
    );
    return total.errors > 0 ? 1 : 0;
  } finally {
    runtime.close();
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

    process.stdout.write(
      [
        `episodi        ${s.episodes} (${s.pending} tuoi da estrarre)`,
        `finestra       ${span}`,
        `entità         ${s.entities}`,
        `fatti          ${s.activeFacts} attivi · ${s.retiredFacts} ritirati`,
        `predicati      ${s.predicates} distinti`,
        `indice vett.   ${vectorRows === null ? 'assente' : `${vectorRows} chunk · ${vectorIndexed ?? 0} vettori`}`,
        '',
        ...s.topPredicates.map((p) => `  ${String(p.n).padStart(4)}  ${p.predicate}`),
      ].join('\n') + '\n',
    );
    return 0;
  } finally {
    db.close();
  }
}

export function cmdMemoryCheck(home: string, json: boolean): number {
  const { db, store } = openStore(home);
  try {
    const violations = checkInvariants(db);
    if (json) {
      process.stdout.write(`${JSON.stringify(violations, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatViolations(violations, store.stats(TENANT).activeFacts)}\n`);
    }
    // Errors are exit 2 because they mean the data is wrong now; warnings are 1
    // because they mean someone should look, not that anything is broken.
    if (violations.some((v) => v.severity === 'error')) return 2;
    return violations.length > 0 ? 1 : 0;
  } finally {
    db.close();
  }
}

function tableCount(db: DatabaseCtor.Database, table: string): number | null {
  try {
    return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  } catch {
    return null;
  }
}
