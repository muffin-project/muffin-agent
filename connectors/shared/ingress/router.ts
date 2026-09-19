import type { TurnDelta, TurnEvent, TurnResult } from '../../../agent/loop.js';
import { ContinuationGone } from '../../../agent/loop.js';
import type { TurnRecord } from '../../../core/turns/store.js';
import { identify, type SurfaceIdentity } from '../../../core/surface/types.js';
import { composeTurnText } from './compose.js';
import type { Arrival } from './ingest.js';
import type { LaneState, QueueNotices } from './lane.js';
import { runWork, type WorkDeps } from './work.js';
import { contentTierOf, type InboundEvent, type IngressPart, type IngressPort } from './types.js';

/**
 * Slice 14 of the ingress decomposition
 * (`docs/evidence/ingresso-unico-e-nucleo-2026-09-05.md` §2.4, §3 row 14): the
 * router. The ingress twin `core/surface/registry.ts`'s `deliver` never got —
 * "il registro ha unificato **solo l'uscita**".
 *
 * ## Two entries, not one
 *
 * `drain()` already had two, so this has two. `receive` takes an event nobody
 * has claimed yet and walks it to an answer. `recover` takes one already bound
 * to a durable work id and resolves it **without ever calling the model** —
 * the five branches of Telegram's `resolveBound`, which are not expressible as
 * a fresh `InboundEvent` because their input is a turn row, not a message.
 *
 * `bind` itself deliberately stays in the port, exactly where it is today,
 * *between* the two: exactly-once belongs where the tables are (§4 invariant
 * 3), and the router is called after the event is already durable. It never
 * owns idempotency; it asks for a claim (`hooks.claim`) and believes the
 * answer.
 *
 * ## Why the stage list is an exported array
 *
 * `INGRESS_STAGES` is the axis slice 16's parity test iterates, and the thing
 * mutation tests remove an element from. It is therefore not decoration: this
 * module *iterates it* to decide what runs. Deleting `busy` from the array
 * deletes the pause check from production, which is what makes the parity test
 * a measurement instead of a restatement.
 *
 * ## What is deliberately not a stage
 *
 * Per §2.5: the group gate's *rule* (`apreUnTurno`) stays in the port and
 * arrives here as `hooks.opensATurn`; the poller-level command pre-emption
 * (`controlla`, `gestiti`, `markProcessed`) stays in the port, because a stage
 * walked once per already-durable event cannot reproduce a pre-emption over a
 * whole batch; and the fresh delivery goes through the port's own write-ahead
 * plan, never `SurfaceRegistry.deliver` — routing it there would write no
 * per-part rows (so a crash mid-answer could not tell `sent` from
 * `possibly_sent`) and would apply `redactText`, changing the bytes of the
 * answer without announcing it.
 */

/**
 * The ten stages, in the order they run. Iterated by `receive` below.
 *
 * `gate` and `remember` are a pair: the gate does not *stop* an event, it
 * diverts it — a group message that opens no turn must still be remembered
 * (ADR-0063's own named follow-up), and the remember stage is where that
 * happens. The divert is by name, so removing `remember` from this array
 * raises rather than silently letting a gated-out message walk on into a turn.
 */
export const INGRESS_STAGES = [
  'pair',
  'gate',
  'remember',
  'command',
  'busy',
  'compose',
  'ingest',
  'work',
  'deliver',
  'settle',
] as const;

export type IngressStage = (typeof INGRESS_STAGES)[number];

/**
 * How one event ended.
 *
 * `queued` is the one that writes **nothing durable** and does not settle: it
 * is what leaves the event in the inbox so `/resume` re-drains it (§2.4).
 * `deferred` says "somebody else owns this work now" — a bind lost to a
 * concurrent drain, a turn still running in the lane, a delivery the port
 * chose to postpone — and always names the work id so the caller can go and
 * `recover` it.
 */
