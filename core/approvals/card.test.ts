import { describe, expect, it } from 'vitest';
import {
  allowLabelFor,
  approvalCardShowsJargon,
  formatApprovalCard,
  renderApprovalCardPlain,
  resolutionLine,
} from './card.js';

const httpAsk = {
  capability: 'sys.http',
  prompt:
    'lettura con parametri scelti dal contenuto: https://nodejs.org/dist/index.json\n\nquesto turno contiene contenuto di livello 3: la memoria richiamata',
  resource: 'https://nodejs.org/dist/index.json',
  taint: 3 as const,
};

const shellAsk = {
  capability: 'sys.shell.write',
  prompt: 'non si torna indietro: cambia questa macchina — sys.shell.write',
  resource: 'command: echo ciao\ncwd: .',
  description: 'stampa la parola ciao',
  taint: 2 as const,
};

describe('formatApprovalCard', () => {
  it('asks to read a public URL in Italian, without kernel jargon', () => {
    const card = formatApprovalCard(httpAsk);
    expect(card.what).toBe('Vuoi che legga https://nodejs.org/dist/index.json?');
    expect(card.why).toContain('contenuto preso dal web o da un gruppo');
    expect(card.object).toBe('https://nodejs.org/dist/index.json');
    expect(card.allowLabel).toBe('Consenti la lettura');
    expect(card.denyLabel).toBe('Rifiuta');
    const plain = renderApprovalCardPlain(httpAsk);
    expect(plain).toContain('https://nodejs.org/dist/index.json');
    expect(approvalCardShowsJargon(plain, card.object)).toBe(false);
    expect(plain).not.toMatch(/taint/i);
    expect(plain).not.toContain('sys.http');
    expect(plain).not.toContain('livello 3');
    expect(plain).not.toContain('parametri scelti dal contenuto');
  });

  it('omits the untrusted why when the turn has no untrusted taint', () => {
    const card = formatApprovalCard({ ...httpAsk, taint: 0 });
    expect(card.what).toContain('https://nodejs.org/dist/index.json');
    expect(card.why).toBeNull();
    expect(
      approvalCardShowsJargon(renderApprovalCardPlain({ ...httpAsk, taint: 0 }), card.object),
    ).toBe(false);
  });

  it('asks to run a command, names irreversibility, and keeps the full command', () => {
    const card = formatApprovalCard(shellAsk);
    expect(card.what).toBe('Vuoi che esegua questo comando?');
    expect(card.why).toContain('Questo comando non si può annullare.');
    expect(card.why).toContain('contenuto preso dal web o da un gruppo');
    expect(card.description).toBe('stampa la parola ciao');
    expect(card.object).toBe('command: echo ciao\ncwd: .');
    expect(card.allowLabel).toBe('Consenti il comando');
    const plain = renderApprovalCardPlain(shellAsk);
    expect(plain).toContain('echo ciao');
    expect(plain).toContain('cwd: .');
    expect(plain.indexOf('Vuoi che esegua')).toBeLessThan(plain.indexOf('stampa la parola ciao'));
    expect(plain.indexOf('stampa la parola ciao')).toBeLessThan(plain.indexOf('echo ciao'));
    expect(approvalCardShowsJargon(plain, card.object)).toBe(false);
    expect(plain).not.toMatch(/taint/i);
    expect(plain).not.toContain('sys.shell');
    expect(plain).not.toContain('livello 3');
  });

  it('keeps a long untruncated URL in the object', () => {
    const url = `https://example.com/${'a'.repeat(4000)}`;
    const plain = renderApprovalCardPlain({
      capability: 'sys.http',
      prompt: 'lettura',
      resource: url,
      taint: 0,
    });
    expect(plain).toContain(url);
    expect(plain).toContain(`Vuoi che legga ${url}?`);
  });

  it('labels a send, and falls back to a generic allow for other capabilities', () => {
    expect(allowLabelFor('outward.send')).toBe("Consenti l'invio");
    expect(allowLabelFor('fs.write')).toBe('Consenti');
    expect(
      formatApprovalCard({
        capability: 'outward.send',
        prompt: 'invio a terzi',
        resource: 'alice@example.com',
        taint: 0,
      }).what,
    ).toBe('Vuoi che invii questo messaggio a alice@example.com?');
  });

  it('resolution lines name the action, never the capability id', () => {
    expect(resolutionLine('sys.http', true)).toBe('lettura: consentito');
    expect(resolutionLine('sys.shell.write', false)).toBe('comando: rifiutato');
    expect(resolutionLine('sys.shell.write', true)).not.toContain('sys.');
  });
});
