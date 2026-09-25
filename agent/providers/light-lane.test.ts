import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_LIGHT_TRANSPORT_RETRIES } from '../loop/types.js';
import { CONSERVATIVE, DEFAULT_EXECUTION, loadProfiles, selectProfile, type Profile } from '../profiles/profile.js';
import { lightLane, LightRequestDeadlineError, type LightAttemptReport, type LightSpend } from './light-lane.js';
import { ProviderError, type ChatCall, type ChatResult, type Provider } from './types.js';

/**
 * The boundary the memory lane never had.
 *
 * Three things the loop does around every model call — bill it, own transport
 * retries, and send only the sampling parameter the model accepts — reached
 * only the main lane. `core/memory/{extract,judge,rerank}.ts` are a second
 * entry point to the same provider and need all three at this boundary.
 */

class Echo implements Provider {
  readonly kind = 'openai-compat' as const;
  readonly seen: ChatCall[] = [];
  async chat(call: ChatCall): Promise<ChatResult> {
    this.seen.push(call);
    return {
      text: 'ok',
      toolCalls: [],
      stopReason: 'end',
      usage: { inputTokens: 11, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1 },
      model: 'claude-haiku-4-5-20251001',
    };
  }
}

const call = (over: Partial<ChatCall> = {}): ChatCall => ({
  model: 'light',
  system: [{ type: 'text', text: 's' }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
  maxOutputTokens: 500,
  temperature: 0,
  stream: false,
  ...over,
});

const ok = (): ChatResult => ({
  text: 'ok',
  toolCalls: [],
  stopReason: 'end',
  usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'light-served',
});

afterEach(() => vi.restoreAllMocks());

describe('billing the light lane', () => {
  it('records what the call cost, with the model the provider actually served', async () => {
    const inner = new Echo();
    const billed: LightSpend[] = [];
    const lane = lightLane(inner, { profile: CONSERVATIVE, record: (e) => billed.push(e) });

    await lane.chat(call());

    expect(billed).toEqual([
      {
        // Not `call.model` ('light'): the price table is keyed on what served
        // the request, and the two differ on every alias.
        model: 'claude-haiku-4-5-20251001',
        inputTokens: 11,
        outputTokens: 3,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
      },
    ]);
  });

  it('bills nothing for a call that threw — a failure is not a charge', async () => {
    const billed: LightSpend[] = [];
    const lane = lightLane(
      {
        kind: 'anthropic',
        chat: async () => {
          throw new Error('502');
        },
      },
      { profile: CONSERVATIVE, record: (e) => billed.push(e) },
    );
    await expect(lane.chat(call())).rejects.toThrow('502');
    expect(billed).toEqual([]);
  });

  it('porta il job nella riga di spesa quando la chiamata ne dichiara uno', async () => {
    const billed: LightSpend[] = [];
    const lane = lightLane(new Echo(), { profile: CONSERVATIVE, record: (e) => billed.push(e) });

    await lane.chat(call({ jobId: 'job-42' }));

    expect(billed).toHaveLength(1);
    expect(billed[0]!.jobId).toBe('job-42');
  });

  it('non inventa un job quando la chiamata non ne dichiara uno', async () => {
    const billed: LightSpend[] = [];
    const lane = lightLane(new Echo(), { profile: CONSERVATIVE, record: (e) => billed.push(e) });

    await lane.chat(call());

    // Assente, non `undefined` esplicito: `LightSpend` non ha un default da cui
    // dedurre un job, e una corsia che ne inventasse uno attribuirebbe a un job
    // una spesa che non è sua.
    expect(billed).toHaveLength(1);
    expect('jobId' in billed[0]!).toBe(false);
  });
});

describe('transport retry ownership', () => {
  it('retries a transient transport failure twice, then bills the one successful logical call', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let attempts = 0;
    const billed: LightSpend[] = [];
    const lane = lightLane(
      {
        kind: 'openai-compat',
        chat: async () => {
          attempts += 1;
          if (attempts <= MAX_LIGHT_TRANSPORT_RETRIES) {
            throw new ProviderError('502', true, 502, 'transport');
          }
          return ok();
        },
      },
      { profile: CONSERVATIVE, record: (e) => billed.push(e) },
    );

    await expect(lane.chat(call())).resolves.toMatchObject({ text: 'ok' });
    expect(attempts).toBe(MAX_LIGHT_TRANSPORT_RETRIES + 1);
    expect(billed).toHaveLength(1);
  });

  it('stops after the bounded transport budget instead of multiplying attempts below the lane', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let attempts = 0;
    const lane = lightLane(
      {
        kind: 'anthropic',
        chat: async () => {
          attempts += 1;
          throw new ProviderError('429', true, 429, 'transport');
        },
      },
      { profile: CONSERVATIVE },
    );

    await expect(lane.chat(call())).rejects.toThrow('429');
    expect(attempts).toBe(MAX_LIGHT_TRANSPORT_RETRIES + 1);
  });

  it('never retries malformed model output even when the adapter marks it retryable', async () => {
    let attempts = 0;
    const lane = lightLane(
      {
        kind: 'openai-compat',
        chat: async () => {
          attempts += 1;
          throw new ProviderError('malformed tool arguments', true, undefined, 'output');
        },
      },
      { profile: CONSERVATIVE },
    );

    await expect(lane.chat(call())).rejects.toThrow('malformed tool arguments');
    expect(attempts).toBe(1);
  });

  it('never retries a permanent transport refusal', async () => {
    let attempts = 0;
    const lane = lightLane(
      {
        kind: 'openai-compat',
        chat: async () => {
          attempts += 1;
          throw new ProviderError('401', false, 401, 'transport');
        },
      },
      { profile: CONSERVATIVE },
    );

    await expect(lane.chat(call())).rejects.toThrow('401');
    expect(attempts).toBe(1);
  });

  it('an abort during the failed attempt cancels the backoff and no second wire attempt starts', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const lane = lightLane(
      {
        kind: 'openai-compat',
        chat: async () => {
          attempts += 1;
          controller.abort('owner-stop');
          throw new ProviderError('502', true, 502, 'transport');
        },
      },
      { profile: CONSERVATIVE },
    );

    await expect(lane.chat(call({ signal: controller.signal }))).rejects.toThrow('502');
    expect(attempts).toBe(1);
  });
});

