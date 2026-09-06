import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../../../cli/init.js';
import { buildRuntime } from '../../../agent/runtime.js';
import type { LoopDeps } from '../../../agent/loop.js';
import type { Provider } from '../../../agent/providers/types.js';
import type { SessionStore } from '../../../core/session/store.js';
import type { TurnRecord } from '../../../core/turns/store.js';
import { QueueNotices } from './lane.js';
import { INGRESS_STAGES, receive, recover, type IngressHooks, type IngressStage, type RecoverHooks } from './router.js';
import { makeIngressPort, type InboundEvent, type IngressPort } from './types.js';

/**
 * Slice 14's router, against a port that is nothing but a recorder.
 *
 * The point of every scene here is *order and effect*, never a spy on an
 * internal: what is asserted is which stages ran, in which order, and which of
 * the port's four durable writes (`settle`, `markProcessed`, `recordDelivery`,
 * the turn itself) actually happened. That is what makes `INGRESS_STAGES` a
 * measurement — the array is what the router iterates, so a stage removed from
 * it disappears from these traces.
 */

const PORT: IngressPort = makeIngressPort(
  {
    id: 'prova',
    limits: { maxMessageChars: 4096, maxUploadBytes: 1, maxDownloadBytes: 1 },
    streaming: { transport: 'edit' },
    places: ['direct'],
    negotiate: (p: string) =>
      p === 'direct'
        ? ({ stream: ['edit', 'off'] as const, editEveryMs: 1_000, maxEditsPerMinute: 20, draftTtlMs: 0, files: ['say'] as const })
        : ({ stream: ['off'] as const, editEveryMs: 0, maxEditsPerMinute: 0, draftTtlMs: 0, files: ['say'] as const }),
    handles: () => true,
    deliver: async () => ({ ok: true }) as never,
  } as never,
  { commands: true, buttons: true, edit: true, typing: true, upload: true },
);

function evento(over: Partial<InboundEvent> = {}): InboundEvent {
  return {
    port: PORT,
    eventId: '11',
    compositionId: '11',
    identity: { connector: 'telegram', authorId: '7', conversationId: '7', direct: true },
    address: { channel: 'prova:7', replyTo: '110', record: { chatId: 7, messageId: 110 } },
    addressing: { direct: true, mentionsBot: false, repliesToBot: false },
    parts: [{ source: 'author', tier: 0, text: 'ciao' }],
    receivedAt: new Date('2026-09-05T10:00:00.000Z'),
    ...over,
  };
}

type Traccia = {
  readonly stadi: IngressStage[];
  readonly scritture: string[];
  readonly detto: string[];
};

/**
 * Un runtime vero, perché lo stadio `work` chiama `runTurn` davvero.
 *
 * Non c'è nessuna cucitura per saltarlo, ed è deliberato: se il router potesse
 * fingere il turno, «l'unico sito d'ingresso di `runTurn`» sarebbe una frase
 * invece di un fatto.
 */
function runtimeVero(): { loop: LoopDeps; sessions: SessionStore } {
  const home = mkdtempSync(join(tmpdir(), 'muffin-router-'));
  const workspace = mkdtempSync(join(tmpdir(), 'muffin-router-ws-'));
  runInit({ home, apiKey: 'sk-router-mai-usata' });
  const runtime = buildRuntime(home, workspace);
  const provider: Provider = {
    kind: 'openai-compat',
    chat: async () =>
      ({
        text: 'risposta',
        toolCalls: [],
        stopReason: 'end',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: 'test-model',
      }) as never,
  };
  return { loop: { ...runtime.deps, provider }, sessions: runtime.deps.sessions };
}

function ganci(
  traccia: Traccia,
  over: Partial<IngressHooks & RecoverHooks> = {},
): IngressHooks & RecoverHooks {
  const segna = <T>(stage: IngressStage, valore: T): T => {
    traccia.stadi.push(stage);
    return valore;
  };
  return {
    ownerId: '7',
    pair: async () => segna('pair', false),
    opensATurn: () => segna('gate', true),
    remember: () => {
      traccia.stadi.push('remember');
      traccia.scritture.push('episodio');
    },
    command: async () => segna('command', false),
    laneState: () => segna('busy', { inPausa: false, vivo: false }),
    notices: new QueueNotices(),
    say: async (_ctx, testo) => {
      traccia.detto.push(testo);
    },
    claim: async () => segna('work', { kind: 'mine' as const, workId: 'w1' }),
    work: runtimeVero(),
    openLive: async () => ({
      arm: () => ({ signal: new AbortController().signal, steer: () => [] }),
      close: async () => {
        traccia.scritture.push('live chiuso');
      },
    }),
    deliver: async () => segna('deliver', 'sent' as const),
    recordDelivery: (workId, delivery) => traccia.scritture.push(`delivery ${workId} ${delivery}`),
    finish: () => traccia.scritture.push('finish'),
    settle: () => traccia.scritture.push('settle'),
    markProcessed: () => {
      traccia.stadi.push('settle');
      traccia.scritture.push('markProcessed');
    },
    turn: () => null,
    recoveredText: () => 'recuperato',
    wireWasUncertain: () => false,
    redeliver: async () => 'sent',
    ...over,
  };
}

const nuovaTraccia = (): Traccia => ({ stadi: [], scritture: [], detto: [] });

describe('gli stadi sono `INGRESS_STAGES`, non una sequenza scritta nel corpo', () => {
  it('un evento che arriva fino in fondo li tocca nell ordine dell array', async () => {
    const traccia = nuovaTraccia();
    // Il turno lo finge il gancio `work`: qui si prova l'ordine, non il loop.
    const esito = await receive(
      PORT,
      evento(),
      ganci(traccia, {
        claim: async () => {
          traccia.stadi.push('work');
          return { kind: 'taken', workId: 'altro' };
        },
      }),
    );
    expect(esito).toEqual({ kind: 'deferred', workId: 'altro', why: 'bind-lost' });
    // `compose` e `ingest` non hanno un gancio che registri: `compose` è
    // condiviso e `ingest` è assente per un evento senza allegato. Restano gli
    // altri, e sono nell'ordine dell'array.
    expect(traccia.stadi).toEqual(['pair', 'gate', 'command', 'busy', 'work']);
    expect(traccia.stadi).toEqual(
      INGRESS_STAGES.filter((s) => traccia.stadi.includes(s)),
    );
  });

  it('l array è quello che il disegno nomina, in quell ordine', () => {
    expect([...INGRESS_STAGES]).toEqual([
      'pair',
      'gate',
      'remember',
      'command',
      'busy',
      'compose',
      'ingest',
      'work',
      'deliver',
      'settle',
    ]);
  });
});

describe('il gate non ferma: devia su `remember`', () => {
  it('un messaggio che non apre un turno viene ricordato, e nessuno stadio dopo gira', async () => {
    const traccia = nuovaTraccia();
    const esito = await receive(PORT, evento(), ganci(traccia, { opensATurn: () => false }));
    expect(esito).toEqual({ kind: 'ignored', stage: 'gate', remembered: true });
    expect(traccia.stadi).toEqual(['pair', 'remember']);
    expect(traccia.scritture).toEqual(['episodio']);
  });

  it('e un messaggio che il gate lascia passare NON viene ricordato due volte', async () => {
    const traccia = nuovaTraccia();
    await receive(PORT, evento(), ganci(traccia));
    // `remember` è nell'array e viene percorso: la sua condizione è la deviazione,
    // non la posizione. Un episodio scritto qui sarebbe il doppione di quello
    // che il turno stesso scrive.
    expect(traccia.scritture).not.toContain('episodio');
  });
});

describe('`queued` non fa settle e non scrive niente di durevole', () => {
  it('in pausa: una frase sola, nessuna scrittura, l evento resta da drenare', async () => {
    const traccia = nuovaTraccia();
    const esito = await receive(
      PORT,
      evento(),
      ganci(traccia, { laneState: () => ({ inPausa: true, vivo: false }) }),
    );
    expect(esito).toEqual({ kind: 'queued', why: 'paused' });
    expect(traccia.detto).toEqual(['⏸ in pausa: lo leggo al /resume.']);
    expect(traccia.scritture).toEqual([]);
  });

  it('e la frase è una sola anche se lo stesso evento passa due volte', async () => {
    const traccia = nuovaTraccia();
    const g = ganci(traccia, { laneState: () => ({ inPausa: true, vivo: false }) });
    await receive(PORT, evento(), g);
    await receive(PORT, evento(), g);
    expect(traccia.detto).toHaveLength(1);
  });

  it('un turno vivo ma senza pausa non consuma il registro degli avvisi', async () => {
    const traccia = nuovaTraccia();
    const notices = new QueueNotices();
    await receive(
      PORT,
      evento(),
      ganci(traccia, {
        notices,
        laneState: () => ({ inPausa: false, vivo: true }),
        claim: async () => ({ kind: 'taken', workId: 'x' }),
      }),
    );
    // Il difetto che questo chiude: spendere qui l'unico avviso che quell'evento
    // ha, e poi tacere quando la pausa arriva davvero.
    expect(notices.size).toBe(0);
  });
});

describe('pairing e comandi consumano l evento senza mai creare un turno', () => {
  it('un codice di pairing chiude subito', async () => {
    const traccia = nuovaTraccia();
    const esito = await receive(PORT, evento(), ganci(traccia, { pair: async () => true }));
    expect(esito).toEqual({ kind: 'paired' });
    expect(traccia.stadi).toEqual([]);
  });

  it('un comando chiude dopo il gate, e prima della pausa', async () => {
    const traccia = nuovaTraccia();
    const esito = await receive(PORT, evento(), ganci(traccia, { command: async () => true }));
    expect(esito).toEqual({ kind: 'commanded' });
    expect(traccia.stadi).toEqual(['pair', 'gate']);
  });
});

describe('consegna e settle', () => {
  it('la mandata scrive settle PRIMA del registro, poi markProcessed', async () => {
    const traccia = nuovaTraccia();
    const esito = await receive(
      PORT,
      evento(),
      ganci(traccia, { claim: async () => ({ kind: 'mine', workId: 'w1' }) }),
    );
    expect(esito).toEqual({ kind: 'answered', workId: 'w1', delivery: 'sent' });
    expect(traccia.scritture).toEqual(['settle', 'delivery w1 sent', 'markProcessed', 'live chiuso']);
  });

  it('una consegna che lancia registra `failed:` e ributta fuori l errore', async () => {
    const traccia = nuovaTraccia();
    await expect(
      receive(
        PORT,
        evento(),
        ganci(traccia, {
          claim: async () => ({ kind: 'mine', workId: 'w1' }),
          deliver: async () => {
            throw new Error('429');
          },
        }),
      ),
    ).rejects.toThrow('429');
    expect(traccia.scritture).toContain('delivery w1 failed:429');
    expect(traccia.scritture).not.toContain('markProcessed');
    // Il vivo si chiude comunque: è nel `finally` del router, non nel ramo felice.
    expect(traccia.scritture).toContain('live chiuso');
  });
});

describe('`recover` non chiama mai il modello', () => {
  const riga = { eventId: '11', settledAt: null };

  it('un turno ancora in volo rimanda, e non tocca niente', async () => {
    const traccia = nuovaTraccia();
    const esito = await recover(PORT, riga, 'w1', evento(), ganci(traccia, {
      turn: () => ({ id: 'w1', status: 'running', delivery: 'pending', replyTo: {} }) as unknown as TurnRecord,
    }));
    expect(esito).toEqual({ kind: 'deferred', workId: 'w1', why: 'still-running' });
    expect(traccia.scritture).toEqual([]);
  });

  it('un turno già consegnato chiude senza rimandare niente', async () => {
    const traccia = nuovaTraccia();
    let inviate = 0;
    const esito = await recover(PORT, riga, 'w1', evento(), ganci(traccia, {
      turn: () => ({ id: 'w1', status: 'done', delivery: 'sent', replyTo: {} }) as unknown as TurnRecord,
      redeliver: async () => {
        inviate++;
        return 'sent';
      },
    }));
    expect(esito).toEqual({ kind: 'recovered', workId: 'w1', delivery: 'already' });
    expect(inviate).toBe(0);
    expect(traccia.scritture).toEqual(['finish']);
  });

  it('un turno `done` mai consegnato ri-manda il testo recuperato, non il modello', async () => {
    const traccia = nuovaTraccia();
    const inviate: string[] = [];
    const esito = await recover(PORT, riga, 'w1', evento(), ganci(traccia, {
      turn: () => ({ id: 'w1', status: 'done', delivery: 'pending', replyTo: { chatId: 7 } }) as unknown as TurnRecord,
      redeliver: async (_id, _replyTo, text) => {
        inviate.push(text);
        return 'sent';
      },
    }));
    expect(esito).toEqual({ kind: 'recovered', workId: 'w1', delivery: 'sent' });
    expect(inviate).toEqual(['recuperato']);
    expect(traccia.scritture).toEqual(['settle', 'delivery w1 sent', 'markProcessed']);
  });

  it('senza indirizzo la riga diventa `undeliverable`, non un invio a nessuno', async () => {
    const traccia = nuovaTraccia();
    const esito = await recover(PORT, riga, 'w1', evento(), ganci(traccia, {
      turn: () => ({ id: 'w1', status: 'done', delivery: 'pending', replyTo: null }) as unknown as TurnRecord,
    }));
    expect(esito).toEqual({ kind: 'recovered', workId: 'w1', delivery: 'undeliverable' });
    expect(traccia.scritture).toEqual(['delivery w1 undeliverable', 'finish']);
  });

  it('bind atterrato ma riga del turno assente: riparte da `compose`, con LO STESSO id', async () => {
    const traccia = nuovaTraccia();
    let claimato = 0;
    const esito = await recover(PORT, riga, 'w-committed', evento(), ganci(traccia, {
      turn: () => null,
      claim: async () => {
        claimato++;
        return { kind: 'mine', workId: 'mai-usato' };
      },
    }));
    // Il gancio `claim` della porta non viene richiamato: l'identità è già
    // impegnata, e mintarne una seconda è esattamente il doppione che il fault
    // point 2 esiste per escludere.
    expect(claimato).toBe(0);
    expect(esito).toEqual({ kind: 'answered', workId: 'w-committed', delivery: 'sent' });
    // Pairing, gate, comandi e pausa non rigirano: hanno già avuto la parola.
    expect(traccia.stadi).toEqual(['deliver', 'settle']);
  });
});

