import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecide } from '../core/policy/decide.js';
import { POLICY_FLOOR } from '../core/policy/matrix.js';
import type { CapabilityDecl, Principal } from '../core/policy/types.js';
import { SessionStore } from '../core/session/store.js';
import { TurnStore } from '../core/turns/store.js';
import { TodoStore } from '../core/turns/todo.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { makeWaitTool, waitCapability } from './tools/wait.js';
import { resumeTurn, runTurn, MAX_RESUMES, type LoopDeps, type RegisteredTool } from './loop.js';
import { CONSERVATIVE } from './profiles/profile.js';
import type { ChatCall, ChatResult, Message, Provider, StreamEvent } from './providers/types.js';

/**
 * A turn that releases the runtime, and comes back.
 *
 * The three properties here are the ones the design priced as expensive if
 * wrong, and two of them fail **silently**:
 *
 *  - **the runtime is released.** `runTurn` returns. If it instead awaited a
 *    timer, every assertion about the row would still pass and the process
 *    would be held for the length of the wait — the difference requirements-status.md#wait-e-todo-sono-primitive-del-runtime-non-tool calls
 *    the one between a Muffin that lives and a Muffin launched from a terminal.
 *  - **the taint comes off the row.** A resume that rebuilt it from the
 *    principal would restart at tier 0 a turn that had already read the web.
 *    Nothing errors; the agent is simply allowed to do something it was not.
 *  - **the model is pinned.** Thinking signatures belong to the model that
 *    produced them, and ADR-0037 records that sending them elsewhere makes no
 *    noise at all — the symptom is a worse agent.
 */

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  calls = 0;
  readonly seen: ChatCall[] = [];
  constructor(private readonly script: ChatResult[]) {}
  async chat(request: ChatCall): Promise<ChatResult> {
    this.seen.push({ ...request, messages: [...request.messages] });
    const next = this.script[this.calls++];
    if (!next) throw new Error('lo script è finito');
    return next;
  }
  /**
   * Solo per il test §4.3 qui sotto: `agent/loop.ts` chiede `chatStream`
   * (`stream: Boolean(input.onDelta && deps.provider.chatStream)`) **solo**
   * quando qualcuno ha attaccato un `onDelta` — nessun altro test di questo
   * file lo fa, quindi per loro questo metodo non cambia niente. Due metà, non
   * un unico chunk: senza, un turno che stream-a non si distinguerebbe da uno
   * che non lo fa nel momento in cui si concatenano i delta.
   */
  async *chatStream(request: ChatCall): AsyncIterable<StreamEvent> {
    const result = await this.chat(request);
    if (result.text) {
      const meta = Math.ceil(result.text.length / 2);
      yield { type: 'text_delta', text: result.text.slice(0, meta) };
      yield { type: 'text_delta', text: result.text.slice(meta) };
    }
    yield { type: 'done', result };
  }
}

const answer = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  stopReason: 'end',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'test',
});

const call = (name: string, args: unknown = {}, id = 'c1'): ChatResult => ({
  text: null,
  toolCalls: [{ id, name, args }],
  stopReason: 'tool_use',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'test',
});

const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };
const NOW = () => new Date('2026-08-16T10:00:00.000Z');

/** A tool that says it dragged the web in, so the taint has somewhere to climb to. */
const webCapability: CapabilityDecl = {
  id: 'net.http',
  effect: 'context',
  // era il default della classe: la riga 'context' non lo eredita più
  maxTaint: 1,
  risk: 'medium',
  reversible: 'yes',
  rerunnable: true,
  resourceKind: 'none',
  policyArgs: [],
  hostOnly: false,
};

/** A tool that must never be repeated. The whole point of `rerunnable: false`. */
const sendCapability: CapabilityDecl = {
  id: 'outward.send',
  effect: 'context',
  risk: 'low',
  reversible: 'no',
  rerunnable: false,
  resourceKind: 'none',
  policyArgs: [],
  hostOnly: false,
};

