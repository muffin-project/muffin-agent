/**
 * `memory_propose` — the intentional-memory door (ADR-0051: many producers,
 * one semantic writer).
 *
 * The model can decide something is worth remembering — the owner said
 * "ricorda X", or the reasoning noticed a detail worth keeping — but it
 * cannot promote its own proposal to a canonical belief. This tool stages a
 * durable `MemoryProposal` (`core/memory/proposals.ts`) and reconciles it
 * through the one canonical reconciler (`core/memory/ingest.ts`
 * `reconcileProposal`): accept / merge / supersede / review / reject, with
 * provenance intact and exactly one belief per accepted proposal.
 *
 * Two different capabilities on purpose: `memory.propose` stages, and nothing
 * here commits except through the reconciler the extraction pipeline uses.
 * A future `memory.commit` would not be this — the canonical commit belongs
 * to the Home/reconciliation boundary, not to the model's menu.
 *
 * The confirmation is the durable result, so a "lo ricordo" cannot precede
 * the commit (ADR-0051 Caso 1). When the lane lock is held, the tool says
 * exactly that — proposal recorded, reconciliation deferred — instead of
 * claiming a belief that does not exist yet.
 */

import { type IngestDeps, reconcileProposal } from '../../core/memory/ingest.js';
import { type ProposalProducer, proposeMemoryRecord } from '../../core/memory/proposals.js';
import type { MemoryStore } from '../../core/memory/store.js';
import type { CapabilityDecl, TrustTier } from '../../core/policy/types.js';
import type { Tracer } from '../../core/tracing/types.js';
import type { ToolOutcome } from '../loop.js';
import type { Provider, ToolSpec } from '../providers/types.js';

/**
 * Staging, not committing: a second identical call is the same proposal, and
 * nothing this door does retires or rewrites a belief on its own. Owner turns
 * and agent inference both reach it — proposing is available wherever the
 * model reasons, committing stays with the reconciler.
 */
export const memoryProposeCapability: CapabilityDecl = {
  id: 'memory.propose',
  effect: 'memory',
  risk: 'low',
  reversible: 'no',
  rerunnable: true,
  progress: 'idempotent_read',
  resourceKind: 'tenant',
  policyArgs: ['subject', 'predicate', 'object'],
  // Owner-only like `memory.forget`: an intentional "ricorda" is the owner's
  // word about the owner's memory (VISION), and the consolidation lane it
  // drains into is host-only too — a group proposal would stage beliefs no
  // lane mines and the group persona claims are never built. Agent inference
  // in an owner turn still reaches it; producing there is not committing.
  hostOnly: true,
};

export const memoryProposeSpec: ToolSpec = {
  name: 'memory_propose',
  description:
    'Remember something intentionally. Use it when the owner says "ricorda X" ("ricorda che il mio commercialista è Mario"), ' +
    'or when you noticed a detail worth keeping and want it to survive this turn. ' +
    'Not for finding anything (that is memory_search), explaining a belief (memory_why), or forgetting one (memory_forget) — ' +
    'and never use the shell, sqlite or files for this. ' +
    'Stages a durable proposal that the memory reconciler accepts, merges, supersedes, reviews or rejects. ' +
    'Pass kind "owner-stated" when the owner explicitly asked to remember, "agent-inference" when it is your own judgment ' +
    'that something is worth keeping. The answer tells you whether it became a belief, merged with one, went to ' +
    'review, or was rejected — report that honestly, never claim "lo ricordo" for a mere proposal. ' +
    'e.g. memory_propose({subject: "owner", predicate: "accountant", object: "Mario", kind: "owner-stated"}).',
  inputSchema: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'Who the candidate is about (usually "owner").' },
      predicate: {
        type: 'string',
        description: 'What kind of fact it is (e.g. "accountant", "lives_in").',
      },
      object: { type: 'string', description: 'The value to remember.' },
      kind: {
        type: 'string',
        description:
          '"owner-stated" when the owner explicitly asked to remember; "agent-inference" when it is your own judgment.',
      },
      evidence_ids: {
        type: 'array',
        items: { type: 'number' },
        description:
          'Episode ids this derives from (from memory_search). Defaults to this turn’s own message.',
      },
      confidence: { type: 'number', description: 'How sure you are (0-1, default 0.8).' },
      valid_from: {
        type: 'string',
        description:
          'When it became true out there, if stated (YYYY-MM-DD). Omit when nobody said.',
      },
    },
    required: ['subject', 'predicate', 'object', 'kind'],
  },
};

