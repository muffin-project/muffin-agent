import { randomBytes } from 'node:crypto';
import { attachMcp, buildRuntime } from '../agent/runtime.js';
import { runTurn, type TurnResult } from '../agent/loop.js';
import { loadImage } from '../agent/images.js';
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
  /** Percorsi di immagini da mostrare al modello insieme all'obiettivo. */
  images?: string[];
};

/** 0 answered · 1 error · 3 needs approval · 4 budget · 5 iteration cap · 6 suspended */
export type RunExit = 0 | 1 | 3 | 4 | 5 | 6;

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

  for (const line of runtime.bootLines) process.stderr.write(`${line}\n`);
  // Same MCP surface as the REPL: headless work has the same hands, and a
  // suspended server is reported on stderr where the script's operator looks.
  try {
    for (const line of await attachMcp(runtime, home)) process.stderr.write(`${line}\n`);
  } catch (error) {
    process.stderr.write(`mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  // A headless turn gets its own thread unless asked to continue one: a script
  // run in a loop should not silently accumulate a conversation.
  const session = runtime.deps.sessions.open(
    options.sessionId ?? `run-${new Date().toISOString().slice(0, 10)}-${randomBytes(3).toString('hex')}`,
  );

  // Le immagini si caricano **prima** di aprire qualunque cosa verso il
  // provider: un percorso sbagliato deve costare un messaggio, non un turno
  // avviato a metà. Un fallimento qui ferma il comando invece di proseguire
  // silenziosamente senza l'immagine — chiedere «cosa vedi in questa foto» e
  // ricevere una risposta su nessuna foto è il fallimento peggiore dei due.
  const images = [];
  for (const percorso of options.images ?? []) {
    const caricata = loadImage(percorso);
    if (!caricata.ok) {
      process.stderr.write(`immagine non usabile (${percorso}): ${caricata.why}\n`);
      runtime.close();
      return 1;
    }
    images.push(caricata.block);
  }

  const controller = new AbortController();
  const timeout = options.timeoutSeconds
    ? setTimeout(() => controller.abort(), options.timeoutSeconds * 1000)
    : null;

  let result: TurnResult;
  try {
    result = await runTurn(runtime.deps, {
      principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
      tenant: 'host',
      surface: 'cli',
      session,
      text: options.goal,
      ...(images.length > 0 ? { images } : {}),
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
      // The write line is what stops the first turn reading as "cache broken":
      // it pays to fill the cache the next turn reads from.
      `${result.usage.cacheWriteTokens > 0 ? ` · ${result.usage.cacheWriteTokens} scritti in cache` : ''}` +
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
    case 'suspended':
      /**
       * Its own code (ADR-0047 §7), because a script that cannot tell this from
       * `answered` will print an empty string and call it a result.
       *
       * Nothing was lost: the row is `waiting` and durable, and the gateway's
       * lane resumes it at the deadline — in *that* process, not this one, which
       * is exiting. Said out loud with the turn id, because a headless caller
       * with no gateway running has a turn that will sit there until one is, and
       * silence would make that look like an answer that never came.
       */
      process.stderr.write(
        `turno sospeso fino a ${result.suspendedUntil?.wakeAt ?? '?'} — riprende dalla corsia del gateway ` +
          `(\`muffin gateway run\`), turno ${result.turnId.slice(0, 12)}\n`,
      );
      return 6;
    case 'aborted':
      process.stderr.write(`interrotto dopo ${options.timeoutSeconds}s\n`);
      return 1;
    case 'error':
      return 1;
  }
}
