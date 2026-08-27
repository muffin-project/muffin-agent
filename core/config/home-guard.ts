/**
 * I posti che Muffin installa nella casa di chi lo usa.
 *
 * Non è una lista di file preziosi: è la lista dei posti dove **questo
 * programma** scrive quando è installato per davvero. Un test che ne tocca uno
 * ha smesso di girare nella sua home temporanea, e l'unico modo di accorgersene
 * finora era guardare — cosa che si fa dopo aver già rotto qualcosa.
 *
 * È successo due volte. La prima un test scrisse un LaunchAgent vero in
 * `~/Library` e il file sopravvisse alla run, perché la pulizia stava dopo
 * un'asserzione che falliva. La seconda, il 27/08/2026, un
 * `muffin-gateway.service` comparve nella `~/.config` vera con
 * `WorkingDirectory` su una directory temporanea già cancellata: la difesa
 * copriva il planner puro e non il chiamante che leggeva `homedir()` da sé.
 *
 * Entrambe le volte il codice si è riparato nel punto giusto. Questo file è
 * l'altra cosa, quella che non dipende dal ricordarsene: un posto solo da cui
 * ogni fuga passa.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';

export type HomeMark = { path: string; stamp: string };

/**
 * I percorsi sorvegliati, dato un HOME.
 *
 * Assoluti e nominati uno per uno: un glob su `~` sarebbe una promessa più
 * larga di quella che questo file può mantenere, e il primo falso positivo
 * (un editor che tocca una preferenza mentre gira la suite) lo farebbe
 * spegnere entro la settimana.
 */
export function watchedPaths(homeDir: string, configHome?: string): string[] {
  return [
    join(homeDir, '.muffin'),
    join(homeDir, 'Library', 'LaunchAgents', 'ai.muffin.gateway.plist'),
    join(configHome ?? join(homeDir, '.config'), 'systemd', 'user', 'muffin-gateway.service'),
    join(configHome ?? join(homeDir, '.config'), 'muffin'),
  ];
}

/**
 * Lo stato di un percorso, in una stringa confrontabile.
 *
 * `assente` è un valore come gli altri, non un errore: la comparsa di un file
 * che non c'era è esattamente il caso che ha morso due volte, e trattarla come
 * "niente da confrontare" la renderebbe invisibile.
 */
export function markHome(homeDir: string, configHome?: string): HomeMark[] {
  return watchedPaths(homeDir, configHome).map((path) => {
    try {
      const s = statSync(path);
      // mtimeMs e size: un file riscritto con lo stesso contenuto non è un
      // problema di questa guardia, ma non costa niente segnalarlo, e la
      // dimensione prende il caso in cui la mtime ha la granularità di un
      // secondo e la scrittura è avvenuta dentro lo stesso.
      return { path, stamp: `${s.mtimeMs}:${s.size}` };
    } catch {
      return { path, stamp: 'assente' };
    }
  });
}

/** Cosa è cambiato fra due marchi — vuoto quando la casa è intatta. */
export function homeDrift(before: HomeMark[], after: HomeMark[]): string[] {
  const prima = new Map(before.map((m) => [m.path, m.stamp]));
  const out: string[] = [];
  for (const m of after) {
    const era = prima.get(m.path);
    if (era === undefined || era === m.stamp) continue;
    out.push(
      era === 'assente'
        ? `${m.path} — non c'era prima della suite, adesso c'è`
        : `${m.path} — è stato riscritto durante la suite`,
    );
  }
  return out;
}
