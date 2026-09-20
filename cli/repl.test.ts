import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInit } from './init.js';
import { applica } from './schermo.js';
import { formatProgressLine, makeReplCliWrite, runRepl, closingLine, statusFor } from './repl.js';
import { TOOL_PHRASES, toolLine, toolPhrase, toolSubject } from '../agent/tool-phrase.js';
import { debugCommand, thinkingCommand } from '../agent/comandi.js';
import { readdirSync, readFileSync } from 'node:fs';
import { cliSurface } from '../core/surface/cli.js';
import { SurfaceRegistry } from '../core/surface/registry.js';
import { DELIVERED, MUTA, type Surface } from '../core/surface/types.js';
import { startFakeProvider } from '../evals/acceptance/provider.js';
import type { TurnEvent } from '../agent/loop.js';

/**
 * The REPL's delivery path, in isolation from the interactive stdin loop.
 *
 * The bug this file has always guarded: a scheduled job for a remote channel
 * advanced its schedule and spent its anchor on a message that never left the
 * machine. What changed is *where* the guard lives. It used to be
 * `makeReplDeliver`, whose remote branch had to remember to **throw** — the
 * only way a `Promise<void>` could say "not delivered", and the thing
 * `cli/gateway.ts`'s copy forgot to do. The `Deliver` contract now returns an
 * outcome, so the guard is a value the scheduler reads rather than an exception
 * three implementations each had to remember to raise.
 *
 * So the REPL no longer owns a `Deliver` at all. It owns a writer for the CLI
 * surface, and the question "is this channel real" belongs to the registry —
 * which is what these tests now drive.
 */
function capture(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return { out, err };
}

describe("the REPL's cli surface", () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes the message and gives the prompt back', async () => {
    const { out } = capture();
    const rl = { cancella: vi.fn(), redraw: vi.fn() };
    const registry = new SurfaceRegistry([cliSurface(makeReplCliWrite(rl))]);

    await expect(registry.deliver('cli', 'promemoria: chiama Marco')).resolves.toEqual({
      delivered: true,
    });
    expect(out.join('')).toContain('promemoria: chiama Marco');
    // Prima si toglie il riquadro, poi si scrive, poi si rimette: senza la
    // prima mossa il messaggio finisce dentro la riga di input.
    expect(rl.cancella).toHaveBeenCalledTimes(1);
    expect(rl.redraw).toHaveBeenCalledTimes(1);
  });

  it('re-prompts even if writing throws, so the REPL never looks hung', async () => {
    const rl = { cancella: vi.fn(), redraw: vi.fn() };
    vi.spyOn(process.stdout, 'write').mockImplementation(() => {
      throw new Error('EPIPE');
    });
    const write = makeReplCliWrite(rl);

    expect(() => write('x')).toThrow(/EPIPE/);
    // Prima si toglie il riquadro, poi si scrive, poi si rimette: senza la
    // prima mossa il messaggio finisce dentro la riga di input.
    expect(rl.cancella).toHaveBeenCalledTimes(1);
    expect(rl.redraw).toHaveBeenCalledTimes(1);
  });
});

