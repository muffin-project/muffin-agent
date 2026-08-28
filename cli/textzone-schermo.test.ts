import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { applica } from './schermo.js';
import { makeTextzone } from './textzone.js';
import type { Cornice } from './riquadro.js';

/**
 * Quanti riquadri vede l'owner.
 *
 * È la domanda che il ridisegno deve sbagliare per essere rotto, ed è la
 * domanda che guardando l'output **non si risponde**: `script` registra i byte,
 * e i byte di dieci ridisegni sono dieci riquadri uno sotto l'altro anche
 * quando a schermo ce n'è sempre stato uno solo. Il 28/08/2026 ho letto quel
 * transcript e concluso che il ridisegno fosse rotto; leggevo la cosa
 * sbagliata.
 *
 * Qui i byte si **applicano** (`cli/schermo.ts`) e si guarda la griglia che ne
 * risulta. È l'unico modo di provare una cosa che è vera solo dopo che il
 * terminale ha finito di interpretare.
 *
 * Il difetto che questi test tengono chiuso è reale e c'era: il ridisegno
 * risaliva di `righe - 1`, ma alla fine di ogni disegno il cursore non sta in
 * fondo al riquadro — sta dove sta il testo. Da lì si risaliva troppo, la
 * cancellazione partiva dal punto sbagliato, e ogni tasto lasciava dietro il
 * riquadro di prima.
 */

const CORNICE: Cornice = {
  prompt: '› ',
  suggerimenti: 'invio spedisce',
  etichetta: 'modello · sessione',
  smorza: (s) => s,
};

/**
 * Righe già a schermo prima che il riquadro cominci — la risposta del turno
 * precedente.
 *
 * **Non sono decorazione: sono il test.** Con il riquadro appoggiato a riga
 * zero, un ridisegno che risale troppo viene fermato dal bordo dello schermo e
 * il difetto sparisce; con dello scrollback sopra, risalire troppo significa
 * cancellare righe che erano già state stampate. È la differenza fra «il
 * riquadro si ridisegna male» e «Muffin ti mangia la risposta di prima», e la
 * seconda è quella che si nota.
 */
const PRIMA = ['risposta del turno prima', 'seconda riga della risposta', ''];

/** Uno stdout finto che registra invece di scrivere, e si dichiara largo 60. */
function schermoFinto(): { write: (c: string) => boolean; scritture: string[]; columns: number; isTTY: true } {
  const scritture: string[] = [`${PRIMA.join('\n')}\n`];
  return {
    scritture,
    columns: 60,
    isTTY: true,
    write: (c: string) => {
      scritture.push(c);
      return true;
    },
  };
}

/** Uno stdin finto che si dichiara TTY e accetta il raw mode. */
function tastieraFinta(): PassThrough & { isTTY: boolean; setRawMode: (v: boolean) => void } {
  const s = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (v: boolean) => void };
  s.isTTY = true;
  s.setRawMode = () => {};
  return s;
}

/** Batte una sequenza di caratteri, uno alla volta, come una persona. */
async function batti(testo: string): Promise<{ righe: string[] }> {
  const input = tastieraFinta();
  const output = schermoFinto();
  const tz = makeTextzone({ input: input as never, output: output as never });

  const letto = tz.read(CORNICE);
  // Un giro di event loop fra un tasto e l'altro: è ciò che rende questo test
  // una battitura e non un incollaggio, e i due percorsi sono diversi.
  for (const c of testo) {
    input.write(c);
    await new Promise((r) => setImmediate(r));
  }
  input.write('\r');
  await letto;
  return applica(output.scritture);
}

/**
 * Come `batti`, ma restituisce **due** schermi: quello mentre si sta scrivendo
 * e quello che resta dopo aver spedito. Sono diversi di proposito, ed è la
 * differenza che va provata.
 */
async function battiEGuardaDueVolte(testo: string): Promise<{ mentre: string[]; dopo: string[] }> {
  const input = tastieraFinta();
  const output = schermoFinto();
  const tz = makeTextzone({ input: input as never, output: output as never });
  const letto = tz.read(CORNICE);
  for (const c of testo) {
    input.write(c);
    await new Promise((r) => setImmediate(r));
  }
  const mentre = applica(output.scritture).righe;
  input.write('\r');
  await letto;
  return { mentre, dopo: applica(output.scritture).righe };
}

const riquadri = (righe: string[]): number => righe.filter((r) => r.startsWith('╭')).length;

/** Cosa era già a schermo prima del riquadro deve esserci ancora. */
function scrollbackIntatto(righe: string[]): void {
  expect(righe[0]).toContain('risposta del turno prima');
  expect(righe[1]).toContain('seconda riga della risposta');
}

