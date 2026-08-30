import { describe, expect, it } from 'vitest';
import {
  MAX_WAIT_MS,
  MIN_WAIT_MS,
  decodeWaitFor,
  encodeWaitFor,
  parseWait,
  satisfied,
  wakeReport,
} from './wait.js';

/**
 * The arithmetic of a wait, tested where it is pure.
 *
 * Nothing in this file sleeps, and that is not a testing convenience: it is the
 * property. `WAIT → persisti → RILASCIA → sveglia → riprendi` (M5-BIS.md#wait-e-todo-sono-primitive-del-runtime-non-tool) means
 * the vocabulary of a wait has to be decidable without a clock, a database or a
 * runtime — otherwise the only way to test "does it come back" is to wait for
 * it, which is exactly the shape (`await sleep()`) this primitive exists not to
 * be.
 *
 * The failures asserted here are the ones that end in a suspension nobody ever
 * ends: an absent deadline, a barrier nothing evaluates, an unreadable row.
 */

const NOW = new Date('2026-08-16T10:00:00.000Z');

describe('quale attesa siamo disposti ad armare', () => {
  it('rifiuta un wait senza scadenza — quello è il caso che non finisce mai', () => {
    const refused = parseWait({}, NOW);
    expect(refused.ok).toBe(false);
    // The reason travels to the model verbatim, so it has to say *why* rather
    // than "invalid argument": a job with no stop condition keeps arriving and
    // the owner notices it, a suspended turn with no deadline is silent.
    expect(refused.ok === false && refused.why).toMatch(/obbligatorio/);
  });

  it('rifiuta sotto il minuto, perché il risveglio passa dal battito da 30s', () => {
    const refused = parseWait({ seconds: 5 }, NOW);
    expect(refused.ok).toBe(false);
    // Refused at the boundary and not silently rounded up: "aspetta 5 secondi"
    // becoming thirty is the runtime lying about what it did.
    expect(refused.ok === false && refused.why).toContain('30s');
    expect(parseWait({ seconds: MIN_WAIT_MS / 1000 }, NOW).ok).toBe(true);
  });

  it('rifiuta oltre i sette giorni, e dice che quello è un job', () => {
    const refused = parseWait({ seconds: MAX_WAIT_MS / 1000 + 1 }, NOW);
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.why).toMatch(/job/);
  });

  it('la scadenza è now + secondi, non un intervallo che qualcuno dovrà interpretare', () => {
    const parsed = parseWait({ seconds: 120 }, NOW);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok === true && parsed.spec.wakeAt).toBe('2026-08-16T10:02:00.000Z');
    expect(parsed.ok === true && parsed.spec.waitFor).toBeNull();
  });

  it('la scadenza resta obbligatoria anche quando c’è una barriera a evento', () => {
    const parsed = parseWait({ seconds: 300, untilProcessExits: 4242 }, NOW);
    expect(parsed.ok).toBe(true);
    // Both, never one: whichever comes first wins, and the deadline is the
    // backstop for the event that never arrives.
    expect(parsed.ok === true && parsed.spec.wakeAt).toBe('2026-08-16T10:05:00.000Z');
    expect(parsed.ok === true && parsed.spec.waitFor).toEqual({ kind: 'process_exit', pid: 4242 });
  });

  it('rifiuta un pid che non è un pid, invece di armare una barriera su niente', () => {
    for (const bad of [0, 1, -3, 2.5, 'init']) {
      const refused = parseWait({ seconds: 300, untilProcessExits: bad }, NOW);
      expect(refused.ok, `pid ${String(bad)}`).toBe(false);
    }
  });
});

describe('la barriera su disco', () => {
  it('va e torna dalla colonna senza perdere niente', () => {
    const encoded = encodeWaitFor({ kind: 'process_exit', pid: 991 });
    expect(encoded).toBe('process_exit:991');
    expect(decodeWaitFor(encoded)).toEqual({ kind: 'process_exit', pid: 991 });
  });

  it('una riga illeggibile degrada alla sola scadenza invece di far cadere la corsia', () => {
    // The value comes off disk: a row written by a future version, or edited by
    // hand, must not take down the process that reads it. `null` means "this
    // turn has only its deadline", which is the direction that still ends.
    for (const junk of ['', 'boh', 'process_exit:', 'process_exit:zero', 'file_changed:/tmp/x', null]) {
      expect(decodeWaitFor(junk)).toBeNull();
    }
  });
});

