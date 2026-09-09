import type { CapabilityDecl } from '../../core/policy/types.js';
import type { TurnStore } from '../../core/turns/store.js';
import { MAX_SUSPENDED_PER_TENANT, MAX_WAIT_MS, MIN_WAIT_MS, parseWait } from '../../core/turns/wait.js';
import type { RegisteredTool } from '../loop.js';
import type { ToolSpec } from '../providers/types.js';

/**
 * `wait` — the door onto a runtime primitive, not a tool that sleeps.
 *
 * The handler does not block, does not `setTimeout`, and does not return late.
 * It validates the request, checks the ceiling and **arms a barrier on the
 * turn**; the loop honours it at its next suspension point, persists the
 * record and returns. That ordering is the whole difference between this and
 * `await sleep()`: the runtime is released, and a process that dies during the
 * wait loses nothing, because the wait is a row and not a stack frame.
 *
 * ## Why the barrier is armed rather than thrown
 *
 * A model emits several tool calls in one turn. Suspending from inside the
 * handler — by throwing, the way `ApprovalRequired` does — would leave the
 * calls after it in the batch with a `tool_use` block and no `tool_result`,
 * which is a malformed request the next provider call rejects. So the barrier
 * is honoured **between iterations**, after the batch completes: every call
 * gets its result, and the suspension happens at the point the design already
 * proved was clean (`docs/evidence/turno-sospendibile.md` §T3, suspension point 1).
 *
 * It is also the semantics the prior art converged on independently: Hermes's
 * `/goal wait` is *a barrier on the next turn*, and ADR-0035 describes `steer`
 * as injecting after the next tool call without interrupting. Something that
 * has to stop **now** is not `wait` — it is `abort`, which already exists
 * (`input.signal`) and already has the right promise: the work stays owed.
 */

/**
 * `tier: 0`, and the reason is written rather than left to the default.
 *
 * This tool brings no bytes in from anywhere: it reads a number the model
 * already had and writes two columns of our own row. Declared explicitly
 * because `ToolOutcome.tier` is on its way to being mandatory
 * (`slice/taint-in-ingresso`), and a tool whose tier is absent because nobody
 * thought about it is indistinguishable, at the merge, from one whose tier is
 * absent because it is genuinely zero.
 */
const CLEAN: 0 = 0;

export const waitCapability: CapabilityDecl = {
  id: 'turn.wait',
  /**
   * **`3`, and it had to be stated** — the class default would have made this
   * tool unusable in the one case it exists for. Since ADR-0053 the number
   * comes from the `context` row instead of from a pin here, and the argument
   * below is what earns that row.
   *
   * `defaultMaxTaint.medium` was 1 (`core/policy/matrix.ts`), so without a
   * ceiling of 3 the canonical wait — *"leggi la pagina, aspetta un'ora,
   * ricontrolla"* — is denied `taint_exceeded` the moment the page is read. The agent would be
   * able to wait only about things it had not looked at, which is close to
   * never, and the failure would arrive as a refusal the owner reads as a bug.
   *
   * Raising the ceiling here is safe for a reason specific to this capability
   * rather than as a general leniency, and the reason is the whole argument:
   *
   *  - **it exports nothing.** No bytes leave the process, no message is sent,
   *    no file is written. It sets two columns on our own row.
   *  - **it arms nothing outward.** The only barrier it can request is "has
   *    this local pid exited" — a *read* of the host's own process table.
   *  - **waiting buys the turn no privilege.** The resumed turn restores its
   *    taint from the record (ADR-0042), so it comes back exactly as tainted as
   *    it went to sleep. If suspension laundered taint this ceiling would be
   *    the wrong call; it is precisely because it does not that this is safe.
   *
   * The risk class stays `medium`, because that answers a different question —
   * what the call *commits* (a row, a context, a resumed prefix nothing meters
   * yet). Taint ceiling and risk class are two axes and this tool sits at
   * different points on each. See ADR-0047.
   *
   * Since ADR-0053 the three bullets above are not this capability's private
   * argument any more: they are the definition of the `context` row (bytes
   * enter the turn, nothing leaves, nothing on the host changes), declared on
   * the line below. The pin is gone because the row says it for everything
   * shaped like this, which is the point — one capability at a time is how the
   * kernel and the printed matrix drifted apart.
   */
  effect: 'context',
  /**
   * `medium`, not `low`. A wait costs nothing at the moment it is armed and
   * something real afterwards: it holds a row and its whole context, and every
   * resume re-sends the prefix — a turn that waits ten times pays ten prefixes,
   * and the per-turn budget that would measure that does not exist yet
   * (DAY-1 requirement E1). Rated for what it commits to, not for what it does.
   */
  risk: 'medium',
  /**
   * `'yes'`: nothing landed in the world, and the barrier can be cleared by
   * finishing the turn. There is no state outside our own database to undo.
   */
  reversible: 'yes',
  /**
   * **Re-runnable, and the argument is not "it is harmless".**
   *
   * Arming a wait twice does not produce two waits: `suspend` writes `wake_at`
   * and `wait_for` on one row, so the second call overwrites the first. The
   * observable effect of one call and of two identical calls is the same row
   * in the same state — which is the actual test for re-runnability
   * (`fs.write` passes it, sending a message does not).
   *
   * The one asymmetry, stated because it is the sort of thing that gets
   * discovered later: a *re-run* re-computes the deadline from the new `now`,
   * so a wait that is re-armed after a crash ends later than the original
   * would have. It ends, and it ends within the same bound, which is what the
   * declaration promises.
   */
  rerunnable: true,
  resourceKind: 'none',
  policyArgs: ['seconds', 'untilProcessExits'],
  /**
   * Host only, and this is a fail-closed answer to an open question rather
   * than a considered permission.
   *
   * The design records it as unresolved: *"Se il `wait` di un turno di gruppo
   * debba essere permesso affatto"* — a tier-2 member who can arm a persistent
   * wait is a surface the threat model has not examined. Until it is examined,
   * the answer that cannot be wrong is no. The kernel refuses a member here
   * (`decide.ts`) and `visibleTools` keeps it off their menu, so a group turn
   * neither sees it nor could use it.
   *
   * **ADR-0073 punto 5 dà a quella domanda aperta un posto dove ricevere una
   * risposta, una stanza alla volta.** Il `true` qui non si muove: il default
   * resta no, per ogni gruppo che nessuno ha esaminato. Ciò che esiste ora è
   * il modo di dire sì a *questa* stanza — un grant `turn.wait` in `tenants`
   * di una `rot/policy.json` sigillata — che è esattamente la forma che
   * «finché non è esaminato» chiedeva: un esame, scritto, per un caso
   * concreto, non un flag globale.
   *
   * E il punto 5 dice perché non serve altro: un `wait` è del **turno**, e un
   * turno di stanza vive già nella sessione della stanza. Il tetto per tenant
   * dei turni sospesi (`turns`, sopra) conta già per tenant, quindi una
   * stanza non può tenere sospesa la casa dell'owner.
   */
  hostOnly: true,
};

