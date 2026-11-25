import type { InferenceLane } from '../../core/config/config.js';
import type {
  FailoverReason,
  LaneChainState,
  LinkCooldown,
} from '../../core/config/provider-chain.js';
import { ActivityAllowanceError } from './activity-allowance.js';
import type { ReasoningResolution } from './reasoning.js';
import {
  type ChatCall,
  type ChatResult,
  type Message,
  type Provider,
  ProviderError,
  type StreamEvent,
} from './types.js';

/**
 * An ordered provider chain behind the ordinary `Provider` contract (ADR-0110).
 *
 * The lane's own connection is link 0; configured fallbacks follow. A call
 * goes to the first link that is not cooling down. When a link fails for a
 * reason that belongs to the *account or the service* — quota or plan limit,
 * sign-in or credential, rate limit, outage — it cools down and the same call
 * goes to the next link. Anything that belongs to the *request* (a 400, a
 * model that will not parse its own output, an abort, a local budget refusal)
 * is rethrown untouched: another provider would not make that request right,
 * and silently re-sending it elsewhere would hide the defect.
 *
 * Nothing here names a provider. Classification reads the `ProviderError`
 * vocabulary every adapter already speaks; links are built by a factory the
 * caller owns, lazily, so a fallback whose secret is missing costs nothing
 * until it is needed and then fails over like any other signed-out link.
 */

export type ChainLink = {
  /** Secret-free identity (`linkId` in core/config/provider-chain.ts). */
  id: string;
  label: string;
  kind: Provider['kind'];
  baseUrl?: string;
  /** The slug to send. `undefined` on link 0: the caller's `call.model` already is it. */
  model?: string;
  /** Built on first use; a throw here counts as an unavailable credential. */
  create: () => Provider;
};

export type ChainEvent = {
  lane: InferenceLane;
  from: ChainLink;
  to: ChainLink | null;
  reason: FailoverReason;
  until: number;
};

export type ChainOptions = {
  lane: InferenceLane;
  now?: () => number;
  /** Persisted record from a previous process, so a known reset is honoured after restart. */
  initial?: LaneChainState;
  /** Called on every transition (failover, recovery); the runtime persists it. */
  onState?: (state: LaneChainState) => void;
  /**
   * Read before every call: a record that changed on disk since the last read
   * (another process cleared a pause), or `undefined` when nothing changed.
   */
  refresh?: () => LaneChainState | undefined;
  /** Observability for each failover. */
  onFailover?: (event: ChainEvent) => void;
};

/**
 * Cooldowns when the provider declared nothing. Quota and sign-in problems do
 * not fix themselves in seconds; retrying the first link every quarter hour
 * costs one failed round trip and notices a reset or a new login without the
 * owner doing anything. Rate limits and outages are short by nature.
 */
export const DEFAULT_COOLDOWN_MS: Readonly<Record<FailoverReason, number>> = {
  quota: 15 * 60_000,
  auth: 15 * 60_000,
  rate_limit: 60_000,
  outage: 30_000,
};

/** Upper bound for any declared window: a reset far away is re-probed daily. */
const MAX_COOLDOWN_MS = 24 * 60 * 60_000;

/**
 * Whether an error is the account's or the service's problem (fail over) or
 * the request's (rethrow). `null` = not a reason to try another provider.
 */
export function failoverReason(error: unknown): FailoverReason | null {
  if (error instanceof ActivityAllowanceError) return null;
  if (!(error instanceof ProviderError)) return null;
  if (error.source === 'output') return null;
  const details = error.details;
  if (details?.quota !== undefined) return 'quota';
  if (details?.reauthentication !== undefined || details?.credentials !== undefined) return 'auth';
  const status = error.status;
  if (status === 401) return 'auth';
  // A bare 403 is not an account problem by itself: OpenRouter uses it for
  // guardrail blocks and moderation flags on the *input*. Re-sending a flagged
  // prompt elsewhere is the request-error case this chain must never take.
  // An adapter that knows a 403 is a credential problem says so in `details`.
  if (status === 402) return 'quota';
  if (status === 429) return 'rate_limit';
  if (status === 408 || (status !== undefined && status >= 500)) return 'outage';
  // No response at all: only the adapters' own connection error counts. A
  // local bug wrapped as a retryable error must not cool a healthy link.
  if (!status && details?.connection === true && details.receivedAnyEvent !== true) {
    return 'outage';
  }
  return null;
}

function cooldownFor(error: ProviderError, reason: FailoverReason, now: number): LinkCooldown {
  const declaredAt =
    error.details?.retryAt ??
    (error.retryAfterMs === undefined ? undefined : now + error.retryAfterMs);
  const declared = declaredAt !== undefined && declaredAt > now;
  const until = declared
    ? Math.min(declaredAt, now + MAX_COOLDOWN_MS)
    : now + DEFAULT_COOLDOWN_MS[reason];
  return { until, reason, at: now, declared };
}