describe('a channel nothing serves', () => {
  afterEach(() => vi.restoreAllMocks());

  it('comes back as a refusal carrying the reason, never as success', async () => {
    // The whole defect, in one assertion. Before the contract change this
    // returned `undefined` from an implementation that had written a line to
    // stderr — indistinguishable, to `Scheduler`, from a message that arrived.
    capture();
    const registry = new SurfaceRegistry([cliSurface(() => {})]);

    const outcome = await registry.deliver('telegram', 'promemoria: chiama Marco');

    expect(outcome.delivered).toBe(false);
    expect(outcome.delivered === false && outcome.why).toMatch(
      /nessuna superficie serve "telegram"/,
    );
  });

  it('names what is connected, so the owner knows which repair to make', async () => {
    // "consegna fallita" with no list is a line the owner cannot act on: they
    // cannot tell `muffin surface enable telegram` from a dead network.
    capture();
    const registry = new SurfaceRegistry([cliSurface(() => {})]);
    const outcome = await registry.deliver('discord', 'x');
    expect(outcome.delivered === false && outcome.why).toContain('connesse: cli');
  });

  it('turns a surface that throws into a refusal instead of letting it escape', async () => {
    // An implementation that breaks the contract must still not be able to make
    // a failed delivery arrive at the scheduler as an exception in a floating
    // promise — that shape took the gateway down once already.
    const broken: Surface = {
      id: 'rotta',
      limits: { maxMessageChars: 10, maxUploadBytes: 0, maxDownloadBytes: 0 },
      streaming: { transport: 'off' },
      places: ['terminal'],
      negotiate: () => MUTA,
      handles: (c) => c === 'rotta',
      deliver: async () => {
        throw new Error('socket chiuso');
      },
      deliverFile: async () => {
        throw new Error('socket chiuso');
      },
    };
    const registry = new SurfaceRegistry([broken]);

    const outcome = await registry.deliver('rotta', 'x');

    expect(outcome).toEqual({
      delivered: false,
      why: expect.stringContaining('socket chiuso') as unknown as string,
    });
  });

  it('routes to the first surface that claims the channel', async () => {
    const seen: string[] = [];
    const fake = (id: string): Surface => ({
      id,
      limits: { maxMessageChars: 100, maxUploadBytes: 0, maxDownloadBytes: 0 },
      streaming: { transport: 'off' },
      places: ['terminal'],
      negotiate: () => MUTA,
      handles: (c) => c === id,
      deliver: async (_c, text) => {
        seen.push(`${id}:${text}`);
        return DELIVERED;
      },
      deliverFile: async () => DELIVERED,
    });
    const registry = new SurfaceRegistry([cliSurface(() => {}), fake('telegram'), fake('discord')]);

    await registry.deliver('discord', 'ciao');

    expect(seen).toEqual(['discord:ciao']);
  });
});

/**
 * The real wiring, B11 — through `buildRuntime` and a fake SSE HTTP server,
 * not a substituted `Provider` object. PRACTICES.md#model-judgement-and-deterministic-contracts-stay-separate: this is the test that
 * fails without the wiring, and a hand-rolled `Provider.chatStream` fake
 * would not exercise `agent/providers/openai-compat.ts`'s own SSE parsing at
 * all — the seam this suite exists to prove is `runRepl` → `runTurn` → the
 * real adapter → a real (if local) socket, same shape
 * `evals/acceptance/provider.ts`'s own docstring insists on for the
 * acceptance suite, one layer down from a spawned binary.
 */
describe('the REPL streams the final answer while it forms (B11)', () => {
  afterEach(() => vi.restoreAllMocks());

  /** A fresh home pointed at `provider`, and nothing else configured. */
  function homeAgainst(baseUrl: string): string {
    const home = mkdtempSync(join(tmpdir(), 'muffin-repl-stream-'));
    runInit({ home, provider: 'openai-compat', baseUrl, apiKey: 'sk-repl-stream-fake' });
    return home;
  }

  /** Feeds one line, then closes — the readline loop's own "closed" catch is what ends `runRepl`. */
  function stdinWith(line: string): PassThrough {
    const stdin = new PassThrough();
    stdin.write(`${line}\n`);
    stdin.end();
    return stdin;
  }

  it('writes the answer as it forms, and the finished text is byte-identical to a non-streamed turn', async () => {
    const provider = await startFakeProvider({ main: [{ text: 'ciao dal muffin finto' }] });
    try {
      const home = homeAgainst(provider.baseUrl);
      const written: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        written.push(String(chunk));
        return true;
      });

      const code = await runRepl(home, { stream: true, stdin: stdinWith('ciao') });

      expect(code).toBe(0);
      // The wire really did carry more than one delta — this is `wordChunks`'
      // own split (`evals/acceptance/provider.ts`), and each one arrived as
      // its own `process.stdout.write` call, not pre-joined upstream.
      //
      // Lo spazio è in testa e non in coda perché `edgeTrimmer` trattiene lo
      // spazio finale di ogni pezzo finché il pezzo dopo non dimostra che era
      // interno: è l'unico modo di fare `.trim()` su una stringa che si ha
      // solo un pezzo per volta, ed è ciò che tiene vera la garanzia
      // byte-identica qui sotto anche adesso che i delta escono dal vivo.
      expect(written).toContain('ciao');
      expect(written).toContain(' dal');
      expect(written).toContain(' muffin');
      // Exactly once: a turn that streamed must not *also* print the
      // finished text at the end — that would be the same answer twice.
      const occurrences = written.join('').split('ciao dal muffin finto').length - 1;
      expect(occurrences).toBe(1);
    } finally {
      await provider.close();
    }
  });

  it('does not stream with --no-stream (opts.stream: false), and still prints the whole answer once', async () => {
    const provider = await startFakeProvider({ main: [{ text: 'risposta intera, non a pezzi' }] });
    try {
      const home = homeAgainst(provider.baseUrl);
      const written: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        written.push(String(chunk));
        return true;
      });

      const code = await runRepl(home, { stream: false, stdin: stdinWith('ciao') });

      expect(code).toBe(0);
      // The mutation this guards against: delete `stream: Boolean(input.onDelta
      // && …)` in the loop, or drop the `opts.stream` check in the REPL, and
      // this turns red because the sink is attached regardless — the request
      // the fake server actually received is the ground truth, not a mock.
      expect(provider.main()[0]?.transcript).toBeDefined();
      expect(written.some((w) => w === 'risposta ')).toBe(false);
      expect(written.join('')).toContain('risposta intera, non a pezzi');
    } finally {
      await provider.close();
    }
  });
});