const waitSpec: ToolSpec = {
  name: 'wait',
  description:
    'Suspend this turn and come back later. Use it when the answer genuinely depends on something that has not ' +
    'happened yet (a process to finish, a deadline to arrive). The turn is persisted and the runtime is released ' +
    '— this is not a sleep, and nothing runs in the meantime. `seconds` is required and is the deadline ' +
    `(min ${MIN_WAIT_MS / 1000}s, max ${MAX_WAIT_MS / 1000}s). Optionally also wait for a process to exit ` +
    'with `until_process_exits`; whichever happens first wakes the turn, and you are told which. ' +
    'Not for pacing yourself, and not a substitute for polling a process from shell_run in a loop: if you can do ' +
    'the work now, do it now. Returns nothing itself — the turn resumes and continues from where it left off.',
  inputSchema: {
    type: 'object',
    properties: {
      seconds: {
        type: 'number',
        description: `Deadline in seconds. Required. Between ${MIN_WAIT_MS / 1000} and ${MAX_WAIT_MS / 1000}.`,
      },
      until_process_exits: {
        type: 'number',
        description: 'Optional pid > 1. Wakes as soon as that process is gone, or at the deadline.',
      },
      why: { type: 'string', description: 'One line: what you are waiting for. Shown to the owner.' },
    },
    required: ['seconds'],
  },
};

/**
 * The tool, over the store it needs for one thing only: counting.
 *
 * The ceiling has to be checked against the database — it is "how many rows is
 * this tenant already holding" — and the kernel cannot do it, because
 * `decide` is synchronous and pure by contract and may not read. So it is
 * enforced here, at the boundary, and the refusal names the number: a limit
 * that fails without saying which one it was is a limit debugged by reading
 * source.
 */
export function makeWaitTool(turns: Pick<TurnStore, 'countSuspended'>, now: () => Date = () => new Date()): RegisteredTool {
  return {
    capability: waitCapability.id,
    spec: waitSpec,
    /**
     * `throwTier: 0` (PR #42's `RegisteredTool.throwTier`, landed on `dev`
     * after this file did). The handler is synchronous and every throw it can
     * reach is a SQLite error out of `turns.countSuspended` — this tool's own
     * failure, carrying none of the caller's bytes, the same reasoning `tier:
     * 0` above already gives for every return on the success path.
     */
    throwTier: 0,
    handler: (args, ctx) => {
      const a = (args ?? {}) as { seconds?: unknown; until_process_exits?: unknown; why?: unknown };
      const parsed = parseWait(
        { seconds: a.seconds, untilProcessExits: a.until_process_exits },
        now(),
      );
      if (!parsed.ok) return { content: `wait rifiutato: ${parsed.why}`, isError: true, tier: CLEAN };

      const held = turns.countSuspended(ctx.tenant);
      if (held >= MAX_SUSPENDED_PER_TENANT) {
        return {
          content:
            `wait rifiutato: ci sono già ${held} turni sospesi su questo tenant, il tetto è ` +
            `${MAX_SUSPENDED_PER_TENANT}. Chiudine uno prima di aprirne un altro, o finisci senza aspettare.`,
          isError: true,
          tier: CLEAN,
        };
      }

      // Armed, not executed. The loop reads the barrier at its next suspension
      // point; nothing here waits, and the text below is what the model sees in
      // the transcript *before* the suspension, so it must not claim the wait
      // is over.
      ctx.suspend(parsed.spec);
      // `parseWait` produce solo `process_exit` — una barriera d'approvazione
      // la arma il kernel, mai il modello — ma il tipo porta entrambe, e
      // stringerlo qui è il controllo che lo dice invece di darlo per scontato.
      const attesa = parsed.spec.waitFor;
      const until = attesa?.kind === 'process_exit' ? ` o finché il processo ${attesa.pid} non esce` : '';
      return {
        content: `Attesa armata fino a ${parsed.spec.wakeAt}${until}. Il turno si sospende qui e riprende da solo.`,
        tier: CLEAN,
      };
    },
  };
}
