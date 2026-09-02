import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { makeFondo } from './fondo.js';
import { applica } from './schermo.js';
import { makeTextzone, rigaDelCursore } from './textzone.js';
import type { Cornice } from './riquadro.js';

/**
 * La casella sta giù e il testo scorre sopra — misurato sullo schermo, non
 * sui byte (`cli/schermo.ts`, stessa lezione di `textzone-schermo.test.ts`).
 *
 * Lo schermo è alto dodici righe di proposito: abbastanza poco da far
 * scorrere davvero una risposta di venti righe, così «lo scrollback resta» è
 * una cosa che si controlla e non che si spera. E il terminale finto risponde
 * a `ESC[6n` come uno vero, con la posizione che il misuratore calcola: è la
 * risposta che decide se il fondo si aggancia.
 */

const RIGHE = 12;

const CORNICE: Cornice = {
  prompt: '› ',
  suggerimenti: 'invio spedisce',
  etichetta: 'modello · sessione',
  smorza: (s) => s,
};

/** Dieci righe già a schermo: il riquadro (quattro righe) non ci entra più sotto. */
const PIENO = Array.from({ length: 10 }, (_, i) => (i === 0 ? 'risposta del turno prima' : `riga ${i}`));
/** Tre righe: ci entra, e il fondo non deve agganciarsi. */
const VUOTO = ['risposta del turno prima', 'seconda riga', ''];

function tastieraFinta(): PassThrough & { isTTY: boolean; setRawMode: (v: boolean) => void } {
  const s = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (v: boolean) => void };
  s.isTTY = true;
  s.setRawMode = () => {};
  return s;
}

/** Uno schermo finto alto dodici righe che sa rispondere «dove sta il cursore». */
function schermoFinto(prima: readonly string[], input?: PassThrough) {
  const scritture: string[] = [`${prima.join('\n')}\n`];
  const out = {
    scritture,
    columns: 60,
    rows: RIGHE,
    isTTY: true as const,
    write: (c: string) => {
      if (c.includes('\x1b[6n') && input !== undefined) {
        const s = applica(scritture, { righe: RIGHE });
        setImmediate(() => input.write(`\x1b[${String(s.riga + 1)};${String(s.colonna + 1)}R`));
        return true;
      }
      scritture.push(c);
      return true;
    },
  };
  return out;
}

const schermo = (scritture: string[]) => applica(scritture, { righe: RIGHE });
const riquadri = (righe: readonly string[]): number => righe.filter((r) => r.startsWith('╭')).length;
const ultimoRiquadro = (righe: readonly string[]): number => righe.findLastIndex((r) => r.startsWith('╭'));

function apparecchia(prima: readonly string[] = PIENO) {
  const input = tastieraFinta();
  const output = schermoFinto(prima, input);
  const fondo = makeFondo(output);
  const tz = makeTextzone({ input: input as never, output: output as never, fondo });
  return { input, output, fondo, tz };
}

async function batti(input: PassThrough, testo: string): Promise<void> {
  for (const c of testo) {
    input.write(c);
    await new Promise((r) => setImmediate(r));
  }
}

async function spedisci(input: PassThrough, letto: Promise<unknown>): Promise<void> {
  input.write('\r');
  await letto;
}

describe('il misuratore capisce i margini', () => {
  it('un a capo sull ultima riga del margine scorre, e con il margine in cima la riga esce nello scrollback', () => {
    const s = applica(['\x1b[1;3r', '\x1b[3;1H', 'a\nb\nc\n'], { righe: 5 });
    expect(s.scrollback).toEqual(['', '', 'a']);
    expect(s.righe.slice(0, 3)).toEqual(['b', 'c', '']);
    expect(s.righe.slice(3)).toEqual(['', '']); // fuori dal margine: intoccato
  });

  it('con il margine superiore piu in basso di uno, cio che esce si perde — e il misuratore lo dice', () => {
    const s = applica(['\x1b[2;3r', '\x1b[3;1H', 'a\nb\nc\n'], { righe: 5 });
    expect(s.scrollback).toEqual([]);
  });

  it('impostare i margini manda il cursore a casa', () => {
    const s = applica(['\x1b[4;1H', '\x1b[1;3r'], { righe: 5 });
    expect(s.riga).toBe(0);
    expect(s.colonna).toBe(0);
  });

  it('salva e ripristina il cursore, e ignora i modi privati', () => {
    const s = applica(['\x1b[3;5H', '\x1b7', '\x1b[1;1H', 'x', '\x1b8', '\x1b[?2004h', 'y'], { righe: 5 });
    expect(s.righe[2]).toBe('    y');
  });
});