describe('formatProgressLine (B13) — in debug, i numeri restano quelli di sempre', () => {
  it('formats a round event', () => {
    expect(formatProgressLine({ type: 'round', n: 3 }, 'debug')).toBe('· giro 3');
  });

  it('formats a model event', () => {
    expect(
      formatProgressLine(
        {
          type: 'model',
          model: 'gpt-test',
          ms: 842,
          inputTokens: 120,
          outputTokens: 40,
          cacheReadTokens: 0,
          stopReason: 'end',
        },
        'debug',
      ),
    ).toBe('· modello: 842ms, 120→40 token, stop: end');
  });

  it('formats a tool_start event', () => {
    expect(
      formatProgressLine(
        { type: 'tool_start', name: 'demo_read', capability: 'demo.read' },
        'debug',
      ),
    ).toBe('· demo_read…');
  });

  it('formats a successful tool_end event', () => {
    expect(
      formatProgressLine({ type: 'tool_end', name: 'demo_read', ms: 12, isError: false }, 'debug'),
    ).toBe('· demo_read fatto (12ms)');
  });

  it('formats a failed tool_end event', () => {
    expect(
      formatProgressLine({ type: 'tool_end', name: 'demo_boom', ms: 3, isError: true }, 'debug'),
    ).toBe('· demo_boom fallito (3ms)');
  });

  it('throws on a variant the switch does not recognise, instead of silently rendering a blank line', () => {
    const bogus = { type: 'bogus' } as unknown as TurnEvent;
    expect(() => formatProgressLine(bogus, 'debug')).toThrow(/unreachable/);
    expect(() => formatProgressLine(bogus, 'normale')).toThrow(/unreachable/);
  });
});

/**
 * B13, wiring through the real REPL — same reasoning as the B11 suite above:
 * this proves `runRepl` → `runTurn` → `TurnInput.onProgress` → stderr, not a
 * hand-rolled fake of any one layer.
 */
