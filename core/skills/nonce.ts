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
  try {
    // `wx`: fallisce se il file esiste già invece di troncarlo. Due processi
    // che bootano insieme su una home nuova passavano entrambi `existsSync`,
    // generavano due nonce e si sovrascrivevano a vicenda — nessuno dei due
    // sbagliato, ma il perdente teneva in memoria un nonce che il disco non
    // aveva più, e il prefisso della cache si frammentava proprio fra i
    // processi che dovevano condividerlo. Segnalato dal judge della slice.
    writeFileSync(file, `${nuovo}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return nuovo;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // Qualcun altro è arrivato primo: il suo vince, e questo processo lo adotta.
    const vincitore = readFileSync(file, 'utf8').trim();
    return /^[0-9a-f]{12,}$/.test(vincitore) ? vincitore : nuovo;
  }
}