/** Everything a propose needs: the store, and the light lane for the judge. */
export type ProposeDeps = {
  store: MemoryStore;
  provider: Provider;
  model: string;
  tracer: Tracer;
  now?: () => Date;
};

/** Who owns the memory being proposed into, and which turn asked. */
export type ProposeContext = {
  tenant: string;
  turnId: string;
  /** Live runtime taint, including bytes recalled earlier in this turn. */
  taint: () => TrustTier;
};

type RawArgs = {
  subject?: unknown;
  predicate?: unknown;
  object?: unknown;
  kind?: unknown;
  evidence_ids?: unknown;
  confidence?: unknown;
  valid_from?: unknown;
};

function str(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

export async function proposeMemory(
  deps: ProposeDeps,
  ctx: ProposeContext,
  args: unknown,
  now: () => Date = () => new Date(),
): Promise<ToolOutcome> {
  const raw = (args ?? {}) as RawArgs;
  const subject = str(raw.subject);
  const predicate = str(raw.predicate);
  const object = str(raw.object);
  if (!subject || !predicate || !object) {
    return {
      content: 'memory_propose richiede "subject", "predicate" e "object" non vuoti.',
      isError: true,
      tier: 0,
    };
  }
  if (raw.kind !== 'owner-stated' && raw.kind !== 'agent-inference') {
    return {
      content:
        'memory_propose richiede "kind": "owner-stated" (l’owner ha detto di ricordare) oppure "agent-inference" (tua inferenza).',
      isError: true,
      tier: 0,
    };
  }
  const producer = raw.kind as ProposalProducer;

  let evidenceIds: number[] = [];
  if (raw.evidence_ids !== undefined) {
    if (!Array.isArray(raw.evidence_ids)) {
      return {
        content: 'memory_propose: "evidence_ids" deve essere una lista di id.',
        isError: true,
        tier: 0,
      };
    }
    for (const v of raw.evidence_ids) {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isInteger(n) || n <= 0) {
        return {
          content: `memory_propose: "evidence_ids" contiene un id non valido: ${String(v)}.`,
          isError: true,
          tier: 0,
        };
      }
      evidenceIds.push(n);
    }
  }
  // The turn's own message is the evidence for an owner-stated "ricorda":
  // the model must not have to name an episode id for the sentence the owner
  // just said. Agent inference without cited episodes falls back to it too —
  // the turn it was inferred in — rather than to nothing.
  if (evidenceIds.length === 0) {
    const ingress = deps.store.episodeIdByTurnId(ctx.tenant, ctx.turnId);
    if (ingress !== null) evidenceIds = [ingress];
  }
  if (evidenceIds.length === 0) {
    return {
      content:
        'memory_propose: nessuna evidenza — passa "evidence_ids" (episodi da memory_search) oppure proponi dentro un turno con messaggio.',
      isError: true,
      tier: 0,
    };
  }

  const confidence = raw.confidence === undefined ? 0.8 : Number(raw.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return {
      content: 'memory_propose: "confidence" deve stare tra 0 e 1.',
      isError: true,
      tier: 0,
    };
  }
  const validFrom =
    typeof raw.valid_from === 'string' && raw.valid_from.trim() !== ''
      ? raw.valid_from.trim()
      : null;
  const contextTier = ctx.taint();

  // Provenance is read off the evidence, never trusted from the arguments:
  // `proposeMemoryRecord` throws on foreign episodes, and derives the tier
  // as the worst of the sources.
  let proposalId: number;
  let duplicate = false;
  try {
    ({ id: proposalId, duplicate } = proposeMemoryRecord(deps.store, {
      tenantId: ctx.tenant,
      subject,
      predicate,
      object,
      ...(validFrom === null ? {} : { validFrom }),
      producer,
      sourceEpisodeIds: evidenceIds,
      contextTier,
      content: `${subject} ${predicate} ${object}`,
      confidence,
    }));
  } catch (error) {
    return {
      content: `memory_propose: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
      tier: 0,
    };
  }

  // A duplicate pending proposal can retain a higher tier from an earlier
  // context. The durable row is authoritative for every replay response;
  // current evidence and live taint may raise, but never lower, that tier.
  const responseTier = (): TrustTier =>
    Math.max(
      worstTier(deps.store, ctx.tenant, evidenceIds),
      ctx.taint(),
      deps.store.proposalById(ctx.tenant, proposalId)?.trustTier ?? 0,
    ) as TrustTier;

  const ingestDeps: IngestDeps = {
    store: deps.store,
    provider: deps.provider,
    model: deps.model,
    tracer: deps.tracer,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  };
  try {
    const out = await reconcileProposal(ingestDeps, ctx.tenant, proposalId, { at: now() });
    // The response repeats the proposal even when reconciliation failed, so
    // operational failure cannot lower the provenance of the evidence it
    // carries back into the model's context.
    const tier = responseTier();
    // Terminal proposal outcomes are durable history. On an idempotent replay,
    // the referenced fact may since have been retired or superseded; don't
    // turn an old acceptance into a present-tense claim.
    const resultFactsStillActive =
      out.factIds.length > 0 &&
      out.factIds.every((id) => deps.store.factById(ctx.tenant, id)?.expiredAt === null);
    if (duplicate && !resultFactsStillActive) {
      switch (out.status) {
        case 'accepted':
          return {
            content:
              `La proposta #${proposalId} era stata accettata (fatto #${out.factIds[0]}). ` +
              'Verifica con memory_search se il fatto è ancora attivo.',
            tier,
          };
        case 'merged':
          return {
            content:
              `La proposta #${proposalId} era stata unita al fatto #${out.factIds[0]}. ` +
              'Verifica con memory_search lo stato corrente.',
            tier,
          };
        case 'superseded':
          return {
            content:
              `La proposta #${proposalId} aveva aggiornato il fatto #${out.factIds[0]}. ` +
              'Verifica con memory_search lo stato corrente.',
            tier,
          };
      }
    }
    switch (out.status) {
      case 'accepted':
        return {
          content: `Ricordo: ${subject} ${predicate} ${object} (fatto #${out.factIds[0]}, proposta #${proposalId}).`,
          tier,
        };
      case 'merged':
        return {
          content: `Lo sapevo già: ${subject} ${predicate} ${object} (fatto #${out.factIds[0]}, proposta #${proposalId} unita).`,
          tier,
        };
      case 'superseded':
        return {
          content: `Aggiorno: ${subject} ${predicate} ${object} (nuovo fatto #${out.factIds[0]}, proposta #${proposalId}).`,
          tier,
        };
      case 'review':
        return {
          content:
            `Sottoposto a revisione: ${subject} ${predicate} ${object} (fatto #${out.factIds[0]}, proposta #${proposalId}). ` +
            `Controlla \`muffin memory review\` per lo stato corrente.`,
          tier,
        };
      case 'rejected':
        return {
          content: `Non registrato (${proposalDetail(deps, ctx.tenant, proposalId)}).`,
          tier,
        };
      case 'pending':
        return { content: `Proposta #${proposalId} ancora in attesa — riprova più tardi.`, tier };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('memoria occupata')) {
      // The honest half of ADR-0051 Caso 1: the intent is durable (proposal
      // #N is on disk and the next consolidation drain will reconcile it),
      // but no canonical belief exists yet — so the model must not say
      // otherwise.
      return {
        content:
          `Proposta #${proposalId} registrata durevolmente, ma la riconciliazione è rimandata (${message}): ` +
          `il consolidamento la prenderà al prossimo giro. Non dire che lo ricordi finché non è una credenza.`,
        tier: responseTier(),
      };
    }
    return { content: `memory_propose: ${message}`, isError: true, tier: responseTier() };
  }
}

function worstTier(store: MemoryStore, tenant: string, ids: number[]): 0 | 1 | 2 | 3 {
  let tier: 0 | 1 | 2 | 3 = 0;
  for (const id of ids) {
    const ep = store.episodeById(tenant, id);
    if (ep && ep.trustTier > tier) tier = ep.trustTier;
  }
  return tier;
}

function proposalDetail(deps: ProposeDeps, tenant: string, proposalId: number): string {
  const detail = deps.store.proposalById(tenant, proposalId)?.detail;
  return detail ?? 'nessun dettaglio';
}
