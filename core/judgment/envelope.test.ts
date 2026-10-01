import { describe, expect, it } from 'vitest';
import { type AskFacts, buildEnvelope, stateHash } from './envelope.js';

/**
 * L'envelope: i fatti compatti, **redatti**. La proprietà che conta è la
 * privacy: ciò che parte verso il provider è ciò che il tracing scrivrebbe,
 * non ciò che l'owner vede — un comando con un token dentro è leggibile
 * dall'owner (è la sua macchina) ma non parte intero.
 */

const fatti = (over: Partial<AskFacts> = {}): AskFacts => ({
  intent: 'sistema il modulo auth',
  capability: 'sys.shell.write',
  effectRow: 'host',
  risk: 'high',
  reversible: 'no',
  rerunnable: false,
  resource: 'command: echo ciao · cwd: .',
  description: 'stampa la parola ciao',
  taint: 2,
  taintOrigin: 'contenuto di livello 2 (gruppo)',
  principal: 'owner',
  tenant: 'host',
  delegationMode: 'manual',
  askPrompt: 'non si torna indietro: cambia questa macchina',
  ...over,
});

describe('buildEnvelope', () => {
  it('porta i fatti che il giudizio serve, con i nomi che il report leggerà', () => {
    const e = buildEnvelope(fatti());
    expect(e.owner_request).toBe('sistema il modulo auth');
    const azione = e.action as Record<string, unknown>;
    expect(azione.capability).toBe('sys.shell.write');
    expect(azione.resource).toBe('command: echo ciao · cwd: .');
    expect(azione.description).toBe('stampa la parola ciao');
    const contesto = e.context as Record<string, unknown>;
    expect(contesto.taint).toBe(2);
    expect(contesto.delegation_mode).toBe('manual');
    const policy = e.policy as Record<string, unknown>;
    expect(policy.verdict).toBe('ask');
  });

  it('un segreto nel comando non parte intero: redatto, come il tracing', () => {
    const e = buildEnvelope(
      fatti({
        resource: 'command: curl -H "Authorization: Bearer abc123xyz789" https://api.esempio.it',
      }),
    );
    const azione = e.action as Record<string, unknown>;
    expect(String(azione.resource)).toContain('«red');
    expect(String(azione.resource)).not.toContain('abc123xyz789');
  });

  it('un segreto nella descrizione del modello e nell intento: stessa sorte', () => {
    const e = buildEnvelope(
      fatti({
        description: 'chiama con token sk-abc123def456ghi789',
        intent: 'usa la chiave sk-abc123def456ghi789 per favore',
      }),
    );
    const azione = e.action as Record<string, unknown>;
    expect(String(azione.description)).not.toContain('sk-abc123');
    expect(String(e.owner_request)).not.toContain('sk-abc123');
  });

  it('i null restano null, non stringhe vuote: mancare è mancare', () => {
    const e = buildEnvelope(fatti({ intent: null, resource: undefined, description: undefined }));
    expect(e.owner_request).toBeNull();
    const azione = e.action as Record<string, unknown>;
    expect(azione.resource).toBeNull();
    expect(azione.description).toBeNull();
  });

  it('l impronta è stabile per lo stesso stato e diversa per un altro', () => {
    const a = stateHash(buildEnvelope(fatti()));
    expect(stateHash(buildEnvelope(fatti()))).toBe(a);
    expect(a).toHaveLength(16);
    const altro = stateHash(buildEnvelope(fatti({ capability: 'sys.shell' })));
    expect(altro).toHaveLength(16);
    expect(altro).not.toBe(a);
  });
});