describe('the REPL renders progress on stderr, gated on stderr being a TTY (B13)', () => {
  afterEach(() => vi.restoreAllMocks());

  function homeAgainst(baseUrl: string): string {
    const home = mkdtempSync(join(tmpdir(), 'muffin-repl-progress-'));
    runInit({ home, provider: 'openai-compat', baseUrl, apiKey: 'sk-repl-progress-fake' });
    return home;
  }

  function stdinWith(line: string): PassThrough {
    const stdin = new PassThrough();
    stdin.write(`${line}\n`);
    stdin.end();
    return stdin;
  }

  it('con --debug scrive una riga per evento su stderr, quando stderr è un TTY', async () => {
    const provider = await startFakeProvider({ main: [{ text: 'ecco fatto' }] });
    const originalIsTTY = process.stderr.isTTY;
    process.stderr.isTTY = true;
    try {
      const home = homeAgainst(provider.baseUrl);
      const err: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        err.push(String(chunk));
        return true;
      });

      // `debug: true` è ciò che `muffin --debug` passa: questo prova il flag
      // fino a stderr, non solo il formattatore.
      const code = await runRepl(home, { stdin: stdinWith('ciao'), debug: true });

      expect(code).toBe(0);
      const progressLines = err
        .join('')
        .split('\n')
        .filter((l) => l.startsWith('· '));
      // Exactly one round, no tool call: the round opens, the execution
      // governor reports that the model is initially awaited, then the
      // completed model event closes it. No tool event exists in this script.
      expect(progressLines).toHaveLength(3);
      expect(progressLines[0]).toBe('· giro 1');
      expect(progressLines[1]).toBe('· modello waiting_for_model, 0s inattivo');
      expect(progressLines[2]).toMatch(/^· modello: \d+ms, \d+→\d+ token, stop: end$/);
    } finally {
      process.stderr.isTTY = originalIsTTY;
      await provider.close();
    }
  });

  /**
   * Il default, che è il caso di tutti: niente giri e niente token addosso a
   * una conversazione. Quello che resta è il passo finito — qui nessuno,
   * perché lo script non chiama tool — e la riga di stato, che vive e sparisce
   * e per costruzione non è nello scrollback.
   */
  it('senza --debug non scrive né il giro né i token', async () => {
    const provider = await startFakeProvider({ main: [{ text: 'ecco fatto' }] });
    const originalIsTTY = process.stderr.isTTY;
    process.stderr.isTTY = true;
    try {
      const home = homeAgainst(provider.baseUrl);
      const err: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        err.push(String(chunk));
        return true;
      });

      const code = await runRepl(home, { stdin: stdinWith('ciao') });

      expect(code).toBe(0);
      const scritto = err.join('');
      expect(scritto).not.toContain('giro 1');
      expect(scritto).not.toContain('token, stop:');
      // E l'attesa c'è stata: la riga di stato l'ha detta, e poi l'ha tolta.
      expect(scritto).toContain('penso…');
    } finally {
      process.stderr.isTTY = originalIsTTY;
      await provider.close();
    }
  });

  it('writes no progress lines when stderr is not a TTY', async () => {
    const provider = await startFakeProvider({ main: [{ text: 'silenzio' }] });
    const originalIsTTY = process.stderr.isTTY;
    process.stderr.isTTY = false;
    try {
      const home = homeAgainst(provider.baseUrl);
      const err: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        err.push(String(chunk));
        return true;
      });

      const code = await runRepl(home, { stdin: stdinWith('ciao') });

      expect(code).toBe(0);
      expect(
        err
          .join('')
          .split('\n')
          .some((l) => l.startsWith('· ')),
      ).toBe(false);
    } finally {
      process.stderr.isTTY = originalIsTTY;
      await provider.close();
    }
  });
});

/**
 * The residue `docs/evidence/forma-delle-superfici-2026-09-03.md` §3-§5
 * describes: on the real binary, an approval used to leave a standalone `⚠`
 * block behind, never merged with the `✓`/`✗` line the tool that followed
 * already got. This is the wiring test §7 of that memo asks for — the same
 * genre as the B11/B13 suites above (a real turn, through `runRepl`), not a
 * unit test on `formatProgressLine` in isolation — and it asserts on the
 * **rendered screen** (`cli/schermo.ts`), not on raw bytes: a redraw that
 * happened to write `⚠` twice and erase it once would look green to a
 * substring check on the raw writes and still be the defect on a real
 * terminal.
 */
