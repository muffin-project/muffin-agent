import { describe, expect, it } from 'vitest';
import { hostContiene } from './sandbox-host.js';

/**
 * L'interruttore che decide se uno scenario viene **esercitato o saltato**.
 *
 * È il pezzo di codice più pericoloso di questa slice, e per una ragione
 * asimmetrica: se sbaglia dicendo «non provabile» quando invece si poteva
 * provare, la suite resta verde senza aver esercitato nulla — cioè diventa
 * esattamente il verde falso che il rosso falso doveva sostituire. Per questo
 * la domanda va a bwrap e non a Muffin, e per questo il ramo Linux è
 * verificabile da macOS invece di essere codice che gira solo dove nessuno
 * guarda.
 */
describe('hostContiene', () => {
  const boom = (msg: string) => () => {
    throw new Error(msg);
  };

  it('su macOS non c\'è niente da dichiarare: seatbelt è nel sistema', () => {
    expect(hostContiene(boom('mai chiamato'), 'darwin')).toEqual({ ok: true });
  });

  it('su Linux dove bwrap contiene, lo scenario si esercita', () => {
    expect(hostContiene(() => {}, 'linux')).toEqual({ ok: true });
  });

  it('su Linux dove bwrap non monta /proc, dichiara il motivo vero', () => {
    // Le parole del container misurate il 27/08. Il motivo deve arrivare
    // all'output: un salto silenzioso è indistinguibile da una prova.
    const esito = hostContiene(
      boom('Command failed\nbwrap: Can\'t mount proc on /newroot/proc: Operation not permitted\n'),
      'linux',
    );
    expect(esito.ok).toBe(false);
    if (esito.ok) return;
    expect(esito.perche).toContain("Can't mount proc");
  });

  it('e se bwrap manca del tutto lo dice, invece di far finta di aver provato', () => {
    const esito = hostContiene(boom('spawnSync bwrap ENOENT'), 'linux');
    expect(esito.ok).toBe(false);
    if (esito.ok) return;
    expect(esito.perche).toContain('ENOENT');
  });

  it('una piattaforma senza meccanismo noto non passa per «ok»', () => {
    // Il verso in cui degradare: sconosciuto non è contenuto.
    expect(hostContiene(boom('mai chiamato'), 'win32').ok).toBe(false);
  });

  it('chiede a bwrap **esattamente** ciò che serve a Muffin, `--proc` compreso', () => {
    // `--proc` è ciò che fallisce dentro Docker, quindi è ciò che va chiesto:
    // un probe più permissivo di ciò che il runtime fa direbbe «si può» dove
    // il runtime poi non può, e il salto diventerebbe un rosso di nuovo.
    let visti: string[] = [];
    hostContiene((_f, args) => {
      visti = args;
    }, 'linux');
    expect(visti).toContain('--proc');
    expect(visti).toContain('--unshare-all');
  });
});
