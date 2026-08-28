import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from '../core/config/config.js';
import { UndoJournal } from '../core/undo/journal.js';
import { cmdUndo, undoOfId } from './undo.js';

/**
 * Una home di prova con un turno già registrato nel journal.
 *
 * L'orologio è **fermo**, e non per comodità: è la condizione che faceva
 * fallire `--last`. Due turni scritti nello stesso millisecondo sono la norma
 * su Linux — misurato il 28/08/2026, 10 giri su 12 in un container — e con
 * l'orologio vero questi test dipendevano da quanto era veloce la macchina.
 * Fermarlo qui li rende una prova della riparazione invece che della fortuna.
 */
function homeConTurno(contenutoPrima = 'prima'): { home: string; file: string; journal: UndoJournal } {
  const home = mkdtempSync(join(tmpdir(), 'muffin-cli-undo-'));
  const work = mkdtempSync(join(tmpdir(), 'muffin-cli-undo-work-'));
  const file = join(work, 'nota.md');
  writeFileSync(file, contenutoPrima, 'utf8');
  const journal = new UndoJournal(paths(home).undo, () => new Date('2026-08-28T12:00:00.000Z'));
  journal.take('t1', { callId: 'toolu_1', capability: 'fs.write', path: file });
  writeFileSync(file, 'dopo', 'utf8');
  return { home, file, journal };
}

let out: string[];
let err: string[];
beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c) => (out.push(String(c)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((c) => (err.push(String(c)), true));
});
afterEach(() => vi.restoreAllMocks());

describe('muffin undo', () => {
  it('senza argomenti elenca cosa si può disfare', () => {
    const { home, file } = homeConTurno();
    expect(cmdUndo([], home)).toBe(0);
    expect(out.join('')).toContain('t1');
    expect(out.join('')).toContain(file);
  });

  it('su una home senza niente da disfare lo dice invece di fallire', () => {
    // Un `muffin undo` a vuoto è la domanda «cosa posso disfare?», e zero è
    // una risposta valida: uscire 1 qui insegnerebbe a leggere «errore» dove
    // c'è «niente da fare».
    const home = mkdtempSync(join(tmpdir(), 'muffin-cli-undo-'));
    expect(cmdUndo([], home)).toBe(0);
    expect(out.join('')).toContain('niente da disfare');
  });

  it('senza --yes stampa cosa farebbe e non tocca il file', () => {
    const { home, file } = homeConTurno();
    expect(cmdUndo(['t1'], home)).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe('dopo');
    expect(out.join('')).toContain('--yes');
  });

  it('con --yes rimette il file com\'era', () => {
    const { home, file } = homeConTurno();
    expect(cmdUndo(['t1', '--yes'], home)).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe('prima');
  });

  /**
   * `t1` e `t2` con lo stesso istante, e l'ordine alfabetico è quello
   * **sbagliato**: prima della riparazione `--last` prendeva `t1` e rimetteva
   * «prima», cioè disfaceva il turno sbagliato. Rosso in 10 giri su 12 dentro
   * un container Linux, sempre verde su macOS.
   */
  it('--last prende il turno più recente, anche a parità di istante', () => {
    const { home, file, journal } = homeConTurno();
    journal.take('t2', { callId: 'c', capability: 'fs.write', path: file });
    writeFileSync(file, 'dopo ancora', 'utf8');

    expect(cmdUndo(['--last', '--yes'], home)).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe('dopo');
  });

  /**
   * Il pareggio vero: stesso istante **e** stesso numero d'ordine, cioè due
   * processi che hanno creato un turno insieme. Su un'operazione distruttiva
   * non si tira a sorte — l'owner riceve i due nomi e sceglie lui.
   */
  it("e quando i due in testa sono indistinguibili, si rifiuta invece di indovinare", () => {
    const { home, file, journal } = homeConTurno();
    journal.take('t2', { callId: 'c', capability: 'fs.write', path: file });
    writeFileSync(file, 'dopo ancora', 'utf8');
    const manifest = join(paths(home).undo, 't2', 'manifest.json');
    const m = JSON.parse(readFileSync(manifest, 'utf8')) as { seq: number };
    writeFileSync(manifest, JSON.stringify({ ...m, seq: 1 }), 'utf8');

    expect(cmdUndo(['--last', '--yes'], home)).toBe(1);
    // Il file non è stato toccato: un rifiuto è un rifiuto.
    expect(readFileSync(file, 'utf8')).toBe('dopo ancora');
    expect(err.join('')).toContain('muffin undo t1 --yes');
    expect(err.join('')).toContain('muffin undo t2 --yes');
  });

  it('mette da parte lo stato attuale, così anche l\'undo si disfa', () => {
    // È la ragione per cui `muffin restore` mette da parte il database prima
    // di sostituirlo: chi disfà il turno sbagliato non deve perdere il lavoro
    // fatto dopo. Senza questa rete, `undo` è esso stesso una scrittura
    // irreversibile — cioè la cosa da cui `undo` esiste per proteggere.
    const { home, file } = homeConTurno();
    cmdUndo(['t1', '--yes'], home);
    expect(readFileSync(file, 'utf8')).toBe('prima');

    expect(cmdUndo([undoOfId('t1'), '--yes'], home)).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe('dopo');
  });

  it('dimentica un turno solo con --yes, e senza mostra cosa butterebbe', () => {
    // Era l'unica azione distruttiva del file senza cancello, e il test
    // precedente lo sanciva come voluto. Il judge della slice l'ha nominata:
    // il restore sovrascrive dei file che da qui si recuperano ancora, questo
    // butta **l'unica** copia — quindi merita il cancello più del restore, non
    // meno.
    const { home, journal, file } = homeConTurno();
    expect(cmdUndo(['--dimentica', 't1'], home)).toBe(1);
    expect(journal.turns()).toEqual(['t1']);
    expect(out.join('')).toContain(file);

    expect(cmdUndo(['--dimentica', 't1', '--yes'], home)).toBe(0);
    expect(journal.turns()).toEqual([]);
  });

  it('dice quale turno non conosce invece di uscire in silenzio', () => {
    const { home } = homeConTurno();
    expect(cmdUndo(['t9', '--yes'], home)).toBe(1);
    expect(err.join('')).toContain('t9');
  });

  it('dopo un undo riuscito butta le copie del turno disfatto, e tiene la rete', () => {
    const { home, journal } = homeConTurno();
    cmdUndo(['t1', '--yes'], home);
    expect(journal.turns()).toEqual([undoOfId('t1')]);
  });
});
