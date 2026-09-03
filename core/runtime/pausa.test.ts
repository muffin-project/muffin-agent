import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { Pausa } from './pausa.js';

describe('la pausa è un fatto durevole', () => {
  it('parte spenta, si mette, si toglie', () => {
    const db = new DatabaseCtor(':memory:');
    const p = new Pausa(db);
    expect(p.attiva()).toBe(false);
    expect(p.da()).toBeNull();
    p.metti('2026-09-03T10:00:00.000Z');
    expect(p.attiva()).toBe(true);
    expect(p.da()).toBe('2026-09-03T10:00:00.000Z');
    p.togli('2026-09-03T10:05:00.000Z');
    expect(p.attiva()).toBe(false);
    expect(p.da()).toBeNull();
  });

  it('un secondo processo sullo stesso database la vede — è la ragione per cui non è in memoria', () => {
    const db = new DatabaseCtor(':memory:');
    new Pausa(db).metti();
    // Una seconda istanza, come un secondo processo: nessuno stato condiviso
    // se non la tabella.
    expect(new Pausa(db).attiva()).toBe(true);
  });
});
