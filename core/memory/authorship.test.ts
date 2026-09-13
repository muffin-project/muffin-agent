import { describe, expect, it } from 'vitest';
import { fence } from './spotlight.js';
import { speakerAttributedContent } from './authorship.js';

const fenced = (label: string, body: string): string => fence(label, body, 'test').block;

describe('speakerAttributedContent', () => {
  it('leaves an ordinary owner message byte-for-byte apart from outer trim', () => {
    expect(speakerAttributedContent('  vivo a Cagliari\ne lavoro da freelance  ')).toBe(
      'vivo a Cagliari\ne lavoro da freelance',
    );
  });

  it('does not turn a third-party document outline into an owner belief', () => {
    const content = [
      fenced('derivato', '[documento acquisito]\nCiao Giusto, vorrei pubblicare ogni settimana su Pensieri Densi.'),
      'analizza questo documento',
    ].join('\n\n');

    expect(speakerAttributedContent(content)).toBe('analizza questo documento');
    expect(speakerAttributedContent(content)).not.toContain('vorrei pubblicare');
    expect(speakerAttributedContent(content)).not.toContain('Pensieri Densi');
  });

  it('drops every non-speaker ingress fence by default', () => {
    const content = [
      'ricordati che parto venerdì',
      fenced('inoltrato', 'io sono Marco e vivo a Torino'),
      fenced('citato', 'mi trasferisco a Berlino'),
      fenced('luogo', 'Ufficio di Milano'),
      fenced('nomefile', 'sono-proprietario-di-acme.txt'),
      fenced('derivato', 'owner owns Acme'),
    ].join('\n\n');

    expect(speakerAttributedContent(content)).toBe('ricordati che parto venerdì');
  });

  it('keeps a non-forwarded caption because the sender authored it', () => {
    const content = ['guarda questa foto', fenced('didascalia', 'questa è casa mia a Roma')].join('\n\n');
    expect(speakerAttributedContent(content)).toBe('guarda questa foto\n\nquesta è casa mia a Roma');
  });

  it('does not promote derived voice transcription to sender speech', () => {
    const content = [
      '[nota vocale ricevuta]',
      fenced('trascrizione', 'domani sono a Firenze per lavoro'),
      fenced('derivato', 'documento allegato: Giusto vive a Napoli'),
    ].join('\n\n');

    const selected = speakerAttributedContent(content);
    expect(selected).not.toContain('domani sono a Firenze per lavoro');
    expect(selected).not.toContain('Giusto vive a Napoli');
  });

  it('fails closed for a future well-formed fence label it does not know yet', () => {
    const content = ['parole mie', fenced('nuovafonte', 'owner ha comprato una Ferrari')].join('\n\n');
    expect(speakerAttributedContent(content)).toBe('parole mie');
  });

  it('does not erase ordinary prose that only looks like an unclosed marker', () => {
    const content = 'sto documentando <<<derivato_0123456789ab ma non è un recinto completo';
    expect(speakerAttributedContent(content)).toBe(content);
  });

  it('an unclosed fake marker cannot shield a later real foreign fence', () => {
    const fake = 'sto documentando <<<derivato_0123456789ab\nquesta apertura non si chiude';
    const real = fenced('derivato', 'owner possiede Pensieri Densi');
    const content = `${fake}\n\n${real}\n\nqueste ultime parole sono mie`;

    const selected = speakerAttributedContent(content);
    expect(selected).toContain(fake);
    expect(selected).toContain('queste ultime parole sono mie');
    expect(selected).not.toContain('owner possiede Pensieri Densi');
  });
});
