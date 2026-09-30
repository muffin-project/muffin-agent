/**
 * The one place that names what `thinking` can be (#789).
 *
 * `off | adaptive | unset` say whether the model reasons; an effort level says
 * how much. They share one setting so `config.json`, `/think`, the profile and
 * `doctor` all read the same value and `off` + an effort cannot conflict.
 *
 * Lives in `core` because the config schema needs it and `core` does not import
 * `agent`; the provider layer imports it from here.
 */
export const THINKING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingEffort = (typeof THINKING_EFFORTS)[number];

export const THINKING_VALUES = ['off', 'adaptive', 'unset', ...THINKING_EFFORTS] as const;
export type Thinking = (typeof THINKING_VALUES)[number];

export function isThinkingEffort(value: string): value is ThinkingEffort {
  return (THINKING_EFFORTS as readonly string[]).includes(value);
}

/**
 * How an endpoint that is not OpenRouter is told about reasoning (#789).
 * Owner-declared, never inferred: an unknown value is a config error, and an
 * absent one keeps today's behaviour (hostname inference for OpenRouter only).
 * `reasoning_effort` is the top-level field vLLM and Ollama document.
 */
export const REASONING_DIALECTS = ['reasoning_effort'] as const;
export type ReasoningDialect = (typeof REASONING_DIALECTS)[number];