/**
 * Reasoning continuations are only valid on the link that produced them. A
 * message from another link (or from before the chain, which is link 0) keeps
 * its text and tools and loses only the opaque reasoning: the metadata payload
 * and the signed `thinking`/`redacted_thinking` content blocks, which a second
 * Anthropic account or model would reject or misread.
 */
function forLink(messages: readonly Message[], link: ChainLink, first: ChainLink): Message[] {
  let changed = false;
  const out = messages.map((message) => {
    const meta = message.providerMetadata;
    if ((meta?.link ?? first.id) === link.id) return message;
    const content = message.content.filter(
      (block) => block.type !== 'thinking' && block.type !== 'redacted_thinking',
    );
    const foreignMeta = meta?.reasoning !== undefined;
    if (!foreignMeta && content.length === message.content.length) return message;
    changed = true;
    const next: Message = { ...message, content };
    if (foreignMeta) {
      const { reasoning: _dropped, ...rest } = meta;
      if (Object.keys(rest).length === 0) delete next.providerMetadata;
      else next.providerMetadata = rest;
    }
    return next;
  });
  return changed ? out : (messages as Message[]);
}

/** Every chain result names its link, so the next call knows whose reasoning it carries. */
function stamp(result: ChatResult, link: ChainLink, index: number, model: string): ChatResult {
  return {
    ...result,
    providerMetadata: { ...(result.providerMetadata ?? {}), link: link.id },
    route: {
      kind: link.kind,
      ...(link.baseUrl === undefined ? {} : { baseUrl: link.baseUrl }),
      model,
      label: link.label,
      index,
    },
  };
}

/** A call without a reasoning request: the link's own default applies. */
function withoutReasoning(call: ChatCall): ChatCall {
  const { reasoning: _r, thinking: _t, ...rest } = call;
  return rest;
}

class ProviderChain implements Provider {
  private readonly built = new Map<string, Provider>();
  private readonly now: () => number;
  private readonly known: Set<string>;
  private state: LaneChainState;

  constructor(
    private readonly links: readonly [ChainLink, ...ChainLink[]],
    private readonly options: ChainOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.known = new Set(links.map((l) => l.id));
    this.state = this.adopt(options.initial);
  }

  /**
   * The adapter family of the link that would serve the next call. Callers
   * that shape a request by family (memory lanes choosing `reasoning` vs
   * `thinking: 'off'`) then shape it for that link, not for link 0.
   */
  get kind(): Provider['kind'] {
    return (this.order()[0] ?? this.links[0]).kind;
  }

  private adopt(saved: LaneChainState | undefined): LaneChainState {
    return {
      active: saved !== undefined && this.known.has(saved.active) ? saved.active : this.links[0].id,
      since: saved?.since ?? this.now(),
      cooldowns: Object.fromEntries(
        Object.entries(saved?.cooldowns ?? {}).filter(([id]) => this.known.has(id)),
      ),
      ...(saved?.lastFallbackError !== undefined && this.known.has(saved.lastFallbackError.link)
        ? { lastFallbackError: saved.lastFallbackError }
        : {}),
    };
  }

  /** Picks up a reset or a cleared pause written by another process (`muffin fallback reset`). */
  private refresh(): void {
    try {
      const fresh = this.options.refresh?.();
      if (fresh !== undefined) this.state = this.adopt(fresh);
    } catch {
      // advisory
    }
  }

  /** Links in the order this call should try them. */
  private order(): ChainLink[] {
    const now = this.now();
    const ready = this.links.filter((l) => (this.state.cooldowns[l.id]?.until ?? 0) <= now);
    // Everything cooling down: try them all in priority order anyway. A chain
    // that refuses to call anyone is worse than one more failed round trip.
    return ready.length > 0 ? ready : [...this.links];
  }

  private provider(link: ChainLink): Provider {
    const existing = this.built.get(link.id);
    if (existing !== undefined) return existing;
    let created: Provider;
    try {
      created = link.create();
    } catch {
      throw new ProviderError(
        `${link.label}: credential unavailable`,
        false,
        undefined,
        'transport',
        undefined,
        false,
        { credentials: 'unavailable' },
      );
    }
    this.built.set(link.id, created);
    return created;
  }

  /**
   * The call as this link receives it: its own model, only its own reasoning,
   * and — on a fallback — no reasoning request the link cannot honour. The
   * primary keeps the strict behaviour it always had: an unsupported request
   * there is the owner's configuration to fix, not something to paper over.
   */
  private async callFor(call: ChatCall, link: ChainLink, provider: Provider): Promise<ChatCall> {
    const messages = forLink(call.messages, link, this.links[0]);
    const linked: ChatCall = {
      ...call,
      ...(link.model === undefined ? {} : { model: link.model }),
      ...(messages === call.messages ? {} : { messages }),
    };
    if (link === this.links[0] || provider.resolveReasoning === undefined) return linked;
    if (linked.reasoning === undefined && linked.thinking === undefined) return linked;
    try {
      const resolution = await provider.resolveReasoning(linked);
      if (resolution?.status === 'unsupported') return withoutReasoning(linked);
    } catch {
      // The adapter will say it again on the real call.
    }
    return linked;
  }

