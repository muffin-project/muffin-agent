/** Interactive execution envelope: time bounds, not a round cap. */
export type ExecutionBudgetConfig = {
  modelCallDeadlineMs: number;
  turnWallDeadlineMs: number;
  activeModelBudgetMs?: number;
  firstActivityTimeoutMs?: number;
  stallTimeoutMs?: number;
  heartbeatIntervalMs?: number;
};

export type ExecutionAbortReason =
  | 'user_stop'
  | 'model_first_activity_timeout'
  | 'model_stall'
  | 'model_deadline'
  | 'turn_deadline'
  | 'active_model_budget_exhausted';

export type ModelCallTelemetry = {
  modelCallIndex: number;
  startedAt: number;
  durationMs: number;
  activeModelMsBefore: number;
  activeModelMsAfter: number;
  activeModelBudgetMs?: number;
  activeModelMsRemaining?: number;
  normalDeadlineMs: number;
  effectiveDeadlineMs: number;
  effectiveDeadlineSource: 'model_deadline' | 'turn_deadline' | 'active_model_budget_exhausted';
};

export type ExecutionBudgetOptions = {
  initialActiveModelMs?: number;
  onActiveModelMs?: (activeModelMs: number) => void;
};

export type ModelProgress = {
  status: 'waiting_for_model' | 'thinking' | 'receiving' | 'stalled';
  elapsedMs: number;
  idleMs: number;
};

export type ModelCallLease = {
  signal: AbortSignal;
  reason: () => ExecutionAbortReason | undefined;
  activity: (kind: 'thinking' | 'text' | 'tool_call') => void;
  telemetry: () => ModelCallTelemetry;
  release: () => void;
};

/** One owner for the turn wall timer and every model-attempt watchdog. */
export class ExecutionBudget {
  readonly startedAt: number;
  private readonly turnController = new AbortController();
  private readonly turnTimer: ReturnType<typeof setTimeout>;
  private activeModelMs: number;
  private modelCallIndex = 0;

  constructor(
    readonly config: ExecutionBudgetConfig,
    private readonly now: () => number = Date.now,
    private readonly options: ExecutionBudgetOptions = {},
  ) {
    this.startedAt = now();
    this.activeModelMs = Math.max(0, options.initialActiveModelMs ?? 0);
    this.turnTimer = setTimeout(() => this.turnController.abort('turn_deadline'), config.turnWallDeadlineMs);
  }

  get signal(): AbortSignal {
    return this.turnController.signal;
  }

  expired(): boolean {
    return this.turnController.signal.aborted;
  }

  activeModelMsUsed(): number {
    return this.activeModelMs;
  }

  activeModelMsRemaining(): number | undefined {
    return this.config.activeModelBudgetMs === undefined
      ? undefined
      : Math.max(0, this.config.activeModelBudgetMs - this.activeModelMs);
  }

  beginModelCall(external?: AbortSignal, onProgress?: (progress: ModelProgress) => void): ModelCallLease {
    const callController = new AbortController();
    const modelCallIndex = ++this.modelCallIndex;
    const startedAt = this.now();
    const activeModelMsBefore = this.activeModelMs;
    const remainingWall = Math.max(0, this.config.turnWallDeadlineMs - (this.now() - this.startedAt));
    const remainingActive = this.activeModelMsRemaining() ?? Number.POSITIVE_INFINITY;
    const deadline = Math.min(this.config.modelCallDeadlineMs, remainingWall, remainingActive);
    const effectiveDeadlineSource =
      remainingWall <= this.config.modelCallDeadlineMs && remainingWall <= remainingActive
        ? 'turn_deadline'
        : remainingActive <= this.config.modelCallDeadlineMs
          ? 'active_model_budget_exhausted'
          : 'model_deadline';
    const firstActivityTimeoutMs = this.config.firstActivityTimeoutMs ?? 30_000;
    const stallTimeoutMs = this.config.stallTimeoutMs ?? 25_000;
    const heartbeatIntervalMs = this.config.heartbeatIntervalMs ?? 15_000;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let firstActivityAt: number | undefined;
    let lastActivityAt = this.now();
    let status: ModelProgress['status'] = 'waiting_for_model';
    let released = false;
    const telemetry = (): ModelCallTelemetry => {
      const durationMs = Math.max(0, this.now() - startedAt);
      const activeModelMsAfter = released ? this.activeModelMs : activeModelMsBefore + durationMs;
      return {
        modelCallIndex,
        startedAt,
        durationMs,
        activeModelMsBefore,
        activeModelMsAfter,
        ...(this.config.activeModelBudgetMs === undefined ? {} : { activeModelBudgetMs: this.config.activeModelBudgetMs }),
        ...(this.config.activeModelBudgetMs === undefined
          ? {}
          : { activeModelMsRemaining: Math.max(0, this.config.activeModelBudgetMs - activeModelMsAfter) }),
        normalDeadlineMs: this.config.modelCallDeadlineMs,
        effectiveDeadlineMs: deadline,
        effectiveDeadlineSource,
      };
    };

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

    if (this.turnController.signal.aborted) callController.abort(this.turnController.signal.reason);
    else if (remainingActive <= 0) callController.abort('active_model_budget_exhausted');
    const hardDeadline = callController.signal.aborted
      ? undefined
      : setTimeout(() => callController.abort(effectiveDeadlineSource), deadline);
    if (!callController.signal.aborted) {
      armWatchdog();
      armHeartbeat();
    }
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
        return reason === 'user_stop' || reason === 'model_first_activity_timeout' || reason === 'model_stall' || reason === 'model_deadline' || reason === 'turn_deadline' || reason === 'active_model_budget_exhausted'
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
      telemetry,
      release: () => {
        if (released) return;
        released = true;
        this.activeModelMs += Math.max(0, this.now() - startedAt);
        this.options.onActiveModelMs?.(this.activeModelMs);
        if (hardDeadline !== undefined) clearTimeout(hardDeadline);
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