describe("un'approvazione rientra nel vocabolario dei passi (§4.1/§5 della memo)", () => {
  afterEach(() => vi.restoreAllMocks());

  function homeAgainst(baseUrl: string): string {
    const home = mkdtempSync(join(tmpdir(), 'muffin-repl-approve-'));
    runInit({ home, provider: 'openai-compat', baseUrl, apiKey: 'sk-repl-approve-fake' });
    return home;
  }

  /** Il messaggio, poi la risposta al prompt `[s/N]` — due righe, un solo stdin. */
  function stdinConSN(messaggio: string, risposta: string): PassThrough {
    const stdin = new PassThrough();
    stdin.write(`${messaggio}\n`);
    stdin.write(`${risposta}\n`);
    stdin.end();
    return stdin;
  }

  // `shell_run_write` e non `shell_run` dal 06/09 (ADR-0074 punto 4): la corsia che
  // chiede è quella che scrive, e questi due test misurano il vocabolario di un
  // ASK. Usare la corsia in sola lettura qui vorrebbe dire misurare un'attesa
  // che non arriva mai — un test verde su uno schermo che non ha niente da dire.
  it('accettata: niente blocco ⚠, il verdetto precede subito il passo del tool, senza righe vuote fra i due', async () => {
    const provider = await startFakeProvider({
      main: [
        { tool: { name: 'shell_run_write', args: { command: 'echo ciao', cwd: '.' } } },
        { text: 'Fatto, ho stampato ciao.' },
      ],
    });
    const originalIsTTY = process.stderr.isTTY;
    process.stderr.isTTY = true;
    try {
      const home = homeAgainst(provider.baseUrl);
      const out: string[] = [];
      const err: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        out.push(String(chunk));
        return true;
      });
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        err.push(String(chunk));
        return true;
      });

      const code = await runRepl(home, {
        stdin: stdinConSN('esegui il comando echo per favore', 's'),
      });

      expect(code).toBe(0);
      // B11, la parte concreta della memo (`cli/textzone.ts:357`): il prompt
      // `[s/N]`, la `s` digitata e la sua eco non hanno mai toccato stdout —
      // solo la risposta del turno lo fa.
      const suStdout = out.join('');
      expect(suStdout).not.toContain('approvi');
      expect(suStdout).not.toContain('[s/N]');
      expect(suStdout).toContain('Fatto, ho stampato ciao.');

      const schermo = applica(err);
      const righe = schermo.righe.map((r) => r.trimEnd());
      const testo = righe.join('\n');

      // Il formato a parte è sparito per intero, non solo nascosto da un
      // secondo ridisegno che lo cancella: applicare i byte è l'unico modo di
      // saperlo (`cli/schermo.ts`, header del file).
      expect(testo).not.toContain('⚠');
      // Il vocabolario dei passi resta lo stesso di ogni altro tool: una riga
      // `⏸` mentre aspetta, `✓`/il capability quando si risolve.
      //
      // Cosa c'è **su** quella riga è cambiato con ADR-0074 punto 2: era
      // `sys.shell: aspetto la tua approvazione` — il nome della capability
      // più una frase che non dice nulla — ed è diventata il testo del
      // kernel, che dice cosa non si può annullare. Il terminale buttava via
      // `ApprovalRequest.prompt`; Telegram lo mostrava già.
      expect(testo).toContain('⏸ non si torna indietro: cambia questa macchina — sys.shell.write');

      const rigaVerdetto = righe.findIndex((r) => r.includes('sys.shell.write: consentito'));
      expect(rigaVerdetto).toBeGreaterThan(-1);
      // Non «rifiutato»: l'unica riga che porta «sys.shell» dopo il verdetto è
      // quella del tool che ne è seguito — l'owner ha detto sì una volta sola.
      const dopo = righe.slice(rigaVerdetto + 1).find((r) => r.trim() !== '');
      const indiceDopo = righe.findIndex((r, i) => i > rigaVerdetto && r.trim() !== '');
      // Nessuna riga vuota fra il verdetto e il passo che segue.
      expect(indiceDopo).toBe(rigaVerdetto + 1);
      expect(dopo).toContain('✓ eseguo un comando: echo ciao');
    } finally {
      process.stderr.isTTY = originalIsTTY;
      await provider.close();
    }
  });

  it('rifiutata: il verdetto dice «rifiutato» nello stesso vocabolario, e il tool non gira mai', async () => {
    const provider = await startFakeProvider({
      main: [
        { tool: { name: 'shell_run_write', args: { command: 'rm -rf /tmp/x', cwd: '.' } } },
        { text: 'Va bene, non lo eseguo.' },
      ],
    });
    const originalIsTTY = process.stderr.isTTY;
    process.stderr.isTTY = true;
    try {
      const home = homeAgainst(provider.baseUrl);
      const err: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        err.push(String(chunk));
        return true;
      });

      const code = await runRepl(home, { stdin: stdinConSN('cancella /tmp/x', 'n') });

      expect(code).toBe(0);
      const testo = applica(err)
        .righe.map((r) => r.trimEnd())
        .join('\n');
      expect(testo).not.toContain('⚠');
      expect(testo).toContain('✗ sys.shell.write: rifiutato');
      // Il rifiuto arriva al tool come un `tool_result` d'errore — non un
      // secondo canale — quindi la riga del passo segue comunque, con `✗`:
      // stesso alfabeto, mai un `✓` per un comando mai eseguito davvero.
      const righe = testo.split('\n').map((r) => r.trimEnd());
      const rigaVerdetto = righe.findIndex((r) => r.includes('sys.shell.write: rifiutato'));
      const indiceDopo = righe.findIndex((r, i) => i > rigaVerdetto && r.trim() !== '');
      expect(indiceDopo).toBe(rigaVerdetto + 1);
      expect(righe[indiceDopo]).toContain('✗ eseguo un comando: rm -rf /tmp/x');
      expect(testo).not.toMatch(/✓ eseguo un comando/);
    } finally {
      process.stderr.isTTY = originalIsTTY;
      await provider.close();
    }
  });
});

/**
 * `/think` è la manopola che rende la scelta misurabile: due turni identici a
 * ragionamento acceso e spento, senza editare un JSON e riavviare in mezzo —
 * che è il motivo per cui quella prova non la faceva nessuno.
 */
