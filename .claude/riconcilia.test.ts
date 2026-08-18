import { describe, expect, it } from 'vitest';
import { baseDichiarata, branchDichiarativi, prDichiarateVive, riconcilia, sezioneInVolo } from './riconcilia.mjs';

/**
 * Il controllo che il handoff non racconti lavoro già fatto.
 *
 * Il difetto che questi test pinnano è successo davvero: `PERCORSO-CRITICO.md`
 * ha continuato a dire «in volo: #53, #54, slice/a1-continuita» per ore dopo che
 * quelle tre erano dentro `dev`, e una sessione fresca che avesse aperto quel
 * file sarebbe andata a rifare lavoro fatto. Le funzioni sotto sono pure apposta
 * per poterle provare senza rete e senza `gh`.
 */

const percorso = `# Percorso critico

**Aggiornato**: 2026-08-17 · base \`dev\` @ \`98e4787\`.

## 0 · In volo adesso

- **PR #60** \`slice/map-resourcefor\` — citazioni della mappa.
- **\`slice/session-taint\`** — WIP committato.

## 1 · Invarianti

| 1.1 | ~~\`slice/wal-intent\`~~ **fatto (#57)** | … |
`;

describe('riconcilia', () => {
  it('legge solo la sezione «in volo», non la cronaca sotto', () => {
    const sezione = sezioneInVolo(percorso);
    expect(sezione).toContain('#60');
    // #57 sta in tabella come lavoro *fatto*: fuori sezione, non è una
    // dichiarazione di lavoro vivo e non deve diventare un reperto.
    expect(sezione).not.toContain('#57');
  });

  it('prende le PR dichiarate vive dal percorso, e altrove solo se la riga lo dice', () => {
    const vive = prDichiarateVive([
      { nome: 'PERCORSO', testo: percorso, soloSezione: true },
      // Righe logiche separate da una riga vuota: l'unità di analisi è il
      // paragrafo, quindi una cronaca non va infilata nello stesso capoverso
      // di una dichiarazione di lavoro vivo.
      { nome: 'STATE', testo: '#12 è in giudizio\n\nil 16/08 sono entrate #28/#29\n', soloSezione: false },
    ]);
    expect([...vive.keys()].sort((a, b) => a - b)).toEqual([12, 60]);
    expect(vive.get(60)).toEqual(['PERCORSO']);
  });

  it('trova branch e base dichiarati', () => {
    expect(branchDichiarativi(percorso)).toEqual(['slice/map-resourcefor', 'slice/session-taint']);
    expect(baseDichiarata(percorso)).toBe('98e4787');
  });

  it('tace quando tutto è coerente', () => {
    const reperti = riconcilia({
      documenti: [{ nome: 'PERCORSO', testo: percorso, soloSezione: true }],
      statoPr: { 60: { state: 'OPEN', headRefName: 'slice/map-resourcefor' } },
      branchRemoti: ['slice/map-resourcefor', 'slice/session-taint', 'dev'],
      base: '98e4787',
      baseEsiste: true,
      baseAntenata: true,
    });
    expect(reperti).toEqual([]);
  });

  it('nomina una PR mergiata ancora descritta come in volo — il difetto del 17/08', () => {
    const reperti = riconcilia({
      documenti: [{ nome: 'PERCORSO', testo: percorso, soloSezione: true }],
      statoPr: { 60: { state: 'MERGED', headRefName: 'slice/map-resourcefor' } },
      branchRemoti: ['slice/map-resourcefor', 'slice/session-taint'],
      base: null,
      baseEsiste: null,
      baseAntenata: null,
    });
    expect(reperti).toHaveLength(1);
    expect(reperti[0]).toMatch(/#60 è mergiata/);
  });

  it('nomina un branch sparito e una base che non è più antenata', () => {
    const reperti = riconcilia({
      documenti: [{ nome: 'PERCORSO', testo: percorso, soloSezione: true }],
      statoPr: { 60: { state: 'OPEN', headRefName: 'slice/map-resourcefor' } },
      branchRemoti: ['slice/map-resourcefor'],
      base: '3068ece',
      baseEsiste: true,
      baseAntenata: false,
    });
    expect(reperti.join('\n')).toMatch(/slice\/session-taint.*non esiste su origin/s);
    expect(reperti.join('\n')).toMatch(/3068ece.*non è un antenato/s);
  });
});