export type IngressOutcome =
  | { readonly kind: 'paired' }
  | { readonly kind: 'ignored'; readonly stage: 'gate'; readonly remembered: boolean }
  | { readonly kind: 'commanded' }
  | { readonly kind: 'queued'; readonly why: 'paused' }
  | { readonly kind: 'answered'; readonly workId: string; readonly delivery: 'sent' | 'possibly_sent' }
  | { readonly kind: 'suspended'; readonly workId: string }
  | {
      readonly kind: 'recovered';
      readonly workId: string;
      readonly delivery: 'sent' | 'possibly_sent' | 'undeliverable' | 'already';
    }
  | { readonly kind: 'deferred'; readonly workId: string | undefined; readonly why: DeferralReason };

/** Why an event was handed back rather than finished. `bind-lost` is the one the caller turns into a `recover`. */
export type DeferralReason = 'bind-lost' | 'still-running' | 'delivery-deferred';

/** What the port hands back from a claim: the durable work identity, and whether this call is the one that owns it. */
export type Claim = { readonly kind: 'mine' | 'taken'; readonly workId: string };

/**
 * The port's live sinks for one turn — presence, a streaming transcript, the
 * `/stop` lever and the `/steer` queue. Opened by the `work` stage and closed
 * in `receive`'s own `finally`, so a port cannot forget either half.
 *
 * All of it is dialect (§2.5: the transcript does not move in this slice), so
 * none of it is built here; the router only owns *when*.
 */
export type LiveWork = {
  /**
   * Called immediately before the model, and not a moment earlier: this is
   * where the port registers its live-turn lane, so `/stop` and `/steer` find
   * something exactly while there is something (ADR-0054). Presence and the
   * transcript start when the sinks are opened — they are how the owner sees
   * that Muffin is busy, including through a slow attachment download — but a
   * lane registered during that download would make `/stop` claim to have
   * aborted a turn that had not started, and make a second message answer "in
   * coda" to nothing.
   */
  readonly arm: () => { readonly signal: AbortSignal; readonly steer: () => string[] };
  readonly onDelta?: ((delta: TurnDelta) => void) | undefined;
  readonly onProgress?: ((event: TurnEvent) => void) | undefined;
  /** Right after `runTurn` returns and *before* anything is delivered. Where a suspended turn's transcript is kept open. */
  readonly ran?: ((result: TurnResult) => Promise<void>) | undefined;
  /** Always, in a `finally`. Idempotent by contract. */
  readonly close: () => Promise<void>;
};

/** What the port does at each point the router decides to act. */
export type IngressHooks = {
  /** The owner's account id as this port knows it, or `undefined` while nobody is paired. Fed straight to `identify()`. */
  readonly ownerId: string | undefined;
  /** `true` when pairing consumed this event. Absent where the port has no pairing. */
  readonly pair?: ((ctx: Ingressing) => Promise<boolean>) | undefined;
  /** §2.5: the group gate's rule stays in the port. `true` means "this opens a turn". */
  readonly opensATurn: (ctx: Ingressing) => boolean;
  /** The gated-out branch. Absent means a gated-out event is simply dropped, as it was before ADR-0063's follow-up. */
  readonly remember?: ((ctx: Ingressing) => void) | undefined;
  /** `true` when a control command consumed this event. */
  readonly command?: ((ctx: Ingressing) => Promise<boolean>) | undefined;
  /** Read at the moment the `busy` stage runs, never cached: the durable pause can flip between two events of one drain. */
  readonly laneState: (ctx: Ingressing) => LaneState;
  /** The per-event ledger for the two notices (`lane.ts`). */
  readonly notices: QueueNotices;
  /** How this port says one sentence back, unprompted. Rendering and splitting stay in the port: they are dialect. */
  readonly say: (ctx: Ingressing, text: string) => Promise<void>;
  /** Downloads and indexes this event's attachment, when it has one. `null` for an event with nothing attached. */
  readonly ingest?: ((ctx: Ingressing) => Promise<Arrival | null>) | undefined;
  /** Mints and commits the durable work identity — the port's own `bind`. */
  readonly claim: (ctx: Ingressing) => Promise<Claim>;
  readonly work: WorkDeps;
  readonly openLive: (ctx: Ingressing) => Promise<LiveWork>;
  /** The port's write-ahead delivery plan (§2.4), never `SurfaceRegistry.deliver`. */
  readonly deliver: (ctx: Ingressing, workId: string, text: string) => Promise<'sent' | 'possibly_sent' | 'deferred'>;
  /** Bookkeeping on the turn row. Not allowed to fail the delivery — the port already wraps it. */
  readonly recordDelivery: (workId: string, delivery: 'sent' | 'possibly_sent' | 'undeliverable' | `failed:${string}`) => void;
  /** Settle this event's fire, then mark it processed — always in that order (§4 invariant 3). */
  readonly finish: (ctx: Ingressing) => void;
  /** Settle alone, for the path that records the delivery between the two writes. */
  readonly settle: (ctx: Ingressing) => void;
  readonly markProcessed: (ctx: Ingressing) => void;
  /** Un-prefixed; the port adds its own name (§4 invariant 11). */
  readonly log?: ((line: string) => void) | undefined;
};