describe('/think', () => {
  it('senza argomenti dice lo stato e da dove viene, senza cambiare niente', () => {
    const out = thinkingCommand('', 'adaptive', undefined, 'consumer-local');
    expect(out.line).toContain('on');
    expect(out.line).toContain('profilo consumer-local');
    expect(out.set).toBeUndefined();
  });

  it("nomina config.json quando è l'override a decidere, non il profilo", () => {
    expect(thinkingCommand('', 'off', 'off', 'consumer-local').line).toContain('config.json');
  });

  it('`on` e `off` scrivono, e lo dicono che dura oltre questa sessione', () => {
    const on = thinkingCommand('on', 'off', 'off', 'consumer-local');
    expect(on.set).toBe('adaptive');
    expect(on.line).toContain('prossimi avvii');
    expect(thinkingCommand('off', 'adaptive', undefined, 'consumer-local').set).toBe('off');
  });

  /**
   * `reset` toglie la riga, e `null` è come si dice «toglila» a un chiamante che
   * distingue `undefined` (non fare niente) da `null` (cancella). Scrivere
   * `adaptive` a mano non sarebbe la stessa cosa: inchioderebbe l'installazione
   * a una risposta giusta per il modello di oggi, e un `muffin update` che
   * porta un profilo nuovo non potrebbe più correggerla.
   */
  it('`reset` cancella l override invece di scriverci il valore di adesso', () => {
    const out = thinkingCommand('reset', 'adaptive', 'adaptive', 'consumer-local');
    expect(out.set).toBeNull();
    expect(out.line).toContain('consumer-local');
  });

  it('un argomento che non è nessuno dei tre non scrive niente, e li nomina', () => {
    const out = thinkingCommand('forse', 'adaptive', undefined, 'consumer-local');
    expect(out.set).toBeUndefined();
    expect(out.line).toContain('on | off | reset');
  });
});

/**
 * Il default del terminale racconta **cosa** sta succedendo; i numeri stanno
 * dietro `--debug`.
 *
 * Prima esisteva una modalità sola, e un owner che chiedeva «come stai?»
 * leggeva `· modello: 2269ms, 5487→2 token, stop: end` — la strumentazione di
 * chi ha scritto il loop, stampata addosso a una conversazione.
 */
describe('formatProgressLine — modalità normale', () => {
  it('il giro e la chiamata al modello non lasciano niente nello scrollback', () => {
    expect(formatProgressLine({ type: 'round', n: 3 }, 'normale')).toBeNull();
    expect(
      formatProgressLine(
        {
          type: 'model',
          model: 'gpt-test',
          ms: 842,
          inputTokens: 120,
          outputTokens: 40,
          cacheReadTokens: 0,
          stopReason: 'end',
        },
        'normale',
      ),
    ).toBeNull();
  });

  it("l'inizio di un tool nemmeno: quello è la riga di stato, e dirlo due volte è dirlo due volte", () => {
    expect(
      formatProgressLine(
        { type: 'tool_start', name: 'memory_search', capability: 'memory.read' },
        'normale',
      ),
    ).toBeNull();
  });

  it('un passo finito resta, in italiano e senza millisecondi', () => {
    expect(
      formatProgressLine(
        { type: 'tool_end', name: 'memory_search', ms: 9, isError: false },
        'normale',
      ),
    ).toBe('  ✓ cerco in memoria');
  });

  it('e un passo fallito si distingue dal segno, non dalla parola', () => {
    expect(
      formatProgressLine({ type: 'tool_end', name: 'fs_write', ms: 3, isError: true }, 'normale'),
    ).toBe('  ✗ scrivo un file');
  });
});

/**
 * Il difetto vero, misurato sul WAL il 28/08/2026: un turno ha fatto **sette**
 * `memory_search` con sette `args_digest` **diversi**, e a schermo erano sette
 * righe identiche. Si legge come un giro a vuoto, e non lo era — nell'intero
 * store non esiste una sola coppia (tool, args) ripetuta. Una riga che non dice
 * su cosa fa diagnosticare la cosa sbagliata, ed è quello che è successo.
 */
