import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { paths } from '../config/config.js';

/**
 * Il nonce del recinto delle skill: uno per installazione, stabile per sempre.
 *
 * Creato al primo uso invece che solo da `init`, perché le installazioni che
 * esistono già non passano da `init` un'altra volta e un file mancante non deve
 * diventare un boot rotto — né, peggio, un ritorno silenzioso al nonce
 * per-chiamata, che è il difetto che questo file esiste per chiudere.
 */
export function promptNonce(home: string): string {
  const file = paths(home).promptNonce;
  if (existsSync(file)) {
    const letto = readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{12,}$/.test(letto)) return letto;
    // Un file illeggibile si rifà: un nonce malformato nel recinto è peggio di
    // un nonce nuovo, e questo non è un segreto la cui rotazione costi qualcosa.
  }
  const nuovo = randomBytes(6).toString('hex');
  writeFileSync(file, `${nuovo}\n`, 'utf8');
  return nuovo;
}