function world(
  script: ChatResult[],
  over: Partial<LoopDeps> = {},
): {
  deps: LoopDeps;
  turns: TurnStore;
  provider: Scripted;
  sessions: SessionStore;
  sends: number;
  crash: (turnId: string, patch: { messages?: Message[]; resumes?: number }) => void;
} {
  const home = mkdtempSync(join(tmpdir(), 'muffin-suspend-'));
  const db = new DatabaseCtor(':memory:');
  const turns = new TurnStore(db);
  const provider = new Scripted(script);
  const sessions = new SessionStore(home);
  const state = { sends: 0 };

  const decls = [waitCapability, webCapability, sendCapability];
  const tools: RegisteredTool[] = [
    makeWaitTool(turns, NOW),
    {
      capability: webCapability.id,
      spec: { name: 'http_get', description: 'fetch', inputSchema: { type: 'object', properties: {} } },
      throwTier: 0,
      handler: () => ({ content: 'la pagina dice X', tier: 3 as const }),
    },
    {
      capability: sendCapability.id,
      spec: { name: 'send_message', description: 'send', inputSchema: { type: 'object', properties: {} } },
      throwTier: 0,
      handler: () => {
        state.sends += 1;
        return { content: 'inviato', tier: 0 as const };
      },
    },
  ];

  const deps: LoopDeps = {
    provider,
    profile: CONSERVATIVE,
    model: 'test-model',
    tools,
    capabilities: new Map(decls.map((d) => [d.id, d])),
    decide: createDecide({
      matrix: POLICY_FLOOR,
      capabilities: new Map(decls.map((d) => [d.id, d])),
      budgetExhausted: () => false,
      hardened: true,
    }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions,
    turns,
    todos: new TodoStore(db),
    budgetExhausted: () => false,
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite.' },
    now: NOW,
    ...over,
  };
  return {
    deps,
    turns,
    provider,
    sessions,
    get sends() {
      return state.sends;
    },
    /**
     * Put a row into the state a crash leaves, with SQL and not with the store.
     *
     * Deliberately raw: `TurnStore` has **no** writer that can move a row into
     * `interrupted` from outside `reclaim`, and that is correct — a store with
     * a "force this status" method is a store whose guards can be walked
     * around. A test that needs the post-crash state has to build it the way a
     * dead process would leave it, and saying so here is cheaper than adding a
     * back door to production for the sake of a fixture.
     */
    crash: (turnId, patch) => {
      const row = turns.get(turnId)!;
      db.prepare(
        // `wait_for`/`wake_at` a NULL, e non e un dettaglio: in produzione una
        // riga arriva a `interrupted` solo da `reclaim`, che agisce su una riga
        // `running` — e una riga `running` la barriera non ce l'ha piu, perche
        // `claim` la spegne appena la prende. Lasciarla qui costruiva uno stato
        // che la produzione non sa produrre, e faceva leggere il crash come un
        // risveglio voluto.
        `UPDATE turns SET status = 'interrupted', claimed_by = NULL, wait_for = NULL, wake_at = NULL,
                          messages = @messages, counters = @counters
         WHERE id = @id`,
      ).run({
        id: turnId,
        messages: JSON.stringify(patch.messages ?? row.messages),
        counters: JSON.stringify({ ...row.counters, ...(patch.resumes === undefined ? {} : { resumes: patch.resumes }) }),
      });
    },
  };
}

/** The transcript up to the unanswered batch — where a mid-batch crash stops. */
function beforeTheResults(messages: Message[]): Message[] {
  const at = messages.findIndex((m) => m.content.some((b) => b.type === 'tool_result'));
  return at === -1 ? messages : messages.slice(0, at);
}

const start = (w: ReturnType<typeof world>, text = 'aspetta e poi dimmelo') => ({
  principal: owner,
  tenant: 'host' as const,
  surface: 'cli',
  session: w.sessions.open('sospensione'),
  text,
});

/** Every piece of text the model was sent in a given request. */
const prompt = (c: ChatCall | undefined): string =>
  (c?.messages ?? [])
    .flatMap((m) => m.content)
    .map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? b.content : ''))
    .join('\n');

