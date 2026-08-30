import { createDecide } from '../../core/policy/decide.js';
import { POLICY_FLOOR, type PolicyMatrix } from '../../core/policy/matrix.js';
import type {
  CapabilityDecl,
  Decision,
  DecisionRequest,
  Principal,
  TrustTier,
} from '../../core/policy/types.js';

/**
 * The two incumbent baselines from the Security v2 eval contract.
 *
 * A changes nothing: the policy sees the ambient context taint production sees.
 * B removes only that one authority input by presenting the same normalized
 * action at taint 0. Principal, tenant, capability declaration, resource,
 * args, budget, Root-of-Trust matrix, hardened mode and egress policy stay the
 * same. B is an experiment, never a production mode.
 */
export type BaselineMode = 'ambient-taint' | 'no-ambient-taint';

export type BaselineAction = Omit<DecisionRequest, 'taint'> & {
  /** What production A would present after context composition. */
  ambientTaint: TrustTier;
};

export type BaselineResult = {
  mode: BaselineMode;
  effectiveTaint: TrustTier;
  decision: Decision;
};

export type BaselineHarnessOptions = {
  capabilities: readonly CapabilityDecl[];
  matrix?: PolicyMatrix;
  hardened?: boolean;
  budgetExhausted?: (tenant: string) => boolean;
  safeMode?: boolean;
  egressAllowed?: (host: string) => boolean;
};

export function makeBaselineHarness(options: BaselineHarnessOptions) {
  const decide = createDecide({
    capabilities: new Map(options.capabilities.map((decl) => [decl.id, decl])),
    matrix: options.matrix ?? POLICY_FLOOR,
    budgetExhausted: options.budgetExhausted ?? (() => false),
    hardened: options.hardened ?? true,
    ...(options.safeMode === undefined ? {} : { safeMode: options.safeMode }),
    ...(options.egressAllowed === undefined ? {} : { egressAllowed: options.egressAllowed }),
  });

  return (action: BaselineAction): readonly [BaselineResult, BaselineResult] => {
    const run = (mode: BaselineMode, taint: TrustTier): BaselineResult => ({
      mode,
      effectiveTaint: taint,
      decision: decide({
        principal: action.principal,
        tenant: action.tenant,
        capability: action.capability,
        resource: action.resource,
        args: action.args,
        taint,
      }),
    });

    return [run('ambient-taint', action.ambientTaint), run('no-ambient-taint', 0)] as const;
  };
}

export const OWNER: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };
