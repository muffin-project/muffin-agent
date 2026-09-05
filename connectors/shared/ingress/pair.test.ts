import { describe, expect, it } from 'vitest';
import { generatePairingCode, startPairing, type PendingPairing } from '../../../core/config/pairing.js';
import { tryPair, type PairingActions, type PairingState } from './pair.js';

/**
 * Slice 12 verification (`docs/evidence/ingresso-unico-e-nucleo-2026-09-05.md`
 * §3 row 12). Unit-level, against the module directly, with two id shapes —
 * a numeric Telegram-like id and a Discord-like snowflake string — proving
 * `TId` is never assumed to be either. The connector-level proof that both
 * `TelegramConnector` and `DiscordConnector` actually call this one function
 * lives in their own `pairing-flow.test.ts`, unchanged by this slice.
 */

function harness<TId>(state: Omit<PairingState<TId>, 'canPersist'> & { canPersist?: boolean }) {
  const said: string[] = [];
  const matched: TId[] = [];
  const attempts: (PendingPairing | null)[] = [];
  const actions: PairingActions<TId> = {
    onMatched: (fromId) => matched.push(fromId),
    onAttempt: (next) => attempts.push(next),
    say: (text) => {
      said.push(text);
    },
  };
  return { state: { canPersist: true, ...state } as PairingState<TId>, actions, said, matched, attempts };
}

describe('tryPair — already decided cases never touch checkPairing at all', () => {
  it('already owned: false, nothing called', async () => {
    const h = harness<number>({ ownerUserId: 42, pairing: startPairing('X', new Date()) });
    const result = await tryPair(h.state, { fromId: 1, text: 'X', eligible: true }, h.actions, new Date());
    expect(result).toBe(false);
    expect(h.said).toEqual([]);
    expect(h.matched).toEqual([]);
  });

  it('no pending pairing: false, nothing called', async () => {
    const h = harness<number>({ ownerUserId: undefined, pairing: undefined });
    const result = await tryPair(h.state, { fromId: 1, text: 'X', eligible: true }, h.actions, new Date());
    expect(result).toBe(false);
    expect(h.said).toEqual([]);
  });

  it('pairing disabled (canPersist false): false, nothing called', async () => {
    const h = harness<number>({
      ownerUserId: undefined,
      pairing: startPairing('X', new Date()),
      canPersist: false,
    });
    const result = await tryPair(h.state, { fromId: 1, text: 'X', eligible: true }, h.actions, new Date());
    expect(result).toBe(false);
    expect(h.said).toEqual([]);
  });

  it('not eligible (the caller\'s own platform rule): false, nothing called — an ordinary group message never burns an attempt', async () => {
    const h = harness<number>({ ownerUserId: undefined, pairing: startPairing('X', new Date()) });
    const result = await tryPair(h.state, { fromId: 1, text: 'X', eligible: false }, h.actions, new Date());
    expect(result).toBe(false);
    expect(h.said).toEqual([]);
    expect(h.attempts).toEqual([]);
  });
});

describe('tryPair — a matching code', () => {
  it('numeric id (Telegram-shaped): onMatched fires with the raw id, then the exact sentence, true', async () => {
    const code = generatePairingCode();
    const h = harness<number>({ ownerUserId: undefined, pairing: startPairing(code, new Date()) });
    const result = await tryPair(h.state, { fromId: 4242, text: code, eligible: true }, h.actions, new Date());
    expect(result).toBe(true);
    expect(h.matched).toEqual([4242]);
    expect(h.said).toEqual(['Sei tu. Da adesso questa è la nostra chat.']);
  });

  it('string snowflake id (Discord-shaped): same outcome, id never coerced', async () => {
    const code = generatePairingCode();
    const h = harness<string>({ ownerUserId: undefined, pairing: startPairing(code, new Date()) });
    const result = await tryPair(
      h.state,
      { fromId: '777000000000000001', text: code, eligible: true },
      h.actions,
      new Date(),
    );
    expect(result).toBe(true);
    expect(h.matched).toEqual(['777000000000000001']);
    expect(h.said).toEqual(['Sei tu. Da adesso questa è la nostra chat.']);
  });

  it('onMatched runs before the reply is awaited, so a failed send still leaves the match persisted', async () => {
    const code = generatePairingCode();
    const order: string[] = [];
    const h = harness<number>({ ownerUserId: undefined, pairing: startPairing(code, new Date()) });
    const actions: PairingActions<number> = {
      onMatched: (fromId) => {
        order.push(`matched:${fromId}`);
      },
      onAttempt: () => {},
      say: async () => {
        order.push('said');
        throw new Error('network down');
      },
    };
    await expect(tryPair(h.state, { fromId: 1, text: code, eligible: true }, actions, new Date())).rejects.toThrow(
      'network down',
    );
    // The persist happens, then the reply is attempted — never the reverse.
    expect(order).toEqual(['matched:1', 'said']);
  });
});

describe('tryPair — a wrong or spent code', () => {
  it('a stranger typing ordinary text: false, no attempt burned', async () => {
    const h = harness<number>({ ownerUserId: undefined, pairing: startPairing(generatePairingCode(), new Date()) });
    const result = await tryPair(
      h.state,
      { fromId: 999, text: 'ciao come stai', eligible: true },
      h.actions,
      new Date(),
    );
    expect(result).toBe(false);
    expect(h.attempts).toEqual([]);
    expect(h.said).toEqual([]);
  });

  it('a wrong code-shaped guess: onAttempt gets the next pending state, exact "wrong" sentence, true', async () => {
    const h = harness<number>({ ownerUserId: undefined, pairing: startPairing(generatePairingCode(), new Date()) });
    const result = await tryPair(
      h.state,
      { fromId: 999, text: 'ABCD-1234', eligible: true },
      h.actions,
      new Date(),
    );
    expect(result).toBe(true);
    expect(h.attempts).toHaveLength(1);
    expect(h.attempts[0]?.attempts).toBe(1);
    expect(h.said).toEqual(['Non è quello. Tentativi rimasti: 4.']);
  });

  it('an expired code: onAttempt gets null (burned/expired), the "no longer valid" sentence, true', async () => {
    // startPairing's own expiresAt = `now` + TTL, so a `pending` that is already
    // expired needs a `now` further back than the TTL itself, not merely a
    // past instant.
    const wellBeforeTtl = new Date(Date.now() - 2 * 10 * 60 * 1000);
    const h = harness<number>({
      ownerUserId: undefined,
      pairing: startPairing(generatePairingCode(), wellBeforeTtl),
    });
    const result = await tryPair(
      h.state,
      { fromId: 999, text: 'ABCD-1234', eligible: true },
      h.actions,
      new Date(),
    );
    expect(result).toBe(true);
    expect(h.attempts).toEqual([null]);
    expect(h.said).toEqual(['Quel codice non vale più. Rigenerane uno dalla CLI.']);
  });
});

describe('tryPair — once paired, the code path is closed', () => {
  it('the right code from the wrong person changes nothing once owned', async () => {
    const code = generatePairingCode();
    const h = harness<number>({ ownerUserId: 777, pairing: startPairing(code, new Date()) });
    const result = await tryPair(h.state, { fromId: 999, text: code, eligible: true }, h.actions, new Date());
    expect(result).toBe(false);
    expect(h.matched).toEqual([]);
    expect(h.attempts).toEqual([]);
  });
});
