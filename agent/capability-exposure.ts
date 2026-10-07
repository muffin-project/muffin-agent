export const CAPABILITY_SEARCH_TOOL_NAME = 'capability_search';

/**
 * Volatile harness guidance shown only when the current turn is actually using
 * progressive capability projection. The ordinary under-cap path sees neither
 * this text nor the discovery schema.
 */
export const CAPABILITY_DISCOVERY_GUIDANCE =
  '[Il menu tool di questo turno è una proiezione parziale del catalogo autorizzato. ' +
  'Se nessun tool visibile corrisponde direttamente alla richiesta, usa capability_search descrivendo la capacità necessaria prima di provare tool non pertinenti o concludere che la capacità non esiste.]';


/**
 * The initial always-visible native kernel when catalogue pressure exists.
 *
 * These are retrieval/orientation primitives, not business/domain capabilities.
 * The list is deliberately small; missing entries are filled from the existing
 * eligible registration order so a custom runtime is not left with an empty
 * kernel merely because it does not ship Muffin's built-ins.
 */
export const DEFAULT_CORE_TOOL_NAMES = [
  'fs_read',
  'fs_list',
  'fs_search',
  'memory_search',
  'skill_read',
] as const;

type CapabilityTool = {
  readonly capability: string;
  readonly spec: {
    readonly name: string;
    readonly description: string;
  };
};

export type CapabilityLoadResult = {
  readonly loaded: ReadonlyArray<{ name: string; capability: string }>;
  readonly matched: number;
  readonly omitted: number;
};

export type CapabilityExposureSnapshot = {
  readonly visible: readonly string[];
  readonly pressured: boolean;
  readonly hiddenCount: number;
};

export type CapabilityDiscoveryPort = {
  /**
   * Select schemas for the next model round. Selection is staged so the
   * provider-visible projection changes only at a model-call boundary.
   *
   * This is not an execution or authority gate: a directly named registered
   * tool still reaches the normal kernel path, preserving Muffin's existing
   * defence-in-depth rule for forbidden calls.
   */
  readonly searchAndLoad: (query: string, maxResults: number) => CapabilityLoadResult;
  /** Apply the last staged selection at the next round boundary. */
  readonly activatePending: () => void;
  /** Current model-visible projection, for truthful runtime inspection. */
  readonly snapshot: () => CapabilityExposureSnapshot;
};

export type CapabilityExposure<T extends CapabilityTool> = {
  /** Mutable only at round boundaries; runTool receives this same array. */
  readonly exposed: T[];
  readonly pressured: boolean;
  readonly hiddenCount: number;
  readonly discovery?: CapabilityDiscoveryPort | undefined;
};

function normalized(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, ' ')
    .trim();
}

function tokens(value: string): string[] {
  return normalized(value)
    .split(/[\s._-]+/)
    .filter((token) => token.length >= 2);
}

function score(tool: CapabilityTool, query: string): number {
  const q = normalized(query);
  if (q === '') return 0;

  const name = normalized(tool.spec.name);
  const capability = normalized(tool.capability);
  const description = normalized(tool.spec.description);
  let value = 0;

  if (name === q) value += 200;
  else if (name.includes(q)) value += 100;

  if (capability === q) value += 160;
  else if (capability.includes(q)) value += 80;

  if (description.includes(q)) value += 30;

  for (const token of tokens(q)) {
    if (name.split(/[._-]+/).includes(token)) value += 30;
    else if (name.includes(token)) value += 15;

    if (capability.split(/[._-]+/).includes(token)) value += 20;
    else if (capability.includes(token)) value += 10;

    if (description.includes(token)) value += 3;
  }

  return value;
}

function takeCore<T extends CapabilityTool>(
  catalog: readonly T[],
  target: number,
  preferred: readonly string[],
): T[] {
  const picked: T[] = [];
  const names = new Set<string>();

  for (const preferredName of preferred) {
    if (picked.length >= target) break;
    const hit = catalog.find((tool) => tool.spec.name === preferredName);
    if (!hit || names.has(hit.spec.name)) continue;
    picked.push(hit);
    names.add(hit.spec.name);
  }

  for (const tool of catalog) {
    if (picked.length >= target) break;
    if (names.has(tool.spec.name)) continue;
    picked.push(tool);
    names.add(tool.spec.name);
  }

  return picked;
}