describe('sampling, which no profile edit could reach', () => {
  it('keeps temperature for a model whose profile says deterministic', async () => {
    const inner = new Echo();
    await lightLane(inner, { profile: CONSERVATIVE }).chat(call());
    expect(inner.seen[0]?.temperature).toBe(0);
  });

  /**
   * The failure this prevents, in production terms: `--light-model` pointed at
   * anything from Opus 4.7 onward would 400 on **every consolidation**, and now
   * that consolidation runs unattended the failure is a memory that silently
   * stops filling. The three memory files hardcode `temperature: 0` outside the
   * profile system, so nothing in `agent/profiles/*` could have corrected it.
   */
  it('drops it — the key, not just the value — when the model refuses one', async () => {
    const inner = new Echo();
    const frontier = selectProfile('claude-opus-4-7', loadProfiles());
    expect(frontier.sampling).toBe('model-default');

    await lightLane(inner, { profile: frontier }).chat(call());
    // `in`, not `=== undefined`: an explicit undefined can still be serialised
    // as a key, and a present key is exactly what the model rejects.
    expect('temperature' in (inner.seen[0] ?? {})).toBe(false);
  });

  it('leaves a call that never asked for a temperature alone', async () => {
    const inner = new Echo();
    const frontier = selectProfile('claude-opus-4-7', loadProfiles());
    const bare = call();
    delete bare.temperature;
    await lightLane(inner, { profile: frontier }).chat(bare);
    // The lane attaches its logical-request signal to every attempt (#497);
    // that is the deadline owner's business, not sampling's: compare the
    // payload without it.
    const { signal: _segnale, ...visto } = inner.seen[0] ?? {};
    expect(visto).toEqual(bare);
  });
});

describe('honoring the provider-declared wait', () => {
  it('waits out the server Retry-After instead of the blind backoff (#496)', async () => {
    // Backoff azzerato (random 0): se la corsia onora la finestra del server,
    // l'unica attesa possibile è quella dichiarata dal provider.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let attempts = 0;
    const lane = lightLane(
      {
        kind: 'openai-compat',
        chat: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new ProviderError(
              '429 lento',
              true,
              429,
              'transport',
              400,
            );
          }
          return ok();
        },
      },
      { profile: CONSERVATIVE },
    );

    const started = Date.now();
    await expect(lane.chat(call())).resolves.toMatchObject({ text: 'ok' });
    // Soglia sotto i 400ms dichiarati: i timer anticipano, non posticipano —
    // sotto carico l'attesa cresce, mai il contrario.
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(attempts).toBe(2);
  });
});

/** Profilo leggero con sola lifetime logica della richiesta da `ms`. */
function corsiaConLifetime(ms: number): Profile {
  return { ...CONSERVATIVE, execution: { ...DEFAULT_EXECUTION, turnWallDeadlineMs: ms } };
}