/** One event on its way through the stages. Mutable on purpose: each stage is defined by what it adds. */
export type Ingressing = {
  readonly port: IngressPort;
  readonly event: InboundEvent;
  /** Resolved once, by `identify()` — §4 invariant 4. */
  readonly identity: SurfaceIdentity;
  parts: readonly IngressPart[];
  /** Set by `compose`, re-set by `ingest` when an attachment adds its own line. */
  text: string | undefined;
  arrival: Arrival | null;
  workId: string | undefined;
  result: TurnResult | undefined;
};

/**
 * One stage the walk actually entered, for one event, on one port.
 *
 * This exists for a single claim, and it is the one §5 names as the falsifier
 * of the whole of phase B: *"il describe 4 non esiste o non diventa rosso
 * quando si inlineano gli stadi nel drain di un connettore importando i moduli
 * condivisi"*. Every other guarantee in the parity test is satisfied by a
 * connector that imports `composeTurnText`, `ingestAttachment` and `runWork`
 * and calls them in its own hand-written order — the shared code would be
 * shared, and the *walk* would not be. Only something the router itself emits
 * can tell the two apart, because it is the only thing an inlined copy has no
 * reason to reproduce.
 *
 * Deliberately not a hook on `IngressHooks`: a hook is handed in by the port,
 * so a port could satisfy it by calling it. Nothing outside this module can
 * make these visits happen.
 */
export type IngressVisit = { readonly portId: string; readonly eventId: string; readonly stage: IngressStage };

export type IngressWitness = (visit: IngressVisit) => void;

let witness: IngressWitness | undefined;

/**
 * Watch the stage walk. Returns the undo, so a test restores whatever was
 * there rather than assuming nothing was.
 *
 * Production never calls this and the default is `undefined`, so the cost on
 * the real path is one `!== undefined` per stage. Same posture as the
 * `testStall` seams in `connectors/telegram/connector.ts` and
 * `agent/scheduler-run.ts`: a window that only a test opens, kept in the
 * production file because putting it anywhere else would mean the test is no
 * longer watching production.
 */
export function witnessIngress(next: IngressWitness | undefined): () => void {
  const previous = witness;
  witness = next;
  return () => {
    witness = previous;
  };
}

/** Nothing more to do here; keep walking the stages. */
const CONTINUE = undefined;

type StageOutcome = IngressOutcome | undefined;

/**
 * Walk one unclaimed event through the ten stages.
 *
 * The loop is the point: `INGRESS_STAGES` is read, not restated, so what the
 * parity test asserts about the array is a fact about production.
 */
export async function receive(port: IngressPort, event: InboundEvent, hooks: IngressHooks): Promise<IngressOutcome> {
  const ctx: Ingressing = {
    port,
    event,
    identity: identify(event.identity, hooks.ownerId),
    parts: event.parts,
    text: undefined,
    arrival: null,
    workId: undefined,
    result: undefined,
  };
  return walk(ctx, hooks, 'pair');
}

/**
 * The stage walk, from `from` onwards.
 *
 * `from` exists for one caller: `recover`'s fault-point-2 branch, where the
 * bind landed but the turn row did not. That event is not a fresh one — its
 * identity is already committed and pairing, the gate and the commands have
 * already had their say — so it re-enters at `compose`, which is exactly where
 * Telegram's `resolveBound` re-entered `runFresh`.
 */
