import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { homeDrift, markHome, watchedPaths } from './home-guard.js';

const case_: string[] = [];
afterAll(() => { for (const d of case_) rmSync(d, { recursive: true, force: true }); });

function casa(): string {
  const d = mkdtempSync(join(tmpdir(), 'muffin-guard-'));
  case_.push(d);
  return d;
}

describe('la guardia sulla casa vera', () => {
  it('sorveglia i posti dove Muffin installa, non la home intera', () => {
    // Un glob su `~` prometterebbe più di quanto questo file mantiene, e il
    // primo falso positivo lo farebbe spegnere entro la settimana.
    const p = watchedPaths('/home/o');
    expect(p).toContain('/home/o/.muffin');
    expect(p).toContain('/home/o/Library/LaunchAgents/ai.muffin.gateway.plist');
    expect(p).toContain('/home/o/.config/systemd/user/muffin-gateway.service');
  });

  it('una casa intatta non produce niente', () => {
    const d = casa();
    expect(homeDrift(markHome(d), markHome(d))).toEqual([]);
  });

  it('un file comparso dal nulla è il caso che ha morso due volte', () => {
    // `assente` è un valore, non "niente da confrontare": trattarlo come
    // assenza di dato renderebbe invisibile esattamente questo.
    const d = casa();
    const prima = markHome(d);
    mkdirSync(join(d, '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(join(d, '.config', 'systemd', 'user', 'muffin-gateway.service'), '[Unit]\n');
    const drift = homeDrift(prima, markHome(d));
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain('non c era prima della suite'.replace('c era', "c'era"));
  });

  it('un file riscritto durante la suite si distingue da uno comparso', () => {
    const d = casa();
    const plist = join(d, 'Library', 'LaunchAgents');
    mkdirSync(plist, { recursive: true });
    writeFileSync(join(plist, 'ai.muffin.gateway.plist'), 'vecchio');
    const prima = markHome(d);
    writeFileSync(join(plist, 'ai.muffin.gateway.plist'), 'nuovo e piu lungo');
    const drift = homeDrift(prima, markHome(d));
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain('riscritto durante la suite');
  });

  it('XDG_CONFIG_HOME sposta i percorsi sorvegliati, come sposta quelli veri', () => {
    const p = watchedPaths('/home/o', '/altrove/cfg');
    expect(p).toContain('/altrove/cfg/systemd/user/muffin-gateway.service');
    expect(p).not.toContain('/home/o/.config/systemd/user/muffin-gateway.service');
  });
});

/**
 * La cucitura che una guardia non può provare da sola.
 *
 * Se `globalSetup` sparisce dalla config, la suite passa — è precisamente il
 * modo in cui una difesa smette di difendere restando verde. L'unico modo di
 * tenerla è leggere la config come dato, dall'interno.
 *
 * Entrambe le config, non solo quella veloce: l'accettazione lancia processi
 * `node` veri che eseguono la CLI vera, ed è la suite che ha più modi di
 * uscire dalla home temporanea, non meno.
 */
describe('la guardia è armata, in tutte e due le suite', () => {
  for (const config of ['vitest.config.ts', 'vitest.acceptance.config.ts']) {
    it(`${config} nomina il globalSetup`, () => {
      const testo = readFileSync(join(import.meta.dirname, '..', '..', config), 'utf8');
      expect(testo).toContain("globalSetup: ['./vitest.home-guard.ts']");
    });
  }

  it('il globalSetup lancia, e non si limita a stampare', () => {
    // Una riga di log in fondo a duemila test verdi non la legge nessuno.
    const testo = readFileSync(join(import.meta.dirname, '..', '..', 'vitest.home-guard.ts'), 'utf8');
    expect(testo).toContain('throw new Error');
  });
});