function fallisciUnaVoltaPoi(messaggio: string, retryAfterMs: number, dopo: () => ChatResult) {
  let tentativi = 0;
  const inner = {
    kind: 'openai-compat',
    chat: async () => {
      tentativi += 1;
      if (tentativi === 1) throw new ProviderError(messaggio, true, 429, 'transport', retryAfterMs);
      return dopo();
    },
    tentativi: () => tentativi,
  } as unknown as Provider & { tentativi: () => number };
  return inner;
}

/**
 * La richiesta logica leggera ha una lifetime propria (#497): presa dalla
 * `execution` del profilo leggero — mai da quello main, mai da un governatore
 * condiviso, mai dalla ModelLane (questi test costruiscono la corsia sopra un
 * finto diretto, senza nient'altro).
 */
describe('la lifetime logica della richiesta leggera (#497)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('Retry-After sotto la lifetime: ritenta e risponde', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const inner = fallisciUnaVoltaPoi('429 lento', 300, ok);
    const lane = lightLane(inner, { profile: corsiaConLifetime(5000) });
    const promessa = lane.chat(call());
    const attesa = expect(promessa).resolves.toMatchObject({ text: 'ok' });
    await vi.advanceTimersByTimeAsync(2000);
    await attesa;
    expect(inner.tentativi()).toBe(2);
  });

  it('Retry-After oltre la lifetime: nessun secondo tentativo, errore non-retryable', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const inner = fallisciUnaVoltaPoi('429 lungo', 10_000, ok);
    const lane = lightLane(inner, { profile: corsiaConLifetime(300) });
    const promessa = lane.chat(call());
    const attesa = expect(promessa).rejects.toThrow(/deadline/);
    // Oltre la finestra intera: senza lifetime il secondo tentativo
    // partirebbe qui e la promessa si risolverebbe invece di rigettare.
    await vi.advanceTimersByTimeAsync(15_000);
    await attesa;
    expect(inner.tentativi()).toBe(1);
    const errore = await promessa.then(
      () => null,
      (e: unknown) => e,
    );
    // Una scadenza di esecuzione di Muffin, non un fallimento del provider:
    // distinguibile per programma da transport/output, mai retryable, mai
    // confusa con l'abort del chiamante. Se la scadenza tornasse a essere un
    // ProviderError, entrambe le asserzioni di istanza fallirebbero.
    expect(errore).toBeInstanceOf(LightRequestDeadlineError);
    expect(errore).not.toBeInstanceOf(ProviderError);
    expect((errore as LightRequestDeadlineError).reason).toBe('light_request_deadline');
    // Non riclassificato come fallimento di trasporto: nessun chiamante deve
    // ripetere una richiesta la cui lifetime è già finita.
    expect((errore as LightRequestDeadlineError).retryable).toBe(false);
  });

  it("l'abort del chiamante vince subito, senza aspettare la finestra", async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const controller = new AbortController();
    const inner = fallisciUnaVoltaPoi('429 lento', 5000, ok);
    const lane = lightLane(inner, { profile: corsiaConLifetime(60_000) });
    const promessa = lane.chat(call({ signal: controller.signal }));
    const attesa = expect(promessa).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(50);
    controller.abort();
    await vi.advanceTimersByTimeAsync(50);
    await attesa;
    expect(inner.tentativi()).toBe(1);
  });

  it('profili leggeri diversi, limiti diversi — indipendente dal main', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const stretta = fallisciUnaVoltaPoi('429 lungo', 5000, ok);
    const larga = fallisciUnaVoltaPoi('429 lungo', 5000, ok);
    const laneStretta = lightLane(stretta, { profile: corsiaConLifetime(200) });
    const laneLarga = lightLane(larga, { profile: corsiaConLifetime(60_000) });
    const pStretta = laneStretta.chat(call());
    const pLarga = laneLarga.chat(call());
    const attesaStretta = expect(pStretta).rejects.toThrow(/deadline/);
    const attesaLarga = expect(pLarga).resolves.toMatchObject({ text: 'ok' });
    await vi.advanceTimersByTimeAsync(10_000);
    await attesaStretta;
    await attesaLarga;
    expect(stretta.tentativi()).toBe(1);
    expect(larga.tentativi()).toBe(2);
    const erroreStretta = await pStretta.then(
      () => null,
      (e: unknown) => e,
    );
    expect(erroreStretta).toBeInstanceOf(LightRequestDeadlineError);
    expect(erroreStretta).not.toBeInstanceOf(ProviderError);
  });
});

