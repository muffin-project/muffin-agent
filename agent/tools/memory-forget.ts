/**
 * `memory_forget` — the owner says «dimentica X», and a belief is retired.
 *
 * DAY-1 cutover, 2026-09-08 (`docs/evidence/dimentica-2026-09-08.md`): on the
 * real install "forget" had no mechanism at all, and the model improvised —
 * shell, sqlite, a recipe of `rm` and `DELETE` handed to the owner — for
 * minutes, without retiring anything. `docs/VISION.md` (07/09) lists forget
 * next to remember and correct as an ordinary conversational intent.
 *
 * Two calls, on purpose:
 *
 *   1. `memory_forget({query})` — the runtime's own recall lists what is
 *      currently believed or recorded about it, each with an id;
 *   2. `memory_forget({facts:[…], episodes:[…]})` — the writer retires exactly
 *      those ids (`core/memory/ingest.ts#retireBeliefs`, under the ingest
 *      lock) and answers with what actually changed.
 *
 * The model chooses which ids the owner meant — the same freedom the judge
 * has when it emits `supersede` — but the retirement itself is by exact id,
 * never "whatever matched the query": that is how the wrong memory goes
 * (LangMem `manage_memory` deletes by `id` for the same reason). Nothing is
 * deleted: facts get `expired_at` + `retired_reason`, episodes get D11's
 * `superseded_at`; `--history` and `memory why` keep the provenance.
 *
 * The confirmation is the durable result, so a "done" cannot precede the
 * commit (ADR-0051 Caso 1, #481).
 */
import { retireBeliefs } from '../../core/memory/ingest.js';
import { recall, type RecallDeps } from '../../core/memory/recall.js';
import type { CapabilityDecl } from '../../core/policy/types.js';
import type { ToolOutcome } from '../loop.js';
import type { ToolSpec } from '../providers/types.js';

/**
 * Owner-only on purpose: «dimentica X» is the owner's word about the owner's
 * memory (`docs/VISION.md`). A room member keeps `memory_search`/`memory_why`
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
    'Forget something on the owner\'s request: "dimentica X", "non considerarlo più vero", ' +
    '"non voglio che tu lo ricordi". Retires the belief and the messages it came from so normal ' +
    'recall stops using them; history and provenance are kept, nothing is deleted. Two steps: ' +
    'first call with `query` to get the candidate facts and episodes with their ids; then call ' +
    'again with the ids to retire (`facts`, `episodes`). Never use the shell, sqlite or files ' +
    'for this. e.g. memory_forget({query: "il mio dentista"}) then memory_forget({facts: [149], episodes: [544]}).',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'What the owner wants forgotten, in natural language — returns candidates with ids.',
      },
      facts: {
        type: 'array',
        items: { type: 'number' },
        description: 'Fact ids to retire (from the candidates).',
      },
      episodes: {
        type: 'array',
        items: { type: 'number' },
        description: 'Episode ids to retire (from the candidates).',
      },
    },
  },
};

type RawArgs = { query?: unknown; facts?: unknown; episodes?: unknown };

function idList(raw: unknown, name: string): number[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return `memory_forget: "${name}" deve essere una lista di id.`;
  const ids: number[] = [];
  for (const v of raw) {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isInteger(n) || n <= 0) return `memory_forget: "${name}" contiene un id non valido: ${String(v)}.`;
    ids.push(n);
  }
  return ids;
}

/** Everything a forget needs from the turn: who owns the memory and which turn asked. */
export type ForgetContext = { tenant: string; turnId: string };

export async function forgetMemory(
  deps: RecallDeps,
  ctx: ForgetContext,
  args: unknown,
  now: () => Date = () => new Date(),
): Promise<ToolOutcome> {
  const raw = (args ?? {}) as RawArgs;
  const facts = idList(raw.facts, 'facts');
  if (typeof facts === 'string') return { content: facts, isError: true, tier: 0 };
  const episodes = idList(raw.episodes, 'episodes');
  if (typeof episodes === 'string') return { content: episodes, isError: true, tier: 0 };

  if (facts.length > 0 || episodes.length > 0) {
    const result = retireBeliefs(deps.store, ctx.tenant, {
      factIds: facts,
      episodeIds: episodes,
      at: now(),
      reason: `richiesta dell'owner · turno ${ctx.turnId}`,
    });
    const missed = {
      facts: facts.filter((id) => !result.facts.includes(id)),
      episodes: episodes.filter((id) => !result.episodes.includes(id)),
    };
    const lines = [
      result.facts.length > 0 ? `ritirati ${result.facts.length} fatti: ${result.facts.map((id) => `#${id}`).join(', ')}` : 'nessun fatto ritirato',
      result.episodes.length > 0
        ? `ritirati ${result.episodes.length} episodi dal recall: ${result.episodes.map((id) => `#${id}`).join(', ')}`
        : 'nessun episodio ritirato',
    ];
    if (missed.facts.length > 0) lines.push(`non trovati o già ritirati (fatti): ${missed.facts.map((id) => `#${id}`).join(', ')}`);
    if (missed.episodes.length > 0) lines.push(`non trovati (episodi): ${missed.episodes.map((id) => `#${id}`).join(', ')}`);
    lines.push('La storia e la provenienza restano: `muffin memory search --history` le mostra come ritirate.');
    return { content: lines.join('\n'), tier: 0 };
  }

  if (typeof raw.query !== 'string' || raw.query.trim() === '') {
    return {
      content: 'memory_forget richiede "query" (per vedere i candidati) oppure "facts"/"episodes" (gli id da ritirare).',
      isError: true,
      tier: 0,
    };
  }
  const found = await recall(deps, ctx.tenant, raw.query.trim(), { limit: 12 });
  const items = found.items.filter((i) => (i.kind === 'fact' || i.kind === 'episode') && i.expired !== true);
  if (items.length === 0) {
    return { content: `Niente da dimenticare: nessun fatto attivo né episodio corrisponde a «${raw.query.trim()}».`, tier: 0 };
  }
  const lines = items.map(
    (i) => `[${i.kind} #${i.id}] ${i.source} — ${i.text.replace(/\s+/g, ' ').slice(0, 200)}`,
  );
  const tier = items.reduce<0 | 1 | 2 | 3>((max, i) => (i.trustTier > max ? i.trustTier : max), 0);
  return {
    content:
      `Candidati (attivi) per «${raw.query.trim()}»:\n${lines.join('\n')}\n\n` +
      'Per ritirarli chiama di nuovo memory_forget con gli id: {facts: [...], episodes: [...]}. ' +
      'Ritira solo ciò che l\'owner intende davvero; un fatto non nominato resta.',
    tier,
  };
}
