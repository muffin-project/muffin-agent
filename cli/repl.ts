import { join } from 'node:path';
import { makeTextzone } from './textzone.js';
import { makeFondo } from './fondo.js';
import { intestazione } from './riquadro.js';
import { attachMcp, buildRuntime, type Runtime } from '../agent/runtime.js';
import { loadProfiles, selectProfile } from '../agent/profiles/profile.js';
import { Scheduler, type Deliver, type ForegroundGate, type StandDown } from '../core/scheduler/scheduler.js';
import { ModelLane } from '../core/turns/model-lane.js';
import { readGateway } from '../core/gateway/lock.js';
import { consolidationBootLine, CONSOLIDATION_TENANT } from '../core/memory/consolidator.js';
import { reviewBootLine } from '../core/memory/maintenance.js';
import type Database from 'better-sqlite3';
import { TICK_MS } from '../core/gateway/service.js';
import { makeJobRunner } from '../agent/scheduler-run.js';
import { runTurn, type TurnDelta, type TurnEvent } from '../agent/loop.js';
import { TOOL_PHRASES, toolLine, toolPhrase, toolSubject } from '../agent/tool-phrase.js';
import { COMANDI as ELENCO_COMANDI, aiuto, debugCommand, eseguiComando, sembraComando, thinkingCommand } from '../agent/comandi.js';
import type { Verbosity } from '../agent/comandi.js';
import { loadConfig, paths, saveConfig } from '../core/config/config.js';
import { cmdModel } from './model.js';
import { makeStatusLine, type StatusLine } from './status-line.js';
import { styleFor } from './ui.js';
import { costUsd } from '../core/budget/pricing.js';
import { attachSendFile, connectSurfaces } from './surface.js';

/**
 * The REPL.
 *
 * One session per launch, so the conversation is continuous by default and
 * `/new` is the explicit way to forget. Ctrl+C cancels the turn in progress —
 * pressing it again within two seconds exits — because the common case is
 * "stop, that is not what I meant", not "kill the process".
 */

/**
 * I comandi che il Tab completa.
 *
 * Derivati dall'elenco condiviso (`agent/comandi.ts`) e non riscritti: due
 * elenchi divergono, e quello che divergerebbe per primo è quello che nessuno
 * legge — un comando aggiunto di là e non qui semplicemente non si
 * completerebbe, in silenzio.
 */
export const COMANDI: readonly string[] = ELENCO_COMANDI.map((c) => `/${c.nome}`);

/** Ri-esportato: il tipo vive con i comandi (`agent/comandi.ts`), che sono la cosa che lo gira. */
export type { Verbosity } from '../agent/comandi.js';

/**
 * Cosa mostra la riga di stato viva, per evento.
 *
 * Solo gli eventi che **aprono un'attesa**: `round` (sta per parlare il
 * modello) e `tool_start`. `model` e `tool_end` chiudono, e chi chiude non
 * scrive uno stato — lo cancella. Separata da `formatProgressLine` perché sono
 * due destinazioni diverse e non due formati della stessa: questa riga viene
 * riscritta e poi sparisce, quella resta nello scrollback.
 */
export function statusFor(event: TurnEvent): string | null {
  switch (event.type) {
    case 'round':
      return '  penso…';
    case 'tool_start':
      return `  ${toolLine(event.name, event.args)}…`;
    default:
      return null;
  }
}



/**
 * How the CLI surface writes inside a REPL, and the one thing it has to do that
 * a plain `write` does not: give the prompt back.
 *
 * This replaces a whole hand-rolled `Deliver`. That function branched on
 * `'cli'`, printed anything else to stderr and **threw**, because at the time
 * throwing was the only way a `Promise<void>` could say "not delivered". Two of
 * the three implementations in the tree remembered to throw and one did not
 * (`cli/gateway.ts`), which is the asymmetry `docs/ORCHESTRATION.md` §14 uses as
 * its worked example.
 *
 * Now the terminal only knows how to write to a terminal, and whether a channel
 * is deliverable at all is the registry's question. `rl.prompt()` still runs
 * after every line for the reason it always did: a delivery that arrives while
 * the owner is looking at an empty prompt must not leave the REPL looking hung.
 */
export function makeReplCliWrite(
  /**
   * Il riquadro dell'input: si toglie, si scrive al suo posto, si rimette.
   *
   * Era `{ prompt: () => void }`, cioè l'interfaccia di readline, ed è rimasta
   * tale dopo che #218 ha tolto readline. Il risultato: la consegna si
   * scriveva dove stava il cursore — **dentro** il riquadro — e poi ne
   * compariva un secondo sotto. Visto su uno schermo vero il 28/08/2026, un
   * avviso del consolidatore finito dentro la riga di input come se l'avesse
   * battuto qualcuno. Ridisegnare non basta: prima bisogna togliere.
   */
  riquadro: { cancella: () => void; redraw: () => void },
  /**
   * Toglie l'attesa in corso prima di consegnare.
   *
   * Una consegna arriva **fuori banda**, cioè per definizione mentre può
   * esserci uno spinner acceso: senza questa, `⏰ …` si incolla dentro la riga
   * di stato invece di sostituirla. Default no-op perché la superficie CLI si
   * costruisce anche dove una riga di stato non esiste (i test, `muffin run`).
   */
  clear: () => void = () => {},
): (text: string) => void {
  return (text) => {
    try {
      clear();
      riquadro.cancella();
      process.stdout.write(`\n⏰ ${text}\n`);
    } finally {
      // Nel `finally`, e non dopo la scrittura: una `write` che lancia (EPIPE)
      // lascerebbe il REPL senza prompt e con l'aria di essere piantato.
      riquadro.redraw();
    }
  };
}