describe('un turno che aspetta rilascia il runtime', () => {
  it('torna subito con stopped:suspended, e la riga dice waiting', async () => {
    const w = world([call('wait', { seconds: 3600 }), answer('non dovrebbe arrivarci')]);

    const started = Date.now();
    const result = await runTurn(w.deps, start(w));
    const elapsed = Date.now() - started;

    // The half that distinguishes this from `await sleep()`. An hour-long wait
    // that held the runtime would make this number an hour.
    expect(elapsed).toBeLessThan(1000);
    expect(result.stopped).toBe('suspended');
    expect(result.suspendedUntil?.wakeAt).toBe('2026-08-16T11:00:00.000Z');
    expect(result.text).toBe('');

    const row = w.turns.get(result.turnId)!;
    expect(row.status).toBe('waiting');
    expect(row.wakeAt).toBe('2026-08-16T11:00:00.000Z');
    // The claim is released in the same statement. A suspended row that kept a
    // pid would be reclaimed as *interrupted* the moment that process exited —
    // every wait outliving its process reported as a crash.
    expect(row.claimedBy).toBeNull();
    // Not an ending: `turn_outcome` stays empty, because the turn has not ended.
    expect(row.outcome).toBeNull();
  });

  it('non chiama più il modello dopo la sospensione', async () => {
    const w = world([call('wait', { seconds: 3600 }), answer('mai')]);
    await runTurn(w.deps, start(w));
    // One call: the one that asked to wait. A loop that kept iterating would
    // have burned the second script entry.
    expect(w.provider.calls).toBe(1);
  });

  it('la sospensione avviene fra un batch e l’altro, mai dentro', async () => {
    // A model emits several calls in one turn. Suspending from inside the
    // handler would leave the calls after it with a `tool_use` and no
    // `tool_result` — a malformed request the next provider call rejects.
    const w = world([
      {
        text: null,
        toolCalls: [
          { id: 'a', name: 'wait', args: { seconds: 3600 } },
          { id: 'b', name: 'http_get', args: {} },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: 'test',
      },
      answer('mai'),
    ]);
    const result = await runTurn(w.deps, start(w));
    expect(result.stopped).toBe('suspended');

    const row = w.turns.get(result.turnId)!;
    const results = row.messages
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'tool_result')
      .map((b) => (b.type === 'tool_result' ? b.toolCallId : ''));
    // Both calls got their result before anything suspended.
    expect(results).toEqual(['a', 'b']);
  });

  it('un wait rifiutato non sospende niente: il turno continua', async () => {
    const w = world([call('wait', { seconds: 2 }), answer('allora faccio subito')]);
    const result = await runTurn(w.deps, start(w));
    expect(result.stopped).toBe('answered');
    expect(result.text).toBe('allora faccio subito');
    expect(w.turns.get(result.turnId)?.status).toBe('done');
  });
});

