import type { FactOrigin } from './schema.js';
import type { Fact, MemoryStore } from './store.js';
import type { TrustTier } from '../policy/types.js';

/**
 * The one renderer behind "why do you believe that", for both doors that ask
 * it.
 *
 * `muffin memory why` (`cli/memory.ts`) existed for the owner; the agent had
 * no way to reach the same answer mid-turn (DAY-1 row C5). Writing a second
 * copy of this formatting inside `agent/tools/memory.ts` would have been
 * exactly the failure this repository keeps paying for — two renderings of
 * "why" that read the same fact and can still say different things, because
 * nothing forces them to change together. There is one function; the CLI and
 * the tool each call it and print or return what it hands back.
 *
 * Deliberately not generative: this reads rows the store already has, in the
 * order the schema put them there. An agent asked to explain its own belief
 * will produce a fluent story whether or not one exists; a foreign key cannot.
 */

const TIER_LABEL = ['owner', 'contatto noto', 'gruppo/sconosciuto', 'web/tool esterno'] as const;

export function tierName(tier: TrustTier): string {
  return `tier ${tier} · ${TIER_LABEL[tier]}`;
}

/** Said, inferred or imported — deliberately not folded into the tier label. */
export function originName(origin: FactOrigin): string {
  return origin === 'said' ? 'detto' : origin === 'inferred' ? 'dedotto' : 'importato';
}

/** Spelled out rather than shown as 0/1/2: a bare integer invites averaging. */
export function importanceName(importance: number): string {
  return importance >= 2 ? 'carico' : importance === 1 ? 'conta' : 'routine';
}

export function factLine(f: Fact): string {
  const object = f.objectName ?? f.objectValue ?? '?';
  const state = f.expiredAt ? `ritirato il ${f.expiredAt.slice(0, 10)}` : 'attivo';
  const world =
    f.validFrom || f.validTo
      ? ` · valido ${f.validFrom?.slice(0, 10) ?? '?'} → ${f.validTo?.slice(0, 10) ?? 'oggi'}`
      : '';
  return `#${f.id} ${f.subjectName} ${f.predicate} ${object} — ${state}${world}`;
}

export type ProvenanceReport = {
  /** Ready to join with '\n' — the exact lines `cmdMemoryWhy` used to build by hand. */
  lines: string[];
  /**
   * The worse of the fact's own tier and the episode's — the same "inherit
   * the worst source" rule `memory_search`'s handler already applies
   * (`recallTaint` in `core/memory/recall.ts`). A caller that skipped the
   * episode's tier could hand back owner-grade trust for a belief whose
   * *episode* came in at tier 2, because nothing ever re-checked the second
   * number.
   */
  tier: TrustTier;
};

/**
 * The episode a fact came from, its tier and connector, when it was learned,
 * what replaced it or what it replaced, and its siblings from the same
 * episode. Tenant-scoped throughout because every store call it makes is.
 */
export function describeProvenance(store: MemoryStore, tenantId: string, fact: Fact): ProvenanceReport {
  const out: string[] = [factLine(fact)];
  // `why` is the one place the two axes must not blur into each other: the
  // tier says who it came from, the origin says how we got from them to this.
  out.push(
    `  fiducia ${fact.confidence.toFixed(2)} · ${tierName(fact.trustTier)} · ` +
      `${originName(fact.origin)} · ${importanceName(fact.importance)}`,
  );
  out.push(`  imparato il ${fact.recordedAt.slice(0, 16).replace('T', ' ')}`);

  if (fact.retiredReason) {
    // «Dimentica X»: retired without a successor (`ingest.ts#retireBeliefs`).
    out.push(`  ritirato senza successore: ${fact.retiredReason}`);
  }
  if (fact.supersededBy !== null) {
    const successor = store.factById(tenantId, fact.supersededBy);
    out.push(`  sostituito da: ${successor ? factLine(successor) : `#${fact.supersededBy} (mancante)`}`);
  }
  for (const old of store.factsSupersededBy(tenantId, fact.id)) {
    out.push(`  ha sostituito: ${factLine(old)}`);
  }

  out.push('');
  let tier = fact.trustTier;
  const episode = store.episodeById(tenantId, fact.episodeId);
  if (!episode) {
    // Impossible while the foreign key holds; worth saying out loud if it
    // ever does not, because a fact without provenance is not a fact here.
    out.push(`episodio #${fact.episodeId} MANCANTE — provenienza rotta`);
  } else {
    if (episode.trustTier > tier) tier = episode.trustTier;
    const where = episode.vaultPath ?? `${episode.connector}:${episode.threadKey}`;
    out.push(`da episodio #${episode.id} · ${episode.role} · ${where}`);
    out.push(`   ${episode.createdAt.slice(0, 16).replace('T', ' ')} · ${tierName(episode.trustTier)}`);
    out.push('');
    for (const line of (episode.content ?? '(nessun testo)').split('\n')) out.push(`   │ ${line}`);

    const siblings = store.factsFromEpisode(tenantId, episode.id).filter((f) => f.id !== fact.id);
    if (siblings.length > 0) {
      out.push('');
      out.push(`dallo stesso episodio:`);
      for (const s of siblings) out.push(`   ${factLine(s)}`);
    }
  }

  return { lines: out, tier };
}