async function walk(ctx: Ingressing, hooks: IngressHooks, from: IngressStage): Promise<IngressOutcome> {
  assertPortHonest(ctx.port, hooks);
  let live: LiveWork | undefined;
  const openLive = async (): Promise<LiveWork> => {
    live ??= await hooks.openLive(ctx);
    return live;
  };
  let divertTo: IngressStage | undefined;
  let started = false;
  try {
    for (const stage of INGRESS_STAGES) {
      if (!started) {
        if (stage !== from) continue;
        started = true;
      }
      let viaDivert = false;
      if (divertTo !== undefined) {
        if (stage !== divertTo) continue;
        divertTo = undefined;
        viaDivert = true;
      }
      witness?.({ portId: ctx.port.surface.id, eventId: ctx.event.eventId, stage });
      const step = await runStage(stage, ctx, hooks, openLive, viaDivert);
      if (step.kind === 'divert') {
        divertTo = step.to;
        continue;
      }
      if (step.outcome !== CONTINUE) return step.outcome;
    }
    if (divertTo !== undefined) {
      // The divert target left the stage list. Loud rather than silent: the
      // alternative is a gated-out group message quietly walking into a turn.
      throw new Error(`ingress: stage "${divertTo}" is not in INGRESS_STAGES`);
    }
    if (!started) throw new Error(`ingress: stage "${from}" is not in INGRESS_STAGES`);
    throw new Error('ingress: the stages ran out without an outcome');
  } finally {
    await live?.close();
  }
}

/**
 * A port's declaration and the hooks it hands in must say the same thing.
 *
 * §2.3 is explicit that a second capability record beside `Surface` would be
 * "two literals that agreed today and had no reason to keep agreeing
 * tomorrow", and `makeIngressPort` already refuses the one pair it can see at
 * construction (`ingress.edit` against `surface.streaming.transport`). This is
 * the same check for the one capability whose evidence only exists here:
 * `commands` has no field on `Surface` and no shape a type can enforce, only a
 * hook that is either wired or not.
 *
 * Both directions, because both are real defects. A port that **declares**
 * commands and wires none would make slice 16's parity table claim a scene
 * that cannot run — the axis would say Discord answers `/stop` while
 * `agent/comandi.ts` never sees a line from it. A port that **runs** commands
 * it does not declare is the mirror: the table would record a divergence that
 * production does not have, and the first reader to trust it would be wrong in
 * the safe-looking direction.
 *
 * The other four capabilities are not checked here, and the reason is that
 * they have no hook to check against: `buttons` is answered by an `Approver`
 * registered in `cli/surface.ts`, `typing` and `upload` live inside
 * `openLive`/`ingest` closures the router only ever calls, and `ingest` is
 * legitimately absent for an event with nothing attached — an absence that
 * says "no attachment here", never "this port cannot receive one".
 */
function assertPortHonest(port: IngressPort, hooks: IngressHooks): void {
  const wired = hooks.command !== undefined;
  if (port.ingress.commands === wired) return;
  throw new Error(
    port.ingress.commands
      ? `ingress port "${port.surface.id}": ingress.commands=true but no command hook is wired`
      : `ingress port "${port.surface.id}": a command hook is wired but ingress.commands=false`,
  );
}

type Step = { readonly kind: 'step'; readonly outcome: StageOutcome } | { readonly kind: 'divert'; readonly to: IngressStage };

const step = (outcome: StageOutcome): Step => ({ kind: 'step', outcome });

