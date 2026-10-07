export const CAPABILITY_SEARCH_TOOL_NAME = 'capability_search';

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

export type CapabilityDiscoveryPort = {
  readonly searchAndLoad: (query: string, maxResults: number) => CapabilityLoadResult;
};

export type CapabilityExposure<T extends CapabilityTool> = {
  /** Mutable on purpose: successful discovery changes the next model round. */
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
    throw new Error('capability_search is required when the authorized catalogue exceeds maxToolsExposed');
  }

  const preferred = input.coreNames ?? DEFAULT_CORE_TOOL_NAMES;
  // One slot is discovery itself and, where the profile permits it, at least
  // one slot must remain loadable. The preferred core is capped at five.
  const coreTarget =
    max === 1 ? 0 : Math.min(preferred.length, catalog.length, Math.max(0, max - 2));
  const core = takeCore(catalog, coreTarget, preferred);
  const fixed = [...core, input.discoveryTool];
  const exposed = [...fixed];
  const coreNames = new Set(core.map((tool) => tool.spec.name));
  const searchable = catalog.filter((tool) => !coreNames.has(tool.spec.name));
  const dynamicCapacity = Math.max(0, max - fixed.length);

  const discovery: CapabilityDiscoveryPort = {
    searchAndLoad(query, maxResults) {
      const limit = Math.max(1, Math.floor(maxResults));
      const ranked = searchable
        .map((tool, index) => ({ tool, index, score: score(tool, query) }))
        .filter((row) => row.score > 0)
        .sort((left, right) => right.score - left.score || left.index - right.index);

      const matches = ranked.slice(0, limit).map((row) => row.tool);

      if (max === 1) {
        // A one-slot profile cannot keep the search door and a loaded schema at
        // once. The matched tool replaces discovery for the next round.
        exposed.splice(
          0,
          exposed.length,
          ...(matches.length > 0 ? [matches[0]!] : [input.discoveryTool]),
        );
      } else {
        // Loaded tools are a task-local projection, not a growing second
        // catalogue. A new search replaces the previous dynamic set.
        exposed.splice(fixed.length);
        exposed.push(...matches.slice(0, dynamicCapacity));
      }

      const loaded = exposed
        .filter((tool) => !fixed.some((fixedTool) => fixedTool.spec.name === tool.spec.name))
        .map((tool) => ({ name: tool.spec.name, capability: tool.capability }));

      return {
        loaded,
        matched: ranked.length,
        omitted: Math.max(0, ranked.length - loaded.length),
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
