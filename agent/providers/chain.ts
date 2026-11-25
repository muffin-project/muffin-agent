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
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'quota';
  if (status === 429) return 'rate_limit';
  if (status === 408 || status === 409 || (status !== undefined && status >= 500)) return 'outage';
  // No status: a connection that never produced a response. The adapters
  // mark those retryable; a non-retryable status-less error is a local one.
  if (status === undefined && error.retryable && details?.receivedAnyEvent !== true) {
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
 * its text and tools and loses only the opaque reasoning payload.
 */
function forLink(messages: readonly Message[], link: ChainLink, first: ChainLink): Message[] {
  let changed = false;
  const out = messages.map((message) => {
    const meta = message.providerMetadata;
    if (meta?.reasoning === undefined) return message;
    if ((meta.link ?? first.id) === link.id) return message;
    changed = true;
    const { reasoning: _dropped, ...rest } = meta;
    const next: Message = { ...message };
    if (Object.keys(rest).length === 0) delete next.providerMetadata;
    else next.providerMetadata = rest;
    return next;
  });
  return changed ? out : (messages as Message[]);
}

function stamp(result: ChatResult, link: ChainLink, index: number, model: string): ChatResult {
  return {
    ...result,
    ...(result.providerMetadata === undefined
      ? {}
      : { providerMetadata: { ...result.providerMetadata, link: link.id } }),
    route: {
      kind: link.kind,
      ...(link.baseUrl === undefined ? {} : { baseUrl: link.baseUrl }),
      model,
      label: link.label,
      index,
    },
  };
}

class ProviderChain implements Provider {
  readonly kind: Provider['kind'];
  private readonly built = new Map<string, Provider>();
  private readonly now: () => number;
  private state: LaneChainState;

  constructor(
    private readonly links: readonly [ChainLink, ...ChainLink[]],
    private readonly options: ChainOptions,
  ) {
    this.kind = links[0].kind;
    this.now = options.now ?? Date.now;
    const known = new Set(links.map((l) => l.id));
    const initial = options.initial;
    this.state = {
      active: initial !== undefined && known.has(initial.active) ? initial.active : links[0].id,
      since: initial?.since ?? this.now(),
      cooldowns: Object.fromEntries(
        Object.entries(initial?.cooldowns ?? {}).filter(([id]) => known.has(id)),
      ),
    };
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

  private callFor(call: ChatCall, link: ChainLink): ChatCall {
    const messages = forLink(call.messages, link, this.links[0]);
    return {
      ...call,
      ...(link.model === undefined ? {} : { model: link.model }),
      ...(messages === call.messages ? {} : { messages }),
    };
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
    if (this.state.active !== link.id) {
      this.state.active = link.id;
      this.state.since = this.now();
    } else if (!hadCooldown) return;
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

  async resolveReasoning(call: ChatCall): Promise<ReasoningResolution | undefined> {
    const link = this.order()[0] ?? this.links[0];
    let provider: Provider;
    try {
      provider = this.provider(link);
    } catch {
      return undefined;
    }
    return provider.resolveReasoning?.(this.callFor(call, link));
  }

  async chat(call: ChatCall): Promise<ChatResult> {
    const order = this.order();
    let firstError: unknown;
    for (const [i, link] of order.entries()) {
      try {
        const provider = this.provider(link);
        const linked = this.callFor(call, link);
        const result = await provider.chat(linked);
        this.succeeded(link);
        return stamp(result, link, this.links.indexOf(link), linked.model);
      } catch (error) {
        if (call.signal?.aborted) throw error;
        const reason = failoverReason(error);
        if (reason === null) throw error;
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
    const order = this.order();
    let firstError: unknown;
    for (const [i, link] of order.entries()) {
      let yielded = false;
      try {
        const provider = this.provider(link);
        const linked = this.callFor(call, link);
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
        if (reason === null) throw error;
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