/**
 * B13: one `TurnInput.onProgress` event, one line, in Italian — the owner's
 * own wording for "still alive", not the trace's `muffin.*` vocabulary.
 *
 * Pure and exported on purpose: a unit test checks the wording without
 * running a turn (or faking a TTY) at all, the same reason `makeReplCliWrite`
 * above is its own function rather than inlined where it is used.
 */
/**
 * Solo per la riga «(2/3)»: il numero di tentativi totali che `agent/loop.ts`
 * fa. Non e' una manopola — e' l'eco di una costante che vive li'.
 */
const MAX_TOOL_RETRIES_MOSTRATI = 3;

export function formatProgressLine(event: TurnEvent, verbosity: Verbosity): string | null {
  if (verbosity === 'debug') {
    switch (event.type) {
      case 'round':
        return `· giro ${event.n}`;
      case 'model':
        return `· modello: ${event.ms}ms, ${event.inputTokens}→${event.outputTokens} token, stop: ${event.stopReason}`;
      case 'tool_start':
        return `· ${event.name}…`;
      case 'tool_retry':
        return `· ${event.name} tentativo ${event.attempt} fra ${event.inMs}ms — ${event.why}`;
      case 'tool_end':
        return `· ${event.name} ${event.isError ? 'fallito' : 'fatto'} (${event.ms}ms)`;
      case 'ask':
        return `· ${event.name} in attesa di approvazione`;
      default:
        return assertNever(event);
    }
  }
  switch (event.type) {
    // Il giro e la chiamata al modello non lasciano traccia: che stia pensando
    // lo dice la riga di stato mentre è vero, e uno scrollback pieno di `giro
    // 3` è la strumentazione del loop, non il racconto di cosa è successo.
    case 'round':
    case 'model':
      return null;
    // Nemmeno l'inizio di un tool: `statusFor` lo mostra vivo, e stampare
    // «cerco in memoria…» e poi «✓ cerco in memoria» sarebbe la stessa cosa
    // detta due volte.
    case 'tool_start':
      return null;
    // Il retry invece si dice, anche fuori da `--debug`: senza, chi guarda vede
    // lo spinner fermo per il doppio del tempo e non sa se stia succedendo
    // qualcosa. È l'unica riga che compare *prima* che un tool finisca, e
    // compare solo quando c'è una ragione.
    case 'tool_retry':
      return `  ↻ ${toolLine(event.name, event.args)} — riprovo (${event.attempt}/${MAX_TOOL_RETRIES_MOSTRATI})`;
    case 'tool_end':
      // Rientrato di due, come l'attesa che sostituisce: il lavoro che ha
      // prodotto la risposta sta sotto la domanda, non accanto ad essa
      // (`cli/STYLES.md` §«La forma di un turno»).
      return `  ${event.isError ? '✗' : '✓'} ${toolLine(event.name, event.args)}`;
    // Un terzo segno, perché sono tre cose diverse: fatto, fallito, e **fermo
    // su di te**. Nel terminale la domanda arriva subito dopo, quindi questa
    // riga dice soltanto perché il lavoro si è fermato lì.
    case 'ask':
      return `  ⏸ ${toolPhrase(event.name)}: aspetto la tua approvazione`;
    default:
      return assertNever(event);
  }
}

/**
 * La riga che chiude il turno, e gli da' una fine visibile.
 *
 * Senza, due turni di fila sono un blocco solo — che e' la meta' della
 * lamentela «manco si capisce da dove parte un comando», applicata al REPL
 * invece che alla shell. Che porti anche il costo e' quasi un effetto
 * collaterale, ma e' il numero che prima si vedeva solo con `--debug` o con
 * `/spend`, cioe' mai.
 *
 * Pura e con l'orologio come parametro: si prova senza far girare un turno.
 */
