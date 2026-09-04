import { describe, expect, it } from 'vitest';
// @ts-expect-error — modulo .mjs senza dichiarazioni: e uno strumento da riga
// di comando, non una dipendenza del runtime, e resta importato com'e.
import { classifica } from './igiene.mjs';

/**
 * Il gruppo che conta e il terzo.
 *
 * Il 04/09/2026 il repository aveva 90 rami locali, e dentro uno chiamato
 * `worktree-agent-ae7010a13828febbd` c'erano sei commit di undo semantico —
 * il punto 5 del percorso critico. Non erano sporcizia: erano lavoro finito e
 * perso di vista, ritrovati per caso mentre si cancellava altro. Questi test
 * fissano la sola regola che li avrebbe fatti vedere.
 */
describe('il censimento dei rami', () => {
  const dentroDev = (b: string) => b.startsWith('integrato');
  const prAperte = new Set(['con-pr']);

  it('chiama abbandonato un ramo con lavoro che nessuna PR sta guardando', () => {
    const { abbandonati } = classifica(['worktree-agent-ae7010a', 'con-pr', 'integrato-x'], dentroDev, prAperte);
    expect(abbandonati).toEqual(['worktree-agent-ae7010a']);
  });

  it('non chiama abbandonato un ramo con una PR aperta', () => {
    const { inLavorazione, abbandonati } = classifica(['con-pr'], dentroDev, prAperte);
    expect(inLavorazione).toEqual(['con-pr']);
    expect(abbandonati).toEqual([]);
  });

  it('mette fra gli integrati solo cio che dev contiene davvero', () => {
    const { integrati, abbandonati } = classifica(['integrato-a', 'orfano-b'], dentroDev, prAperte);
    expect(integrati).toEqual(['integrato-a']);
    // La direzione dell'errore e decisa: nel dubbio un ramo finisce fra gli
    // abbandonati, che si segnalano, mai fra gli integrati, che si cancellano.
    expect(abbandonati).toEqual(['orfano-b']);
  });

  it('mette ogni ramo in un gruppo solo', () => {
    const rami = ['integrato-a', 'con-pr', 'orfano-b'];
    const { integrati, inLavorazione, abbandonati } = classifica(rami, dentroDev, prAperte);
    expect([...integrati, ...inLavorazione, ...abbandonati].sort()).toEqual([...rami].sort());
  });
});