describe('e poi torna', () => {
  it('riprende dove era, e sa da cosa è stato svegliato', async () => {
    const w = world([call('wait', { seconds: 3600 }), answer('ecco, adesso te lo dico')]);
    const first = await runTurn(w.deps, start(w));

    const resumed = await resumeTurn(w.deps, first.turnId);
    expect('why' in resumed).toBe(false);
    expect(!('why' in resumed) && resumed.stopped).toBe('answered');
    expect(!('why' in resumed) && resumed.text).toBe('ecco, adesso te lo dico');

    // Told which barrier ended the wait, because "the process exited" and "you
    // ran out of time" lead to different next moves.
    expect(prompt(w.provider.seen[1])).toMatch(/Attesa finita/);
    // Same row, same identity: "what did it do" and "why" stay one join.
    expect(!('why' in resumed) && resumed.turnId).toBe(first.turnId);
    expect(w.turns.get(first.turnId)?.status).toBe('done');
  });

  it(
    'porta i delta e il progress fino al chiamante di resumeTurn — la ' +
      'riparazione di docs/evidence/forma-delle-superfici-2026-09-03.md §4.3',
    async () => {
      // Prima di quella riparazione `resumeTurn` ignorava del tutto un terzo
      // argomento — non esisteva nemmeno — e un turno ripreso non aveva modo
      // di far arrivare `onDelta`/`onProgress` a chi lo aveva rimesso in moto:
      // per il tratto fra la sospensione e la risposta finale, niente
      // streaming. Questo test prova la wiring, non l'intenzione: mutare la
      // chiamata a `drive(...)` dentro `resumeTurn` per non passare più
      // `stream.onDelta`/`stream.onProgress` lo fa fallire.
      const w = world([call('wait', { seconds: 3600 }), answer('ecco, adesso te lo dico')]);
      const first = await runTurn(w.deps, start(w));

      const deltas: string[] = [];
      const progressTypes: string[] = [];
      const resumed = await resumeTurn(w.deps, first.turnId, {
        onDelta: (d) => {
          if (d.type === 'text') deltas.push(d.text);
        },
        onProgress: (e) => {
          progressTypes.push(e.type);
        },
      });

      expect('why' in resumed).toBe(false);
      expect(!('why' in resumed) && resumed.stopped).toBe('answered');
      // La risposta del giro ripreso è arrivata anche come delta — non solo
      // nel risultato finale, che il codice vecchio produceva comunque.
      expect(deltas.join('')).toBe('ecco, adesso te lo dico');
      // E il fatto che un giro sia partito è arrivato come progress, esattamente
      // come per un turno fresco.
      expect(progressTypes).toContain('round');
      expect(progressTypes).toContain('model');
    },
  );

  it('conta le riprese sulla riga, non nel processo che muore', async () => {
    // Un **crash**, non un `wait`: il contatore conta le recovery, e provarlo
    // con un risveglio voluto provava la cosa sbagliata. La riga di prima
    // aspettava e poi asseriva 1, che e esattamente il difetto per cui un
    // turno che aspetta quattro volte moriva col messaggio dei crash
    // (`agent/resume-checkpoint-budget.test.ts`). Il titolo — dove vive il
    // contatore — resta vero, e adesso e provato dal caso che lo riguarda.
    const w = world([call('wait', { seconds: 3600 }), answer('fatto')]);
    const first = await runTurn(w.deps, start(w));
    expect(w.turns.get(first.turnId)?.counters.resumes).toBe(0);

    // Il processo muore: la riga torna `interrupted`, senza barriera.
    w.crash(first.turnId, {});
    await resumeTurn(w.deps, first.turnId);
    expect(w.turns.get(first.turnId)?.counters.resumes).toBe(1);
  });

  it('si ferma dopo tre riprese invece di riprovare a ogni boot', async () => {
    const w = world([call('wait', { seconds: 3600 })]);
    const first = await runTurn(w.deps, start(w));

    // The bound exists because the failure it guards is one the record makes
    // *more* likely: a turn whose resume kills the process would be retried by
    // every boot for ever, and the process that dies is never the one counting.
    // Three crashes, which is what three failed resumes are.
    w.crash(first.turnId, { resumes: MAX_RESUMES });

    const refused = await resumeTurn(w.deps, first.turnId);
    expect('why' in refused && refused.why).toBe('exhausted');
    // Closed, not left to be picked up again.
    expect(w.turns.get(first.turnId)?.status).toBe('done');
  });

  it('rifiuta la ripresa su un modello diverso, e lo dice', async () => {
    const w = world([call('wait', { seconds: 3600 })]);
    const first = await runTurn(w.deps, start(w));

    const refused = await resumeTurn({ ...w.deps, model: 'un-altro-modello' }, first.turnId);
    expect('why' in refused && refused.why).toBe('model_changed');
    expect('why' in refused && refused.detail).toMatch(/ADR-0037/);
    // Terminal: a row that woke every boot to be refused again is the
    // silent-forever failure the record exists to stop producing.
    expect(w.turns.get(first.turnId)?.status).toBe('done');
    // And the reason is in the transcript, so the surface has something to say.
    expect(JSON.stringify(w.turns.get(first.turnId)?.messages)).toMatch(/non è un resume/);
  });

  it('dice di no a un turno già chiuso e a uno che non esiste', async () => {
    const w = world([answer('fatto')]);
    const done = await runTurn(w.deps, start(w));
    expect('why' in (await resumeTurn(w.deps, done.turnId)) && 'finished').toBe('finished');
    const missing = await resumeTurn(w.deps, 'non-esiste');
    expect('why' in missing && missing.why).toBe('not_found');
  });
});

