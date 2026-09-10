/** Interactive execution envelope: time bounds, not a round cap. */
export type ExecutionBudgetConfig = {
  modelCallDeadlineMs: number;
  turnWallDeadlineMs: number;
  firstActivityTimeoutMs?: number;
  stallTimeoutMs?: number;
  heartbeatIntervalMs?: number;
};

export type ExecutionAbortReason =
  | 'user_stop'
  | 'model_first_activity_timeout'
  | 'model_stall'
  | 'model_deadline'
  | 'turn_deadline';

export type ModelProgress = {
  status: 'waiting_for_model' | 'thinking' | 'receiving' | 'stalled';
  elapsedMs: number;
  idleMs: number;
};

export type ModelCallLease = {
  signal: AbortSignal;
  reason: () => ExecutionAbortReason | undefined;
  activity: (kind: 'thinking' | 'text' | 'tool_call') => void;
  release: () => void;
};

/** One owner for the turn wall timer and every model-attempt watchdog. */
export class ExecutionBudget {
  readonly startedAt: number;
  private readonly turnController = new AbortController();
  private readonly turnTimer: ReturnType<typeof setTimeout>;

  constructor(readonly config: ExecutionBudgetConfig, private readonly now: () => number = Date.now) {
    this.startedAt = now();
    this.turnTimer = setTimeout(() => this.turnController.abort('turn_deadline'), config.turnWallDeadlineMs);
  }

  get signal(): AbortSignal {
    return this.turnController.signal;
  }

  expired(): boolean {
    return this.turnController.signal.aborted;
  }

  beginModelCall(external?: AbortSignal, onProgress?: (progress: ModelProgress) => void): ModelCallLease {
    const callController = new AbortController();
    const remainingWall = Math.max(0, this.config.turnWallDeadlineMs - (this.now() - this.startedAt));
    const deadline = Math.min(this.config.modelCallDeadlineMs, remainingWall);
    const firstActivityTimeoutMs = this.config.firstActivityTimeoutMs ?? 30_000;
    const stallTimeoutMs = this.config.stallTimeoutMs ?? 25_000;
    const heartbeatIntervalMs = this.config.heartbeatIntervalMs ?? 15_000;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let firstActivityAt: number | undefined;
    let lastActivityAt = this.now();
    let status: ModelProgress['status'] = 'waiting_for_model';

    const emit = (): void => {
      onProgress?.({ status, elapsedMs: this.now() - this.startedAt, idleMs: this.now() - lastActivityAt });
    };
    const clearWatchdog = (): void => {
      if (watchdog !== undefined) clearTimeout(watchdog);
      watchdog = undefined;
    };
    const armWatchdog = (): void => {
      clearWatchdog();
      const timeout = firstActivityAt === undefined ? firstActivityTimeoutMs : stallTimeoutMs;
      watchdog = setTimeout(() => {
        status = 'stalled';
        emit();
        callController.abort(firstActivityAt === undefined ? 'model_first_activity_timeout' : 'model_stall');
      }, timeout);
    };
    const armHeartbeat = (): void => {
      if (onProgress === undefined || heartbeatIntervalMs <= 0) return;
      heartbeat = setTimeout(() => {
        emit();
        armHeartbeat();
      }, heartbeatIntervalMs);
    };

    const hardDeadline = setTimeout(
      () => callController.abort(deadline === remainingWall ? 'turn_deadline' : 'model_deadline'),
      deadline,
    );
    armWatchdog();
    armHeartbeat();
    emit();

    const signals = [this.turnController.signal, callController.signal];
    if (external !== undefined) signals.push(external);
    const signal = AbortSignal.any(signals);
    let externalAbort = false;
    const onExternalAbort = (): void => {
      externalAbort = true;
      if (!callController.signal.aborted) callController.abort('user_stop');
    };
    external?.addEventListener('abort', onExternalAbort, { once: true });

    return {
      signal,
      reason: () => {
        if (externalAbort) return 'user_stop';
        const reason = signal.reason;
        return reason === 'user_stop' || reason === 'model_first_activity_timeout' || reason === 'model_stall' || reason === 'model_deadline' || reason === 'turn_deadline'
          ? reason
          : undefined;
      },
      activity: (kind) => {
        if (callController.signal.aborted) return;
        if (firstActivityAt === undefined) firstActivityAt = this.now();
        lastActivityAt = this.now();
        status = kind === 'thinking' ? 'thinking' : 'receiving';
        armWatchdog();
      },
      release: () => {
        clearTimeout(hardDeadline);
        clearWatchdog();
        if (heartbeat !== undefined) clearTimeout(heartbeat);
        external?.removeEventListener('abort', onExternalAbort);
      },
    };
  }

  close(): void {
    clearTimeout(this.turnTimer);
  }
}