  private publish(): void {
    try {
      this.options.onState?.(structuredClone(this.state));
    } catch {
      // Status is advisory; it never changes the call's outcome.
    }
  }

  private succeeded(link: ChainLink): void {
    const hadCooldown = this.state.cooldowns[link.id] !== undefined;
    if (hadCooldown) delete this.state.cooldowns[link.id];
    const hadError = this.state.lastFallbackError?.link === link.id;
    if (hadError) delete this.state.lastFallbackError;
    if (this.state.active !== link.id) {
      this.state.active = link.id;
      this.state.since = this.now();
    } else if (!hadCooldown && !hadError) return;
    this.publish();
  }

  private failed(
    link: ChainLink,
    next: ChainLink | undefined,
    error: ProviderError,
    reason: FailoverReason,
  ): void {
    const cooldown = cooldownFor(error, reason, this.now());
    this.state.cooldowns[link.id] = cooldown;
    this.publish();
    try {
      this.options.onFailover?.({
        lane: this.options.lane,
        from: link,
        to: next ?? null,
        reason,
        until: cooldown.until,
      });
    } catch {
      // observability only
    }
  }

  /**
   * A fallback refused the request itself after an earlier link had already
   * failed over. The fallback's problem is recorded (for doctor) but the error
   * the caller sees stays the earlier one: "plan exhausted" explains the
   * outage, a fallback's 404 would hide it.
   */
  private fallbackRefused(link: ChainLink, error: unknown, firstError: unknown): never {
    this.state.lastFallbackError = {
      link: link.id,
      at: this.now(),
      ...(error instanceof ProviderError && error.status !== undefined
        ? { status: error.status }
        : {}),
      kind: error instanceof Error ? error.name : 'Error',
    };
    this.publish();
    throw firstError;
  }

  async resolveReasoning(call: ChatCall): Promise<ReasoningResolution | undefined> {
    this.refresh();
    const link = this.order()[0] ?? this.links[0];
    let provider: Provider;
    try {
      provider = this.provider(link);
    } catch {
      return undefined;
    }
    return provider.resolveReasoning?.(await this.callFor(call, link, provider));
  }

  async chat(call: ChatCall): Promise<ChatResult> {
    this.refresh();
    const order = this.order();
    let firstError: unknown;
    for (const [i, link] of order.entries()) {
      try {
        const provider = this.provider(link);
        const linked = await this.callFor(call, link, provider);
        const result = await provider.chat(linked);
        this.succeeded(link);
        return stamp(result, link, this.links.indexOf(link), linked.model);
      } catch (error) {
        if (call.signal?.aborted) throw error;
        const reason = failoverReason(error);
        if (reason === null) {
          if (firstError !== undefined) this.fallbackRefused(link, error, firstError);
          throw error;
        }
        firstError ??= error;
        this.failed(link, order[i + 1], error as ProviderError, reason);
      }
    }
    // Every link refused for an account or service reason. The first error is
    // the one the owner configured as primary, and the one existing messages
    // (plan exhausted, sign in again) already know how to explain.
    throw firstError;
  }

  async *chatStream(call: ChatCall): AsyncIterable<StreamEvent> {
    this.refresh();
    const order = this.order();
    let firstError: unknown;
    for (const [i, link] of order.entries()) {
      let yielded = false;
      try {
        const provider = this.provider(link);
        const linked = await this.callFor(call, link, provider);
        const index = this.links.indexOf(link);
        if (provider.chatStream === undefined) {
          const result = await provider.chat(linked);
          this.succeeded(link);
          yield { type: 'done', result: stamp(result, link, index, linked.model) };
          return;
        }
        for await (const event of provider.chatStream(linked)) {
          if (event.type === 'done') {
            this.succeeded(link);
            yielded = true;
            yield { type: 'done', result: stamp(event.result, link, index, linked.model) };
            return;
          }
          yielded = true;
          yield event;
        }
        return;
      } catch (error) {
        // Bytes already reached the caller: switching provider now would
        // splice two answers. The loop's own stream fallback owns this case.
        if (yielded || call.signal?.aborted) throw error;
        const reason = failoverReason(error);
        if (reason === null) {
          if (firstError !== undefined) this.fallbackRefused(link, error, firstError);
          throw error;
        }
        firstError ??= error;
        this.failed(link, order[i + 1], error as ProviderError, reason);
      }
    }
    throw firstError;
  }
}

/**
 * One link is returned as itself: a lane without fallbacks runs exactly the
 * adapter it ran before this module existed, with no wrapper in between.
 */
export function providerChain(
  links: readonly [ChainLink, ...ChainLink[]],
  options: ChainOptions,
): Provider {
  if (links.length === 1) return links[0].create();
  return new ProviderChain(links, options);
}
