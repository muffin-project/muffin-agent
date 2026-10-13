import { retireBeliefs } from '../../core/memory/ingest.js';
import { type RecallDeps, recall } from '../../core/memory/recall.js';
import type { CapabilityDecl, TrustTier } from '../../core/policy/types.js';
import type { ToolOutcome } from '../loop.js';
import type { Provider, ToolSpec } from '../providers/types.js';
import {
  type ForgetSource,
  forgetDiscoveryQuery,
  ownerForgetRequest,
} from './memory-forget-intent.js';
import { type ForgetCandidate, resolveForgetTargets } from './memory-forget-target.js';

/**
 * Owner-only on purpose: «dimentica X» is the owner's word about the owner's
 * memory (`docs/product/VISION.md`). A room member keeps `memory_search`/`memory_why`
 * (ADR-0073's list without grant) and does not get a door that retires what
 * the room learned. Same effect class as `memory.write` (`core/policy/doors.ts`),
 * tenant-scoped, declared next to its tool like `inspectCapability`.
 */
export const memoryForgetCapability: CapabilityDecl = {
  id: 'memory.forget',
  effect: 'memory',
  risk: 'low',
  reversible: 'no',
  rerunnable: false,
  resourceKind: 'tenant',
  policyArgs: [],
  hostOnly: true,
};

export const memoryForgetSpec: ToolSpec = {
  name: 'memory_forget',
  description:
    'Forget memory on a direct current owner request. Use it when the owner asks "dimentica X" or "forget X". ' +
    'Not for a correction, a quoted request, or your own judgment that something is stale. ' +
    'Call with {}. The runtime derives the target from the authenticated owner message, resolves matching facts ' +
    'and their source episodes, and retires them through the canonical writer. Unresolved targets or sources ' +
    'containing other information require clarification; no retirement is inferred from a matching keyword. ' +
    'History and provenance remain queryable. Never use shell, sqlite or files for this. Report the actual receipt.',
  inputSchema: { type: 'object', properties: {} },
};

type RawArgs = { query?: unknown; facts?: unknown; episodes?: unknown };

function idList(raw: unknown, name: string): number[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return `memory_forget: "${name}" deve essere una lista di id.`;
  const ids: number[] = [];
  for (const v of raw) {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isInteger(n) || n <= 0)
      return `memory_forget: "${name}" contiene un id non valido: ${String(v)}.`;
    ids.push(n);
  }
  return ids;
}

export type ForgetDeps = RecallDeps & { provider: Provider; model: string };
export type ForgetContext = {
  signal?: AbortSignal;
  tenant: string;
  turnId: string;
  getSource: () => ForgetSource | null;
  jobId?: string;
};

