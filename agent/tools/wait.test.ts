import { describe, expect, it } from 'vitest';
import { createDecide } from '../../core/policy/decide.js';
import { POLICY_FLOOR } from '../../core/policy/matrix.js';
import { MAX_SUSPENDED_PER_TENANT, type WaitSpec } from '../../core/turns/wait.js';
import { toolContext } from '../fixtures/tool-context.js';
import { makeWaitTool, waitCapability } from './wait.js';

/**
 * `wait` is a door onto a runtime primitive, and the tests are about what it
 * does **not** do.
 *
 * It does not sleep, it does not `setTimeout`, and it does not return late. It
 * arms a barrier on the turn and comes back immediately; the loop honours the
 * barrier at its next suspension point, writes the row and returns to the
 * caller. A handler that slept would pass every assertion about its *output*
 * and be the exact thing M5-BIS.md#wait-e-todo-sono-primitive-del-runtime-non-tool says is not a wait — so the assertion is on
 * the clock and on the barrier, not on the string.
 */

/** A context that records the barrier instead of throwing, for the one tool that arms one. */
function armed(over: Parameters<typeof toolContext>[0] = {}): {
  ctx: ReturnType<typeof toolContext>;
  barriers: WaitSpec[];
} {
  const barriers: WaitSpec[] = [];
  return { ctx: toolContext({ suspend: (spec) => barriers.push(spec), ...over }), barriers };
}

const counting = (n: number) => ({ countSuspended: () => n });
const NOW = () => new Date('2026-08-16T10:00:00.000Z');

describe('wait non dorme', () => {
  it('torna subito e lascia una barriera, invece di tenere il runtime', async () => {
    const { ctx, barriers } = armed();
    const tool = makeWaitTool(counting(0), NOW);

    const started = Date.now();
    const out = await tool.handler({ seconds: 3600 }, ctx);
    const elapsed = Date.now() - started;

    // The number is generous on purpose — this is not a benchmark. What it
    // rules out is an `await sleep(3600_000)` inside the handler, which is the
    // implementation this primitive exists instead of.
    expect(elapsed).toBeLessThan(500);
    expect(barriers).toEqual([{ wakeAt: '2026-08-16T11:00:00.000Z', waitFor: null }]);
    expect(out.isError).toBeUndefined();
    // The text the model sees *before* the suspension must not claim the wait
    // is over — it is written into the transcript at arming time.
    expect(out.content).toMatch(/si sospende/);
  });

  it('porta anche la barriera a evento, quando gliela chiedi', async () => {
    const { ctx, barriers } = armed();
    const out = await makeWaitTool(counting(0), NOW).handler(
      { seconds: 600, until_process_exits: 4242 },
      ctx,
    );
    expect(barriers[0]).toEqual({
      wakeAt: '2026-08-16T10:10:00.000Z',
      waitFor: { kind: 'process_exit', pid: 4242 },
    });
    expect(out.content).toContain('4242');
  });
});

describe('quando wait dice di no', () => {
  it('un’attesa rifiutata non arma niente', async () => {
    const { ctx, barriers } = armed();
    const out = await makeWaitTool(counting(0), NOW).handler({ seconds: 5 }, ctx);
    expect(out.isError).toBe(true);
    // The half that matters: a refusal that still armed the barrier would
    // suspend the turn anyway, on a deadline nobody agreed to.
    expect(barriers).toEqual([]);
  });

  it('rifiuta sopra il tetto per tenant, e dice il numero che l’ha rotto', async () => {
    const { ctx, barriers } = armed();
    const out = await makeWaitTool(counting(MAX_SUSPENDED_PER_TENANT), NOW).handler(
      { seconds: 3600 },
      ctx,
    );
    expect(out.isError).toBe(true);
    // A limit that fails without saying which one it was is a limit debugged by
    // reading source.
    expect(out.content).toContain(String(MAX_SUSPENDED_PER_TENANT));
    expect(barriers).toEqual([]);
  });

  it('conta i sospesi del tenant del turno, non di un tenant cablato', async () => {
    const asked: string[] = [];
    const tool = makeWaitTool({ countSuspended: (t) => (asked.push(t), 0) }, NOW);
    await tool.handler({ seconds: 3600 }, armed({ tenant: 'gruppo-7' }).ctx);
    expect(asked).toEqual(['gruppo-7']);
  });
});

describe('cosa dichiara al kernel e alla registrazione degli esiti', () => {
  it('ogni ritorno porta tier 0, compresi i rifiuti', async () => {
    // `ToolOutcome.tier` is on its way to being mandatory
    // (`slice/taint-in-ingresso`), and a tier absent because nobody thought
    // about it is indistinguishable at the merge from one absent because it is
    // genuinely zero. This tool brings no bytes in from anywhere.
    const tool = makeWaitTool(counting(0), NOW);
    const ok = await tool.handler({ seconds: 3600 }, armed().ctx);
    const refused = await tool.handler({ seconds: 1 }, armed().ctx);
    const capped = await makeWaitTool(counting(99), NOW).handler({ seconds: 3600 }, armed().ctx);
    expect([ok.tier, refused.tier, capped.tier]).toEqual([0, 0, 0]);
  });

  it('si dichiara ri-eseguibile, e lo è: due chiamate uguali lasciano una barriera sola', async () => {
    expect(waitCapability.rerunnable).toBe(true);
    // Not "it is harmless" — the actual test for re-runnability. `suspend`
    // writes `wake_at`/`wait_for` on one row, so the second call overwrites the
    // first: the observable state after one call and after two identical calls
    // is the same row in the same state.
    const { ctx, barriers } = armed();
    const tool = makeWaitTool(counting(0), NOW);
    await tool.handler({ seconds: 3600 }, ctx);
    await tool.handler({ seconds: 3600 }, ctx);
    expect(new Set(barriers.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  it('il kernel lo permette a ogni taint, perché il caso canonico parte da una pagina letta', () => {
    /**
     * The regression this pins: `defaultMaxTaint.medium` is 1, so without an
     * explicit `maxTaint` the sequence this tool exists for — read a page, wait
     * an hour, check again — is denied `taint_exceeded` at the first step.
     *
     * All four tiers, not just 3: a ceiling that happened to allow 3 while
     * denying 2 would be a different bug wearing the same green tick.
     */
    const decide = createDecide({
      matrix: POLICY_FLOOR,
      capabilities: new Map([[waitCapability.id, waitCapability]]),
      budgetExhausted: () => false,
      hardened: true,
    });
    for (const taint of [0, 1, 2, 3] as const) {
      const decision = decide({
        principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
        tenant: 'host',
        capability: waitCapability.id,
        resource: { kind: 'none' },
        args: {},
        taint,
      });
      expect(decision.effect, `taint ${taint}`).toBe('allow');
    }
  });

  it('il kernel lo nega a un membro di gruppo, non solo il menu', () => {
    // `hostOnly` is a fail-closed answer to a question the threat model has not
    // examined: a tier-2 member arming a persistent wait. `visibleTools` keeps
    // it off their menu; this is the enforcement behind the menu.
    const decide = createDecide({
      matrix: POLICY_FLOOR,
      capabilities: new Map([[waitCapability.id, waitCapability]]),
      budgetExhausted: () => false,
      hardened: true,
    });
    const decision = decide({
      principal: { kind: 'member', connector: 'telegram', externalId: '7', tenantId: 'gruppo-7' },
      tenant: 'gruppo-7',
      capability: waitCapability.id,
      resource: { kind: 'none' },
      args: {},
      taint: 2,
    });
    expect(decision.effect).toBe('deny');
  });
});
