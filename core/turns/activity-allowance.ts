import type { TurnRecord } from './store.js';
export type ActivityLimits = {
  maxModelCalls: number;
  maxToolCalls: number;
  maxAutomaticContinuations: number;
};
export type ActivityAllowance = ActivityLimits & {
  modelCallsUsed: number;
  toolCallsUsed: number;
  automaticContinuationsUsed: number;
};
const limitKeys = ['maxModelCalls', 'maxToolCalls', 'maxAutomaticContinuations'] as const;
const usedKeys = ['modelCallsUsed', 'toolCallsUsed', 'automaticContinuationsUsed'] as const;
export function checkedAllowance(value: unknown): ActivityAllowance {
  if (value === null || typeof value !== 'object') throw new Error('Invalid activity allowance');
  const raw = value as Record<string, unknown>;
  for (const key of [...limitKeys, ...usedKeys]) {
    if (
      !Number.isSafeInteger(raw[key]) ||
      (raw[key] as number) < (key === 'maxModelCalls' || key === 'maxToolCalls' ? 1 : 0)
    )
      throw new Error('Invalid activity allowance');
  }
  for (const [used, limit] of [
    ['modelCallsUsed', 'maxModelCalls'],
    ['toolCallsUsed', 'maxToolCalls'],
    ['automaticContinuationsUsed', 'maxAutomaticContinuations'],
  ] as const) {
    if ((raw[used] as number) > (raw[limit] as number))
      throw new Error('Invalid activity allowance');
  }
  return Object.fromEntries(
    [...limitKeys, ...usedKeys].map((key) => [key, raw[key]]),
  ) as ActivityAllowance;
}
export function newActivityAllowance(limits: ActivityLimits): ActivityAllowance {
  return checkedAllowance({
    ...limits,
    modelCallsUsed: 0,
    toolCallsUsed: 0,
    automaticContinuationsUsed: 0,
  });
}
export const OWNER_ACTIVITY_RECOVERABLE_REASONS = [
  'provider_empty',
  'truncated',
  'provider_transport',
  'model_stall',
  'model_deadline',
  'turn_deadline',
  'active_model_budget',
  'recovery_exhausted',
  'plan_open',
] as const;
export function isOwnerActivityAutonomous(
  record: Pick<TurnRecord, 'principal' | 'counters' | 'continuableReason'>,
): boolean {
  if (
    record.principal.kind !== 'owner' ||
    record.counters.activityAllowance === undefined ||
    !OWNER_ACTIVITY_RECOVERABLE_REASONS.some((reason) => reason === record.continuableReason?.class)
  )
    return false;
  const a = checkedAllowance(record.counters.activityAllowance);
  return (
    a.modelCallsUsed < a.maxModelCalls &&
    a.toolCallsUsed < a.maxToolCalls &&
    a.automaticContinuationsUsed < a.maxAutomaticContinuations
  );
}