describe('la taint viene dalla riga, non dal principal', () => {
  /**
   * The assertion is on what the resumed turn is **allowed to do**, not on what
   * the row says.
   *
   * The first version of this test read `turns.get(id).taint` after the resume
   * and called it proof. It was not: that column is written by `endToolCall`
   * with `max()`, so it says 3 whether or not the resume ever restored
   * anything — and mutating `makeSnapshot(…, record.taint)` to
   * `makeSnapshot(…, 0)` left the whole suite green. A test that survives the
   * removal of the thing it is named after is measuring something else.
   *
   * So the resumed turn calls a capability whose ceiling is **below** the taint
   * it climbed to. If the snapshot came back off the row, the kernel refuses it
   * `taint_exceeded`. If it were rebuilt from the principal, the same call is
   * allowed — which is the fetch-then-act pattern reopened by a new door, and
   * it fails loudly here instead of quietly in production.
   */
  it('il turno ripreso GIRA alla taint che aveva raggiunto, e il kernel lo dimostra', async () => {
    const w = world([
      call('http_get', {}, 'h1'),
      call('wait', { seconds: 3600 }, 'w1'),
      // …resume happens here…
      call('http_get', {}, 'h2'),
      answer('non posso più leggere: sono sporco da prima di addormentarmi'),
    ]);

    const first = await runTurn(w.deps, start(w));
    // The wait really armed — without this the rest would be asserting about a
    // turn that simply ran to the end.
    expect(first.stopped).toBe('suspended');
    expect(w.turns.get(first.turnId)?.status).toBe('waiting');
    expect(w.turns.get(first.turnId)?.taint).toBe(3);

    const resumed = await resumeTurn(w.deps, first.turnId);
    expect('why' in resumed).toBe(false);

    // 1. The kernel's own answer, on the resumed turn's second fetch. `net.http`
    //    is medium risk with no `maxTaint`, so its ceiling is 1: at taint 3 this
    //    is a refusal, at taint 0 it is an allow.
    const afterWaking = prompt(w.provider.seen[w.provider.seen.length - 1]);
    expect(afterWaking).toMatch(/Rifiutato dal kernel dei permessi \(taint_exceeded\)/);
    // And it says why, in the kernel's own words, instead of promising an
    // owner decision that does not exist for a crossed ceiling (episode 310
    // of the owner's database: the model turned that promise into «è la
    // policy, non un bug»).
    expect(afterWaking).toMatch(/context taint 3 exceeds 1 for net\.http/);
    expect(afterWaking).not.toMatch(/serve una decisione dell'owner/);

    // 2. And the value the turn reports, which is the same snapshot read from
    //    the other end.
    expect(!('why' in resumed) && resumed.taint).toBe(3);
  });

  it('un turno pulito che riprende resta pulito — il ripristino non sporca per sicurezza', async () => {
    // The other direction. Without it the assertion above would pass on a
    // resume that simply started everything at tier 3.
    const w = world([call('wait', { seconds: 3600 }, 'w1'), call('http_get', {}, 'h1'), answer('letto')]);
    const first = await runTurn(w.deps, start(w));
    expect(first.stopped).toBe('suspended');

    const resumed = await resumeTurn(w.deps, first.turnId);
    expect(!('why' in resumed) && resumed.stopped).toBe('answered');
    // The fetch went through, so the resumed turn really was at 0 when it ran.
    expect(prompt(w.provider.seen[w.provider.seen.length - 1])).toContain('la pagina dice X');
  });
});

describe('una chiamata in volo quando il processo muore', () => {
  it('non si rifà se non è dichiarata ri-eseguibile, e lo dice', async () => {
    const w = world([call('send_message', {}, 'm1'), answer('dopo'), answer('ripreso')]);
    const first = await runTurn(w.deps, start(w));
    expect(w.sends).toBe(1);

    // The state a crash between "the handler was called" and "the outcome came
    // back" really leaves: an intent row with no outcome, and a transcript
    // ending on the unanswered `tool_use`. The intent row is written by a
    // *second* call id, so the recorded outcome of `m1` cannot be what saves
    // this — the assertion below is about `rerunnable`, not about replay.
    const row = w.turns.get(first.turnId)!;
    const truncated = beforeTheResults(row.messages).map((m) => ({
      ...m,
      content: m.content.map((b) => (b.type === 'tool_use' ? { ...b, id: 'm2' } : b)),
    }));
    w.crash(first.turnId, { messages: truncated });
    w.turns.startToolCall(first.turnId, {
      callId: 'm2',
      tool: 'send_message',
      capability: sendCapability.id,
      rerunnable: false,
      args: {},
    });

    const resumed = await resumeTurn(w.deps, first.turnId);
    expect('why' in resumed).toBe(false);
    // The whole property, in one number: the message was NOT sent a second time.
    expect(w.sends).toBe(1);
    // And the model is told the truth — never that it did not happen.
    const repaired = prompt(w.provider.seen[w.provider.seen.length - 1]);
    expect(repaired).toMatch(/non è possibile sapere se ha avuto effetto/);
    expect(repaired).toMatch(/Non l'ho rifatta/);
  });

  it('rigioca l’esito registrato invece di richiamare l’handler', async () => {
    const w = world([call('send_message', {}, 'm1'), answer('dopo'), answer('ripreso')]);
    const first = await runTurn(w.deps, start(w));
    expect(w.sends).toBe(1);

    // This time the outcome *was* recorded — the crash happened after it. A
    // resume replays it: Temporal's property in our own words, "during replay
    // that result is reused, not recomputed".
    w.crash(first.turnId, { messages: beforeTheResults(w.turns.get(first.turnId)!.messages) });

    await resumeTurn(w.deps, first.turnId);
    expect(w.sends).toBe(1);
    expect(prompt(w.provider.seen[w.provider.seen.length - 1])).toContain('inviato');
  });
});
