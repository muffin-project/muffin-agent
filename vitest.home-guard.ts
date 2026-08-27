/**
 * La guardia sulla casa vera, per tutta la suite.
 *
 * `globalSetup` e non un `beforeAll`: gira una volta sola per run, fuori dai
 * worker, ed è l'unico posto che vede *tutti* i file di test insieme. Un test
 * che scrive nella home dell'owner non lo fa nel file dove lo si sospetta —
 * altrimenti sarebbe già stato visto.
 *
 * Perché esiste: `core/config/home-guard.ts` racconta le due volte in cui è
 * successo. Il codice si è riparato entrambe le volte nel punto giusto; questo
 * è la parte che non dipende dal ricordarsene.
 */
import { homedir } from 'node:os';
import { markHome, homeDrift, type HomeMark } from './core/config/home-guard.js';

let prima: HomeMark[] = [];

export function setup(): void {
  prima = markHome(homedir(), process.env['XDG_CONFIG_HOME']);
}

export function teardown(): void {
  const drift = homeDrift(prima, markHome(homedir(), process.env['XDG_CONFIG_HOME']));
  if (drift.length === 0) return;
  // Un throw qui fa uscire vitest non-zero: è la differenza fra una guardia e
  // una riga di log che nessuno legge in fondo a 2000 test verdi.
  throw new Error(
    `la suite ha toccato la casa vera — un test è uscito dalla sua home temporanea:\n  ${drift.join('\n  ')}\n\n` +
      `Chi scrive lì di solito legge la destinazione da \`homedir()\` invece di riceverla:\n` +
      `vedi il commento su \`homeDir\` in \`cli/gateway.ts\`.`,
  );
}
