import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runInit } from '../cli/init.js';
import { TurnLane } from '../core/turns/lane.js';
import { ModelLane } from '../core/turns/model-lane.js';
import type { TurnRecord } from '../core/turns/store.js';
import { buildRuntime } from './runtime.js';
import type { LoopDeps } from './loop.js';
import { makeLaneRunner } from './turn-lane.js';
import type { ChatResult, Provider } from './providers/types.js';
import { providerMessages } from './loop/provider-checkpoint.js';

/**
 * Accettazione · **un processo vero viene ucciso a metà turno, e al riavvio il
 * turno riprende.**
 *
 * This is the bar DAY-1 requirement B5 sets, and it is performed rather than simulated. A
 * second node process boots the production `buildRuntime`, starts a real turn,
 * and is `SIGKILL`ed while a tool call is in flight — no `finally`, no cleanup,
 * no chance to write anything on the way out, which is what a laptop closing or
 * an OOM kill actually looks like. Everything asserted afterwards was left on
 * disk by production code.
 *
 * The tool in flight is declared **`rerunnable: false`**, because that is the
 * expensive half. The turn must come back *declaring* that the call may have
 * landed — never repeating it, and never pretending it did not happen. Before
 * this slice the same crash re-ran the whole turn from the top, tool calls and
 * their effects included, with nothing anywhere saying so.
 */

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  calls = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(): Promise<ChatResult> {
    const next = this.script[this.calls++];
    if (!next) throw new Error('lo script è finito');
    return next;
  }
}

const answer = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  stopReason: 'end',
  usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'test',
});

/**
 * The child: a real Muffin taking a real turn, which stops existing mid-call.
 *
 * It goes through `buildRuntime`, so the row, the intent record and the pinned
 * model are all written by the same code an install runs. The handler signals
 * the parent and then never returns — the process is killed inside it.
 */
const CHILD = (runtimeUrl: string, loopUrl: string) => `
import { writeFileSync } from 'node:fs';
import { buildRuntime } from ${JSON.stringify(runtimeUrl)};
import { runTurn } from ${JSON.stringify(loopUrl)};

const [home, ws, marker] = process.argv.slice(2);
const rt = buildRuntime(home, ws);

// Not re-runnable, and that is the whole point of the scenario: sending a
// message twice is not something any record can undo.
const decl = {
  id: 'demo.send', effect: 'context', risk: 'low', reversible: 'no', rerunnable: false,
  resourceKind: 'none', policyArgs: [], hostOnly: false,
};
rt.register({
  capability: 'demo.send',
  spec: { name: 'send_message', description: 'manda', inputSchema: { type: 'object', properties: {} } },
  handler: async () => {
    // "The effect is in flight." The parent kills us on seeing this.
    writeFileSync(marker, 'in volo');
    // The timer is not decoration: a bare \`new Promise(() => {})\` empties the
    // event loop, node notices the top-level await can never settle, and the
    // process exits **13 on its own** — a tidy shutdown, which is the one thing
    // this scenario must not be. Something has to keep the loop alive so the
    // parent's SIGKILL is what ends it.
    const keepAlive = setInterval(() => {}, 1000);
    await new Promise(() => {});
    clearInterval(keepAlive);
  },
}, decl);

const provider = {
  kind: 'openai-compat',
  chat: async () => ({
    text: null,
    toolCalls: [{ id: 'k1', name: 'send_message', args: { to: 'Marco' } }],
    stopReason: 'tool_use',
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    model: 'test',
  }),
};

await runTurn({ ...rt.deps, provider }, {
  principal: { kind: 'owner', connector: 'telegram', externalId: '1' },
  tenant: 'host',
  surface: 'telegram',
  session: rt.deps.sessions.open('telegram:99'),
  text: 'manda il messaggio a Marco e poi dimmi com’è andata',
  replyTo: { chatId: 99 },
});
`;

