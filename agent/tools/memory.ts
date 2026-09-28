import {
  checkTemporalWindow,
  EVERY_INSTANT,
  normaliseDate,
  recall,
  renderForPrompt,
  type RecallDeps,
} from '../../core/memory/recall.js';
import { describeProvenance } from '../../core/memory/provenance.js';
import type { Fact } from '../../core/memory/store.js';
import type { CapabilityDecl } from '../../core/policy/types.js';
import type { ToolOutcome } from '../loop.js';
import type { ToolSpec } from '../providers/types.js';

/**
 * Explicit memory search.
 *
 * The pre-loop already recalls against the incoming message; this is for when
 * the model needs to go looking on purpose — a second query mid-turn, a name it
 * only encountered after reading a file, a follow-up the first recall could not
 * have anticipated. Without it the only memory the model ever gets is whatever
 * the opening sentence happened to retrieve.
 *
 * It reads the tenant of the turn, never a tenant of its own choosing: the
 * argument list has no tenant field, deliberately, so no amount of clever
 * prompting can widen the scope.
 */

export const memoryCapability: CapabilityDecl = {
  id: 'memory.read',
  effect: 'context',
  risk: 'low',
  reversible: 'yes',
  // A read, and a read of our own store: running it twice returns the same
  // rows or fresher ones, and changes nothing.
  rerunnable: true,
  // Lo stesso motivo della riga sopra, detto per il guardrail: una seconda
  // ricerca **identica** nello stesso turno non porta righe nuove.
  progress: 'idempotent_read',
  resourceKind: 'tenant',
  policyArgs: ['query'],
  // Not host-only: a group's agent may search that group's memory, and only
  // that group's — the store enforces the boundary.
  hostOnly: false,
};

/**
 * The temporal arguments are on the tool and not only on the CLI, and that is
 * the load-bearing part of this slice rather than a convenience.
 *
 * `--history` existed, worked, and was reachable from a terminal only. The
 * consumer that decides whether Muffin can answer *"who was my contact in May"*
 * is the model, mid-turn, and it had `query` and `limit` — so a memory that
 * kept every retired belief on purpose had no path by which any of them could
 * reach an answer. That is `operational_mode` in `knowledge/05-person-model.md`:
 * a column, a value, zero readers. The rule the corpus draws from it is the one
 * followed here — wire the reader first.
 *
 * They are arguments the model sets, which is also why this is not the
 * classifier `02-ontologia.md` §9 forbids: nothing inspects the query text for
 * "in May" and switches mode behind the model's back. The model says which
 * instant it means, recall labels what it finds, and the answer is the model's.
 */
export const memorySearchSpec: ToolSpec = {
  name: 'memory_search',
  description:
    'Search your own memory: past conversations, documents and facts you have learned. ' +
    'Use it when the answer may depend on something said before, or on a name or detail you ' +
    'have just come across. Not for a fact about this running instance — model, provider, build, which tools ' +
    'you can see — that is sys_inspect, not memory. Results carry their source and how much it is trusted. ' +
    'For a question about the past ("who was my accountant in May", "what did we decide back then"), ' +
    'set as_of to that date — without it you get what is true now, which is a wrong answer to a ' +
    'question about then. Set history:true to see a belief and everything it replaced. ' +
    'Returns up to `limit` fragments, each with its provenance and trust tier. e.g. memory_search({query: "chi è il mio commercialista"}).',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for, in natural language' },
      limit: { type: 'number', description: 'How many fragments to return (default 8, max 20)' },
      as_of: {
        type: 'string',
        description:
          'Evaluate memory as it stood at this date (YYYY-MM or YYYY-MM-DD), instead of now. ' +
          'Use it whenever the question is about a past moment.',
      },
      history: {
        type: 'boolean',
        description:
          'Return superseded beliefs too, each marked with when it held and what replaced it.',
      },
      surface: {
        type: 'string',
        description: 'Only what was learned on this channel (e.g. "telegram", "cli", "vault").',
      },
      since: { type: 'string', description: 'Only evidence from this date onwards (YYYY-MM-DD).' },
      until: { type: 'string', description: 'Only evidence up to this date (YYYY-MM-DD).' },
      around: {
        type: 'number',
        description:
          'Also return the K messages before and after each result in its own thread, as context. ' +
          'Use it when a single recalled line is ambiguous on its own (max 5).',
      },
    },
    required: ['query'],
  },
};

/** The raw shape of `args`, before any of it is trusted. */
type RawArgs = {
  query?: unknown;
  limit?: unknown;
  as_of?: unknown;
  history?: unknown;
  surface?: unknown;
  since?: unknown;
  until?: unknown;
  around?: unknown;
};

