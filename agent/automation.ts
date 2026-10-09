import type {
  StoredAutomationAction,
  StoredAutomationRule,
} from '../core/automation/rules.js';

/**
 * The executable waist owned by #605.
 *
 * This is deliberately not an event bus. Producers bring one already-identified
 * occurrence, rules choose an action, and the action delegates to the execution
 * mechanism that already owns durability/authority (scheduler, Turn/Work, WAL).
 * Nothing here stores events, mints principals, starts a scheduler, or calls a
 * model by itself.
 */

export type RuntimeEventKind =
  | 'schedule.fire'
  | 'message.received'
  | 'external.condition.matched';

export type RuntimeEvent = {
  /** Stable producer-owned occurrence identity. Never process-local. */
  readonly occurrenceId: string;
  readonly kind: RuntimeEventKind;
  readonly source: string;
  readonly observedAt: string;
  /**
   * Bounded structured facts used by deterministic matchers. Provenance is
   * preserved by the producer; this object is never reclassified as owner text.
   */
  readonly evidence: Readonly<Record<string, unknown>>;
};

type MaybePromise<T> = T | Promise<T>;

export type DeterministicSignal =
  | { readonly signal: false }
  | { readonly signal: true; readonly evidence: unknown };

export type ActionRequest<T> =
  | {
      readonly mode: 'deterministic';
      readonly run: () => MaybePromise<T>;
    }
  | {
      readonly mode: 'agent';
      readonly run: () => MaybePromise<T>;
    }
  | {
      readonly mode: 'deterministic_then_agent_on_signal';
      readonly check: () => MaybePromise<DeterministicSignal>;
      /** The settled result when the deterministic check emits no signal. */
      readonly noSignal: () => MaybePromise<T>;
      readonly runAgent: (evidence: unknown) => MaybePromise<T>;
    };

export type AutomationRule<T> = {
  readonly id: string;
  readonly matches: (event: RuntimeEvent) => boolean;
  readonly action: (event: RuntimeEvent) => ActionRequest<T>;
};

export type StoredAutomationActionResolver<T> = (
  action: StoredAutomationAction,
  event: RuntimeEvent,
  rule: StoredAutomationRule,
) => ActionRequest<T>;

function storedMatcherMatches(rule: StoredAutomationRule, event: RuntimeEvent): boolean {
  if (!rule.enabled || rule.eventKind !== event.kind) return false;
  switch (rule.matcher.type) {
    case 'evidence_equals':
      return Object.is(event.evidence[rule.matcher.key], rule.matcher.value);
  }
}

/**
 * Project one durable definition into the #605 executable seam.
 *
 * The store never gains an executor. Resolution stays host-owned so policy,
 * authority, WAL and canonical Turn execution are rechecked where they already
 * live. A persisted rule is data; this function is the only conversion to the
 * in-memory closure shape used by dispatchRuntimeEvent.
 */
export function compileStoredAutomationRule<T>(
  rule: StoredAutomationRule,
  resolve: StoredAutomationActionResolver<T>,
): AutomationRule<T> {
  return {
    id: rule.id,
    matches: (event) => storedMatcherMatches(rule, event),
    action: (event) => resolve(rule.action, event, rule),
  };
}

export async function executeAction<T>(request: ActionRequest<T>): Promise<T> {
  switch (request.mode) {
    case 'deterministic':
    case 'agent':
      return request.run();
    case 'deterministic_then_agent_on_signal': {
      const result = await request.check();
      if (!result.signal) return request.noSignal();
      return request.runAgent(result.evidence);
    }
  }
}

/**
 * First deterministic match wins. With no rule, the producer's canonical
 * fallback runs. This keeps ordinary ingress/scheduler behaviour unchanged
 * while giving event-triggered automation one common executable boundary.
 */
export async function dispatchRuntimeEvent<T>(
  event: RuntimeEvent,
  rules: readonly AutomationRule<T>[],
  fallback: ActionRequest<T>,
): Promise<T> {
  const rule = rules.find((candidate) => candidate.matches(event));
  return executeAction(rule === undefined ? fallback : rule.action(event));
}
