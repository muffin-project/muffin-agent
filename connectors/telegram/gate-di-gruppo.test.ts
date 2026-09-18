import { describe, expect, it } from 'vitest';
import { apreUnTurno } from './connector.js';

/**
 * Fino al 04/09/2026 `drain()` apriva un turno vero — modello, memoria, tool —
 * per ogni update che `parseUpdate` non scartava: gruppo o privata, menzionato
 * o no. A proteggere l'owner era solo la *privacy mode* di Telegram, accesa per
 * default, che a un bot non-admin non consegna nemmeno una menzione nuda
 * (`core.telegram.org/bots/features`, letta il 04/09/2026).
 *
 * L'owner la spegne di proposito — vuole che Muffin veda la conversazione, non
 * solo cio' che gli e' indirizzato. Da quel momento questa funzione e' l'unica
 * cosa fra un gruppo attivo e un turno per messaggio.
 */

const gruppo = { isPrivate: false, meUsername: 'MuffinAgentTestBot' };

describe('il gate di gruppo', () => {
  it('in privata apre sempre: non c\'e' + ' niente da indovinare', () => {
    expect(apreUnTurno({ isPrivate: true, testo: 'ciao' })).toBe(true);
    expect(apreUnTurno({ isPrivate: true, testo: undefined })).toBe(true);
  });

  it('in gruppo una riga qualsiasi non apre niente', () => {
    expect(apreUnTurno({ ...gruppo, testo: 'ragazzi che si fa stasera' })).toBe(false);
  });

  it('un comando apre, anche nella forma con il nome del bot', () => {
    expect(apreUnTurno({ ...gruppo, testo: '/stop' })).toBe(true);
    expect(apreUnTurno({ ...gruppo, testo: '/steer@MuffinAgentTestBot fai altro' })).toBe(true);
  });

  it('una reply a Muffin apre; una reply a qualcun altro no', () => {
    expect(apreUnTurno({ ...gruppo, testo: 'e questo?', citato: { da: 'muffin' } })).toBe(true);
    expect(apreUnTurno({ ...gruppo, testo: 'e questo?', citato: { da: 'altri' } })).toBe(false);
    expect(apreUnTurno({ ...gruppo, testo: 'e questo?', citato: { da: 'chi-scrive' } })).toBe(false);
  });

  it('una menzione apre, senza distinzione di maiuscole', () => {
    expect(apreUnTurno({ ...gruppo, testo: 'ehi @MuffinAgentTestBot ci sei?' })).toBe(true);
    expect(apreUnTurno({ ...gruppo, testo: 'ehi @muffinagenttestbot ci sei?' })).toBe(true);
  });

  it('un altro bot con un nome piu\' lungo non lo risveglia', () => {
    // `@MuffinAgentTestBot2` contiene `@MuffinAgentTestBot` come prefisso: senza
    // il confine di parola, ogni messaggio a quel bot aprirebbe un turno qui.
    expect(apreUnTurno({ ...gruppo, testo: 'ciao @MuffinAgentTestBot2' })).toBe(false);
    expect(apreUnTurno({ ...gruppo, testo: 'ciao @MuffinAgentTestBot_altro' })).toBe(false);
  });

  it('senza username non inventa menzioni: resta chiuso', () => {
    // Prima che `getMe` risponda, `meUsername` e' `undefined`. Fallire chiuso
    // e' l'unica direzione accettabile: un turno in piu' in un gruppo lo
    // vedono tutti.
    expect(apreUnTurno({ isPrivate: false, testo: 'ehi @MuffinAgentTestBot' })).toBe(false);
    expect(apreUnTurno({ isPrivate: false, testo: '/stop' })).toBe(true);
  });

  it('un messaggio senza testo ne allegato non apre niente', () => {
    expect(apreUnTurno({ ...gruppo, testo: undefined })).toBe(false);
    expect(apreUnTurno({ ...gruppo, testo: undefined, citato: { da: 'muffin' } })).toBe(true);
  });

  /**
   * PRE-21 PILOT — observer-off (owner decision, 2026-09-18): nei gruppi un
   * allegato o una posizione NON aprono un turno da soli. Il vecchio «un
   * allegato apre sempre» (non perdere il file) appartiene al futuro disegno
   * del contesto passivo di stanza. Un file apre quando e' indirizzato come
   * qualunque riga: reply a Muffin, @menzione, comando.
   */
  it('un allegato da solo, in gruppo, non apre niente — osservatore spento', () => {
    expect(apreUnTurno({ ...gruppo, testo: undefined, haAllegato: true })).toBe(false);
    expect(apreUnTurno({ ...gruppo, testo: 'guarda qua', haAllegato: true })).toBe(false);
    expect(apreUnTurno({ ...gruppo, testo: undefined, haAllegato: true, citato: { da: 'altri' } })).toBe(false);
  });

  it('un allegato indirizzato apre: reply a Muffin, menzione, comando', () => {
    expect(apreUnTurno({ ...gruppo, testo: undefined, haAllegato: true, citato: { da: 'muffin' } })).toBe(true);
    expect(apreUnTurno({ ...gruppo, testo: 'ehi @MuffinAgentTestBot guarda questo', haAllegato: true })).toBe(true);
    expect(apreUnTurno({ ...gruppo, testo: '/riassumi', haAllegato: true })).toBe(true);
  });

  it('in privata resta tutto aperto, allegato o no: non c\'e\' niente da indovinare', () => {
    expect(apreUnTurno({ isPrivate: true, testo: undefined, haAllegato: true })).toBe(true);
  });
});