describe('dove sta il cursore', () => {
  it('legge la risposta del terminale e rimette nello stream quello che non era la risposta', async () => {
    const input = tastieraFinta();
    const output = schermoFinto([], input);
    const promessa = rigaDelCursore(input as never, output);
    // Un tasto premuto in anticipo, prima della risposta.
    setImmediate(() => input.write('q'));
    const riga = await promessa;
    // Lo schermo finto parte con un a capo: il cursore sta sulla seconda riga.
    expect(riga).toBe(2);
    input.resume();
    const rimasto = await new Promise<string>((r) => input.once('data', (c) => r(String(c))));
    expect(rimasto).toBe('q');
  });

  it('senza risposta torna null in fretta', async () => {
    const input = tastieraFinta();
    const output = schermoFinto([]);
    expect(await rigaDelCursore(input as never, output, 20)).toBeNull();
  });
});

describe('finche il riquadro ci entra sotto, niente cambia', () => {
  it('lo schermo mezzo vuoto tiene il riquadro sotto il contenuto, senza margini', async () => {
    const { input, output, fondo, tz } = apparecchia(VUOTO);
    const letto = tz.read(CORNICE);
    await batti(input, 'ciao');
    expect(fondo.aperto).toBe(false);
    const s = schermo(output.scritture);
    expect(riquadri(s.righe)).toBe(1);
    expect(ultimoRiquadro(s.righe)).toBe(3);
    expect(s.scrollback).toEqual([]);
    await spedisci(input, letto);
  });
});

describe('quando il contenuto arriva in fondo, la casella si aggancia', () => {
  it('si scorre del minimo, e il riquadro sta nelle ultime righe con il cursore dentro', async () => {
    const { input, output, fondo, tz } = apparecchia();
    const letto = tz.read(CORNICE);
    await batti(input, 'ciao');
    expect(fondo.aperto).toBe(true);
    const s = schermo(output.scritture);

    expect(riquadri(s.righe)).toBe(1);
    expect(ultimoRiquadro(s.righe)).toBe(RIGHE - 4);
    expect(s.righe[RIGHE - 3]).toContain('› ciao');
    expect(s.righe[RIGHE - 1]).toContain('invio spedisce');
    expect(s.riga).toBe(RIGHE - 3);
    // Sono uscite solo le righe che servivano: il cursore stava sull'undicesima
    // riga (dieci di contenuto e un a capo), quattro di riquadro su dodici,
    // quindi tre. La riga del cursore — vuota — è l'ultima della regione.
    expect(s.scrollback).toEqual(['risposta del turno prima', 'riga 1', 'riga 2']);
    expect(s.righe[RIGHE - 5]).toBe('');
    expect(s.righe[RIGHE - 6]).toBe('riga 9');
    await spedisci(input, letto);
  });

  it('spedito, il messaggio va nella storia come riquadro e in fondo ne resta uno vuoto', async () => {
    const { input, output, tz } = apparecchia();
    const letto = tz.read(CORNICE);
    await batti(input, 'ciao');
    await spedisci(input, letto);
    const s = schermo(output.scritture);

    expect([...s.scrollback, ...s.righe].join('\n')).toContain('› ciao');
    expect(riquadri(s.righe)).toBe(2);
    expect(ultimoRiquadro(s.righe)).toBe(RIGHE - 4);
    expect(s.righe[RIGHE - 3]).toMatch(/│ ›\s+│/);
    // Il cursore e tornato nella regione, sull'ultima riga, colonna 1.
    expect(s.riga).toBe(RIGHE - 5);
    expect(s.colonna).toBe(0);
  });

  it('una risposta di venti righe scorre sopra la casella, e la casella non si muove', async () => {
    const { input, output, tz } = apparecchia();
    const letto = tz.read(CORNICE);
    await batti(input, 'ciao');
    await spedisci(input, letto);
    // Come il REPL: la risposta va su stdout, byte nudi, dalla regione.
    for (let i = 0; i < 20; i++) output.write(`riga ${i} della risposta\n`);
    const s = schermo(output.scritture);

    expect(riquadri(s.righe)).toBe(1);
    expect(ultimoRiquadro(s.righe)).toBe(RIGHE - 4);
    expect(s.righe[RIGHE - 5]).toBe('');
    expect(s.righe[RIGHE - 6]).toBe('riga 19 della risposta');
    expect(s.scrollback.join('\n')).toContain('riga 0 della risposta');
    expect(s.scrollback.join('\n')).toContain('› ciao');
    expect(s.scrollback.indexOf('riga 0 della risposta')).toBeLessThan(s.scrollback.indexOf('riga 1 della risposta'));
  });

  it('una consegna che arriva mentre scrivi finisce sopra la casella, e il testo digitato resta', async () => {
    const { input, output, tz } = apparecchia();
    const letto = tz.read(CORNICE);
    await batti(input, 'sto scriv');
    // `makeReplCliWrite`, alla lettera: togli, scrivi, rimetti.
    tz.cancella();
    output.write('\n⏰ arrivato un promemoria\n');
    tz.redraw();
    await batti(input, 'endo');
    const s = schermo(output.scritture);

    expect(riquadri(s.righe)).toBe(1);
    expect(s.righe[RIGHE - 3]).toContain('› sto scrivendo');
    expect(s.righe.slice(0, RIGHE - 4).join('\n')).toContain('⏰ arrivato un promemoria');
    expect(s.riga).toBe(RIGHE - 3);
    await spedisci(input, letto);
  });

  it('fra un turno e l altro, redraw rimette la casella vuota — dopo un SIGWINCH serve', async () => {
    const { input, output, tz, fondo } = apparecchia();
    const letto = tz.read(CORNICE);
    await batti(input, 'x');
    await spedisci(input, letto);
    output.write('la risposta\n');
    fondo.ridimensiona();
    tz.redraw();
    const s = schermo(output.scritture);
    expect(ultimoRiquadro(s.righe)).toBe(RIGHE - 4);
    expect(s.righe[RIGHE - 3]).toMatch(/│ ›\s+│/);
    expect(s.riga).toBe(RIGHE - 5);
  });

  it('la lettura dopo non chiede piu dove sta il cursore: agganciato una volta, resta', async () => {
    const { input, output, tz, fondo } = apparecchia();
    let letto = tz.read(CORNICE);
    await batti(input, 'a');
    await spedisci(input, letto);
    const richieste = () => output.scritture.filter((c) => c.includes('\x1b[6n')).length;
    // La risposta al DSR non viene registrata, quindi le richieste non compaiono in `scritture`:
    // si conta invece che `aperto` resti vero e che la seconda lettura disegni subito nel fondo.
    expect(fondo.aperto).toBe(true);
    letto = tz.read(CORNICE);
    await batti(input, 'b');
    const s = schermo(output.scritture);
    expect(s.righe[RIGHE - 3]).toContain('› b');
    expect(richieste()).toBe(0);
    await spedisci(input, letto);
  });
});

