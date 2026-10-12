import { z } from 'zod';
import type { CapabilityDecl } from '../../core/policy/types.js';
import type { RegisteredTool } from '../loop.js';
import { CAPABILITY_SEARCH_TOOL_NAME } from '../capability-exposure.js';

export const capabilityDiscoveryCapability: CapabilityDecl = {
  id: 'sys.capability_discover',
  effect: 'context',
  risk: 'low',
  reversible: 'yes',
  rerunnable: true,
  resourceKind: 'none',
  policyArgs: ['query'],
  hostOnly: false,
};

const argsSchema = z.object({
  query: z.string().min(2).max(200),
  max_results: z.number().int().min(1).max(5).optional(),
});

export function makeCapabilitySearchTool(): RegisteredTool {
  return {
    capability: capabilityDiscoveryCapability.id,
    spec: {
      name: CAPABILITY_SEARCH_TOOL_NAME,
      description:
        'Search and load authorized tools that are not currently visible. ' +
        'Use it when none of the visible tools directly fits the user task; describe the capability you need instead of guessing a hidden tool name. ' +
        'Not for tasks already covered by a visible tool, and not for browsing the catalogue without a task need. ' +
        'The next model round receives the loaded tool schemas; execution still goes through normal policy checks.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Short description of the capability needed for the current task; describe the need, not a guessed tool name.',
          },
          max_results: {
            type: 'integer',
            minimum: 1,
            maximum: 5,
            description: 'Maximum number of matching tool schemas to load.',
          },
        },
        required: ['query'],
      },
    },
    throwTier: 0,
    handler: (args, ctx) => {
      const parsed = argsSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: 'invalid arguments: query must be a short non-empty capability description',
          isError: true,
          tier: 0,
        };
      }

      const discovery = ctx.capabilityDiscovery;
      if (!discovery) {
        return {
          content: 'Capability discovery is not needed on this turn: the authorized catalogue already fits.',
          tier: 0,
        };
      }

      const result = discovery.searchAndLoad(parsed.data.query, parsed.data.max_results ?? 3);
      if (result.loaded.length === 0) {
        return {
          content: 'No authorized hidden capability matched that query.',
          tier: 0,
        };
      }

      const loaded = result.loaded
        .map((entry) => entry.name + ' [' + entry.capability + ']')
        .join(', ');
      const suffix =
        result.omitted > 0
          ? ' ' + String(result.omitted) + ' additional match(es) were not loaded because of the profile exposure ceiling.'
          : '';
      return {
        content: 'Selected for the next model round in this lease: ' + loaded + '.' + suffix,
        tier: 0,
      };
    },
  };
}
