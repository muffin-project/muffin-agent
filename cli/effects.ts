import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import DatabaseCtor from 'better-sqlite3';
import { paths } from '../core/config/config.js';
import { loadSealedBudgets } from '../core/rot/budgets.js';
import { type EffectsFilter, formatEffects, localDay, readEffects } from '../core/turns/effects.js';

/**
 * `muffin effects` — il registro degli effetti (D15) da terminale.
 *
 * **Non è la porta dell'owner, ed è deliberato.** La decisione owner del
 * 07/09/2026 (`docs/product/VISION.md`) dice che chi usa Muffin normalmente gli parla:
 * «cosa hai fatto oggi?» arriva al modello, che chiama `sys_effects`. Questo
 * comando sta nel quarto secchio della VISION — *developer/operator
 * interfaces* — e serve a ciò per cui quel secchio esiste: leggere il registro
 * quando il turno non parte, quando il database da guardare non è quello vivo,
 * quando serve una risposta senza spendere un modello.
 *
 * Una sola query per tutte e due le porte (`readEffects`): questo comando e il
 * tool non possono dare risposte diverse alla stessa domanda, perché è
 * letteralmente la stessa funzione.
 *
 * `--db` è opzionale, a differenza di `muffin orientamento`: quel comando
 * esiste per misurare *un* database e il suo mandato vietava di toccare la
 * home dell'owner, mentre questo risponde «cosa ho fatto **io**», e l'io è
 * l'installazione da cui lo lanci. Aperto in sola lettura comunque.
 */
const EFFECTS_USAGE = `usage: muffin effects [--turn <id> | --day YYYY-MM-DD | --today] [--db <path>]
  cosa e' passato senza domanda, per turno o per giornata: capability, risorsa,
  riga della matrice che l'ha ammesso, classe di reversibilita'.
  --turn  un turno preciso (l'id che il turno stampa alla fine)
  --day   una giornata locale (default: oggi)
  --today esplicito, equivale a nessun filtro
  --db    un database diverso da quello dell'installazione, in sola lettura
`;

export function cmdEffects(argv: string[], now: () => Date = () => new Date()): number {
  let values: { turn?: string; day?: string; today?: boolean; db?: string };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        turn: { type: 'string' },
        day: { type: 'string' },
        today: { type: 'boolean' },
        db: { type: 'string' },
      },
      allowPositionals: false,
    }) as { values: typeof values });
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n${EFFECTS_USAGE}`,
    );
    return 78;
  }

  if (values.turn !== undefined && values.day !== undefined) {
    process.stderr.write(
      `--turn e --day sono due domande diverse: scegline una.\n${EFFECTS_USAGE}`,
    );
    return 78;
  }

  const file = values.db ?? paths().db;
  if (!existsSync(file)) {
    process.stderr.write(`nessun database in ${file}\n`);
    return 78;
  }

  /**
   * Il fuso **dell'owner**, dal root of trust sigillato, per la ragione scritta
   * in `agent/tools/effects.ts`: le due porte devono intendere la stessa
   * giornata, e il fuso del processo non è quello dell'owner appena il comando
   * gira dentro un supervisore o su una VPS. Stessa lettura di
   * `cli/jobs.ts#ownerTimezone`, e la stessa caduta a `UTC` quando il root of
   * trust non si legge — un fuso indovinato sarebbe peggio di uno dichiarato.
   *
   * Su un `--db` altrui resta il fuso di **questa** installazione: è l'unico
   * che si possa leggere, e la giornata stampata lo dice nell'intestazione.
   */
  let timeZone = 'UTC';
  try {
    timeZone = loadSealedBudgets(paths().home).quietHours.timezone;
  } catch {
    // Root of trust illeggibile: è un problema di `muffin doctor`, non di
    // questo comando, che deve comunque poter mostrare il registro.
  }

  const adesso = now();
  // Costruito **dentro** il try/catch che segue, non prima: `dayBounds` lancia
  // su una data non valida, e fuori di qui quel lancio usciva da `cmdEffects`
  // come stack trace — `cli/main.ts` non lo cattura. Un errore d'uso deve
  // uscire 78 con una frase, come ogni altro argomento sbagliato.
  const filter = (): EffectsFilter =>
    values.turn !== undefined
      ? { turnId: values.turn }
      : { day: values.day ?? localDay(adesso, timeZone), timeZone };

  const db = new DatabaseCtor(file, { readonly: true, fileMustExist: true });
  try {
    process.stdout.write(`${formatEffects(readEffects(db, filter()))}\n`);
    return 0;
  } catch (error) {
    // Un database piu' vecchio del registro degli effetti non ha le colonne, e
    // dirlo per nome e' piu' utile del messaggio grezzo di SQLite: la cura e'
    // far girare Muffin una volta, che le aggiunge (`ensureColumn`).
    const detail = error instanceof Error ? error.message : String(error);
    if (/no such column/.test(detail)) {
      process.stderr.write(
        `${file} e' stato scritto prima del registro degli effetti e non ha le colonne ` +
          `(${detail}). Fai partire Muffin una volta su questa home: le aggiunge da solo.\n`,
      );
      return 78;
    }
    if (/data non valida/.test(detail)) {
      process.stderr.write(`${detail}\n${EFFECTS_USAGE}`);
      return 78;
    }
    throw error;
  } finally {
    db.close();
  }
}