describe('il fondo cresce e si stringe senza perdere il cursore della regione', () => {
  function agganciato() {
    const output = schermoFinto(PIENO);
    const fondo = makeFondo(output);
    expect(fondo.aggancia(PIENO.length + 1, 4)).toBe(true);
    fondo.disegna(['a', 'b', 'c', 'd'], null);
    return { output, fondo };
  }

  it('crescendo di due righe durante uno streaming, il testo sale di due e il cursore lo segue', () => {
    const { output, fondo } = agganciato();
    output.write('streaming…');
    fondo.disegna(['a', 'b', 'c', 'd', 'e', 'f'], null);
    const s = schermo(output.scritture);
    expect(s.righe[RIGHE - 7]).toBe('streaming…');
    expect(s.riga).toBe(RIGHE - 7);
    expect(s.colonna).toBe('streaming…'.length);
    expect(s.righe.slice(RIGHE - 6)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('stringendosi, le righe liberate sono pulite e il cursore resta dov era', () => {
    const { output, fondo } = agganciato();
    fondo.disegna(['a', 'b', 'c', 'd', 'e', 'f'], null);
    output.write('testo');
    fondo.disegna(['a', 'b', 'c', 'd'], null);
    const s = schermo(output.scritture);
    expect(s.righe[RIGHE - 7]).toBe('testo');
    expect(s.riga).toBe(RIGHE - 7);
    expect(s.righe.slice(RIGHE - 6)).toEqual(['', '', 'a', 'b', 'c', 'd']);
  });

  it('chiudi toglie i margini e lascia il cursore sotto la casella', () => {
    const { output, fondo } = agganciato();
    fondo.chiudi();
    output.write('$ ');
    const s = schermo(output.scritture);
    expect([...s.scrollback, ...s.righe].join('\n')).toContain('d');
    expect(s.righe[RIGHE - 1]).toBe('$ ');
  });

  it('senza altezza non fa niente', () => {
    const output = { ...schermoFinto(PIENO), rows: undefined };
    const fondo = makeFondo(output as never);
    expect(fondo.attivo).toBe(false);
    expect(fondo.aggancia(11, 4)).toBe(false);
    fondo.disegna(['a'], null);
    expect(output.scritture).toHaveLength(1);
  });
});
