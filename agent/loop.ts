/**
 * The agent loop.
 *
 * One engine for every surface — CLI today, chat connectors in M4 — because the
 * alternative is two loops that drift, and the one that gets less use is the one
 * that breaks silently.
 *
 * Shape: a deterministic pre-loop, then tool calls until the model produces a
 * final answer. Nothing here classifies intent or routes between models: those
 * are the two pieces of scaffolding that most often end up fighting the model
 * instead of helping it.
 *
 * **This file is now a barrel, and only a barrel.** The 4428-line original was
 * decomposed into `agent/loop/` over nine slices; what stayed behind is the
 * public import surface, unchanged, so that none of the 35 modules that import
 * from `agent/loop.js` had to be touched (§4 inv. 8 of
 * `docs/evidence/ingresso-unico-e-nucleo-2026-09-05.md`). Where each piece now
 * lives:
 *
 *  - `loop/types.ts` — the contract: `LoopDeps`, `TurnInput`, `TurnResult`,
 *    `ToolContext`, the approval shapes, the constants.
 *  - `loop/entry.ts` — the ways in (`enqueueTurn`, `runTurn`, `resumeTurn`),
 *    the terminal refusals, and the `/steer` funnel `drive()`.
 *  - `loop/engine.ts` — the deterministic pre-loop and the call to `runRounds`.
 *  - `loop/round.ts` — the paid path: model call, stream, completion gate, the
 *    batch of tool calls.
 *  - `loop/tool-call.ts`, `loop/durability.ts`, `loop/run-state.ts`,
 *    `loop/permissions.ts`, `loop/context.ts`, `loop/stream.ts` — one subject
 *    each, named after it.
 *
 * A file under `agent/loop/` never imports this barrel back (asserted by
 * `agent/loop/barrel.test.ts`): the modules read `./types.js` and each other,
 * and this file is the one-way door out to the rest of the tree.
 */

export {
  MAX_RESUMES,
  type ApprovalRequest,
  type ApprovalWhere,
  type Approver,
  type LoopDeps,
  type RegisteredTool,
  type ResumeRefusal,
  type ResumeStream,
  type SpendEntry,
  type ToolContext,
  type ToolOutcome,
  type TurnRuntimeInfo,
  type TurnDelta,
  type TurnEvent,
  type TurnInput,
  type TurnResult,
} from './loop/types.js';
export { denyText } from './loop/permissions.js';
export { continueTurn, enqueueTurn, resumeTurn, runTurn, type ContinuationRefusal } from './loop/entry.js';
export {
  CONTINUATION_TTL_MS,
  ContinuationGone,
  askWhichContinuation,
  buildFreshCounters,
  describeCandidate,
  evidenceForContinuation,
  explicitResumeMessage,
  isContinuationAsk,
  noteAmbiguity,
  resolveContinuation,
  resolveFollowup,
  routeContinuationTarget,
  type ContinuationCandidate,
  type ContinuationMatch,
} from './loop/continuation.js';
