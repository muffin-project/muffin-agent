import {
  checkTemporalWindow,
  EVERY_INSTANT,
  normaliseDate,
  recall,
  renderForPrompt,
  type RecallDeps,
} from '../../core/memory/recall.js';
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
  risk: 'low',
  reversible: 'yes',
  // A read, and a read of our own store: running it twice returns the same
  // rows or fresher ones, and changes nothing.
  rerunnable: true,
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
    'have just come across. Results carry their source and how much it is trusted. ' +
    'For a question about the past ("who was my accountant in May", "what did we decide back then"), ' +
    'set as_of to that date — without it you get what is true now, which is a wrong answer to a ' +
    'question about then. Set history:true to see a belief and everything it replaced.',
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