export function closingLine(
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number },
  ms: number,
  usd: number | null,
): string {
  const secondi = `${(ms / 1000).toFixed(1)}s`;
  const token = `${usage.inputTokens}→${usage.outputTokens} token`;
  // **Quanto del prompt è arrivato dalla cache, ogni turno.**
  //
  // Il numero c'era già in `result.usage` e non lo leggeva nessuno: «la cache
  // non prende, 0 sul modello vivo» è girato per giorni come stato di fatto
  // sulla base di un documento di ricerca del 26/08, e il 28/08 misurando le
  // tracce prendeva il **54%** su un turno da nove chiamate — con tre chiamate
  // a zero in mezzo ad altre che colpivano. Cioè: né «non prende» né «prende»,
  // e nessuno dei due si sarebbe scoperto senza andare a rileggere i trace a
  // mano.
  //
  // Si stampa anche quando è zero, che è il caso che conta: uno 0% ripetuto è
  // la cosa da vedere mentre succede, non da ricostruire dopo.
  const cache =
    usage.cacheReadTokens === undefined || usage.inputTokens === 0
      ? null
      : `${Math.round((usage.cacheReadTokens / usage.inputTokens) * 100)}% da cache`;
  // Un costo che arrotonda a zero si scrive `<$0.0001` e non `$0.0000`: il
  // secondo dice «gratis», che e' falso e per un tetto di spesa e' la bugia
  // che conta.
  const costo = usd === null ? null : usd < 0.0001 ? '<$0.0001' : `$${usd.toFixed(4)}`;
  return `  ${[secondi, token, cache, costo].filter((x): x is string => x !== null).join(' · ')}`;
}

/**
 * Same guarantee `agent/loop.ts`'s own copy gives `TurnEvent`'s sibling
 * unions: a fifth variant nobody taught this `switch` about is a compile
 * error here, not a blank line the owner has to guess the meaning of.
 */
function assertNever(x: never): never {
  throw new Error(`unreachable: unhandled variant ${JSON.stringify(x)}`);
}

/**
 * The REPL's half of ADR-0035: *is the gateway the scheduler right now?*
 *
 * Re-read on every tick, never cached, and that is the entire fix. The claim
 * used to be read once at startup, which made the answer true only for the
 * instant the window opened. Two orderings break a boot-time answer, and both
 * are ordinary:
 *
 *  - **REPL first, gateway second.** A terminal is open, `muffin gateway
 *    install` finally runs, or systemd starts the unit at login a moment after
 *    the shell. From that instant two tickers share one job store, which is the
 *    thing this ADR exists to make impossible — and nothing was ever going to
 *    notice, because nobody read the claim again.
 *  - **The laptop lid.** A suspended gateway stops beating, so on wake its
 *    claim is older than `STALE_AFTER_MS` and reads as dead to a REPL opened
 *    right then — correctly, on the evidence available. Seconds later the
 *    gateway resumes and beats, and the REPL has to give the store back.
 *
 * It announces on the **transition** and not on the state, so the boot line
 * stays the only thing said at boot: `owned` starts as whatever the boot line
 * reported. And it announces in both directions — a gateway that dies leaves
 * this session scheduling again, and a REPL that silently resumed owning the
 * jobs would be the same defect wearing the other hat.
 */
export function gatewayStandDown(
  db: Database.Database,
  say: (line: string) => void,
  ownedAtBoot: boolean,
): StandDown {
  let owned = ownedAtBoot;
  return () => {
    const gateway = readGateway(db);
    const now = gateway !== null;
    if (now !== owned) {
      owned = now;
      say(
        gateway
          ? `scheduler: passato al gateway (pid ${gateway.pid}) — i job girano lì adesso, non più in questa finestra`
          : `scheduler: il gateway non risponde più — i job tornano a girare in questa finestra`,
      );
    }
    return now;
  };
}