/**
 * §2.3, second half. `makeIngressPort` refuses a port whose `edit` contradicts
 * its own `Surface`; this is the same refusal for the one capability that has
 * no field on `Surface` to contradict — only a hook that is wired or is not.
 *
 * Slice 15's own mutation lands here: declaring `commands: true` on Discord
 * (`connectors/discord/surface.ts`) while nothing in its connector calls
 * `agent/comandi.ts` makes the very first message it drains throw, instead of
 * quietly making slice 16's parity table claim a scene that cannot run.
 */
describe('a port whose declaration and hooks disagree never walks (§2.3)', () => {
  const senzaComandi: IngressPort = makeIngressPort(
    {
      id: 'muta',
      limits: { maxMessageChars: 4096, maxUploadBytes: 1, maxDownloadBytes: 1 },
      streaming: { transport: 'off' },
      places: ['direct'],
      negotiate: () => ({ stream: ['off'] as const, editEveryMs: 0, maxEditsPerMinute: 0, draftTtlMs: 0, files: ['say'] as const }),
      handles: () => true,
      deliver: async () => ({ ok: true }) as never,
    } as never,
    { commands: false, buttons: false, edit: false, typing: true, upload: true },
  );

  it('refuses commands: true with no command hook, naming the port', async () => {
    const traccia: Traccia = { stadi: [], scritture: [], detto: [] };
    const dichiaraECiMente = makeIngressPort(senzaComandi.surface, { ...senzaComandi.ingress, commands: true });
    const { command: _tolto, ...senzaGancio } = ganci(traccia);
    await expect(receive(dichiaraECiMente, evento({ port: dichiaraECiMente }), senzaGancio)).rejects.toThrow(
      /ingress port "muta": ingress\.commands=true but no command hook is wired/,
    );
    // E non a metà strada: niente ha camminato, quindi niente ha scritto.
    expect(traccia.stadi).toEqual([]);
    expect(traccia.scritture).toEqual([]);
  });

  it('refuses a wired command hook on a port that declares commands: false', async () => {
    const traccia: Traccia = { stadi: [], scritture: [], detto: [] };
    await expect(receive(senzaComandi, evento({ port: senzaComandi }), ganci(traccia))).rejects.toThrow(
      /a command hook is wired but ingress\.commands=false/,
    );
  });

  it('walks normally when the two agree', async () => {
    const traccia: Traccia = { stadi: [], scritture: [], detto: [] };
    const { command: _tolto, ...senzaGancio } = ganci(traccia);
    const esito = await receive(senzaComandi, evento({ port: senzaComandi }), senzaGancio);
    expect(esito.kind).toBe('answered');
    expect(traccia.stadi).not.toContain('command');
  });
});
