import { createHash } from 'node:crypto';

export type ToolLoopObservation = {
  turnId: string;
  tool: string;
  args: unknown;
  result: string;
  isError: boolean;
  /** True only when repeating the observation itself cannot create a second effect. */
  idempotentRead: boolean;
};

export type ToolLoopWarning = {
  kind: 'exact_failure' | 'same_tool_failure' | 'idempotent_no_progress';
  count: number;
  message: string;
};

type Seen = {
  tool: string;
  argsDigest: string;
  resultDigest: string;
  isError: boolean;
  idempotentRead: boolean;
};

type TurnState = {
  last: Seen | null;
  exactFailureRun: number;
  sameToolFailureRun: number;
  sameResultRun: number;
  /** Monotone access sequence for bounded LRU eviction. */
  touched: number;
};

type Thresholds = {
  exactFailure: number;
  sameToolFailure: number;
  idempotentNoProgress: number;
};

export type ToolLoopGuardrailOptions = {
  warnAfter?: Partial<Thresholds>;
  /** Bounds state even before a turn-end lifecycle hook is wired. */
  maxTrackedTurns?: number;
};

const DEFAULT_WARN_AFTER: Thresholds = {
  exactFailure: 2,
  sameToolFailure: 3,
  idempotentNoProgress: 2,
};

/**
 * Warning-first detector for a turn that is spending calls without changing
 * what it knows.
 *
 * This controller has deliberately no authority. It cannot block a call,
 * approve one, mutate arguments or change policy. Its output is a nudge the
 * caller may append to the tool result so the *model* can self-correct. A hard
 * circuit breaker, especially for unattended work, is a separate guardrail
 * effect and must go through the runtime boundary rather than being smuggled
 * into this detector.
 *
 * Prior art: Hermes' exact-failure / same-tool-failure / idempotent-no-progress
 * guards. Muffin differs in two ways:
 *
 * 1. successful no-progress detection is allowed only when the caller has
 *    established this is an idempotent read; a generic "same output" rule over
 *    writes can turn a repeated real-world effect into a harmless-looking loop;
 * 2. state is per durable turn id and globally bounded, because resumed/gateway
 *    work outlives a stack frame and the first wiring does not yet have a
 *    universal turn-end hook to clean every terminal path.
 */
export class ToolLoopGuardrail {
  private readonly states = new Map<string, TurnState>();
  private tick = 0;
  private readonly warnAfter: Thresholds;
  private readonly maxTrackedTurns: number;

  constructor(options: ToolLoopGuardrailOptions = {}) {
    this.warnAfter = {
      exactFailure: positive(options.warnAfter?.exactFailure, DEFAULT_WARN_AFTER.exactFailure),
      sameToolFailure: positive(options.warnAfter?.sameToolFailure, DEFAULT_WARN_AFTER.sameToolFailure),
      idempotentNoProgress: positive(
        options.warnAfter?.idempotentNoProgress,
        DEFAULT_WARN_AFTER.idempotentNoProgress,
      ),
    };
    this.maxTrackedTurns = positive(options.maxTrackedTurns, 128);
  }

  observe(observation: ToolLoopObservation): ToolLoopWarning | null {
    const current: Seen = {
      tool: observation.tool,
      argsDigest: digest(observation.args),
      resultDigest: digest(observation.result),
      isError: observation.isError,
      idempotentRead: observation.idempotentRead,
    };

    const previous = this.states.get(observation.turnId) ?? fresh();
    const last = previous.last;

    const exactFailureRun =
      current.isError &&
      last?.isError === true &&
      last.tool === current.tool &&
      last.argsDigest === current.argsDigest
        ? previous.exactFailureRun + 1
        : current.isError
          ? 1
          : 0;

    const sameToolFailureRun =
      current.isError && last?.isError === true && last.tool === current.tool
        ? previous.sameToolFailureRun + 1
        : current.isError
          ? 1
          : 0;

    const sameResultRun =
      current.idempotentRead &&
      !current.isError &&
      last?.idempotentRead === true &&
      last.isError === false &&
      last.tool === current.tool &&
      last.resultDigest === current.resultDigest
        ? previous.sameResultRun + 1
        : current.idempotentRead && !current.isError
          ? 1
          : 0;

    this.tick += 1;
    this.states.set(observation.turnId, {
      last: current,
      exactFailureRun,
      sameToolFailureRun,
      sameResultRun,
      touched: this.tick,
    });
    this.evictIfNeeded();

    // Most specific first. At call 3 an exact repeated failure also satisfies
    // "same tool failed three times"; telling the model which call is repeating
    // is more actionable than the weaker category.
    if (exactFailureRun >= this.warnAfter.exactFailure) {
      return {
        kind: 'exact_failure',
        count: exactFailureRun,
        message:
          `[guardrail: no progress] ${current.tool} ha fallito ${exactFailureRun} volte di seguito ` +
          `con gli stessi argomenti. Non ripetere la stessa chiamata: cambia strategia, restringi il problema ` +
          `o spiega cosa ti blocca.`,
      };
    }
    if (sameToolFailureRun >= this.warnAfter.sameToolFailure) {
      return {
        kind: 'same_tool_failure',
        count: sameToolFailureRun,
        message:
          `[guardrail: no progress] ${current.tool} ha fallito ${sameToolFailureRun} volte di seguito ` +
          `anche cambiando argomenti. Un altro tentativo dello stesso tool non è evidenza di progresso: ` +
          `cambia approccio o chiudi dichiarando il blocker.`,
      };
    }
    if (sameResultRun >= this.warnAfter.idempotentNoProgress) {
      return {
        kind: 'idempotent_no_progress',
        count: sameResultRun,
        message:
          `[guardrail: no progress] ${current.tool} è una lettura idempotente e ha restituito lo stesso risultato ` +
          `${sameResultRun} volte di seguito. Hai già questa informazione: usa ciò che sai invece di richiederla ancora, ` +
          `oppure cambia fonte/domanda.`,
      };
    }
    return null;
  }

  /** Optional explicit cleanup once the universal turn-end seam exists. */
  forget(turnId: string): void {
    this.states.delete(turnId);
  }

  get trackedTurns(): number {
    return this.states.size;
  }

  private evictIfNeeded(): void {
    while (this.states.size > this.maxTrackedTurns) {
      let oldestId: string | null = null;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [id, state] of this.states) {
        if (state.touched < oldest) {
          oldest = state.touched;
          oldestId = id;
        }
      }
      if (oldestId === null) return;
      this.states.delete(oldestId);
    }
  }
}

function fresh(): TurnState {
  return { last: null, exactFailureRun: 0, sameToolFailureRun: 0, sameResultRun: 0, touched: 0 };
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? (value as number) : fallback;
}

/**
 * No raw arguments/results are retained by the guardrail. They already have
 * their canonical stores and redaction boundaries; loop detection needs only
 * equality, and a short digest answers that question without creating another
 * private-data store.
 */
function digest(value: unknown): string {
  const encoded = JSON.stringify(value ?? null) ?? String(value);
  return createHash('sha256').update(encoded).digest('hex').slice(0, 16);
}