describe('la riga dice anche su cosa', () => {
  it('sette ricerche diverse sono sette righe diverse', () => {
    const riga = (query: string): string | null =>
      formatProgressLine(
        { type: 'tool_end', name: 'memory_search', ms: 9, isError: false, args: { query } },
        'normale',
      );
    expect(riga('cosa ha detto ieri')).toBe('  ✓ cerco in memoria: cosa ha detto ieri');
    expect(riga('primo messaggio')).toBe('  ✓ cerco in memoria: primo messaggio');
    expect(riga('cosa ha detto ieri')).not.toBe(riga('primo messaggio'));
  });

  it('e anche la riga di stato viva, che è dove si guarda mentre succede', () => {
    expect(
      statusFor({
        type: 'tool_start',
        name: 'fs_read',
        capability: 'fs.read',
        args: { path: 'note/spesa.md' },
      }),
    ).toBe('  leggo un file: note/spesa.md…');
  });

  /** Un campo solo, quello che risponde a «su cosa?» — non un dump degli argomenti. */
  it('di `fs_write` mostra il percorso e non il contenuto', () => {
    const s = toolLine('fs_write', {
      path: 'note/x.md',
      content: 'un file intero, riga dopo riga',
    });
    expect(s).toBe('scrivo un file: note/x.md');
    expect(s).not.toContain('riga dopo riga');
  });

  /**
   * Gli argomenti li ha scritti il **modello**. Una sequenza di escape dentro
   * un percorso, stampata cruda, muove il cursore — e sotto questa riga sta il
   * riquadro dell'input, che si ridisegna contando le righe che ha scritto.
   */
  it('e appiattisce quello che il modello ha scritto, prima di stamparlo', () => {
    expect(toolSubject('shell_run', { command: 'ls\n\u001b[2Arm -rf x' })).toBe('ls [2Arm -rf x');
    expect(toolSubject('fs_read', { path: 'a\tb\nc' })).toBe('a b c');
  });

  it('e accorcia invece di mandare a capo', () => {
    const lungo = toolSubject('memory_search', { query: 'x'.repeat(200) });
    expect(lungo.length).toBeLessThanOrEqual(48);
    expect(lungo.endsWith('…')).toBe(true);
  });

  /** Senza soggetto la riga resta quella di prima: un tool MCP non è nella mappa. */
  it('e senza un campo da mostrare non aggiunge niente', () => {
    expect(toolLine('sys_inspect', { qualcosa: 'x' })).toBe('mi guardo dentro');
    expect(toolLine('mcp_qualcosa', { path: 'x' })).toBe('mcp_qualcosa');
    expect(toolLine('fs_read', undefined)).toBe('leggo un file');
    expect(toolLine('fs_read', { path: '' })).toBe('leggo un file');
  });
});

describe('statusFor — solo chi apre un attesa', () => {
  it('il giro è «penso», perché è esattamente quello che sta succedendo', () => {
    expect(statusFor({ type: 'round', n: 1 })).toBe('  penso…');
  });

  it('un tool che parte dice cosa sta facendo, non come si chiama la funzione', () => {
    expect(statusFor({ type: 'tool_start', name: 'web_search', capability: 'web.search' })).toBe(
      '  cerco sul web…',
    );
  });

  it('chi chiude non apre: model e tool_end non scrivono nessuna attesa', () => {
    expect(statusFor({ type: 'tool_end', name: 'web_search', ms: 1, isError: false })).toBeNull();
  });

  it('un tool che questa build non conosce (MCP) porta il suo nome, non un errore', () => {
    expect(toolPhrase('qualcosa_di_mcp')).toBe('qualcosa_di_mcp');
  });
});

/**
 * La mappa a mano ha un prezzo — invecchia quando arriva un tool nuovo — e
 * questo test è il prezzo pagato qui invece che da un lettore che in
 * produzione si trova `send_file…` in mezzo a frasi italiane.
 */
describe('ogni tool registrato ha una frase', () => {
  it('nessun nome scoperto resta senza frase, e nessuna frase resta senza tool', () => {
    const dir = new URL('../agent/tools/', import.meta.url).pathname;
    const scoperti = new Set<string>();
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts') || file.includes('.test.')) continue;
      for (const m of readFileSync(`${dir}${file}`, 'utf8').matchAll(/^\s*name: '([a-z_]+)',$/gm)) {
        scoperti.add(m[1]!);
      }
    }
    expect(scoperti.size).toBeGreaterThan(10);
    expect([...scoperti].filter((n) => !(n in TOOL_PHRASES)).sort()).toEqual([]);
    expect(
      Object.keys(TOOL_PHRASES)
        .filter((n) => !scoperti.has(n))
        .sort(),
    ).toEqual([]);
  });
});