describe('quando la barriera è soddisfatta', () => {
  it('process_exit è soddisfatta esattamente quando il processo non c’è più', () => {
    const barrier = { kind: 'process_exit', pid: 4242 } as const;
    expect(satisfied(barrier, () => true)).toBe(false);
    expect(satisfied(barrier, () => false)).toBe(true);
  });

  it('sul processo di questo test, che è vivo per definizione, non è soddisfatta', () => {
    // The injected `alive` above proves the branch; this proves the default is
    // wired to the real one, which is the half a stub cannot show.
    expect(satisfied({ kind: 'process_exit', pid: process.pid })).toBe(false);
  });
});

describe('cosa viene detto al modello al risveglio', () => {
  it('distingue "il processo è uscito" da "è scaduto il tempo"', () => {
    const barrier = { kind: 'process_exit', pid: 4242 } as const;
    // Two different next moves, so they must not arrive as the same sentence.
    expect(wakeReport(barrier, 'event')).toMatch(/è uscito/);
    expect(wakeReport(barrier, 'timer')).toMatch(/ancora vivo/);
    expect(wakeReport(null, 'timer')).toMatch(/tempo che avevi chiesto/);
  });

  it('un’attesa scaduta è un tool_result, non un turno ucciso in silenzio', () => {
    // The model asked to wait, so the model decides what an expired wait means:
    // wait more, go on without, or say so. All three are in the text.
    expect(wakeReport({ kind: 'process_exit', pid: 7 }, 'timer')).toMatch(/Decidi tu/);
  });
});

describe("la seconda barriera: l'owner ha risposto", () => {
  it('va e torna dalla colonna senza perdersi', () => {
    const b = { kind: 'approval', id: 'a1b2c3d4' } as const;
    expect(encodeWaitFor(b)).toBe('approval:a1b2c3d4');
    expect(decodeWaitFor('approval:a1b2c3d4')).toEqual(b);
  });

  /**
   * Un id di una forma che non scriviamo noi è una riga che non abbiamo
   * scritto noi. Degrada come ogni barriera illeggibile: il turno resta con la
   * sola scadenza, che è la direzione che finisce comunque.
   */
  it('e un id che non è il nostro non diventa una barriera', () => {
    expect(decodeWaitFor('approval:../../etc/passwd')).toBeNull();
    expect(decodeWaitFor('approval:')).toBeNull();
  });

  it('si apre solo se qualcuno sa dire che la risposta è arrivata', () => {
    const b = { kind: 'approval', id: 'abc' } as const;
    expect(satisfied(b, { answered: () => true })).toBe(true);
    expect(satisfied(b, { answered: () => false })).toBe(false);
    // Nessun valutatore: non sapere non è sì. Il turno aspetta la scadenza.
    expect(satisfied(b, {})).toBe(false);
  });

  /**
   * **Il modello non può armarsela.** `parseWait` è l'unico parser che legge
   * argomenti di una tool call, e non ha nessun ramo che produca una barriera
   * d'approvazione: potersela armare vorrebbe dire potersi far riprendere da
   * una risposta che nessuno ha dato.
   */
  it("e il modello non può chiederla: `wait` produce solo l'uscita di un processo", () => {
    const now = new Date('2026-08-28T10:00:00.000Z');
    for (const argomenti of [
      { seconds: 120, untilProcessExits: 4242 },
      { seconds: 120, untilProcessExits: 'approval:abc' },
      { seconds: 120, waitFor: 'approval:abc' },
      { seconds: 120, kind: 'approval', id: 'abc' },
    ]) {
      const esito = parseWait(argomenti as { seconds?: unknown; untilProcessExits?: unknown }, now);
      if (!esito.ok) continue;
      expect(esito.spec.waitFor?.kind ?? 'process_exit').toBe('process_exit');
    }
  });

  it('e quando torna, dice che è tornata per una risposta e non per il tempo', () => {
    const b = { kind: 'approval', id: 'abc' } as const;
    expect(wakeReport(b, 'event')).toContain('ha risposto');
    const scaduta = wakeReport(b, 'timer');
    expect(scaduta).toContain('non ha risposto');
    // E dice cosa fare adesso, invece di lasciare il modello a riprovare.
    expect(scaduta).toContain('non rifare la chiamata');
  });
});