export async function runRepl(
  home = paths().home,
  opts: {
    /**
     * Overrides the TTY autodetection below — `--no-stream`, or a test that
     * wants a deterministic answer regardless of what `process.stdout.isTTY`
     * happens to be under the test runner. Absent means "decide from the
     * terminal", which is the only thing `muffin` itself ever passes.
     */
    stream?: boolean;
    /**
     * Lo stato iniziale della verbosità — `muffin --debug`. La stessa manopola
     * che `/debug` gira a caldo, e deliberatamente la stessa funzione dietro
     * (`debugCommand`): il flag decide con cosa si parte, il comando decide
     * cosa si fa dopo.
     */
    debug?: boolean;
    /**
     * Where the readline interface reads from. Injectable for the same reason
     * `cli/prompt.ts`'s functions already take an `input` parameter: a real
     * run always means `process.stdin`, and a wiring test needs a stream it
     * controls, that ends on its own once the scripted lines are consumed —
     * `process.stdin` in a test process has no such ending.
     */
    stdin?: NodeJS.ReadableStream;
  } = {},
): Promise<number> {
  // Sopra `buildRuntime` e sopra `connectSurfaces`, non accanto agli altri
  // flag: entrambi ricevono un writer che deve poter cancellare l'attesa in
  // corso prima di scrivere, e un `const` dichiarato più in basso sarebbe nella
  // sua temporal dead zone nel momento in cui glielo si passa.
/**
   * B13: whether *this* turn attaches `TurnInput.onProgress` at all.
   *
   * Gated on **`process.stderr`**'s own TTY-ness, not `process.stdout`'s
   * (`streamEnabled`) — progress lines are written to stderr
   * (below), so the stream whose interactivity decides whether to bother is
   * the one the lines actually land on. A REPL with only stdout redirected
   * (`muffin > risposte.txt`) still shows progress on the terminal, because
   * stderr is still a TTY there; a fully non-interactive run (both streams
   * redirected — cron, `muffin < script > log 2>&1`) attaches nothing, the
   * same way `onDelta` attaches nothing to `muffin run` (see `streamEnabled`
   * above).
   *
   * No `opts` override, unlike `streamEnabled`: there is no `--no-progress`
   * a human needs a deterministic escape hatch for, so nothing here has to
   * carry one. A test that wants this on or off sets `process.stderr.isTTY`
   * directly before calling `runRepl`, the same kind of stream fake
   * `cli/prompt.test.ts` and `cli/onboarding.test.ts` already construct by
   * hand for `isTTY`.
   */
  const progressEnabled = process.stderr.isTTY === true;


  /**
   * La riga di stato viva, una per REPL e non una per turno: il timer che la
   * anima va fermato dall'uscita e da Ctrl+C, e un oggetto creato dentro il
   * ciclo non sarebbe raggiungibile da nessuno dei due.
   */
  const status = makeStatusLine((text) => process.stderr.write(text), progressEnabled);

  /**
   * Lo stile di questa sessione e il prompt che ne deriva.
   *
   * Il `›` prende il colore perche' e' l'unico pezzo di cornice che sta a
   * colonna zero insieme alla risposta: distinguerlo e' cio' che rende
   * evidente dove finisce quello che hai scritto tu e comincia quello che ha
   * scritto lui. Su una pipa torna `› ` nudo, e readline riceve gli stessi byte
   * di prima (`cli/STYLES.md`).
   */
  const style = styleFor(process.stderr);
  const promptText = style.enabled ? `${style.accent('›')} ` : '› ';
  /**
   * La guida delle righe successive, larga quanto il prompt.
   *
   * Serve a far vedere a colpo d'occhio che tre righe sono **un** messaggio e
   * non tre: senza, un testo multilinea sembra tre turni già spediti. Smorzata,
   * perché è cornice — `cli/STYLES.md`.
   */


  let runtime: Runtime;
  try {
    runtime = buildRuntime(home, process.cwd(), { log: (line) => status.line(line) });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (runtime.safeMode) {
    process.stderr.write(
      `! safe mode: root of trust diverged (${runtime.safeMode.reason}) — capability sopra il rischio basso negate\n`,
    );
  }

  // `muffin` starts the agent, and the agent is on every surface it was given —
  // in this same process (ADR-0022), for as long as this process lives. Not a
  // subcommand you also have to remember to run: a message from the phone works
  // because Muffin is running, which is what "running" should mean.
  //
  // The readline interface does not exist yet and must not be created early —
  // constructing it starts stdin flowing, before the boot lines are even
  // printed. So the CLI surface is handed a prompt it resolves at call time; a
  // delivery that lands before the prompt exists simply does not redraw one.
  let redrawPrompt: () => void = () => {};
  let cancellaPrompt: () => void = () => {};
  const surfaces = connectSurfaces(
    runtime,
    home,
    makeReplCliWrite({ cancella: () => cancellaPrompt(), redraw: () => redrawPrompt() }, () => status.clear()),
  );
  // DAY-1 requirement B14: a file the model produces can now reach the owner as a real
  // attachment on whichever surface this turn is on, not only as a path cited
  // in text — the same registry `deliver` uses, one call later.
  attachSendFile(runtime, home, surfaces.registry);

  /**
   * B11: whether *this* turn attaches `TurnInput.onDelta` at all.
   *
   * `cliSurface` (inside `connectSurfaces`, above) already declared its own
   * `streaming` capability from this exact same `process.stdout.isTTY` check
   * — this is the second, independent read of it, because `opts.stream` can
   * make this REPL run *more* conservative than what the surface says is
   * possible (`--no-stream`), and the capability object has no room to carry
   * a per-invocation override. A capability says what a surface *can* do; a
   * turn still decides whether to use it, the same way a browser supporting
   * a feature is not the same claim as a page turning it on.
   *
   * `!process.stdout.isTTY` also covers `muffin run` never reaching this
   * function at all (headless has its own code path, `cli/run.ts`, and never
   * attaches a sink) and a piped `muffin | tee log` — `result.text` still
   * carries the whole answer either way, so nothing is lost, only the live
   * redraw.
   */
  const streamEnabled = opts.stream ?? process.stdout.isTTY === true;

    /** `muffin --debug` decide il valore iniziale; `/debug` lo cambia da qui in poi. */
  let verbosity: Verbosity = opts.debug === true ? 'debug' : 'normale';

  // Allowlisted MCP servers, verified against their pins. A suspension is
  // boot-visible, not buried: the owner reads why before the first turn.
  let mcpLines: string[] = [];
  try {
    mcpLines = await attachMcp(runtime, home);
  } catch (error) {
    mcpLines = [`mcp: ${error instanceof Error ? error.message : String(error)}`];
  }

  // Only when there is something to decide — see `reviewBootLine`.
  const review = reviewBootLine(runtime.db, CONSOLIDATION_TENANT);

  /**
   * L'intestazione di apertura — «personaggio in alto», parole dell'owner.
   *
   * Una volta sola e poi scrollback come tutto il resto: non si ridisegna e non
   * si aggancia in cima allo schermo, perché `cli/STYLES.md` esclude lo schermo
   * alternato e la ragione vale ancora (quello che è scorso resta copiabile).
   * Le cose che servono anche dopo venti messaggi — modello e sessione — non
   * stanno qui: stanno sul bordo del riquadro, che è sempre l'ultima cosa a
   * schermo.
   *
   * Le righe di avvio (superfici, MCP, memoria) restano **fuori**: sono
   * diagnostica, cambiano di numero a ogni avvio, e infilarle in una cornice le
   * farebbe sembrare identità.
   */
  process.stderr.write(
    `${intestazione(
      [
        `${style.accent('✳')} ${style.bold('muffin')}`,
        style.dim(`${runtime.config.models.main} · profilo ${runtime.deps.profile.name}`),
      ],
      style.dim,
      process.stderr.columns ?? 80,
    ).join('\n')}\n` +
      surfaces.lines.map((l) => `${l}\n`).join('') +
      mcpLines.map((l) => `${l}\n`).join('') +
      runtime.bootLines.map((l) => `${l}\n`).join('') +
      `${consolidationBootLine()}\n` +
      (review === null ? '' : `${review}\n`) +
      `\n`,
  );

  /**
   * La textzone: il messaggio si scrive qui, non in `rl.question`.
   *
   * readline legge **una riga** — Invio spedisce sempre — e non ha un modo di
   * estendersi: la sua unità è la riga. Resta comunque in piedi qui accanto
   * perché la domanda di approvazione è davvero una riga sola (`[s/N]`), e
   * usare la textzone per quella vorrebbe dire offrire un editor multilinea a
   * chi deve dire sì o no.
   *
   * I due non leggono mai insieme: `approve` gira **dentro** un turno, cioè
   * mentre la textzone non sta leggendo niente.
   */
  /**
   * Il fondo fisso (`cli/fondo.ts`): la casella sta nelle ultime righe, la
   * risposta scorre sopra. Attivo solo su un terminale che dichiara la sua
   * altezza; altrove — una pipe, `script`, i test — il riquadro vive in
   * fondo allo scrollback come prima. Le sequenze di posizionamento vanno su
   * **stderr**, così stdout resta i byte della risposta e basta (B11).
   */
  const fondo = makeFondo({
    write: (s) => process.stderr.write(s),
    get rows() {
      return process.stdout.rows;
    },
    get columns() {
      return process.stdout.columns;
    },
    isTTY: process.stdout.isTTY === true && process.stderr.isTTY === true,
  });
  // Su un terminale, sempre: uscire lasciando i margini di scorrimento
  // impostati lascia la shell con tre righe che non scorrono più.
  process.on('exit', () => fondo.chiudi());

  const textzone = makeTextzone({
    input: (opts.stdin ?? process.stdin) as NodeJS.ReadStream,
    output: process.stdout,
    historyFile: join(home, 'repl-history'),
    comandi: COMANDI,
    fondo,
  });
  // Lo schermo è cambiato: i margini vanno rimessi sulle righe nuove e il
  // riquadro ridisegnato, che si stia leggendo o no.
  process.stdout.on('resize', () => {
    fondo.ridimensiona();
    textzone.redraw();
  });
  // Dopo una scrittura fuori banda — un messaggio consegnato da una superficie
  // mentre stavi scrivendo — il prompt e ciò che avevi già digitato tornano al
  // loro posto. È la stessa promessa di prima (`rl.prompt()`), mantenuta da chi
  // adesso possiede il terminale: la textzone sa anche **cosa** c'era scritto,
  // che readline da lì non poteva sapere.
  //
  // Non fa niente quando non stiamo leggendo: un messaggio arrivato mentre il
  // modello risponde non deve far comparire un prompt che nessuno sta usando.
  redrawPrompt = () => textzone.redraw();
  cancellaPrompt = () => textzone.cancella();

  // The terminal is the surface that *can* ask, so here the kernel's `ask`
  // verdict becomes a question instead of a refusal. The wording is the kernel's
  // own — a paraphrase is a chance to make the request sound smaller than it is —
  // and anything that is not an explicit yes is a no.
  //
  // Registrata sotto `cli` e non scritta su `deps.approve`: quella era una
  // funzione sola per processo, e un turno arrivato da Telegram finiva a
  // chiedere `[s/N]` qui dentro — a chi non l'aveva chiesto, su uno schermo che
  // in quel momento nessuno guarda.
  runtime.approvers.set('cli', async (request) => {
    status.line(`\n⚠ ${request.prompt}`);
    // The model's own account first, the exact bytes after: one reads the
    // sentence to know whether to look, and the command to decide. Never
    // the sentence alone — a paraphrase is where a request sounds smaller.
    if (request.description) process.stderr.write(`   cosa fa: ${request.description}\n`);
    if (request.resource) process.stderr.write(`   su: ${request.resource}\n`);
    // Taint 0 is the quiet default; anything above it means untrusted content
    // already steered this turn, and that changes the answer more often than
    // the capability name does.
    if (request.taint > 0) {
      const label = ['', 'contatto noto', 'gruppo/sconosciuto', 'contenuto esterno (web o tool)'][request.taint];
      process.stderr.write(`   contesto: turno a taint ${request.taint}${label ? ` — ${label}` : ''}\n`);
    }
    const risposta = await textzone.readLine(`   approvi "${request.capability}"? [s/N] `);
    // Ctrl+C qui è un no, non un'attesa. Prima non lo era: il gestore SIGINT
    // annullava il turno e questa domanda restava appesa, quindi il terminale
    // continuava a chiedere l'approvazione di una cosa già annullata.
    const answer = risposta.tipo === 'testo' ? risposta.testo.trim().toLowerCase() : '';
    const allowed = answer === 's' || answer === 'si' || answer === 'sì' || answer === 'y';
    process.stderr.write(`   ${allowed ? 'approvato' : 'rifiutato'}\n\n`);
    return allowed ? 'allow' : 'deny';
  });

  let session = runtime.deps.sessions.open();
  let controller: AbortController | null = null;
  let lastInterrupt = 0;

  /**
   * Ctrl+C **mentre un turno gira**.
   *
   * A prompt fermo non passa di qui: la textzone possiede il terminale in modo
   * raw e il tasto le arriva come tasto, non come segnale — quel ramo sta nel
   * loop, dove si sa se è il primo o il secondo. Qui resta il caso che nessuno
   * dei due può gestire: il terminale non lo sta leggendo nessuno perché il
   * modello sta rispondendo.
   */
  process.on('SIGINT', () => {
    if (controller) {
      controller.abort();
      status.line(`\n^C turno annullato`);
      lastInterrupt = Date.now();
    }
  });

  // The scheduler runs here only when nothing else owns it (ADR-0035). A tick
  // finds what is due and runs it as system:scheduler. Foreground wins — while
  // an interactive turn holds the lane (`controller` set), a tick defers, and a
  // job already running gets that turn's abort signal to yield.
  const foreground: ForegroundGate = {
    isActive: () => controller !== null,
    signal: () => controller?.signal,
  };
  // Delivery is the registry's, not this file's. Every surface `connectSurfaces`
  // brought up is a destination; anything else comes back `{ delivered: false }`
  // with the list of what is connected, which is the sentence that tells the
  // owner whether the fix is `muffin surface enable` or a network problem.
  const deliver: Deliver = surfaces.registry.deliver;
  /**
   * Two schedulers must never run (ADR-0035).
   *
   * The gateway owns the ticker whenever it is up; this session ticks only
   * while nobody has the claim. Both tickers on one job store would run the
   * same job twice — the shape of Hermes #25517 that ADR-0022's corollary told
   * us to design out rather than discover.
   *
   * **One mechanism decides, every tick.** There used to be two: a boot-time
   * `readGateway` that decided whether to create the timer at all, plus nothing
   * afterwards. So the timer existing was the answer, and the answer was frozen
   * at the moment the window opened. Now the timer always exists and
   * `gatewayStandDown` arbitrates each tick — which is also what lets this
   * session pick the jobs back up when the gateway dies, instead of a terminal
   * that has been open since before the crash sitting there scheduling nothing.
   *
   * The lock is read, never taken: a REPL that claimed it would stop the
   * gateway from restarting after a crash while a terminal happened to be open.
   * And a gateway killed with -9 does not wedge this forever — its claim goes
   * stale after ten missed heartbeats and the tick after that runs jobs again.
   */
  const gateway = readGateway(runtime.db);
  const standDown = gatewayStandDown(
    runtime.db,
    (line) => {
      process.stderr.write(`\n${line}\n`);
    },
    gateway !== null,
  );
  const scheduler = new Scheduler(
    runtime.jobs,
    makeJobRunner(runtime.deps, runtime.jobFires, runtime.executor, { cwd: runtime.workspace }),
    deliver,
    foreground,
    (e) => {
      if (e.kind === 'delivery_failed') {
        status.line(`job ${e.job.id.slice(0, 8)}: consegna fallita (${e.error})`);
      } else if (e.kind === 'yielded') {
        // P21 (1b)/(2) MEDIUM: see the identical branch in `cli/gateway.ts` —
        // an aborted job retried silently on every tick before this.
        status.line(`job ${e.job.id.slice(0, 8)}: ceduto — riproverà al prossimo giro`);
      } else if (e.kind === 'not_recorded') {
        status.line(`job ${e.job.id.slice(0, 8)}: esito non registrato — ${e.error}`);
      }
    },
    undefined,
    standDown,
    // The outcome lands on the turn's row, same as `cli/gateway.ts`.
    (turnId, state) => runtime.deps.turns.delivered(turnId, state),
    // The REPL owns no `TurnLane` (ADR-0035: it cedes turns to the gateway),
    // so there is nothing to share this token with — a fresh instance still
    // serialises this scheduler against itself, which is the whole property
    // this session needs.
    new ModelLane(),
    // `stillOwner` — the REPL's scheduler holds no gateway claim to
    // re-verify, same default as every other REPL/test construction.
    undefined,
    // B7: same wiring as `cli/gateway.ts`, so a job the REPL runs (no gateway
    // installed yet, or its claim gone stale) gets the same identity bridge.
    (job) => runtime.jobFires.settle(job.id, job.nextFireAt.toISOString()),
  );
  const ticker = setInterval(() => scheduler.tick(), TICK_MS);
  ticker.unref(); // the timer must not, by itself, keep the process alive
  // Says who owns it *now*, from the same read the ticker will redo. The line
  // is allowed to become false — that is what the handover announcement is for.
  process.stderr.write(
    gateway === null
      ? `scheduler: in questa sessione — i job girano finché la finestra è aperta\n`
      : `scheduler: del gateway (pid ${gateway.pid}) — i job girano anche senza di te\n`,
  );
  // One tick now, not only on the interval — the gateway does the same and for
  // the same reason (`service.ts`): a job that came due while nothing was
  // running is the case `markRan`'s catch-up exists for, and waiting a whole
  // interval to notice it is a job the owner watched not happen.
  scheduler.tick();

  try {
    for (;;) {
      const esito = await textzone.read({
        prompt: promptText,
        // Sul bordo: modello e sessione, cioè le due cose che l'intestazione
        // dice all'avvio e che dopo venti messaggi non sono più sullo schermo.
        etichetta: style.dim(`${runtime.config.models.main} · ${session.id}`),
        suggerimenti: 'invio spedisce · shift+invio va a capo · tab completa · /help',
        smorza: style.dim,
      });
      if (esito.tipo === 'fine') break;
      if (esito.tipo === 'interrotto') {
        // Ctrl+C a prompt vuoto: la stessa regola di prima — il primo avverte,
        // il secondo entro due secondi esce. Con un turno in volo non si passa
        // mai di qui, perché la textzone non sta leggendo.
        const ora = Date.now();
        if (ora - lastInterrupt < 2000) break;
        lastInterrupt = ora;
        process.stderr.write(`(di nuovo Ctrl+C per uscire)\n`);
        continue;
      }
      const line = esito.testo.trim();
      if (line === '') continue;

      if (sembraComando(line)) {
        // Un posto solo per tutte le superfici (`agent/comandi.ts`): qui resta
        // solo ciò che è davvero del terminale — chiudere il processo, la
        // riga di stato da togliere prima di scrivere, e la sessione nuova,
        // che qui è un id nuovo mentre su Telegram è un archivio.
        const esito = await eseguiComando(line, {
          home,
          config: runtime.config,
          onConfig: (next) => {
            runtime.config = next;
          },
          profilo: { name: runtime.deps.profile.name, thinking: runtime.deps.profile.thinking },
          onThinking: (t) => {
            runtime.deps.profile.thinking = t;
          },
          budget: runtime.budget,
          sessionId: session.id,
          verbosity,
          puoiUscire: true,
          model: (argv, out) => cmdModel(home, argv, { out }),
        });
        if (esito.esci === true) break;
        if (esito.sconosciuto === true) {
          process.stderr.write(`comando sconosciuto.\n${aiuto(true)}\n`);
          continue;
        }
        if (esito.nuovaSessione === true) session = runtime.deps.sessions.open();
        if (esito.verbosity !== undefined) verbosity = esito.verbosity;
        // `status.line` e non `stderr.write`: lo spinner possiede il terminale
        // mentre gira, e una riga scritta sotto di lui gli finisce dentro.
        status.line(esito.testo);
        continue;
      }

      const iniziatoAlle = Date.now();
      controller = new AbortController();
      try {
        /**
         * B11: the leading `\n` moves here, written once, before the first
         * delta — so a streamed turn's stdout bytes are `\n` + every chunk in
         * order, and an unstreamed one is `\n` + `result.text`, and those are
         * required to be the *same* bytes (`repl.test.ts`). Nothing is
         * flushed a second time below when `streamedAnyText` ends up true:
         * `result.text` was already written, chunk by chunk, as it formed.
         */
        let streamedAnyText = false;
        const onDelta = streamEnabled
          ? (delta: TurnDelta): void => {
              if (delta.type === 'boundary') {
                // Quel testo non era la risposta. Non lo si toglie — è stato
                // scritto davvero — ma si chiude, così quello che viene dopo
                // non gli si incolla addosso e `streamedAnyText` torna a dire
                // il vero: la risposta **non** è ancora a schermo.
                if (streamedAnyText) process.stdout.write('\n');
                streamedAnyText = false;
                if (delta.reason === 'superseded') {
                  // Il caso raro va detto, non lasciato indovinare: senza
                  // questa riga il turno mostra due stesure di fila e sembra
                  // che l'agente si sia ripetuto.
                  process.stderr.write(`${style.dim('↺ quel tentativo è stato sostituito')}\n`);
                }
                return;
              }
              if (!streamedAnyText) {
                // La riga di stato se ne va **prima** del primo byte di
                // risposta: lo spinner riscrive in place, e una risposta che
                // comincia mentre lui gira si troverebbe `⠹ penso…` incollato
                // davanti alla prima parola.
                status.clear();
                process.stdout.write('\n');
                streamedAnyText = true;
              }
              process.stdout.write(delta.text);
            }
          : undefined;
        const onProgress = progressEnabled
          ? (event: TurnEvent): void => {
              const line = formatProgressLine(event, verbosity);
              if (line !== null) {
                status.clear();
                process.stderr.write(`${line}\n`);
              }
              // In debug la riga di stato non serve: ogni giro e ogni tool
              // lasciano già una riga propria, e uno spinner sopra righe che
              // scorrono da sole è solo una cosa in più che lampeggia.
              const attesa = verbosity === 'debug' ? null : statusFor(event);
              if (attesa !== null) status.show(attesa);
            }
          : undefined;

        const result = await runTurn(runtime.deps, {
          principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
          tenant: 'host',
          surface: 'cli',
          session,
          text: line,
          signal: controller.signal,
          // No `replyTo` (the REPL holds the answer itself, see below), but a
          // `replyChannel` all the same: `send_file` mid-turn needs somewhere
          // to address an attachment, and for the terminal that address is
          // just `cli` — the owner is on this machine, so `cliSurface`'s
          // `deliverFile` names the path rather than moving any bytes.
          replyChannel: 'cli',
          ...(onDelta ? { onDelta } : {}),
          ...(onProgress ? { onProgress } : {}),
        });
        // Anche sul ramo non-streaming: senza `onDelta` nessuno ha ancora
        // tolto la riga di stato, e l'ultima attesa resterebbe stampata sopra
        // la risposta.
        status.clear();
        process.stdout.write(streamedAnyText ? '\n\n' : `\n${result.text}\n\n`);
        // Su stderr, come tutto cio' che e' cornice: `muffin > risposte.txt`
        // raccoglie le risposte e lascia questa a schermo.
        if (progressEnabled) {
          const usd = costUsd(runtime.config.models.main, result.usage, runtime.config.provider.baseUrl);
          process.stderr.write(
            `${style.dim(closingLine(result.usage, Date.now() - iniziatoAlle, usd))}\n\n`,
          );
        }
        if (result.stopped === 'suspended') {
          /**
           * A suspended turn prints nothing above (its text is empty), so
           * without this line the terminal shows a blank answer and the word
           * "suspended" — which reads as a failure.
           *
           * It says who is going to finish it, because in this process the
           * answer is *nobody*: the REPL stands down for the gateway (ADR-0035)
           * and deliberately runs no turn lane, so a wait armed here is owed a
           * `muffin gateway run`. Telling the owner that is the difference
           * between a turn that is waiting and a turn that is lost.
           */
          process.stderr.write(
            `(sospeso fino a ${result.suspendedUntil?.wakeAt ?? '?'} — riprende dalla corsia del gateway; ` +
              `turno ${result.turnId.slice(0, 12)})\n`,
          );
        } else if (result.stopped !== 'answered') {
          process.stderr.write(`(${result.stopped} dopo ${result.iterations} passaggi)\n`);
        }
      } catch (error) {
        status.clear();
        process.stderr.write(`errore: ${error instanceof Error ? error.message : String(error)}\n`);
      } finally {
        // Anche su Ctrl+C e su un turno che esplode: uno spinner che gira dopo
        // la fine del turno è un processo che sembra ancora al lavoro, ed è la
        // bugia che questa riga esiste per non dire.
        status.stop();
        controller = null;
      }
    }
  } catch (error) {
    // readline throws on close(); that is the normal way out of the loop.
    if (!(error instanceof Error && /closed/i.test(error.message))) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  } finally {
    status.stop();
    clearInterval(ticker);
    // Il terminale torna com'era, sempre. Uscire lasciando lo stdin in raw mode
    // non rompe Muffin: rompe la **shell** che resta dopo — niente eco, niente
    // Ctrl+C — e chi ci finisce dentro non ha nessun motivo di collegare la
    // cosa a un comando che è già uscito.
    if (process.stdin.isTTY === true) process.stdin.setRawMode(false);
    // Surfaces first, then the runtime: the connector must stop polling before
    // the database under it goes away.
    surfaces.stop();
    runtime.close();
    // I margini tornano com'erano e il cursore scende sotto il riquadro,
    // che resta nello scrollback come l'ultima cosa scritta.
    fondo.chiudi();
  }

  process.stderr.write(`\nciao.\n`);
  return 0;
}
