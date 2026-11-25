export const CAPABILITY_SEARCH_TOOL_NAME = 'capability_search';

/**
 * Volatile harness guidance shown only when the current turn is actually using
 * progressive capability projection. The full projection needs neither this
 * text nor the discovery schema.
 */
export const CAPABILITY_DISCOVERY_GUIDANCE =
  '[Il menu tool di questo turno è una proiezione parziale del catalogo autorizzato. ' +
  'Valuta separatamente ogni azione ed effetto richiesto: se anche uno solo non è coperto dai tool visibili, usa capability_search per trovare la capacità autorizzata necessaria, anche quando altri tool visibili coprono altre parti. ' +
  'Non concludere che la richiesta è completa dopo aver svolto soltanto una parte.]';

/**
 * The initial always-visible native kernel when catalogue pressure exists.
 *
 * Keep common workspace read and write operations and orientation tools visible.
 * The list only selects from the catalogue already filtered by authority.
 */
export const DEFAULT_CORE_TOOL_NAMES = [
  'fs_read',
  'fs_write',
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
  readonly eligibleCount: number;
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
  readonly searchAndLoad: (
    query: string,
    maxResults: number,
    firstName?: string,
  ) => CapabilityLoadResult;
  /** Apply the batch at the model boundary and return whether discovery remains available. */
  readonly activatePending: () => boolean;
};

export type CapabilityExposure<T extends CapabilityTool> = {
  /** Mutable only at round boundaries; runTool receives this same array. */
  readonly exposed: T[];
  readonly pressured: boolean;
  /** Current schema menu in both selective and flat mode. */
  readonly snapshot: () => CapabilityExposureSnapshot;
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
 * There is no numeric cap. Tools named in the core stay visible. Every other
 * eligible tool stays reachable: when a discovery tool exists it is not in
 * the first schema list and loads by deterministic lexical search. The
 * eligible catalogue is shown whole when discovery is absent or the turn
 * cannot use it.
 *
 * eligible must already be principal/grant filtered. Execution remains on the
 * normal tool path and therefore gets the kernel's full policy re-check.
 */
export function createCapabilityExposure<T extends CapabilityTool>(input: {
  readonly eligible: readonly T[];
  readonly discoveryTool?: T | undefined;
  readonly canDiscover?: (() => boolean) | undefined;
  readonly coreNames?: readonly string[] | undefined;
}): CapabilityExposure<T> {
  const discoveryName = input.discoveryTool?.spec.name;
  const catalog =
    discoveryName === undefined
      ? [...input.eligible]
      : input.eligible.filter((tool) => tool.spec.name !== discoveryName);

  const preferred = input.coreNames ?? DEFAULT_CORE_TOOL_NAMES;
  const core = takeCore(catalog, preferred.length, preferred).filter((tool) =>
    preferred.includes(tool.spec.name),
  );
  const coreNames = new Set(core.map((tool) => tool.spec.name));
  const searchable = catalog.filter((tool) => !coreNames.has(tool.spec.name));

  const discoveryTool = searchable.length === 0 ? undefined : input.discoveryTool;
  const fixed = discoveryTool === undefined ? catalog : [...core, discoveryTool];
  const exposed = [...fixed];
  let discoveryAvailable = discoveryTool !== undefined;
  const snapshot = (): CapabilityExposureSnapshot => ({
    visible: exposed.map((tool) => tool.spec.name),
    eligibleCount: input.eligible.length,
    pressured: discoveryAvailable,
    hiddenCount: discoveryAvailable ? searchable.length : 0,
  });

  if (discoveryTool === undefined) return { exposed, pressured: false, snapshot };

  let pending: Map<string, T> | null = null;
  let loaded: T[] = [];

  const discovery: CapabilityDiscoveryPort = {
    searchAndLoad(query, maxResults, firstName) {
      const limit = Math.max(1, Math.floor(maxResults));
      const ranked = searchable
        .map((tool, index) => ({
          tool,
          index,
          score: tool.spec.name === firstName ? Number.MAX_SAFE_INTEGER : score(tool, query),
        }))
        .filter((row) => row.score > 0)
        .sort((left, right) => right.score - left.score || left.index - right.index);

      const selected = ranked.slice(0, limit).map((row) => row.tool);
      pending ??= new Map();
      for (const tool of selected) pending.set(tool.spec.name, tool);

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
      const available = input.canDiscover?.() ?? true;
      const selectionChanged = pending !== null;
      if (pending !== null) {
        loaded = [...pending.values()];
        pending = null;
      }
      if (available !== discoveryAvailable || (available && selectionChanged)) {
        discoveryAvailable = available;
        exposed.splice(0, exposed.length, ...(available ? [...fixed, ...loaded] : catalog));
      }
      return discoveryAvailable;
    },
  };

  return {
    exposed,
    pressured: true,
    snapshot,
    discovery,
  };
}

/**
 * Use the same deterministic authority-filtered search to seed the first model
 * round from the task text. This is the provider-neutral fallback for models
 * that do not reliably decide to invoke the discovery meta-tool themselves.
 *
 * The search door remains visible, so a later need can still replace the
 * task-local selection.
 */
export function preloadCapabilitiesForTask<T extends CapabilityTool>(
  exposure: CapabilityExposure<T>,
  query: string,
  maxResults = 2,
  firstName?: string,
): CapabilityLoadResult | null {
  if (!exposure.pressured || exposure.discovery === undefined) return null;
  const result = exposure.discovery.searchAndLoad(query, maxResults, firstName);
  return exposure.discovery.activatePending() ? result : null;
}
