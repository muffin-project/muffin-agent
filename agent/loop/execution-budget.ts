/** Interactive execution envelope: time bounds, not a round cap. */
export type ExecutionBudgetConfig = {
  modelCallDeadlineMs: number;
  turnWallDeadlineMs: number;
};

export type ExecutionAbortReason = 'user_stop' | 'model_deadline' | 'turn_deadline';

export type ModelCallLease = {
  signal: AbortSignal;
  reason: () => ExecutionAbortReason | undefined;
  release: () => void;
};

export class ExecutionBudget {
  readonly startedAt = Date.now();
  private readonly turnController = new AbortController();
  private readonly turnTimer: ReturnType<typeof setTimeout>;

  constructor(readonly config: ExecutionBudgetConfig) {
    this.turnTimer = setTimeout(() => this.turnController.abort('turn_deadline'), config.turnWallDeadlineMs);
  }

  get signal(): AbortSignal {
    return this.turnController.signal;
  }

  expired(): boolean {
    return this.turnController.signal.aborted;
  }

  beginModelCall(external?: AbortSignal): ModelCallLease {
    const callController = new AbortController();
    const remainingWall = Math.max(0, this.config.turnWallDeadlineMs - (Date.now() - this.startedAt));
    const deadline = Math.min(this.config.modelCallDeadlineMs, remainingWall);
    const timer = setTimeout(
      () => callController.abort(deadline === remainingWall ? 'turn_deadline' : 'model_deadline'),
      deadline,
    );
    const signals = [this.turnController.signal, callController.signal];
    if (external !== undefined) signals.push(external);
    const signal = AbortSignal.any(signals);
    const onExternalAbort = (): void => {
      if (!callController.signal.aborted) callController.abort('user_stop');
    };
    external?.addEventListener('abort', onExternalAbort, { once: true });

    return {
      signal,
      reason: () => {
        const reason = signal.reason;
        return reason === 'user_stop' || reason === 'model_deadline' || reason === 'turn_deadline' ? reason : undefined;
      },
      release: () => {
        clearTimeout(timer);
        external?.removeEventListener('abort', onExternalAbort);
      },
    };
  }

  close(): void {
    clearTimeout(this.turnTimer);
  }
}