describe('il conteggio dei tentativi fisici (#496)', () => {
  it('ogni tentativo partito è riportato, anche se la richiesta fallisce', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const visti: LightAttemptReport[] = [];
    const lane = lightLane(
      {
        kind: 'openai-compat',
        chat: async () => {
          throw new ProviderError('502 stanco', true, 502, 'transport');
        },
      },
      { profile: CONSERVATIVE, onAttempt: (a) => visti.push(a) },
    );
    await expect(lane.chat(call())).rejects.toThrow('502 stanco');
    // Due retry = tre tentativi fisici, tutti riportati: la prova esiste
    // anche se la spesa non registra niente (nessun addebito sul fallimento).
    // Stessa richiesta logica per tutti: un solo requestId.
    expect(visti.map(({ attempt, model }) => ({ attempt, model }))).toEqual([
      { attempt: 1, model: 'light' },
      { attempt: 2, model: 'light' },
      { attempt: 3, model: 'light' },
    ]);
    const richieste = new Set(visti.map((v) => v.requestId));
    expect(richieste.size).toBe(1);
    expect([...richieste][0]).toMatch(/^[0-9a-f-]{10,}$/);
  });

  it('successo al secondo tentativo: due riporti, una spesa', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const visti: LightAttemptReport[] = [];
    const spese: LightSpend[] = [];
    let tentativi = 0;
    const lane = lightLane(
      {
        kind: 'openai-compat',
        chat: async () => {
          tentativi += 1;
          if (tentativi === 1) throw new ProviderError('429 lento', true, 429, 'transport', 10);
          return ok();
        },
      },
      { profile: CONSERVATIVE, onAttempt: (a) => visti.push(a), record: (e) => spese.push(e) },
    );
    await expect(lane.chat(call())).resolves.toMatchObject({ text: 'ok' });
    expect(visti.map(({ attempt, model }) => ({ attempt, model }))).toEqual([
      { attempt: 1, model: 'light' },
      { attempt: 2, model: 'light' },
    ]);
    expect(new Set(visti.map((v) => v.requestId)).size).toBe(1);
    expect(spese).toHaveLength(1);
  });

  it('deadline prima del secondo tentativo: solo il primo è riportato', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const visti: LightAttemptReport[] = [];
      const lane = lightLane(
        {
          kind: 'openai-compat',
          chat: async () => {
            throw new ProviderError('429 lungo', true, 429, 'transport', 10_000);
          },
        },
        {
          profile: { ...CONSERVATIVE, execution: { ...DEFAULT_EXECUTION, turnWallDeadlineMs: 300 } },
          onAttempt: (a) => visti.push(a),
        },
      );
      const promessa = lane.chat(call());
      const attesa = expect(promessa).rejects.toThrow(/deadline/);
      await vi.advanceTimersByTimeAsync(2000);
      await attesa;
      // Il secondo tentativo non è mai partito: giusto non riportarlo.
      expect(visti.map(({ attempt, model }) => ({ attempt, model }))).toEqual([
        { attempt: 1, model: 'light' },
      ]);
      expect(new Set(visti.map((v) => v.requestId)).size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('due richieste concorrenti si raggruppano per requestId', async () => {
    // A fallisce una volta e ritenta (1,2), B riesce subito (1): i riporti
    // si intercalano, ma ogni requestId ricostruisce la sua sola sequenza.
    vi.useFakeTimers();
    try {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const visti: LightAttemptReport[] = [];
      let tentativiA = 0;
      const lane = lightLane(
        {
          kind: 'openai-compat',
          chat: async (chiamata: ChatCall) => {
            if (chiamata.model === 'a') {
              tentativiA += 1;
              if (tentativiA === 1) throw new ProviderError('429', true, 429, 'transport', 10);
            }
            return ok();
          },
        },
        { profile: CONSERVATIVE, onAttempt: (a) => visti.push(a) },
      );
      const pa = lane.chat(call({ model: 'a' }));
      const pb = lane.chat(call({ model: 'b' }));
      const attesaA = expect(pa).resolves.toMatchObject({ text: 'ok' });
      const attesaB = expect(pb).resolves.toMatchObject({ text: 'ok' });
      await vi.advanceTimersByTimeAsync(2000);
      await attesaA;
      await attesaB;
      const perRichiesta = new Map<string, number[]>();
      for (const v of visti) {
        perRichiesta.set(v.requestId, [...(perRichiesta.get(v.requestId) ?? []), v.attempt]);
      }
      expect(perRichiesta.size).toBe(2);
      expect([...perRichiesta.values()].sort()).toEqual([[1], [1, 2]]);
    } finally {
      vi.useRealTimers();
    }
  });
});
