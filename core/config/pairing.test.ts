import { describe, expect, it } from 'vitest';
import {
  PAIRING_MAX_ATTEMPTS,
  PAIRING_TTL_MS,
  checkPairing,
  generatePairingCode,
  startPairing,
} from './pairing.js';

const NOW = new Date('2026-08-10T10:00:00Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);

describe('pairing code', () => {
  it('matches the code that was generated', () => {
    const code = generatePairingCode();
    const pending = startPairing(code, NOW);
    expect(checkPairing(pending, code, NOW).outcome).toEqual({ status: 'matched' });
  });

  it('is consumed by the match, so it cannot be used twice', () => {
    // The single-use guarantee. Without it the code stays a second owner
    // credential in whatever terminal printed it.
    const code = generatePairingCode();
    const { next } = checkPairing(startPairing(code, NOW), code, NOW);
    expect(next).toBeNull();
  });

  it('expires', () => {
    const code = generatePairingCode();
    const pending = startPairing(code, NOW);
    expect(checkPairing(pending, code, later(PAIRING_TTL_MS + 1)).outcome).toEqual({ status: 'expired' });
  });

  it('burns after enough wrong guesses instead of answering for ever', () => {
    const pending = startPairing(generatePairingCode(), NOW);
    let state = pending;
    for (let i = 1; i < PAIRING_MAX_ATTEMPTS; i++) {
      const r = checkPairing(state, 'WRONG-GUESS', NOW);
      expect(r.outcome.status).toBe('wrong');
      state = r.next!;
    }
    expect(checkPairing(state, 'WRONG-GUESS', NOW).outcome).toEqual({ status: 'burned' });
  });

  it('a burned code does not accept the right answer either', () => {
    // Otherwise the cap only slows an attacker down and still rewards them.
    const code = generatePairingCode();
    let state = startPairing(code, NOW);
    for (let i = 0; i < PAIRING_MAX_ATTEMPTS - 1; i++) state = checkPairing(state, 'NOPE', NOW).next!;
    checkPairing(state, 'NOPE', NOW); // burns it
    const burned = { ...state, attempts: PAIRING_MAX_ATTEMPTS };
    expect(checkPairing(burned, code, NOW).outcome).toEqual({ status: 'burned' });
  });

  it('never stores the code itself', () => {
    const code = generatePairingCode();
    const pending = startPairing(code, NOW);
    const serialised = JSON.stringify(pending);
    expect(serialised).not.toContain(code);
    expect(serialised).not.toContain(code.replace('-', ''));
    expect(pending.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('forgives what a phone keyboard does to a code read off a screen', () => {
    const code = generatePairingCode();
    const pending = startPairing(code, NOW);
    const typed = ` ${code.toLowerCase().replace('-', ' ')} `;
    expect(checkPairing(pending, typed, NOW).outcome).toEqual({ status: 'matched' });
  });

  it('draws from an alphabet without the characters people misread', () => {
    // I/L/O/U are absent on purpose: the code is read off one screen and typed
    // on another, and "0 or O" is the failure that makes people give up.
    for (let i = 0; i < 200; i++) {
      expect(generatePairingCode()).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}$/);
    }
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generatePairingCode()));
    expect(seen.size).toBe(500);
  });
});
