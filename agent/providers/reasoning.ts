export type ReasoningMode = 'off' | 'adaptive' | 'on';

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ReasoningRequest = {
  mode: ReasoningMode;
  effort?: ReasoningEffort;
  maxTokens?: number;
};

export type ReasoningSupport = 'supported' | 'unsupported' | 'unknown';

export type ReasoningCapabilities = {
  support: ReasoningSupport;
  canDisable: boolean;
  supportedEfforts?: readonly ReasoningEffort[];
  defaultEnabled?: boolean;
  defaultEffort?: ReasoningEffort;
  supportsMaxTokens: boolean;
  mandatory: boolean;
};

export type ReasoningCapabilitySource =
  | 'openrouter-live'
  | 'openrouter-cache'
  | 'static-snapshot'
  | 'provider-default'
  | 'endpoint-defaults'
  | 'unknown';

export type ReasoningResolution = {
  requested?: ReasoningRequest;
  effective?: ReasoningRequest;
  status: 'applied' | 'omitted' | 'unsupported';
  capabilitySource: ReasoningCapabilitySource;
  reason?: string;
};

export class ReasoningConfigurationError extends Error {
  readonly code = 'unsupported_reasoning_capability' as const;

  constructor(readonly resolution: ReasoningResolution) {
    super(resolution.reason ?? 'unsupported reasoning capability');
    this.name = 'ReasoningConfigurationError';
  }
}

export function reasoningFromLegacyThinking(thinking: 'adaptive' | 'off' | 'unset' | undefined): ReasoningRequest | undefined {
  if (thinking === undefined || thinking === 'unset') return undefined;
  return { mode: thinking };
}

export function reasoningRequest(call: { reasoning?: ReasoningRequest; thinking?: 'adaptive' | 'off' | 'unset' }): ReasoningRequest | undefined {
  return call.reasoning ?? reasoningFromLegacyThinking(call.thinking);
}

export function resolveReasoningPolicy(
  requested: ReasoningRequest | undefined,
  capabilities: ReasoningCapabilities,
  capabilitySource: ReasoningCapabilitySource,
): ReasoningResolution {
  if (requested === undefined) return { status: 'omitted', capabilitySource };
  if (requested.maxTokens !== undefined && (!Number.isInteger(requested.maxTokens) || requested.maxTokens <= 0)) {
    return unsupported(requested, capabilitySource, 'reasoning maxTokens must be a positive integer');
  }
  if (requested.mode === 'off' && (requested.effort !== undefined || requested.maxTokens !== undefined)) {
    return unsupported(requested, capabilitySource, 'reasoning off cannot carry effort or maxTokens');
  }
  if (requested.maxTokens !== undefined && !capabilities.supportsMaxTokens) {
    return unsupported(
      requested,
      capabilitySource,
      capabilities.support === 'unknown'
        ? 'reasoning capability is unknown; refusing an exact token budget until metadata is available'
        : 'provider/model does not expose an exact reasoning token budget',
    );
  }
  if (requested.effort !== undefined && capabilities.supportedEfforts !== undefined && !capabilities.supportedEfforts.includes(requested.effort)) {
    return unsupported(requested, capabilitySource, `reasoning effort ${requested.effort} is not supported`);
  }
  if (requested.mode === 'off') {
    if (capabilities.support === 'unsupported') return { requested, status: 'omitted', capabilitySource, reason: 'endpoint has no reasoning capability; omission is the off state' };
    if (capabilities.support === 'unknown') return unsupported(requested, capabilitySource, 'reasoning capability is unknown; refusing to claim that off was applied');
    if (capabilities.mandatory || !capabilities.canDisable) return unsupported(requested, capabilitySource, 'model/provider requires reasoning and cannot disable it');
    return { requested, effective: requested, status: 'applied', capabilitySource };
  }
  if (capabilities.support === 'unsupported') {
    return { requested, effective: { mode: 'adaptive' }, status: 'omitted', capabilitySource, reason: 'endpoint has no reasoning capability; provider default remains in control' };
  }
  if (capabilities.support === 'unknown') {
    return { requested, effective: { mode: 'adaptive' }, status: 'omitted', capabilitySource, reason: 'reasoning capability is unknown; provider default remains in control' };
  }
  return { requested, effective: requested, status: 'applied', capabilitySource };
}

function unsupported(requested: ReasoningRequest, capabilitySource: ReasoningCapabilitySource, reason: string): ReasoningResolution {
  return { requested, status: 'unsupported', capabilitySource, reason };
}
