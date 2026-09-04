/**
 * La guardia sulla casa vera, per tutta la suite.
 *
 * `globalSetup` e non un `beforeAll`: gira una volta sola per run, fuori dai
 * worker, ed è l'unico posto che vede *tutti* i file di test insieme. Un test
 * che scrive nella home dell'owner non lo fa nel file dove lo si sospetta —
 * altrimenti sarebbe già stato visto.
 *
 * Perché esiste: `core/config/home-guard.ts` racconta le due volte in cui è
 * successo, e il falso positivo del 04/09 che ha deciso la forma attuale.
 *
 * **Chi ha scritto si chiede al socket di controllo**, con la stessa primitiva e
 * la stessa dottrina che `core/gateway/control-socket.ts` usa per non
 * scambiare un socket rimasto da un morto per un gateway vivo: *«la differenza
 * si misura, non si assume: si prova a parlarci»*. Una risposta è una prova che
 * un processo è vivo su quella casa; il silenzio **non** è una prova che sia
 * morto, e infatti qui vale come «nessuna indulgenza».
 *
 * Si chiede a `teardown`, non a `setup`: la domanda è chi stava scrivendo
 * *durante* la suite, e un gateway avviato a metà run non è visibile all'inizio.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  giudica,
  homeDrift,
  markHome,
  raccontaDrift,
  type HomeMark,
  type Installazione,
} from './core/config/home-guard.js';
import { askGateway, type Identify } from './core/gateway/control-socket.js';

let prima: HomeMark[] = [];

export function setup(): void {
  prima = markHome(homedir(), process.env['XDG_CONFIG_HOME']);
}

/**
 * `null` su qualunque incertezza, ed è la direzione sicura: significa
 * «giudica tutto», non «lascia passare».
 */
async function installazioneViva(): Promise<Installazione> {
  const home = join(homedir(), '.muffin');
  try {
    const r = (await askGateway(home, 'identify')) as Identify | null;
    if (r === null || typeof r.pid !== 'number' || typeof r.home !== 'string') return null;
    return { pid: r.pid, home: r.home };
  } catch {
    return null;
  }
}

export async function teardown(): Promise<void> {
  const drift = homeDrift(prima, markHome(homedir(), process.env['XDG_CONFIG_HOME']));
  if (drift.length === 0) return;

  const viva = await installazioneViva();
  const { fatali, spiegate } = giudica(drift, viva);

  if (spiegate.length > 0 && viva !== null) {
    // Si stampa comunque: l'informazione non si perde, cambia solo chi la
    // giudica. Se un giorno una di queste righe è davvero un test sfuggito,
    // resta scritta sopra l'output della run invece di sparire.
    process.stderr.write(
      `\nla casa viva ha scritto mentre girava la suite — gateway pid ${viva.pid}, non è una fuga:\n  ` +
        `${spiegate.map(raccontaDrift).join('\n  ')}\n`,
    );
  }
  if (fatali.length === 0) return;

  // Un throw qui fa uscire vitest non-zero: è la differenza fra una guardia e
  // una riga di log che nessuno legge in fondo a 2000 test verdi.
  throw new Error(
    `la suite ha toccato la casa vera — un test è uscito dalla sua home temporanea:\n  ` +
      `${fatali.map(raccontaDrift).join('\n  ')}\n\n` +
      (viva === null
        ? `Nessun gateway ha risposto sul socket di controllo, quindi ogni deriva è stata giudicata.\n`
        : `Un gateway è vivo (pid ${viva.pid}), ma queste derive non sono cose che un gateway in esecuzione produce.\n`) +
      `Chi scrive lì di solito legge la destinazione da \`homedir()\` invece di riceverla:\n` +
      `vedi il commento su \`homeDir\` in \`cli/gateway.ts\`.`,
  );
}