/**
 * `/debug` e `muffin --debug` sono la stessa manopola, e dietro c'è una
 * funzione sola: due implementazioni della stessa cosa sono la cucitura che
 * `docs/development/JUDGE.md` descrive — corrette separatamente, capaci di non essere
 * d'accordo il giorno che una delle due cambia.
 */
describe('/debug', () => {
  it('da solo inverte, perché gli stati sono due e da un interruttore non si vuole altro', () => {
    expect(debugCommand('', 'normale').set).toBe('debug');
    expect(debugCommand('', 'debug').set).toBe('normale');
  });

  it('`on` e `off` sono espliciti e idempotenti', () => {
    expect(debugCommand('on', 'debug').set).toBe('debug');
    expect(debugCommand('off', 'normale').set).toBe('normale');
  });

  it('e dice cosa comparirà, non solo che è acceso', () => {
    expect(debugCommand('on', 'normale').line).toContain('token');
  });

  it('un argomento che non è nessuno dei due non cambia niente, e nomina anche la forma nuda', () => {
    const out = debugCommand('forse', 'normale');
    expect(out.set).toBeUndefined();
    expect(out.line).toContain('/debug da solo');
  });
});

/**
 * Un turno deve avere una **fine visibile**: senza, due turni di fila sono un
 * blocco solo — la stessa lamentela dell'owner sull'output dei comandi,
 * applicata al REPL invece che alla shell.
 */
describe('closingLine', () => {
  it('secondi, token e costo, rientrati come il resto della cornice', () => {
    const l = closingLine({ inputTokens: 5487, outputTokens: 2 }, 4712, 0.0023);
    expect(l).toBe('  4.7s · 5487→2 token · $0.0023');
  });

  /**
   * Un costo che arrotonda a zero si scrive `<$0.0001`, mai `$0.0000`: il
   * secondo dice «gratis», che è falso — e per un tetto di spesa è la bugia che
   * conta, perché è quella che ti fa smettere di guardare.
   */
  it('un costo minuscolo non diventa mai zero', () => {
    expect(closingLine({ inputTokens: 10, outputTokens: 1 }, 800, 0.00004)).toContain('<$0.0001');
    expect(closingLine({ inputTokens: 10, outputTokens: 1 }, 800, 0.00004)).not.toContain(
      '$0.0000',
    );
  });

  /**
   * `costUsd` risponde `null` per un modello locale, e `null` non è zero: si
   * tace sul costo invece di dichiararne uno.
   */
  it('su un modello locale la voce del costo sparisce, invece di dire zero', () => {
    const l = closingLine({ inputTokens: 10, outputTokens: 1 }, 800, null);
    expect(l).not.toContain('$');
    expect(l).toContain('token');
  });

  /**
   * Il numero c'era già in `result.usage` e non lo leggeva nessuno. «La cache
   * non prende, 0 sul modello vivo» è girato per giorni come stato di fatto,
   * sulla base di un documento di ricerca del 26/08; il 28/08, misurando le
   * tracce, un turno da nove chiamate prendeva il **54%** — con tre chiamate a
   * zero in mezzo ad altre che colpivano. Né «non prende» né «prende», e
   * nessuno dei due si scopriva senza rileggere i trace a mano.
   */
  it('dice quanto del prompt è arrivato dalla cache', () => {
    expect(
      closingLine({ inputTokens: 8866, outputTokens: 785, cacheReadTokens: 7840 }, 4712, 0.0023),
    ).toBe('  4.7s · 8866→785 token · 88% da cache · $0.0023');
  });

  /** Lo zero è il caso che conta: si vede mentre succede, invece di ricostruirlo dopo. */
  it("e lo dice anche quando è zero, che è l'unica lettura che serviva", () => {
    expect(
      closingLine({ inputTokens: 9607, outputTokens: 158, cacheReadTokens: 0 }, 3000, null),
    ).toContain('0% da cache');
  });

  /** Senza il campo la riga resta quella di prima: non si inventa uno 0%. */
  it('ma se il campo non arriva non si inventa una percentuale', () => {
    expect(closingLine({ inputTokens: 10, outputTokens: 1 }, 800, null)).not.toContain('cache');
  });

  /** Un turno interrotto prima di parlare col modello non divide per zero. */
  it('e a zero token in ingresso non stampa NaN', () => {
    const l = closingLine({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, 120, null);
    expect(l).not.toContain('NaN');
    expect(l).not.toContain('cache');
  });
});