/**
 * Build one turn's model-visible tool projection from an already authority-
 * filtered catalogue.
 *
 * Under the cap, the old fast path is byte-for-byte in the same order and no
 * discovery schema is added. Under pressure, a small retrieval kernel stays
 * visible, capability_search occupies one slot, and the remaining slots are a
 * replaceable task-local projection loaded by deterministic lexical search.
 *
 * eligible must already be principal/grant filtered. Execution remains on the
 * normal tool path and therefore gets the kernel's full policy re-check.
 */
export function createCapabilityExposure<T extends CapabilityTool>(input: {
  readonly eligible: readonly T[];
  readonly maxToolsExposed: number;
  readonly discoveryTool?: T | undefined;
  readonly coreNames?: readonly string[] | undefined;
}): CapabilityExposure<T> {
  const max = input.maxToolsExposed;
  if (!Number.isInteger(max) || max <= 0) {
    throw new Error('maxToolsExposed must be a positive integer');
  }

  const discoveryName = input.discoveryTool?.spec.name;
  const catalog =
    discoveryName === undefined
      ? [...input.eligible]
      : input.eligible.filter((tool) => tool.spec.name !== discoveryName);

  if (catalog.length <= max) {
    return {
      exposed: [...catalog],
      pressured: false,
      hiddenCount: 0,
    };
  }

  if (input.discoveryTool === undefined) {
    throw new Error(
      'capability_search is required when the authorized catalogue exceeds maxToolsExposed',
    );
  }
  const discoveryTool = input.discoveryTool;

  const preferred = input.coreNames ?? DEFAULT_CORE_TOOL_NAMES;
  // Reserve one slot for discovery and, where possible, at least one slot for
  // a task-local schema. Five is only the preferred maximum core, never a
  // reason to violate the profile ceiling.
  const coreTarget =
    max === 1 ? 0 : Math.min(preferred.length, catalog.length, Math.max(0, max - 2));
  const core = takeCore(catalog, coreTarget, preferred);
  const fixed = [...core, discoveryTool];
  const exposed = [...fixed];
  const coreNames = new Set(core.map((tool) => tool.spec.name));
  const searchable = catalog.filter((tool) => !coreNames.has(tool.spec.name));
  const dynamicCapacity = Math.max(0, max - fixed.length);

  let pending: T[] | null = null;

  const discovery: CapabilityDiscoveryPort = {
    searchAndLoad(query, maxResults) {
      const limit = Math.max(1, Math.floor(maxResults));
      const ranked = searchable
        .map((tool, index) => ({ tool, index, score: score(tool, query) }))
        .filter((row) => row.score > 0)
        .sort((left, right) => right.score - left.score || left.index - right.index);

      const matches = ranked.slice(0, limit);
      const selected =
        max === 1
          ? matches.slice(0, 1).map((row) => row.tool)
          : matches.slice(0, dynamicCapacity).map((row) => row.tool);

      if (max === 1) {
        // With a one-schema custom profile the search door temporarily swaps
        // with the selected schema. On a miss it stays in place, but a miss is
        // still reported as a miss rather than pretending discovery loaded
        // itself.
        pending = selected.length > 0 ? selected : [discoveryTool];
      } else {
        pending = selected;
      }

      const loaded = selected.map((tool) => ({
        name: tool.spec.name,
        capability: tool.capability,
      }));

      return {
        loaded,
        matched: ranked.length,
        omitted: Math.max(0, ranked.length - loaded.length),
      };
    },

    activatePending() {
      if (pending === null) return;
      if (max === 1) {
        exposed.splice(0, exposed.length, ...pending);
      } else {
        exposed.splice(fixed.length);
        exposed.push(...pending);
      }
      pending = null;
    },

    snapshot() {
      return {
        visible: exposed.map((tool) => tool.spec.name),
        pressured: true,
        hiddenCount: searchable.length,
      };
    },
  };

  return {
    exposed,
    pressured: true,
    hiddenCount: searchable.length,
    discovery,
  };
}

/**
 * Use the same deterministic authority-filtered search to seed the first model
 * round from the task text. This is the provider-neutral fallback for models
 * that do not reliably decide to invoke the discovery meta-tool themselves.
 *
 * The search door remains visible (except on the intentionally tiny one-slot
 * profile), so a later need can still replace the task-local selection.
 */
export function preloadCapabilitiesForTask<T extends CapabilityTool>(
  exposure: CapabilityExposure<T>,
  query: string,
  maxResults = 2,
): CapabilityLoadResult | null {
  if (!exposure.pressured || exposure.discovery === undefined) return null;
  const result = exposure.discovery.searchAndLoad(query, maxResults);
  exposure.discovery.activatePending();
  return result;
}

