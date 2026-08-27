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
  // 0600 come i segreti, e non perché apra qualcosa: perché **è** il recinto
  // delle skill per tutta la vita di questa installazione. `~/.muffin` è 0755
  // con umask 022, quindi senza `mode` questo file nascerebbe leggibile da
  // qualunque altro utente della macchina — e su una VPS «qualunque altro
  // utente» non è un'ipotesi. Prima di questa riga i nonce vivevano solo in
  // memoria, per chiamata: metterne uno su disco è la cosa nuova, e va messa
  // con i permessi giusti. Judge di `slice/skill-di-serie`.
  writeFileSync(file, `${nuovo}\n`, { encoding: 'utf8', mode: 0o600 });
  return nuovo;
}
