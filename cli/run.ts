import { randomBytes } from 'node:crypto';
import { buildRuntime } from '../agent/runtime.js';
import { runTurn, type TurnResult } from '../agent/loop.js';
import { paths } from '../core/config/config.js';

/**
 * Headless single turn.
 *
 * stdout carries the answer and nothing else, so `muffin run "..." | pbcopy`
 * does what you expect. Everything else — warnings, safe mode, spend — goes to
 * stderr. The exit code distinguishes the ways a turn can end, because a script
 * that cannot tell "answered" from "hit the cap" will treat both as success.
 */

export type RunOptions = {
  goal: string;
  json?: boolean;
  sessionId?: string;
  timeoutSeconds?: number;
  home?: string;
};

/** 0 answered · 1 error · 3 needs approval · 4 budget · 5 iteration cap */
export type RunExit = 0 | 1 | 3 | 4 | 5;

export async function runHeadless(options: RunOptions): Promise<RunExit> {
  const home = options.home ?? paths().home;
  let runtime;
  try {
    runtime = buildRuntime(home);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (runtime.safeMode) {
    process.stderr.write(
      `! safe mode: root of trust diverged (${runtime.safeMode.reason}: ${runtime.safeMode.diverged.join(', ')})\n` +
        `  capabilities above low risk are denied — \`muffin rot verify\` for detail\n`,
    );
  }

  // A headless turn gets its own thread unless asked to continue one: a script
  // run in a loop should not silently accumulate a conversation.
  const session = runtime.deps.sessions.open(
    options.sessionId ?? `run-${new Date().toISOString().slice(0, 10)}-${randomBytes(3).toString('hex')}`,
  );

  const controller = new AbortController();
  const timeout = options.timeoutSeconds
    ? setTimeout(() => controller.abort(), options.timeoutSeconds * 1000)
    : null;

  let result: TurnResult;
  try {
    result = await runTurn(runtime.deps, {
      principal: { kind: 'owner', connector: 'cli' },
      tenant: 'host',
      surface: 'cli',
      session,
      text: options.goal,
      signal: controller.signal,
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    if (timeout) clearTimeout(timeout);
    runtime.close();
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...result, session: session.id }, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.text}\n`);
  }

  process.stderr.write(
    `\n${result.iterations} passaggi · ${result.usage.inputTokens} token in / ${result.usage.outputTokens} out` +
      `${result.usage.cacheReadTokens > 0 ? ` · ${result.usage.cacheReadTokens} da cache` : ''}` +
      ` · sessione ${session.id} · trace ${result.traceId.slice(0, 12)}\n`,
  );

  switch (result.stopped) {
    case 'answered':
      return 0;
    case 'budget':
      return 4;
    case 'cap':
      return 5;
    case 'ask':
      // The one exit code a script can act on: nothing was done, and a person
      // has to decide. Headless has no channel by design — inventing consent on
      // behalf of an absent owner is the failure mode this whole layer exists to
      // prevent.
      process.stderr.write(
        `serve approvazione: ${result.pending?.capability ?? '?'}` +
          `${result.pending?.resource ? ` su ${result.pending.resource}` : ''}` +
          ` — rilancia in \`muffin\` interattivo per decidere\n`,
      );
      return 3;
    case 'aborted':
      process.stderr.write(`interrotto dopo ${options.timeoutSeconds}s\n`);
      return 1;
    case 'error':
      return 1;
  }
}
