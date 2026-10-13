import { AsyncLocalStorage } from 'node:async_hooks';
import type { TurnStore } from '../../core/turns/store.js';
import type { Provider } from './types.js';

type ActivityScope = { turns: TurnStore; turnId: string; claimToken: string | null };
const active = new AsyncLocalStorage<ActivityScope>();

/** Local admission failure, never a provider transport failure. */
export class ActivityAllowanceError extends Error {
  readonly retryable = false;
  constructor(readonly resource: 'model' | 'tool') {
    super(`Activity ${resource} allowance exhausted or execution claim lost`);
    this.name = 'ActivityAllowanceError';
  }
}

/** Async context keeps concurrent activities and unrelated light jobs separate. */
export function withActivityAllowance<T>(scope: ActivityScope, work: () => T): T {
  return active.run(scope, work);
}

/** Completed-turn background work has its own owner and financial controls. */
export function withoutActivityAllowance<T>(work: () => T): T {
  return active.exit(work);
}

export function reserveActivityAttempt(resource: 'model' | 'tool'): void {
  const scope = active.getStore();
  if (scope === undefined) return;
  if (
    scope.claimToken === null ||
    !scope.turns.reserveActivity(scope.turnId, scope.claimToken, resource)
  ) {
    throw new ActivityAllowanceError(resource);
  }
}

/** One reservation per physical main request, including stream fallback. */
export function activityProvider(inner: Provider): Provider {
  return {
    kind: inner.kind,
    ...(inner.resolveReasoning === undefined
      ? {}
      : { resolveReasoning: inner.resolveReasoning.bind(inner) }),
    async chat(call) {
      if (!call.signal?.aborted) reserveActivityAttempt('model');
      return inner.chat(call);
    },
    ...(inner.chatStream === undefined
      ? {}
      : {
          async *chatStream(call: Parameters<Provider['chat']>[0]) {
            if (!call.signal?.aborted) reserveActivityAttempt('model');
            yield* inner.chatStream!(call);
          },
        }),
  };
}
