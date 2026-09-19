import { buildRuntime } from '../agent/runtime.js';
import { continueTurn, explicitResumeMessage, type TurnResult } from '../agent/loop.js';
import { paths } from '../core/config/config.js';

/**
 * `muffin resume <turn-id>` — the explicit command half of continuation.
 *
 * The conversational half ("riprendi") lives on the surfaces; this is the
 * recovery/debug half, and it reuses the exact same primitive
 * (`continueTurn`): same grant, same fresh lease, same refusals. The grant
 * message is the harness-marked resume marker rather than owner words —
 * this command carries no conversation, so it must not invent any.
 *
 * Local execution only (no gateway forwarding): the grant is claim-fenced,
 * so a racing gateway simply wins or loses the race out loud instead of
 * duplicating the lease.
 */

export type ResumeOptions = {
  turnId: string;
  json?: boolean;
  home?: string;
};

export async function runResume(options: ResumeOptions): Promise<0 | 1 | 3 | 4 | 5 | 6 | 7> {
  const home = options.home ?? paths().home;
  let runtime;
  try {
    runtime = buildRuntime(home);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  let result: TurnResult | { turnId: string; why: string; detail: string };
  try {
    result = await continueTurn(runtime.deps, options.turnId, {
      message: explicitResumeMessage(options.turnId),
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    runtime.close();
    return 1;
  } finally {
    runtime.close();
  }

  if ('why' in result) {
    process.stderr.write(`non continuato (${result.why}): ${result.detail}\n`);
    return 1;
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.text}\n`);
  }
  switch (result.stopped) {
    case 'answered':
      return 0;
    case 'budget':
      return 4;
    case 'cap':
      return 5;
    case 'ask':
      return 3;
    case 'suspended':
      return 6;
    case 'continuable':
      // The new lease exhausted itself too: same code as `muffin run`,
      // same remedy — the id below is the same row, still continuable.
      process.stderr.write(`lease esaurita di nuovo — \`muffin resume ${result.turnId}\` per riprovare\n`);
      return 7;
    case 'aborted':
    case 'error':
      return 1;
  }
}
