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
    };
  }
  return { stopped: result.stopped, text: result.text };
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
      ...(signal ? { signal } : {}),
    });
    return jobOutcomeFromTurn(result);
  };
}
