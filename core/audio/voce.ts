import type { AudioBlock } from '../../agent/providers/types.js';
import { loadAudio } from '../../agent/audio.js';
import { audioAccettato } from '../../agent/providers/modalita.js';
import { trascrivi, type TrascriviDeps } from './trascrivi.js';

/**
 * Il bivio delle note vocali, in un posto solo.
 *
 * L'owner l'ha disegnato così il 28/08/2026: «se il modello supporta audio lo
 * mandiamo al modello direttamente, altrimenti usiamo whisper.cpp, quindi
 * facciamo entrambe le cose, ma scegliamo quale fare in base al modello a cui
 * stiamo mandando».
 *
 * Questo modulo è quel «scegliamo». Sta qui e non dentro il connettore
 * Telegram perché il connettore non ha nessuna ragione di sapere che esistono
 * i provider o whisper: riceve una funzione e la chiama. Il giorno che una
 * nota vocale arriva da un'altra superficie — o dalla CLI — la seconda porta
 * non riscrive la decisione, chiama la stessa funzione.
 */

export type Voce =
  /** Il modello ascolta: i byte vanno a lui. */
  | { modo: 'ascolta'; blocco: AudioBlock }
  /** Il modello non ascolta: la voce è diventata testo senza uscire di casa. */
  | { modo: 'trascritto'; testo: string }
  /** Né l'uno né l'altro, e si dice perché. */
  | { modo: 'no'; why: string; rimedio?: string };

export type VoceDeps = TrascriviDeps & {
  /** `undefined` quando il provider è Anthropic: audio in ingresso non ne accetta. */
  baseUrl?: string | undefined;
  model: string;
  apiKey?: string | undefined;
  /** Solo per i test, come il `run` di `trascrivi`. */
  fetch?: typeof globalThis.fetch;
};

/**
 * Cosa fare di questo file audio.
 *
 * Non lancia mai, come `loadAudio` e `trascrivi`: ogni esito è una cosa da
 * raccontare, e il solo esito inaccettabile sarebbe il silenzio — una nota
 * vocale ricevuta di cui nessuno dice niente è un pezzo di conversazione perso
 * senza traccia.
 */
export async function decidiVoce(percorso: string, deps: VoceDeps): Promise<Voce> {
  const chiedi = { apiKey: deps.apiKey, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) };
  if (await audioAccettato(deps.baseUrl, deps.model, chiedi)) {
    const caricato = loadAudio(percorso);
    // Il modello ascolterebbe, ma questi byte non glieli possiamo dare — troppo
    // grossi, o non un formato che sappiamo nominare. Non è la fine: la
    // trascrizione locale non ha nessuno di quei due limiti, e provarla è
    // meglio che chiudere qui.
    if (caricato.ok) return { modo: 'ascolta', blocco: caricato.block };
  }
  const detto = await trascrivi(percorso, deps);
  if (detto.ok) return { modo: 'trascritto', testo: detto.testo };
  return { modo: 'no', why: detto.why, ...(detto.rimedio === undefined ? {} : { rimedio: detto.rimedio }) };
}
