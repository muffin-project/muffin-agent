/**
 * Come i comandi si presentano su un terminale.
 *
 * Nasce da una riga dell'owner davanti a un `muffin doctor` lungo una schermata:
 * *«manco si capisce da dove parte un comando»*. È letteralmente vero — l'output
 * comincia subito dopo il prompt della shell, tutto dello stesso colore, e
 * `✓`, `!` e le righe di rimedio `→` hanno lo stesso peso visivo di tutto il
 * resto. Trovare il primo `!` in venti righe di `✓` è un lavoro che sta facendo
 * l'occhio e che dovrebbe fare il terminale.
 *
 * **Il colore è additivo e sparisce da solo.** Mai quando `NO_COLOR` è
 * impostata (lo standard, e la suite di test lo passa già a ogni `spawnSync`),
 * mai quando lo stream non è un TTY, mai su `TERM=dumb`. Quindi ogni
 * `expect(out).toContain('…')` che c'è oggi continua a valere byte per byte,
 * e una pipe verso `grep` o `tee` riceve lo stesso testo di prima. È la stessa
 * regola di `makeStatusLine` e per la stessa ragione: una sequenza di escape
 * dentro un file è spazzatura.
 *
 * **Niente dipendenze.** Sono otto codici SGR: importare una libreria per
 * `\x1b[32m` sarebbe un'altra cosa da aggiornare per il resto della vita del
 * progetto.
 */

const SGR = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
} as const;

export type Style = {
  /** Se il colore sta davvero uscendo. Letto dai test, e da chi deve decidere se allineare a mano. */
  readonly enabled: boolean;
  ok(s: string): string;
  warn(s: string): string;
  fail(s: string): string;
  dim(s: string): string;
  bold(s: string): string;
  accent(s: string): string;
  /**
   * La riga che dice **dove comincia questo comando**.
   *
   * Il problema che risolve non è estetico: senza, l'output di un comando e
   * quello del comando prima sono un blocco solo, e in uno scrollback lungo non
   * c'è modo di dire dove finisce uno e comincia l'altro. Una riga sola, con il
   * nome del comando e ciò su cui sta lavorando.
   */
  header(command: string, subject?: string): string;
};

const identita = (s: string): string => s;

/**
 * Lo stile per questo stream.
 *
 * `env` iniettabile perché i test non devono poter dipendere dall'ambiente di
 * chi li lancia — e perché la regola `NO_COLOR` va provata, non assunta.
 */
export function styleFor(
  stream: { isTTY?: boolean | undefined },
  env: Record<string, string | undefined> = process.env,
): Style {
  const enabled = stream.isTTY === true && env['NO_COLOR'] === undefined && env['TERM'] !== 'dumb';
  if (!enabled) {
    return {
      enabled: false,
      ok: identita,
      warn: identita,
      fail: identita,
      dim: identita,
      bold: identita,
      accent: identita,
      header: (command, subject) => (subject === undefined ? `${command}` : `${command} · ${subject}`),
    };
  }
  const vesti =
    (codice: string) =>
    (s: string): string =>
      `${codice}${s}${SGR.reset}`;
  return {
    enabled: true,
    ok: vesti(SGR.green),
    warn: vesti(SGR.yellow),
    fail: vesti(SGR.red),
    dim: vesti(SGR.dim),
    bold: vesti(SGR.bold),
    accent: vesti(SGR.cyan),
    header: (command, subject) =>
      `${SGR.bold}${SGR.cyan}${command}${SGR.reset}` +
      (subject === undefined ? '' : ` ${SGR.dim}· ${subject}${SGR.reset}`),
  };
}

/** Lo stile che non colora mai — per i test e per chi costruisce una stringa che va su disco. */
export const PLAIN: Style = styleFor({ isTTY: false }, {});
