import { createInterface } from 'node:readline/promises';
import { attachMcp, buildRuntime, type Runtime } from '../agent/runtime.js';
import { Scheduler, type Deliver, type ForegroundGate } from '../core/scheduler/scheduler.js';
import { makeJobRunner } from '../agent/scheduler-run.js';
import { runTurn } from '../agent/loop.js';
import { paths } from '../core/config/config.js';
import { connectSurfaces } from './surface.js';

/**
 * The REPL.
 *
 * One session per launch, so the conversation is continuous by default and
 * `/new` is the explicit way to forget. Ctrl+C cancels the turn in progress —
 * pressing it again within two seconds exits — because the common case is
 * "stop, that is not what I meant", not "kill the process".
 */

const HELP = `/new     inizia una sessione nuova
/session mostra l'id della sessione
/spend   quanto hai speso questo mese
/exit    esci (o Ctrl+D)`;

export async function runRepl(home = paths().home): Promise<number> {
  let runtime: Runtime;
  try {
    runtime = buildRuntime(home);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (runtime.safeMode) {
    process.stderr.write(
      `! safe mode: root of trust diverged (${runtime.safeMode.reason}) — capability sopra il rischio basso negate\n`,
    );
  }

  // `muffin` starts the agent, and the agent is on every surface it was given —
  // in this same process (ADR-0022), for as long as this process lives. Not a
  // subcommand you also have to remember to run: a message from the phone works
  // because Muffin is running, which is what "running" should mean.
  const surfaces = connectSurfaces(runtime, home);

  // Allowlisted MCP servers, verified against their pins. A suspension is
  // boot-visible, not buried: the owner reads why before the first turn.
  let mcpLines: string[] = [];
  try {
    mcpLines = await attachMcp(runtime, home);
  } catch (error) {
    mcpLines = [`mcp: ${error instanceof Error ? error.message : String(error)}`];
  }

  process.stderr.write(
    `muffin · ${runtime.config.models.main} · profilo ${runtime.deps.profile.name}\n` +
      surfaces.lines.map((l) => `${l}\n`).join('') +
      mcpLines.map((l) => `${l}\n`).join('') +
      runtime.bootLines.map((l) => `${l}\n`).join('') +
      `/help per i comandi, Ctrl+C annulla il turno, Ctrl+D esce\n\n`,
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // The terminal is the surface that *can* ask, so here the kernel's `ask`
  // verdict becomes a question instead of a refusal. The wording is the kernel's
  // own — a paraphrase is a chance to make the request sound smaller than it is —
  // and anything that is not an explicit yes is a no.
  runtime.deps.approve = async (request) => {
    process.stderr.write(`\n⚠ ${request.prompt}\n`);
    if (request.resource) process.stderr.write(`   su: ${request.resource}\n`);
    const answer = (await rl.question(`   approvi "${request.capability}"? [s/N] `)).trim().toLowerCase();
    const allowed = answer === 's' || answer === 'si' || answer === 'sì' || answer === 'y';
    process.stderr.write(`   ${allowed ? 'approvato' : 'rifiutato'}\n\n`);
    return allowed ? 'allow' : 'deny';
  };

  let session = runtime.deps.sessions.open();
  let controller: AbortController | null = null;
  let lastInterrupt = 0;

  rl.on('SIGINT', () => {
    const now = Date.now();
    if (controller) {
      controller.abort();
      process.stderr.write(`\n^C turno annullato\n`);
      lastInterrupt = now;
      return;
    }
    // Nothing running: a second Ctrl+C in quick succession means leave.
    if (now - lastInterrupt < 2000) {
      rl.close();
      return;
    }
    lastInterrupt = now;
    process.stderr.write(`\n(di nuovo Ctrl+C per uscire)\n`);
    rl.prompt();
  });

  // The scheduler runs in this same process (ADR-0022): a tick finds what is
  // due and runs it as system:scheduler. Foreground wins — while an interactive
  // turn holds the lane (`controller` set), a tick defers, and a job already
  // running gets that turn's abort signal to yield.
  const foreground: ForegroundGate = {
    isActive: () => controller !== null,
    signal: () => controller?.signal,
  };
  const deliver: Deliver = async (channel, text) => {
    if (channel === 'cli') {
      process.stdout.write(`\n⏰ ${text}\n`);
      rl.prompt();
      return;
    }
    // A remote surface is reached through its connector's send — the M4 connect,
    // proven on a running bot. Until that is wired, a scheduled message for a
    // remote channel surfaces here rather than vanishing.
    process.stderr.write(`\n⏰ [job → ${channel}: consegna remota da cablare]\n${text}\n`);
    rl.prompt();
  };
  const scheduler = new Scheduler(runtime.jobs, makeJobRunner(runtime.deps), deliver, foreground, (e) => {
    if (e.kind === 'delivery_failed') {
      process.stderr.write(`job ${e.job.id.slice(0, 8)}: consegna fallita (${e.error})\n`);
    }
  });
  const ticker = setInterval(() => scheduler.tick(), 30_000);
  ticker.unref(); // the timer must not, by itself, keep the process alive

  try {
    for (;;) {
      const line = (await rl.question('› ')).trim();
      if (line === '') continue;

      if (line.startsWith('/')) {
        if (line === '/exit') break;
        if (line === '/help') {
          process.stderr.write(`${HELP}\n`);
          continue;
        }
        if (line === '/new') {
          session = runtime.deps.sessions.open();
          process.stderr.write(`sessione nuova: ${session.id}\n`);
          continue;
        }
        if (line === '/session') {
          process.stderr.write(`${session.id}\n`);
          continue;
        }
        if (line === '/spend') {
          const s = runtime.budget.status();
          process.stderr.write(
            `$${s.monthUsd.toFixed(4)} / $${s.monthlyCapUsd} questo mese${s.exhausted ? ' — esaurito' : ''}\n`,
          );
          continue;
        }
        process.stderr.write(`comando sconosciuto. ${HELP}\n`);
        continue;
      }

      controller = new AbortController();
      try {
        const result = await runTurn(runtime.deps, {
          principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
          tenant: 'host',
          surface: 'cli',
          session,
          text: line,
          signal: controller.signal,
        });
        process.stdout.write(`\n${result.text}\n\n`);
        if (result.stopped !== 'answered') {
          process.stderr.write(`(${result.stopped} dopo ${result.iterations} passaggi)\n`);
        }
      } catch (error) {
        process.stderr.write(`errore: ${error instanceof Error ? error.message : String(error)}\n`);
      } finally {
        controller = null;
      }
    }
  } catch (error) {
    // readline throws on close(); that is the normal way out of the loop.
    if (!(error instanceof Error && /closed/i.test(error.message))) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  } finally {
    clearInterval(ticker);
    rl.close();
    // Surfaces first, then the runtime: the connector must stop polling before
    // the database under it goes away.
    surfaces.stop();
    runtime.close();
  }

  process.stderr.write(`\nciao.\n`);
  return 0;
}
