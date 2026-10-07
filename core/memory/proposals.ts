import type { TrustTier } from '../policy/types.js';
import type { FactOrigin } from './schema.js';
import type { MemoryStore } from './store.js';

/**
 * The durable MemoryProposal primitive (ADR-0051: many producers, one
 * semantic writer).
 *
 * This module owns the *staging* half: what a proposal is, what makes two
 * proposals the same, and the one durable write that records an intent. It
 * never writes a belief — `store.addFact` is not called here, by construction.
 * The *commit* half lives in exactly one place, `ingest.ts#reconcileProposal`,
 * which is what keeps the single-writer falsifier (`proposals.test.ts`'s
 * "the writer stays single") green.
 */

/** Who staged the candidate. Never the committer: see ADR-0051. */
export const PROPOSAL_PRODUCERS = [
  'owner-stated',
  'agent-inference',
  'extraction',
  'import',
] as const;
export type ProposalProducer = (typeof PROPOSAL_PRODUCERS)[number];

/**
 * Where a proposal stands. `pending` is the only state that can still become
 * a belief; every other state carries `resultingFactIds` (possibly empty, for
 * `rejected`) and `decidedAt`, so the answer to "what became of intent X" is a
 * row, not a reconstruction.
 */
export const PROPOSAL_STATUSES = [
  'pending',
  'accepted',
  'merged',
  'superseded',
  'review',
  'rejected',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** A reconciled proposal — the terminal states of `ProposalStatus`. */
export type ProposalOutcome = Exclude<ProposalStatus, 'pending'>;

export type ProposeInput = {
  tenantId: string;
  subject: string;
  subjectKind?: string;
  predicate: string;
  object: string;
  validFrom?: string | null;
  producer: ProposalProducer;
  /** At least one episode id, owned by this tenant. Never empty. */
  sourceEpisodeIds: number[];
  /** Runtime-derived floor from the current prompt, never from model arguments. */
  contextTier?: TrustTier;
  /** The candidate sentence, shown to the judge as the incoming evidence. */
  content: string;
  confidence: number;
  importance?: number;
  /** Requested pin. Honoured only through `addFact`'s own gate at reconcile. */
  pinned?: boolean;
  proposedAt?: string;
};

export type MemoryProposal = {
  id: number;
  tenantId: string;
  identityKey: string;
  subject: string;
  subjectKind: string;
  predicate: string;
  objectValue: string;
  validFrom: string | null;
  producer: ProposalProducer;
  sourceEpisodeIds: number[];
  content: string;
  trustTier: TrustTier;
  confidence: number;
  origin: FactOrigin;
  importance: number;
  pinnedRequest: boolean;
  status: ProposalStatus;
  resultingFactIds: number[];
  detail: string | null;
  proposedAt: string;
  decidedAt: string | null;
};

/**
 * What makes "the same proposal" the same: normalised candidate plus
 * producer plus sorted source identity — provenance before probability, per
 * ADR-0051's reconciliation rule. Two producers staging the same content get
 * different keys (their provenance differs) and still converge to one belief
 * at reconcile; the same producer staging the same content twice gets the
 * same key, and the second propose is a no-op.
 */
export function proposalIdentityKey(input: {
  subject: string;
  predicate: string;
  object: string;
  validFrom?: string | null;
  producer: ProposalProducer;
  sourceEpisodeIds: number[];
}): string {
  const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const episodes = [...new Set(input.sourceEpisodeIds)].sort((a, b) => a - b);
  // Encode the semantic tuple as JSON rather than joining fields with a
  // delimiter that candidate text itself may contain.
  return JSON.stringify([
    'v1',
    norm(input.subject),
    norm(input.predicate),
    norm(input.object),
    input.validFrom?.trim() || null,
    input.producer,
    episodes,
  ]);
}

/**
 * The origin a producer's candidate carries. Derived from the producer,
 * never accepted from a caller: a caller that could name its own origin could
 * launder an inference into a `said`.
 */
export function originForProducer(producer: ProposalProducer): FactOrigin {
  switch (producer) {
    case 'owner-stated':
      return 'said';
    case 'agent-inference':
      return 'inferred';
    case 'extraction':
      return 'said';
    case 'import':
      return 'imported';
  }
}

/**
 * Stages an intent durably. Synchronous and idempotent: the INSERT is
 * `OR IGNORE` on `(tenant_id, identity_key)`, so a repeated propose —
 * including a retry after a crash that killed the first caller right after
 * its commit — returns the same row instead of a second one.
 *
 * Validates the provenance it will need at reconcile (non-blank candidate,
 * at least one tenant-owned episode) rather than staging a proposal the
 * reconciler could never commit. The trust tier is the maximum of source
 * evidence and the runtime-derived current-prompt floor, never model input.
 *
 * Throws on invalid input. Never writes a belief.
 */
export function proposeMemoryRecord(
  store: MemoryStore,
  input: ProposeInput,
): { id: number; duplicate: boolean } {
  const subject = input.subject.trim();
  const predicate = input.predicate.trim();
  // The object may be blank: that is a reconciliation verdict (`rejected`),
  // not a staging error — what became of the intent stays answerable as a
  // row. Subject and predicate name what the candidate is about and cannot
  // be empty.
  if (subject === '' || predicate === '') {
    throw new Error('memory_propose: subject and predicate must both be non-blank.');
  }
  const object = input.object.trim();
  const validFrom = input.validFrom?.trim() || null;
  if (!PROPOSAL_PRODUCERS.includes(input.producer)) {
    throw new Error(`memory_propose: unknown producer "${input.producer}".`);
  }
  const episodeIds = [...new Set(input.sourceEpisodeIds)];
  if (episodeIds.length === 0) {
    throw new Error(
      'memory_propose: at least one source evidence episode is required — a belief without provenance is not staged.',
    );
  }
  // Tenant-owned, or it is not evidence this tenant may build on. Read before
  // writing: a proposal citing a foreign episode must fail here, not at
  // reconcile, where the failure would look like a judgment.
  let tier: TrustTier = 0;
  for (const id of episodeIds) {
    const ep = store.episodeById(input.tenantId, id);
    if (!ep) {
      throw new Error(`memory_propose: episode #${id} is not evidence for this tenant.`);
    }
    if (ep.trustTier > tier) tier = ep.trustTier;
  }
  if (input.contextTier !== undefined && input.contextTier > tier) tier = input.contextTier;
  return store.insertProposal({
    tenantId: input.tenantId,
    identityKey: proposalIdentityKey({
      subject,
      predicate,
      object,
      validFrom,
      producer: input.producer,
      sourceEpisodeIds: episodeIds,
    }),
    subject,
    subjectKind: input.subjectKind?.trim() || 'person',
    predicate,
    objectValue: object,
    validFrom,
    producer: input.producer,
    sourceEpisodeIds: episodeIds,
    content: input.content,
    trustTier: tier,
    confidence: input.confidence,
    origin: originForProducer(input.producer),
    importance: input.importance ?? 0,
    pinnedRequest: input.pinned === true,
    proposedAt: input.proposedAt ?? new Date().toISOString(),
  });
}
