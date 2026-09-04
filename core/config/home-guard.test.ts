import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { giudica, homeDrift, markHome, raccontaDrift, watchedPaths, VOCI_DEL_GATEWAY } from './home-guard.js';

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
    expect(drift[0]!.kind).toBe('apparso');
    expect(raccontaDrift(drift[0]!)).toContain("non c'era prima della suite");
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
    expect(drift[0]!.kind).toBe('riscritto');
    expect(raccontaDrift(drift[0]!)).toContain('riscritto durante la suite');
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

/**
 * Il falso positivo del 04/09, e la sola indulgenza che compra.
 *
 * Una suite tutta verde (`Test Files 1 passed`) è uscita rossa perché
 * l'installazione viva dell'owner stava scrivendo la propria casa mentre i test
 * giravano. La guardia non si spegne e non diventa un avviso: impara a chiedere
 * **chi** ha scritto, e perdona solo ciò che un processo vivo possiede.
 */
describe('chi ha scritto: la casa viva non è una fuga', () => {
  /** La radice della casa, prima e dopo, come la vede `markHome`. */
  function casaConVoci(voci: string[]): { dir: string; marchio: () => ReturnType<typeof markHome> } {
    const d = casa();
    mkdirSync(join(d, '.muffin'), { recursive: true });
    for (const v of voci) writeFileSync(join(d, '.muffin', v), 'x');
    return { dir: d, marchio: () => markHome(d) };
  }

  const viva = (dir: string) => ({ pid: 4242, home: join(dir, '.muffin') });

  it('il socket ricreato da un gateway vivo si spiega, e non fa fallire', () => {
    // È letteralmente l'incidente: `gateway.sock` ricreato alle 02:25.
    const { dir, marchio } = casaConVoci(['config.json']);
    const prima = marchio();
    writeFileSync(join(dir, '.muffin', 'gateway.sock'), '');
    const drift = homeDrift(prima, marchio());
    expect(drift).toHaveLength(1);
    expect(drift[0]!.kind).toBe('voci');

    const g = giudica(drift, viva(dir));
    expect(g.fatali).toEqual([]);
    expect(g.spiegate).toHaveLength(1);
    // Il messaggio nomina la voce: prima diceva solo «è stato riscritto».
    expect(raccontaDrift(g.spiegate[0]!)).toContain('gateway.sock');
  });

  it('la stessa deriva SENZA nessuno che risponde resta fatale — è il ramo della CI', () => {
    const { dir, marchio } = casaConVoci(['config.json']);
    const prima = marchio();
    writeFileSync(join(dir, '.muffin', 'gateway.sock'), '');
    const g = giudica(homeDrift(prima, marchio()), null);
    expect(g.fatali).toHaveLength(1);
    expect(g.spiegate).toEqual([]);
  });

  it('una voce che un gateway non possiede è fatale anche mentre il gateway è vivo', () => {
    // Un test sfuggito non passa per compagnia: basta un nome sconosciuto
    // accanto a uno noto perché la riga torni fatale.
    const { dir, marchio } = casaConVoci([]);
    const prima = marchio();
    writeFileSync(join(dir, '.muffin', 'gateway.sock'), '');
    writeFileSync(join(dir, '.muffin', 'pippo.txt'), 'un test sfuggito');
    const g = giudica(homeDrift(prima, marchio()), viva(dir));
    expect(g.spiegate).toEqual([]);
    expect(g.fatali).toHaveLength(1);
    expect(raccontaDrift(g.fatali[0]!)).toContain('pippo.txt');
  });

  it('un gateway vivo su UN ALTRA casa non spiega niente qui', () => {
    const { dir, marchio } = casaConVoci([]);
    const prima = marchio();
    writeFileSync(join(dir, '.muffin', 'gateway.sock'), '');
    const g = giudica(homeDrift(prima, marchio()), { pid: 4242, home: '/altra/casa/.muffin' });
    expect(g.fatali).toHaveLength(1);
  });

  it('le voci perdonate sono solo cose che esistono perché un processo è vivo', () => {
    // Allargare questa lista allarga ciò che la guardia perdona. Nessuna di
    // queste è configurazione, e nessuna sopravvive al processo con uno stato.
    expect(VOCI_DEL_GATEWAY).toContain('gateway.sock');
    expect(VOCI_DEL_GATEWAY).toContain('muffin.db-wal');
    for (const mai of ['config.json', 'rot', 'secrets', 'skills', 'vault', 'muffin.db']) {
      expect(VOCI_DEL_GATEWAY).not.toContain(mai);
    }
  });
});

/**
 * Il vincolo non negoziabile: la nuova attribuzione **non** deve poter perdere
 * nessuna delle due fughe vere. Entrambe erano «un file che non c'era, adesso
 * c'è», e si riprovano qui con un gateway vivo che dichiara la stessa casa —
 * cioè nella condizione più indulgente che il codice sappia produrre.
 */
describe('le due fughe vere restano fatali, anche col gateway vivo', () => {
  const casi = [
    {
      nome: 'il LaunchAgent scritto nella ~/Library vera',
      scrivi: (d: string) => {
        mkdirSync(join(d, 'Library', 'LaunchAgents'), { recursive: true });
        writeFileSync(join(d, 'Library', 'LaunchAgents', 'ai.muffin.gateway.plist'), '<plist/>');
      },
      atteso: 'ai.muffin.gateway.plist',
    },
    {
      nome: 'la unit systemd comparsa nella ~/.config vera (27/08/2026)',
      scrivi: (d: string) => {
        mkdirSync(join(d, '.config', 'systemd', 'user'), { recursive: true });
        writeFileSync(join(d, '.config', 'systemd', 'user', 'muffin-gateway.service'), '[Unit]\n');
      },
      atteso: 'muffin-gateway.service',
    },
  ];

  for (const c of casi) {
    it(c.nome, () => {
      const d = casa();
      mkdirSync(join(d, '.muffin'), { recursive: true });
      const prima = markHome(d);
      c.scrivi(d);
      const drift = homeDrift(prima, markHome(d));
      const g = giudica(drift, { pid: 4242, home: join(d, '.muffin') });
      expect(g.spiegate).toEqual([]);
      expect(g.fatali).toHaveLength(1);
      expect(g.fatali[0]!.kind).toBe('apparso');
      expect(raccontaDrift(g.fatali[0]!)).toContain(c.atteso);
    });
  }

  it('e la casa che compare dal nulla è una fuga, non un gateway che parte', () => {
    // Un gateway vivo implica che la casa esisteva già: se compare durante la
    // suite, a crearla è stato qualcos altro.
    const d = casa();
    const prima = markHome(d);
    mkdirSync(join(d, '.muffin'), { recursive: true });
    const g = giudica(homeDrift(prima, markHome(d)), { pid: 4242, home: join(d, '.muffin') });
    expect(g.fatali).toHaveLength(1);
    expect(g.fatali[0]!.kind).toBe('apparso');
  });
});