describe('a schermo resta un riquadro solo', () => {
  /**
   * Il difetto vero, misurato: una colonna di riquadri, uno per lettera
   * digitata.
   */
  it('dopo aver digitato dieci caratteri, non dieci riquadri', async () => {
    const s = await batti('ciao mondo');
    expect(riquadri(s.righe)).toBe(1);
  });

  /**
   * L'altra metà, e quella che fa male: un ridisegno che risale più in su del
   * proprio bordo cancella righe che non sono sue. A schermo si vede come la
   * risposta di prima che sparisce mentre scrivi la domanda dopo.
   */
  it('e quello che era già a schermo prima è ancora lì', async () => {
    const s = await batti('ciao mondo');
    scrollbackIntatto(s.righe);
  });

  it('e il testo digitato è quello che si legge dentro', async () => {
    const s = await batti('ciao mondo');
    expect(s.righe.find((r) => r.includes('›'))).toContain('ciao mondo');
  });

  it("e il riquadro porta la sua etichetta, anche dopo che l'hai spedito", async () => {
    const s = await battiEGuardaDueVolte('x');
    expect(s.mentre.join('\n')).toContain('modello · sessione');
    expect(s.dopo.join('\n')).toContain('modello · sessione');
  });

  /**
   * I suggerimenti dicono cosa puoi premere **adesso**. Sotto un messaggio già
   * spedito non dicono niente e restano lì per sempre: una copia per turno, per
   * tutta la sessione, in mezzo alla conversazione. Il riquadro invece resta,
   * perché è quello che fa vedere dove finisce ciò che hai scritto tu.
   */
  it('ma i suggerimenti spariscono quando il messaggio è partito', async () => {
    const s = await battiEGuardaDueVolte('x');
    expect(s.mentre.join('\n')).toContain('invio spedisce');
    expect(s.dopo.join('\n')).not.toContain('invio spedisce');
  });

  /**
   * Cancellare accorcia il testo, e un ridisegno che non cancella davvero
   * lascia la coda della riga di prima: `ciaox` diventa `ciao` e la `x` resta.
   */
  it('e cancellare non lascia dietro la coda di quello che c era', async () => {
    const input = tastieraFinta();
    const output = schermoFinto();
    const tz = makeTextzone({ input: input as never, output: output as never });
    const letto = tz.read(CORNICE);

    for (const c of 'ciaox') {
      input.write(c);
      await new Promise((r) => setImmediate(r));
    }
    input.write('\x7f'); // backspace
    await new Promise((r) => setImmediate(r));
    input.write('\r');
    await letto;

    const s = applica(output.scritture);
    const riga = s.righe.find((r) => r.includes('›')) ?? '';
    expect(riga).toContain('ciao');
    expect(riga).not.toContain('ciaox');
  });

  /**
   * Un buffer multilinea fa crescere il riquadro; tornando a una riga sola deve
   * **rimpicciolirsi**, non lasciare a schermo il bordo di quello alto.
   */
  it('e un riquadro cresciuto e poi rimpicciolito non lascia bordi orfani', async () => {
    const input = tastieraFinta();
    const output = schermoFinto();
    const tz = makeTextzone({ input: input as never, output: output as never });
    const letto = tz.read(CORNICE);

    for (const c of 'una') {
      input.write(c);
      await new Promise((r) => setImmediate(r));
    }
    input.write('\n'); // Ctrl+J: a capo, non spedisce
    await new Promise((r) => setImmediate(r));
    for (const c of 'due') {
      input.write(c);
      await new Promise((r) => setImmediate(r));
    }
    // Ora si torna indietro: si cancella tutta la seconda riga e l'a capo.
    for (let i = 0; i < 4; i += 1) {
      input.write('\x7f');
      await new Promise((r) => setImmediate(r));
    }
    input.write('\r');
    await letto;

    const s = applica(output.scritture);
    expect(riquadri(s.righe)).toBe(1);
    expect(s.righe.filter((r) => r.startsWith('╰'))).toHaveLength(1);
  });
});

describe('un messaggio che arriva mentre stai scrivendo', () => {
  /**
   * Il difetto vero, visto su uno schermo dentro tmux il 28/08/2026: un avviso
   * del consolidatore è comparso **dentro** il riquadro dell'input, dopo il
   * `›`, come se l'avesse battuto qualcuno. Poi ne è comparso un secondo sotto.
   *
   * La causa: `makeReplCliWrite` chiamava `rl.prompt()` — l'interfaccia di
   * readline — rimasta lì dopo che #218 ha tolto readline. Ridisegnare non
   * basta: chi consegna scrive dove sta il cursore, e il cursore sta dentro il
   * riquadro. Prima bisogna **togliere**.
   */
  it('finisce sopra il riquadro, non dentro, e il riquadro resta uno', async () => {
    const input = tastieraFinta();
    const output = schermoFinto();
    const tz = makeTextzone({ input: input as never, output: output as never });
    const letto = tz.read(CORNICE);

    for (const c of 'sto scrivendo') {
      input.write(c);
      await new Promise((r) => setImmediate(r));
    }

    // La consegna fuori banda, nell'ordine che `makeReplCliWrite` usa.
    tz.cancella();
    output.write('\n⏰ promemoria: chiama Marco\n');
    tz.redraw();
    await new Promise((r) => setImmediate(r));

    input.write('\r');
    await letto;

    const s = applica(output.scritture);
    const righe = s.righe;
    const avviso = righe.findIndex((r) => r.includes('chiama Marco'));
    const cornice = righe.findIndex((r) => r.startsWith('╭'));
    expect(avviso).toBeGreaterThanOrEqual(0);
    // Sopra, non dentro: la riga dell'avviso precede il bordo alto.
    expect(avviso).toBeLessThan(cornice);
    // E dentro il riquadro c'è ancora quello che si stava scrivendo.
    expect(righe.find((r) => r.includes('›'))).toContain('sto scrivendo');
    expect(riquadri(righe)).toBe(1);
    scrollbackIntatto(righe);
  });
});