async function runStage(
  stage: IngressStage,
  ctx: Ingressing,
  hooks: IngressHooks,
  openLive: () => Promise<LiveWork>,
  /** `true` only when the gate diverted here — see the `remember` case. */
  viaDivert: boolean,
): Promise<Step> {
  switch (stage) {
    case 'pair': {
      // Before the model, and only while unpaired: a code arrives as an
      // ordinary message, so this must not answer with a turn.
      if (hooks.pair === undefined) return step(CONTINUE);
      return step((await hooks.pair(ctx)) ? { kind: 'paired' } : CONTINUE);
    }
    case 'gate': {
      // ADR-0063. Not a stop: a message that opens no turn is still something
      // that was said in a room Muffin is in.
      if (hooks.opensATurn(ctx)) return step(CONTINUE);
      return { kind: 'divert', to: 'remember' };
    }
    case 'remember': {
      // Reached on two roads, and only one of them is this stage's. An event
      // that *passed* the gate walks straight past: its words enter memory
      // through the turn itself, and writing an episode here as well would
      // double every group message Muffin actually answers.
      if (!viaDivert) return step(CONTINUE);
      if (hooks.remember === undefined) return step({ kind: 'ignored', stage: 'gate', remembered: false });
      hooks.remember(ctx);
      return step({ kind: 'ignored', stage: 'gate', remembered: true });
    }
    case 'command': {
      // A command never creates a turn: it does not call the model, and
      // binding it to one would drag it through the whole resume-and-deliver
      // machine built for an answer that is not coming.
      if (hooks.command === undefined) return step(CONTINUE);
      return step((await hooks.command(ctx)) ? { kind: 'commanded' } : CONTINUE);
    }
    case 'busy': {
      // ADR-0054 §4: in pausa niente parte. The event stays in the inbox,
      // announced once, and `/resume` restarts the drain that finds it there.
      // Nothing durable is written and nothing is settled — that is what makes
      // it re-drainable (§2.4).
      const state = hooks.laneState(ctx);
      // The ledger is only touched on the branch that actually announces:
      // consuming an entry for an event that walks on would spend the one
      // notice this event is owed, and the *next* pass would say nothing.
      if (!state.inPausa) return step(CONTINUE);
      const testo = hooks.notices.decide(ctx.event.eventId, state);
      if (testo !== undefined) await hooks.say(ctx, testo);
      return step({ kind: 'queued', why: 'paused' });
    }
    case 'compose': {
      ctx.text = composeTurnText(ctx.parts);
      return step(CONTINUE);
    }
    case 'ingest': {
      // The file lands and is indexed **before** the turn runs, so the agent
      // finds it in memory rather than being told about a path it cannot read.
      // A failed download does not fail the turn.
      if (hooks.ingest === undefined) return step(CONTINUE);
      // Presence starts here and not at `work`: on a slow link the download is
      // the part the owner waits through, and before this slice the Telegram
      // connector already started its "sta scrivendo…" ahead of `ingest`.
      await openLive();
      const arrival = await hooks.ingest(ctx);
      if (arrival === null) return step(CONTINUE);
      ctx.arrival = arrival;
      // The arrival line is generated by Muffin while ingesting bytes; it is
      // status, not something the sender said. Keep it separate from the
      // attachment's content/provenance so neither can be mined as owner speech.
      const statusPart: IngressPart =
        {
          source: 'derived',
          tier: 0,
          text: arrival.line,
          detail:
            'stato generato da Muffin durante l ingest dell allegato — non parole del mittente',
        };
      const arrivalParts: IngressPart[] = [statusPart];
      if (arrival.part !== undefined) arrivalParts.push(arrival.part);
      ctx.parts = [...arrivalParts, ...ctx.parts];
      ctx.text = composeTurnText(ctx.parts);
      return step(CONTINUE);
    }
    case 'work': {
      const claim = await hooks.claim(ctx);
      ctx.workId = claim.workId;
      // Lost the race: some other bind landed first (two overlapping drains,
      // or this same call resolving a retry). No turn to run here — the id
      // this call minted was never written anywhere — so the caller resolves
      // the winner's id through `recover`, exactly as if it had found the
      // event already bound.
      if (claim.kind === 'taken') return step({ kind: 'deferred', workId: claim.workId, why: 'bind-lost' });
      if (ctx.text === undefined) throw new Error('ingress: the work stage ran without a composed text');
      const sinks = await openLive();
      const lane = sinks.arm();
      try {
        ctx.result = await runWork(hooks.work, ctx.port, ctx.event, {
          workId: claim.workId,
          identity: ctx.identity,
          text: ctx.text,
          contentTaint: contentTierOf(ctx.parts),
          replyTo: replyRecordOf(ctx),
          signal: lane.signal,
          steer: lane.steer,
          ...(ctx.arrival?.image === undefined ? {} : { images: [ctx.arrival.image] }),
          ...(ctx.arrival?.audio === undefined ? {} : { audios: [ctx.arrival.audio] }),
          ...(sinks.onDelta === undefined ? {} : { onDelta: sinks.onDelta }),
          ...(sinks.onProgress === undefined ? {} : { onProgress: sinks.onProgress }),
        });
      } catch (error) {
        // The continuation target vanished between bind and execution. Never
        // recompute under this event's identity: the event stays pending and
        // `recover` resolves it against the durable row — already delivered,
        // or still running elsewhere and re-checked on the next drain.
        if (error instanceof ContinuationGone) {
          return step({ kind: 'deferred', workId: ctx.workId ?? claim.workId, why: 'still-running' });
        }
        throw error;
      }
      await sinks.ran?.(ctx.result);
      return step(CONTINUE);
    }
    case 'deliver': {
      const result = ctx.result;
      const workId = ctx.workId;
      if (result === undefined || workId === undefined) throw new Error('ingress: the deliver stage ran without a turn');
      // A suspended turn has produced nothing to deliver. Rendering `''` would
      // send an empty message and record `sent` on a turn that has not
      // answered — the owner would read it as the answer. The lane delivers
      // when the turn resumes.
      if (result.stopped === 'suspended') return step(CONTINUE);
      try {
        const outcome = await hooks.deliver(ctx, workId, result.text);
        if (outcome === 'deferred') return step({ kind: 'deferred', workId, why: 'delivery-deferred' });
        if (outcome === 'possibly_sent') {
          hooks.finish(ctx);
          hooks.recordDelivery(workId, 'possibly_sent');
          return step({ kind: 'answered', workId, delivery: 'possibly_sent' });
        }
      } catch (error) {
        // The second outcome, kept apart from the first: the *turn* answered,
        // the *delivery* did not. A failed delivery must never make the work
        // run again, because that doubles it. Rethrown unchanged, so the event
        // stays pending — retried by `recover`, never by a second call into
        // the model.
        hooks.recordDelivery(workId, `failed:${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
      // The send landed — settle this event's fire *before* the bookkeeping
      // write below, so a crash between the two still proves delivery happened
      // on the next resolution.
      hooks.settle(ctx);
      hooks.recordDelivery(workId, 'sent');
      return step(CONTINUE);
    }
    case 'settle': {
      const result = ctx.result;
      const workId = ctx.workId;
      if (result === undefined || workId === undefined) throw new Error('ingress: the settle stage ran without a turn');
      if (result.stopped === 'suspended') {
        // The *event* is nonetheless fully handled: a turn exists, is bound,
        // and has been handed to the turn lane. Settling here is what stops
        // this same event from being re-checked on every future drain;
        // whatever answer eventually comes is the lane's own delivery.
        hooks.finish(ctx);
        return step({ kind: 'suspended', workId });
      }
      hooks.markProcessed(ctx);
      return step({ kind: 'answered', workId, delivery: 'sent' });
    }
  }
}

/** What a port already wrote as this event's durable reply address. */
function replyRecordOf(ctx: Ingressing): Record<string, unknown> {
  return ctx.event.address.record;
}

/** The half of an event's durable row `recover` needs, named without a platform's vocabulary. */
export type StoredIngressEvent = {
  readonly eventId: string;
  /** Set the moment this event's fire was settled — proof of delivery even when the turn's own column did not land. */
  readonly settledAt: string | null;
};

/** What `recover` needs on top of `IngressHooks`. */
export type RecoverHooks = {
  /** The turn row, read straight from `loop.turns` — never re-derived. */
  readonly turn: (workId: string) => TurnRecord | null;
  /** The answer this turn already produced, recovered from its session rather than recomputed. */
  readonly recoveredText: (record: TurnRecord) => string;
  /** `true` when the port's write-ahead plan holds a part it could not confirm. */
  readonly wireWasUncertain: (workId: string) => boolean;
  /** Redelivery of an already-computed answer, to the address on the durable row. */
  readonly redeliver: (workId: string, replyTo: Record<string, unknown>, text: string) => Promise<'sent' | 'possibly_sent' | 'deferred'>;
};

/**
 * This event is already bound to `workId` — from a previous pass of this same
 * drain, a crashed one before it, or a race with itself resolved a moment ago.
 *
 * **Never calls the model.** It only recovers or defers, and that is the whole
 * contract: the five branches below are the difference between an agent that
 * answers once and one that answers twice after every crash.
 */
export async function recover(
  port: IngressPort,
  stored: StoredIngressEvent,
  workId: string,
  event: InboundEvent,
  hooks: IngressHooks & RecoverHooks,
): Promise<IngressOutcome> {
  const ctx: Ingressing = {
    port,
    event,
    identity: identify(event.identity, hooks.ownerId),
    parts: event.parts,
    text: undefined,
    arrival: null,
    workId,
    result: undefined,
  };
  const existing = hooks.turn(workId);
  if (existing === null) {
    // Fault point 2: the bind landed, the turn row did not — a crash between
    // the two. Nothing has run yet, so this is not a duplicate: finish exactly
    // what was interrupted, with the identity already committed, never a
    // second one. Re-enters at `compose`, because pairing, the gate and the
    // commands already had their say when this event was first seen.
    return walk(ctx, { ...hooks, claim: async () => ({ kind: 'mine', workId }) }, 'compose');
  }
  if (existing.status !== 'done') {
    // Fault points 3/4: some pass already created this turn, and it belongs to
    // the turn's own resume machinery now (reclaim, the turn lane), not to a
    // second call into the model for the same event. The event stays pending,
    // and the next drain re-checks once the turn is actually `done`.
    hooks.log?.(`evento ${stored.eventId} già legato al turno ${workId.slice(0, 12)} (${existing.status}) — rimando`);
    return { kind: 'deferred', workId, why: 'still-running' };
  }
  // `done`: the model already ran. Resolve delivery without ever recomputing.
  if (
    stored.settledAt !== null ||
    existing.delivery === 'sent' ||
    existing.delivery === 'possibly_sent' ||
    existing.delivery === 'undeliverable'
  ) {
    // Fault points 5/7: already delivered — by this same port's earlier pass,
    // or by an independent turn-lane delivery. `settledAt` proves it even when
    // the turn's own bookkeeping column did not land.
    if (
      existing.delivery !== 'sent' &&
      existing.delivery !== 'possibly_sent' &&
      existing.delivery !== 'undeliverable'
    ) {
      hooks.recordDelivery(workId, hooks.wireWasUncertain(workId) ? 'possibly_sent' : 'sent');
    }
    hooks.finish(ctx);
    return { kind: 'recovered', workId, delivery: 'already' };
  }
  // `pending` (never delivered) or `failed:<why>` (attempted and refused) —
  // recover the text, retry the send, never recompute (fault points 5 and 6).
  if (existing.replyTo === null) {
    hooks.recordDelivery(workId, 'undeliverable');
    hooks.finish(ctx);
    return { kind: 'recovered', workId, delivery: 'undeliverable' };
  }
  const text = hooks.recoveredText(existing);
  try {
    const outcome = await hooks.redeliver(workId, existing.replyTo, text);
    if (outcome === 'deferred') return { kind: 'deferred', workId, why: 'delivery-deferred' };
    if (outcome === 'possibly_sent') {
      hooks.finish(ctx);
      hooks.recordDelivery(workId, 'possibly_sent');
      return { kind: 'recovered', workId, delivery: 'possibly_sent' };
    }
  } catch (error) {
    hooks.recordDelivery(workId, `failed:${error instanceof Error ? error.message : String(error)}`);
    throw error; // stays pending; the next drain retries the send, not the model
  }
  hooks.settle(ctx);
  hooks.recordDelivery(workId, 'sent');
  hooks.markProcessed(ctx);
  return { kind: 'recovered', workId, delivery: 'sent' };
}