export async function searchMemory(
  deps: RecallDeps,
  tenantId: string,
  args: unknown,
  jobId?: string,
): Promise<ToolOutcome> {
  const raw = (args ?? {}) as RawArgs;
  if (typeof raw.query !== 'string' || raw.query.trim() === '') {
    // `tier: 0` — this is Muffin's own validation message, never a byte an
    // attacker chose (`ToolOutcome.tier` is required for exactly this reason,
    // `agent/loop.ts`'s doc comment on the field).
    return { content: 'memory_search richiede "query" non vuota.', isError: true, tier: 0 };
  }
  const query = raw.query;

  // Parse at the boundary: this is JSON the model produced, not a value this
  // process already trusts. A type error here has to come back as something
  // the model can act on — a reason to retry with a different argument — never
  // as a silently ignored field, which is how "history" almost read like a
  // plain search a second time.
  for (const [field, value] of [
    ['as_of', raw.as_of],
    ['surface', raw.surface],
    ['since', raw.since],
    ['until', raw.until],
  ] as const) {
    if (value !== undefined && typeof value !== 'string') {
      return { content: `memory_search: "${field}" deve essere una stringa.`, isError: true, tier: 0 };
    }
  }
  if (raw.history !== undefined && typeof raw.history !== 'boolean') {
    return { content: 'memory_search: "history" deve essere booleano.', isError: true, tier: 0 };
  }
  if (raw.around !== undefined && typeof raw.around !== 'number') {
    return { content: 'memory_search: "around" deve essere un numero.', isError: true, tier: 0 };
  }

  const asOfRaw = raw.as_of as string | undefined;
  const sinceRaw = raw.since as string | undefined;
  const untilRaw = raw.until as string | undefined;
  const asOfParsed = normaliseDate(asOfRaw, 'end');
  const since = normaliseDate(sinceRaw, 'start');
  const until = normaliseDate(untilRaw, 'end');
  for (const [field, value, parsed] of [
    ['as_of', asOfRaw, asOfParsed],
    ['since', sinceRaw, since],
    ['until', untilRaw, until],
  ] as const) {
    if (value !== undefined && parsed === undefined) {
      return {
        content: `memory_search: "${field}" = "${value}" non è una data leggibile (usa YYYY-MM o YYYY-MM-DD).`,
        isError: true,
        tier: 0,
      };
    }
  }

  const when = asOfParsed ?? (raw.history === true ? EVERY_INSTANT : undefined);
  const windowError = checkTemporalWindow({ asOf: when, since, until });
  if (windowError === 'empty-window') {
    return {
      content: 'memory_search: "since" è dopo "until" — quella finestra non può contenere niente.',
      isError: true,
      tier: 0,
    };
  }
  if (windowError === 'future-asof') {
    return {
      content: 'memory_search: "as_of" è nel futuro — posso raccontare solo cosa credevo, non cosa crederò.',
      isError: true,
      tier: 0,
    };
  }

  const surface = raw.surface as string | undefined;
  const around = raw.around as number | undefined;

  const result = await recall(deps, tenantId, query, {
    limit: Math.min(Math.max(Number(raw.limit) || 8, 1), 20),
    ...(when === undefined ? {} : { asOf: when }),
    ...(surface !== undefined ? { surface } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(around !== undefined ? { neighbours: around } : {}),
    // Attribution only: the reranker this search pays for lands on the job's
    // ledger when the search runs inside one of its turns.
    ...(jobId === undefined ? {} : { jobId }),
  });

  if (result.items.length === 0 && result.gaps.length === 0) {
    // Explicitly "nothing", never an empty string: the model has to be able to
    // tell "I have no memory of this" apart from "the tool broke".
    return {
      content: `Nessun ricordo per "${query}". Strategie usate: ${result.strategies.join(', ')}.`,
      // No memory came back, so nothing came in. The max below is over an empty
      // set and would say 0 anyway; saying it here keeps the two paths from
      // being read as one having been forgotten.
      tier: 0,
    };
  }

  return {
    // `renderForPrompt` is the one place the temporal label, the successor line
    // and the gap sentence are written — the automatic pre-turn recall in
    // `agent/loop.ts` already goes through it. Hand-building a second, narrower
    // set of lines here would mean this deliberate, on-demand search — the path
    // the model reaches for specifically to answer a question like "who was my
    // accountant in May" — could silently drop the very labels that make the
    // answer safe to say, while the automatic path kept them.
    content: [`${result.items.length} ricordi (${result.strategies.join(', ')}):`, renderForPrompt(result)].join(
      '\n',
    ),
    // The turn inherits the worst source it just pulled in, exactly as the
    // pre-loop recall does. Searching on purpose must not be a way around it.
    tier: result.items.reduce<0 | 1 | 2 | 3>((max, i) => (i.trustTier > max ? i.trustTier : max), 0),
  };
}

/**
 * DAY-1 C5 — "posso capire perché crede una cosa?"
 *
 * `muffin memory why` (`cli/memory.ts`) already answered this for the owner,
 * at a terminal. The model had no door to the same answer: asked mid-turn
 * "why do you think that", it could only narrate — the least trustworthy
 * artefact this system produces, because a model asked to justify a belief
 * will produce a fluent reason whether or not one exists. This tool and the
 * CLI command now read the identical rows through `describeProvenance`
 * (`core/memory/provenance.ts`), so the two can never quietly start
 * disagreeing about what "why" means.
 *
 * Same capability as `memory_search` (`memoryCapability`, `memory.read`):
 * this is a read of the same store, scoped to the same tenant, and inventing
 * a second capability id for the same effect would be a distinction the
 * policy matrix has no row for.
 */
export const memoryWhySpec: ToolSpec = {
  name: 'memory_why',
  description:
    'Explain why you believe something: the exact episode a fact came from, who said it (or which ' +
    'document), when, over which connector, and how much it is trusted. Use it whenever the owner asks ' +
    '"why do you think that" or "who told you that" — never invent a reason, look it up. ' +
    'Not for finding a fact in the first place — call memory_search first, then explain the one it returns. ' +
    'Pass "fact_id" when you already have one; otherwise pass "query" describing the belief in ' +
    'natural language and the closest matching fact is explained. Returns the provenance of one fact, or a ' +
    'message saying none matched.',
  inputSchema: {
    type: 'object',
    properties: {
      fact_id: { type: 'number', description: 'The id of a fact you already know (e.g. from memory_search), to explain directly.' },
      query: {
        type: 'string',
        description: 'The belief to explain, in natural language, when you do not already have a fact_id.',
      },
    },
  },
};

/** The raw shape of `args`, before any of it is trusted. */
type WhyRawArgs = {
  fact_id?: unknown;
  query?: unknown;
};

export async function whyMemory(
  deps: RecallDeps,
  tenantId: string,
  args: unknown,
  jobId?: string,
): Promise<ToolOutcome> {
  const raw = (args ?? {}) as WhyRawArgs;
  const hasFactId = raw.fact_id !== undefined;
  const hasQuery = typeof raw.query === 'string' && raw.query.trim() !== '';

  if (hasFactId && typeof raw.fact_id !== 'number') {
    return { content: 'memory_why: "fact_id" deve essere un numero.', isError: true, tier: 0 };
  }
  if (!hasFactId && !hasQuery) {
    return {
      content: 'memory_why richiede "fact_id" (un id già noto) oppure "query" (il fatto da spiegare, a parole).',
      isError: true,
      tier: 0,
    };
  }

  let fact: Fact | null;
  if (hasFactId) {
    const factId = raw.fact_id as number;
    // Tenant-scoped through the store's own method — never trusts a fact_id
    // the model happens to type into meaning "any tenant's fact #N".
    fact = deps.store.factById(tenantId, factId);
    if (!fact) {
      return { content: `Nessun fatto #${factId} in questa memoria.`, tier: 0 };
    }
  } else {
    // The ordinary path: `renderForPrompt` never prints a fact id (nothing in
    // `memory_search`'s rendered block does), so the model almost never has
    // one to pass. It has words instead — the same hybrid recall
    // `memory_search` runs, read here for its facts rather than rendered for
    // the prompt.
    const query = raw.query as string;
    const found = await recall(deps, tenantId, query, {
      limit: 5,
      ...(jobId === undefined ? {} : { jobId }),
    });
    const hit = found.items.find((item) => item.kind === 'fact');
    if (!hit) {
      return {
        content: `Nessun fatto trovato per "${query}" — niente di cui posso spiegare la provenienza. Strategie usate: ${found.strategies.join(', ')}.`,
        tier: 0,
      };
    }
    fact = deps.store.factById(tenantId, hit.id);
    if (!fact) {
      // The hop just found it; a fact retired between that read and this one
      // is the only way this branch is reachable.
      return { content: `Il fatto #${hit.id} non è più leggibile.`, tier: 0 };
    }
  }

  const { lines, tier } = describeProvenance(deps.store, tenantId, fact);
  return { content: lines.join('\n'), tier };
}
