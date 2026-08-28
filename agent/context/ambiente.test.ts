import { describe, expect, it } from 'vitest';
import { ambienteSection } from './assemble.js';

/**
 * Che momento è, e dove stai parlando.
 *
 * Il difetto che questi test tengono chiuso è stato misurato su uno schermo
 * vero il 28/08/2026: alla domanda «che giorno e che ora sono adesso?», Muffin
 * ha provato a eseguire `date` con `sys.shell` — cioè ha chiesto un permesso
 * all'owner per sapere l'ora. Non era una stranezza del modello: nel prompt la
 * data non c'era, in nessuna forma. Un agente con memoria, uno scheduler, dei
 * `todo` con scadenze e una persona che dice «posso riprendere qualcosa dopo
 * ore o giorni» non sapeva in che giorno fosse.
 */

const QUANDO = new Date('2026-08-28T04:59:00Z');

describe('la data entra nel contesto', () => {
  it('dice giorno della settimana, data, ora e fuso', () => {
    const s = ambienteSection(QUANDO, 'cli', 'Europe/Rome');
    expect(s).toContain('venerdì');
    expect(s).toContain('28 agosto 2026');
    expect(s).toContain('06:59'); // 04:59Z a Roma d'estate
    expect(s).toContain('Europe/Rome');
  });

  /**
   * «Le 4:59» senza fuso non è un momento, ed è la metà che si dimentica: un
   * agente che gira su una VPS in un fuso e parla con un owner in un altro
   * risponderebbe l'ora giusta della macchina sbagliata.
   */
  it('e lo stesso istante in due fusi non è la stessa ora', () => {
    const roma = ambienteSection(QUANDO, 'cli', 'Europe/Rome');
    const tokyo = ambienteSection(QUANDO, 'cli', 'Asia/Tokyo');
    expect(roma).not.toBe(tokyo);
    expect(tokyo).toContain('Asia/Tokyo');
  });

  /**
   * Locale esplicito: quello di sistema su questa macchina è `en-US`
   * (misurato), e un agente che parla italiano non deve leggere «Friday» per
   * sapere che giorno è.
   */
  it('e lo dice in italiano, non nel locale della macchina', () => {
    const s = ambienteSection(QUANDO, 'cli', 'Europe/Rome');
    expect(s).not.toContain('Friday');
    expect(s).not.toContain('August');
  });
});

describe('e la superficie pure', () => {
  /**
   * `voice.md` ha una regola che **dipende** da questo — «non uso LaTeX nei
   * messaggi destinati a superfici che non lo renderizzano» — e fino a questo
   * momento era insoddisfacibile: la regola c'era, il dato per applicarla no.
   */
  it('dice dove stai parlando, con la parola di una persona', () => {
    expect(ambienteSection(QUANDO, 'cli', 'Europe/Rome')).toContain('un terminale');
    expect(ambienteSection(QUANDO, 'telegram', 'Europe/Rome')).toContain('Telegram');
  });

  /** Una superficie che ancora non esiste si nomina da sé, invece di sparire. */
  it('e una superficie che non conosce la chiama col suo nome', () => {
    expect(ambienteSection(QUANDO, 'matrix', 'Europe/Rome')).toContain('matrix');
  });
});

describe('dove sta, e perché non altrove', () => {
  /**
   * Sta nella coda volatile, mai in `systemPrompts`. I prompt di sistema si
   * assemblano una volta all'avvio proprio per restare un prefisso cacheable
   * byte per byte, e un orologio lì davanti è letteralmente l'errore che la
   * documentazione di Anthropic sul prompt caching chiama per nome — «il
   * breakpoint su contenuto che cambia a ogni richiesta».
   *
   * Qui si prova la proprietà che lo rende collocabile solo lì: **cambia**.
   */
  it('due istanti diversi danno due testi diversi', () => {
    const a = ambienteSection(new Date('2026-08-28T04:59:00Z'), 'cli', 'Europe/Rome');
    const b = ambienteSection(new Date('2026-08-28T05:59:00Z'), 'cli', 'Europe/Rome');
    expect(a).not.toBe(b);
  });

  /** È una sezione con la sua intestazione, come le altre della coda. */
  it('ed è una sezione, non una riga sciolta in mezzo al testo', () => {
    expect(ambienteSection(QUANDO, 'cli', 'Europe/Rome').startsWith('## Adesso')).toBe(true);
  });
});
