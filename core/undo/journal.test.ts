import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UndoJournal, copyNameFor } from './journal.js';

function scratch(): { root: string; work: string } {
  const base = mkdtempSync(join(tmpdir(), 'muffin-undo-'));
  const work = join(base, 'work');
  mkdirSync(work, { recursive: true });
  return { root: join(base, 'undo'), work };
}

describe('UndoJournal', () => {
  it('puts back what was there before', () => {
    const { root, work } = scratch();
    const j = new UndoJournal(root);
    const f = join(work, 'nota.md');
    writeFileSync(f, 'prima', 'utf8');

    j.take('t1', { callId: 'toolu_1', capability: 'fs.write', path: f });
    writeFileSync(f, 'dopo', 'utf8');

    expect(j.restore('t1')?.problems).toEqual([]);
    expect(readFileSync(f, 'utf8')).toBe('prima');
  });

  it('removes a file that did not exist before the turn', () => {
    // `copy: null` non è «niente da fare»: è l'informazione che tornare
    // indietro vuol dire togliere. Un undo che lascia il file creato ha
    // ripristinato metà turno e detto di averlo ripristinato tutto.
    const { root, work } = scratch();
    const j = new UndoJournal(root);
    const f = join(work, 'nuovo.md');

    j.take('t1', { callId: 'c', capability: 'fs.write', path: f });
    writeFileSync(f, 'creato dal turno', 'utf8');

    j.restore('t1');
    expect(existsSync(f)).toBe(false);
  });

  it('undoes two writes to the same file back to the FIRST state, not the second', () => {
    // Questa è la ragione dell'ordine inverso, e l'unico test che la vede: in
    // avanti l'ultima copia applicata sarebbe la penultima scrittura, e il
    // file resterebbe a uno stato intermedio che non è mai stato «prima».
    const { root, work } = scratch();
    const j = new UndoJournal(root);
    const f = join(work, 'nota.md');
    writeFileSync(f, 'v0', 'utf8');

    j.take('t1', { callId: 'c1', capability: 'fs.write', path: f });
    writeFileSync(f, 'v1', 'utf8');
    j.take('t1', { callId: 'c2', capability: 'fs.write', path: f });
    writeFileSync(f, 'v2', 'utf8');

    j.restore('t1');
    expect(readFileSync(f, 'utf8')).toBe('v0');
  });

  it('keeps two writes in one turn as two copies', () => {
    const { root, work } = scratch();
    const j = new UndoJournal(root);
    const f = join(work, 'nota.md');
    writeFileSync(f, 'v0', 'utf8');
    j.take('t1', { callId: 'c', capability: 'fs.write', path: f });
    writeFileSync(f, 'v1', 'utf8');
    j.take('t1', { callId: 'c', capability: 'fs.write', path: f });

    const entry = j.read('t1');
    expect(entry?.snapshots).toHaveLength(2);
    // Stesso callId, due copie: se il nome dipendesse solo dal callId la
    // seconda sovrascriverebbe la prima e l'ordine inverso non avrebbe niente
    // da applicare.
    expect(new Set(entry?.snapshots.map((s) => s.copy)).size).toBe(2);
  });

  it('throws instead of reporting success when the copy cannot be taken', () => {
    // Il contratto su cui poggia tutto il ramo `draft`: se `take` fallisse in
    // silenzio, il loop eseguirebbe la scrittura credendo di avere una copia.
    const { root, work } = scratch();
    const j = new UndoJournal(root);
    const f = join(work, 'nota.md');
    writeFileSync(f, 'prima', 'utf8');
    mkdirSync(root, { recursive: true });
    chmodSync(root, 0o500); // read+execute: si entra, non si scrive
    try {
      expect(() => j.take('t1', { callId: 'c', capability: 'fs.write', path: f })).toThrow();
    } finally {
      chmodSync(root, 0o700);
    }
  });

  it('rifiuta di fotografare qualcosa che esiste e non è un file', () => {
    // `copy: null` significa «non c'era niente prima», e un undo lo legge come
    // «togli». Una directory registrata così sarebbe un manifest che mente su
    // cosa c'era; la regola del file dice che allora l'effetto non deve
    // avvenire, non che si annota un dato falso e si spera. Judge della slice.
    const { root, work } = scratch();
    const j = new UndoJournal(root);
    const dir = join(work, 'una-directory');
    mkdirSync(dir, { recursive: true });
    expect(() => j.take('t1', { callId: 'c', capability: 'fs.write', path: dir })).toThrow(
      /non è un file regolare/,
    );
  });

  it('reports a missing copy as a problem instead of claiming the file was restored', () => {
    const { root, work } = scratch();
    const j = new UndoJournal(root);
    const f = join(work, 'nota.md');
    writeFileSync(f, 'prima', 'utf8');
    const snap = j.take('t1', { callId: 'c', capability: 'fs.write', path: f });
    writeFileSync(f, 'dopo', 'utf8');
    // Qualcuno ha svuotato ~/.muffin/undo a mano.
    rmSync(join(root, 't1', snap.copy!));

    const esito = j.restore('t1');
    expect(esito?.restored).toEqual([]);
    expect(esito?.problems).toHaveLength(1);
    expect(readFileSync(f, 'utf8')).toBe('dopo');
  });

  it('refuses to write a copy outside the turn directory, whatever the provider called the call', () => {
    // Il callId sono byte del provider. `../../` dentro un nome di file è la
    // via più corta perché un registro di sicurezza scriva fuori da sé.
    expect(copyNameFor('../../rot/policy.json', 0)).toBe('000-______rot_policy_json');
    expect(copyNameFor('', 3)).toBe('003-call');
  });

  it('lists the newest turn first and forgets one on request', () => {
    const { root, work } = scratch();
    const j = new UndoJournal(root);
    writeFileSync(join(work, 'a'), 'a', 'utf8');
    j.take('vecchio', { callId: 'c', capability: 'fs.write', path: join(work, 'a') });
    j.take('nuovo', { callId: 'c', capability: 'fs.write', path: join(work, 'a') });

    expect(j.turns()[0]).toBe('nuovo');
    j.forget('nuovo');
    expect(j.turns()).toEqual(['vecchio']);
  });

  it('reads nothing from a corrupted manifest instead of throwing', () => {
    const { root, work } = scratch();
    const j = new UndoJournal(root);
    writeFileSync(join(work, 'a'), 'a', 'utf8');
    j.take('t1', { callId: 'c', capability: 'fs.write', path: join(work, 'a') });
    writeFileSync(join(root, 't1', 'manifest.json'), '{ tronc', 'utf8');

    expect(j.read('t1')).toBeNull();
    expect(j.restore('t1')).toBeNull();
  });
});