/** Spawns the child, waits until the tool is in flight, and kills -9. */
async function killMidTurn(home: string, ws: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-crashresume-'));
  const script = join(dir, 'child.mjs');
  const marker = join(dir, 'in-flight');
  writeFileSync(
    script,
    CHILD(
      pathToFileURL(join(process.cwd(), 'agent', 'runtime.ts')).href,
      pathToFileURL(join(process.cwd(), 'agent', 'loop.ts')).href,
    ),
  );

  const child = spawn('node', ['--import', 'tsx', script, home, ws, marker], { stdio: 'ignore' });
  // Attached before anything can await, or a child that dies early resolves
  // nothing and the wait below hangs until the test times out.
  let gone = child.exitCode !== null;
  const exited = new Promise<void>((resolve) => {
    if (gone) resolve();
    child.on('exit', () => {
      gone = true;
      resolve();
    });
  });

  for (let i = 0; i < 600 && !existsSync(marker) && !gone; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!existsSync(marker)) {
    child.kill('SIGKILL');
    await exited;
    throw new Error(`il figlio non è mai arrivato alla tool call (uscito ${child.exitCode})`);
  }
  // SIGKILL, not SIGTERM: no handler, no `finally`, no flush. The row and the
  // intent record have to be enough on their own.
  child.kill('SIGKILL');
  await exited;
  // The kill has to be what ended it. A child that exited on its own would be a
  // tidy shutdown wearing the costume of a crash, and would prove nothing.
  expect(child.signalCode).toBe('SIGKILL');
}

async function settle(lane: TurnLane): Promise<void> {
  for (let i = 0; i < 200 && lane.isRunning(); i++) await new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('accettazione · ucciso a metà turno, riprende al riavvio', () => {
  it('riprende il turno e dichiara la chiamata che può essere avvenuta', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-crashresume-home-'));
    runInit({ home, apiKey: 'sk-never-called' });
    const ws = mkdtempSync(join(tmpdir(), 'muffin-crashresume-ws-'));

    await killMidTurn(home, ws);

    // ---- the restart -------------------------------------------------------
    const runtime = buildRuntime(home, ws);
    // Named at boot, on the real path, because every surface builds a runtime.
    const notes = runtime.bootLines.join('\n');
    expect(notes).toContain('send_message');
    expect(notes).toContain('non è possibile sapere se ha avuto effetto');

    const rows = runtime.db.prepare(`SELECT id, status FROM turns`).all() as { id: string; status: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('interrupted');
    const turnId = rows[0]!.id;

    // The intent row survived with no outcome — this is what separates "done"
    // from "maybe done", and before this pair of rows existed there was no
    // trace of the call at all.
    const uncertain = runtime.deps.turns.uncertainCalls(turnId);
    expect(uncertain.map((c) => [c.tool, c.rerunnable])).toEqual([['send_message', false]]);

    // ---- the lane picks it back up -----------------------------------------
    const provider = new Scripted([answer('Ho provato a mandarlo, ma non posso confermartelo.')]);
    const deps: LoopDeps = { ...runtime.deps, provider };
    const delivered: { turn: TurnRecord; text: string }[] = [];
    let sends = 0;
    // The same tool the dead process was inside, registered again — a restart
    // has the same tool list. If the resume re-ran it, this counter would move.
    runtime.register(
      {
        capability: 'demo.send',
        spec: { name: 'send_message', description: 'manda', inputSchema: { type: 'object', properties: {} } },
        throwTier: 0,
        handler: () => {
          sends += 1;
          return { content: 'inviato', tier: 0 as const };
        },
      },
      {
        id: 'demo.send',
        effect: 'context',
        risk: 'low',
        reversible: 'no',
        rerunnable: false,
        resourceKind: 'none',
        policyArgs: [],
        hostOnly: false,
      },
    );

    const lane = new TurnLane({
      turns: runtime.deps.turns,
      run: makeLaneRunner(deps, async (turn, text) => {
        delivered.push({ turn, text });
      }),
      modelLane: new ModelLane(),
    });
    lane.tick();
    await settle(lane);

    const done = runtime.deps.turns.get(turnId)!;
    const transcript = JSON.stringify(providerMessages(done));
    runtime.close();

    // 1. It resumed, and the answer reached the surface the row named.
    expect(delivered.map((d) => d.text)).toEqual(['Ho provato a mandarlo, ma non posso confermartelo.']);
    expect(delivered[0]?.turn.replyTo).toEqual({ chatId: 99 });
    expect(done.status).toBe('done');
    expect(done.outcome).toBe('answered');
    expect(done.delivery).toBe('sent');
    expect(done.counters.resumes).toBe(1);

    // 2. The call was NOT repeated. This is the number the whole two-phase
    //    record exists to hold at zero.
    expect(sends).toBe(0);

    // 3. And it was not pretended away either: the model was handed the truth,
    //    which is what lets it answer honestly instead of claiming success.
    expect(transcript).toContain('non è possibile sapere se ha avuto effetto');
    expect(transcript).toContain("Non l'ho rifatta");
  }, 120_000);
});
