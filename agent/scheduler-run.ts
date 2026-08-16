import { randomBytes } from 'node:crypto';
import type { Job } from '../core/scheduler/jobs.js';
import type { JobOutcome, RunJob } from '../core/scheduler/scheduler.js';
import { runTurn, type LoopDeps, type TurnResult } from './loop.js';

/**
 * The bridge from a scheduled job to a real turn.
 *
 * A job runs as the scheduler principal — `{ kind: 'system', source:
 * 'scheduler' }` — so the kernel treats it as itself, not as the owner: a
 * high-risk capability it would ask the owner for becomes an ASK queued for the
 * owner's return (threat model §3), and `outward.*` / `config.ratchet` are
 * denied outright. It never inherits the owner's column. Each fire gets a fresh
 * session: a daily brief is not one growing conversation.
 *
 * It does get the **owner-class context** (`agent/context/assemble.ts`), and
 * that is not the same statement as inheriting the owner's column: the job runs
 * on the host tenant, over the owner's own memory, and its output is for the
 * owner. Handing it the group prompt would produce a daily brief written by a
 * guest in someone else's room. The class follows from the pair it already
 * passes — `system` principal, `host` tenant — so there is nothing to keep in
 * sync here; a job ever armed for a group tenant moves to the group class on
 * its own.
 */

/**
 * Map a turn's end to a delivery. Kept pure and separate from the runner so the
 * one piece with a decision in it — what the owner sees when the kernel queued
 * an ASK — is tested without a model.
 */
export function jobOutcomeFromTurn(result: TurnResult): JobOutcome {
  if (result.stopped === 'ask' && result.pending) {
    const on = result.pending.resource ? ` su ${result.pending.resource}` : '';
    return {
      stopped: 'ask',
      text: `In coda per te: "${result.pending.capability}"${on} — ${result.pending.prompt}`,
      turnId: result.turnId,
    };
  }
  return { stopped: result.stopped, text: result.text, turnId: result.turnId };
}

export function makeJobRunner(deps: LoopDeps): RunJob {
  return async (job: Job, signal): Promise<JobOutcome> => {
    const session = deps.sessions.open(`job-${job.id.slice(0, 8)}-${randomBytes(3).toString('hex')}`);
    const result = await runTurn(deps, {
      principal: { kind: 'system', source: 'scheduler' },
      tenant: 'host',
      surface: job.channel,
      session,
      text: job.goal,
      /**
       * Every job turn delivers **out of band**, including one whose channel is
       * `cli`, and the address is the channel itself.
       *
       * This is the field that makes B8 checkable rather than a promise. A turn
       * created without `replyTo` gets `delivery = NULL`, which
       * `core/turns/store.ts` defines as *"this surface delivers in band — the
       * caller of `runTurn` has the text in its hand and there is no separate
       * step that can fail"*. For a job that is simply false: `Scheduler.run`
       * calls `deliver` afterwards and that call can fail. So the row started
       * out asserting the one thing that made the failure invisible. With the
       * address on it the row starts at `pending`, and a fire whose delivery is
       * never settled stays `pending` where `muffin doctor` can see it — which
       * is a different and more useful fact than "no record either way".
       */
      replyTo: { channel: job.channel },
      // `job.channel` is already a `SurfaceRegistry` address — the exact same
      // string `Deliver` uses — so a tool call mid-job (`send_file`) reaches
      // the same destination the job's own text answer will.
      replyChannel: job.channel,
      ...(signal ? { signal } : {}),
    });
    return jobOutcomeFromTurn(result);
  };
}