/** One direct owner action, independently resolved targets, one canonical writer. */
export async function forgetMemory(
  deps: ForgetDeps,
  ctx: ForgetContext,
  args: unknown,
  now: () => Date = () => new Date(),
): Promise<ToolOutcome> {
  let resolutionTier: TrustTier = 0;
  const error = (content: string): ToolOutcome => ({
    content,
    isError: true,
    tier: resolutionTier,
  });
  if (ctx.signal?.aborted) return error('memory_forget: interrotto. Nessuna memoria ritirata.');
  const request = ownerForgetRequest(ctx.getSource(), ctx.tenant, ctx.turnId);
  if (request === null)
    return error(
      'memory_forget: nessuna richiesta diretta e attuale dell’owner autorizza questo oblio.',
    );
  if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args)))
    return error('memory_forget: argomenti non validi.');
  const raw = (args ?? {}) as RawArgs;
  const requestedFacts = idList(raw.facts, 'facts');
  const requestedEpisodes = idList(raw.episodes, 'episodes');
  if (typeof requestedFacts === 'string') return error(requestedFacts);
  if (typeof requestedEpisodes === 'string') return error(requestedEpisodes);
  // Legacy query never controls discovery or the mutation target.
  const discoveryQuery = forgetDiscoveryQuery(request)!;
  const found = await recall(deps, ctx.tenant, discoveryQuery, {
    limit: 13,
    ...(ctx.jobId === undefined ? {} : { jobId: ctx.jobId }),
  });
  resolutionTier = Math.max(0, ...found.items.map((i) => i.trustTier)) as TrustTier;
  const fallbackFacts = deps.store.searchActiveFacts(ctx.tenant, discoveryQuery, 13);
  if (found.items.length >= 13 || fallbackFacts.length >= 13)
    return error(
      'Troppi candidati: specifica meglio cosa vuoi dimenticare. Nessuna memoria ritirata.',
    );
  const factIds = new Set(fallbackFacts.map((f) => f.id));
  const episodeIds = new Set<number>();
  for (const item of found.items) {
    if (item.expired) continue;
    if (item.kind === 'fact') factIds.add(item.id);
    else if (item.turnId !== ctx.turnId) episodeIds.add(item.id);
  }
  for (const id of [...episodeIds]) {
    for (const f of deps.store.factsFromEpisode(ctx.tenant, id))
      if (f.expiredAt === null) factIds.add(f.id);
  }
  for (const id of factIds) {
    const f = deps.store.factById(ctx.tenant, id);
    if (f?.episodeId != null) episodeIds.add(f.episodeId);
  }
  const candidates: ForgetCandidate[] = [];
  const snapshots = new Map<string, string>();
  for (const id of episodeIds) {
    const ep = deps.store.episodeById(ctx.tenant, id);
    if (
      !ep ||
      ep.content === null ||
      ep.turnId === ctx.turnId ||
      deps.store.provenanceOf(ctx.tenant, 'episode', id)?.supersededAt !== null ||
      ep.undoneAt !== undefined
    )
      continue;
    resolutionTier = Math.max(resolutionTier, ep.trustTier) as TrustTier;
    const sourceFacts = deps.store
      .factsFromEpisode(ctx.tenant, id)
      .filter((f) => f.expiredAt === null);
    if (ep.content.length > 12_000 || sourceFacts.length > 12)
      return error(
        'La fonte non è risolvibile in modo completo entro questa richiesta. Nessuna memoria ritirata.',
      );
    snapshots.set(
      `episode:${id}`,
      JSON.stringify({
        episode: ep,
        provenance: deps.store.provenanceOf(ctx.tenant, 'episode', id),
      }),
    );
    candidates.push({
      kind: 'episode',
      id,
      text: ep.content,
      sourceEpisodeId: id,
      sourceText: ep.content,
      sourceFactIds: sourceFacts.map((f) => f.id),
    });
    for (const f of sourceFacts) {
      resolutionTier = Math.max(resolutionTier, f.trustTier) as TrustTier;
      snapshots.set(`fact:${f.id}`, JSON.stringify(deps.store.factById(ctx.tenant, f.id)));
      candidates.push({
        kind: 'fact',
        id: f.id,
        text: `${f.subjectName} ${f.predicate} ${f.objectValue ?? f.objectName ?? ''}`,
        sourceEpisodeId: id,
        sourceText: ep.content,
        sourceFactIds: sourceFacts.map((s) => s.id),
      });
    }
  }
  if (candidates.length > 24 || JSON.stringify(candidates).length > 64_000)
    return error(
      'Troppi candidati: specifica meglio cosa vuoi dimenticare. Nessuna memoria ritirata.',
    );
  const decision = await resolveForgetTargets(
    deps.provider,
    deps.model,
    request,
    candidates,
    ctx.jobId,
    ctx.signal,
  );
  if (ctx.signal?.aborted) return error('memory_forget: interrotto. Nessuna memoria ritirata.');
  if (decision === null)
    return error(
      'Non posso verificare il bersaglio dell’oblio: il giudizio è assente o non valido. Nessuna memoria ritirata.',
    );
  if (decision.status === 'none')
    return error('Nessun candidato corrisponde alla richiesta completa. Nessuna memoria ritirata.');
  if (decision.status === 'ambiguous' || !decision.sourceOnlyTargets)
    return error(
      'Il bersaglio o la sua fonte contiene altre informazioni: specifica cosa vuoi ritirare. Nessuna memoria ritirata.',
    );
  const selectedFacts = new Set(decision.facts);
  const selectedEpisodes = new Set(decision.episodes);
  for (const id of selectedFacts) {
    const item = candidates.find((c) => c.kind === 'fact' && c.id === id)!;
    if (item.sourceEpisodeId !== null) selectedEpisodes.add(item.sourceEpisodeId);
  }
  for (const id of selectedEpisodes) {
    const ep = candidates.find((c) => c.kind === 'episode' && c.id === id);
    if (!ep || ep.sourceFactIds.some((f) => !selectedFacts.has(f)))
      return error(
        'La fonte contiene altri fatti attivi: serve chiarire l’effetto sul messaggio sorgente. Nessuna memoria ritirata.',
      );
  }
  if (
    requestedFacts.some((id) => !selectedFacts.has(id)) ||
    requestedEpisodes.some((id) => !selectedEpisodes.has(id))
  )
    return error(
      'Gli id del modello non corrispondono al bersaglio autorizzato dall’owner. Nessuna memoria ritirata.',
    );
  if (typeof raw.query === 'string' && !requestedFacts.length && !requestedEpisodes.length) {
    return {
      content:
        'Candidati autorizzati dalla richiesta attuale:\n' +
        candidates
          .filter((c) => (c.kind === 'fact' ? selectedFacts.has(c.id) : selectedEpisodes.has(c.id)))
          .map((c) => `[${c.kind} #${c.id}] ${c.text}`)
          .join('\n') +
        '\nPer eseguire usa memory_forget con gli id, oppure {}.',
      tier: resolutionTier,
    };
  }
  // Authority, canonical row snapshots and both writes share one SQLite
  // transaction; the existing writer acquires the ingestion lock inside it.
  const result = deps.store.transact(() => {
    ctx.signal?.throwIfAborted();
    if (ownerForgetRequest(ctx.getSource(), ctx.tenant, ctx.turnId) !== request)
      throw new Error('La richiesta dell’owner è cambiata: nessuna memoria ritirata.');
    for (const id of selectedFacts)
      if (JSON.stringify(deps.store.factById(ctx.tenant, id)) !== snapshots.get(`fact:${id}`))
        throw new Error('Il fatto è cambiato durante la risoluzione: nessuna memoria ritirata.');
    for (const id of selectedEpisodes) {
      if (
        JSON.stringify({
          episode: deps.store.episodeById(ctx.tenant, id),
          provenance: deps.store.provenanceOf(ctx.tenant, 'episode', id),
        }) !== snapshots.get(`episode:${id}`)
      )
        throw new Error('La fonte è cambiata durante la risoluzione: nessuna memoria ritirata.');
      if (
        deps.store
          .factsFromEpisode(ctx.tenant, id)
          .some((f) => f.expiredAt === null && !selectedFacts.has(f.id))
      )
        throw new Error('La fonte ora contiene altri fatti: nessuna memoria ritirata.');
    }
    return retireBeliefs(deps.store, ctx.tenant, {
      factIds: [...selectedFacts],
      episodeIds: [...selectedEpisodes],
      at: now(),
      reason: `richiesta diretta dell’owner · turno ${ctx.turnId}`,
    });
  });
  return {
    content: `ritirati ${result.facts.length} fatti: ${result.facts.map((id) => `#${id}`).join(', ')}\nritirati ${result.episodes.length} episodi dal recall: ${result.episodes.map((id) => `#${id}`).join(', ')}\nLa storia e la provenienza restano consultabili con memory why e search --history.`,
    tier: resolutionTier,
  };
}
