import type { ImageLoad } from '../../agent/images.js';
import type { ImageBlock } from '../../agent/providers/types.js';

/**
 * Il bivio delle immagini, in un posto solo — gemello di `decidiVoce`.
 *
 * L'owner l'ha disegnato così: se il modello ci vede, l'immagine va a lui;
 * se è misurato che non ci vede, la descrive un altro modello che ci vede e
 * lo si dice esplicitamente; se nessuno ci vede (o non si può descrivere), lo
 * si dice forte invece di far finta.
 *
 * Sta qui e non dentro il connettore Telegram per la stessa ragione di `voce`:
 * il connettore riceve una funzione e la chiama. Tre esiti anche qui, e anche
 * qui il solo esito inaccettabile sarebbe il silenzio — con una differenza:
 * descrivere costa una chiamata al modello (la trascrizione è gratis perché è
 * locale), quindi il ramo `descritta` esiste solo quando c'è davvero chi
 * descrive, tetto piccolo e spesa sulla corsia leggera.
 */

export type Vista =
  /** Il modello vede: i byte vanno a lui. */
  | { modo: 'mostra'; blocco: ImageBlock }
  /** Il modello non vede: un altro modello l'ha descritta, e si dice quale. */
  | { modo: 'descritta'; testo: string; descrittaDa: string }
  /** Né l'uno né l'altro, e si dice perché. */
  | { modo: 'no'; why: string; rimedio?: string };

/**
 * Come si misura se un modello vede le immagini. Firma identica a
 * `immagineAccettata`, che il chiamante di produzione inietta: il nucleo
 * decide, non va in rete da sé.
 */
export type MisuraVista = (
  baseUrl: string | undefined,
  model: string,
  domanda: { apiKey?: string | undefined; fetch?: typeof globalThis.fetch },
) => Promise<boolean | undefined>;

export type VistaDeps = {
  baseUrl?: string | undefined;
  /** Omission preserves legacy shared-endpoint callers; explicit undefined is native light. */
  lightBaseUrl?: string | undefined;
  lightApiKey?: string | undefined;
  mainModel: string;
  lightModel: string;
  apiKey?: string | undefined;
  /** Solo per i test, come il `run` di `trascrivi`. */
  fetch?: typeof globalThis.fetch;
  /**
   * Chi carica i byte e chi misura la vista. Iniettati dal chiamante
   * (produzione: `loadImage` + `immagineAccettata` via `vistaFor`): questo
   * modulo non importa comportamento da `agent/`, solo contratti di tipo.
   */
  carica: (percorso: string) => ImageLoad;
  misuraVista: MisuraVista;
  /**
   * Descrive l'immagine col modello leggero. Chiesto solo quando serve, mai
   * in anticipo: è una chiamata a pagamento. Assente vuol dire "nessuno
   * descrive" — il bivio cade dritto sul `no` dichiarato.
   */
  descrivi?: ((immagine: ImageBlock) => Promise<string>) | undefined;
};

/**
 * Cosa fare di questo file immagine.
 *
 * Non lancia mai: ogni esito è una cosa da raccontare. `false` misurato sul
 * modello principale apre la via di fuga, `undefined` (endpoint non
 * misurabile, Anthropic nativo) tiene la strada di sempre.
 */
export async function decidiVista(percorso: string, deps: VistaDeps): Promise<Vista> {
  const domanda = {
    apiKey: deps.apiKey,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
  };
  const vede = await deps.misuraVista(deps.baseUrl, deps.mainModel, domanda);
  if (vede !== false) {
    const caricata = deps.carica(percorso);
    if (caricata.ok) return { modo: 'mostra', blocco: caricata.block };
    return { modo: 'no', why: caricata.why };
  }
  const lightBaseUrl = Object.hasOwn(deps, 'lightBaseUrl') ? deps.lightBaseUrl : deps.baseUrl;
  const lightQuestion = {
    ...domanda,
    apiKey: Object.hasOwn(deps, 'lightApiKey') ? deps.lightApiKey : deps.apiKey,
  };
  if (
    deps.descrivi !== undefined &&
    (await deps.misuraVista(lightBaseUrl, deps.lightModel, lightQuestion)) === true
  ) {
    const caricata = deps.carica(percorso);
    if (!caricata.ok) return { modo: 'no', why: caricata.why };
    try {
      const testo = await deps.descrivi(caricata.block);
      if (testo.trim() === '')
        return { modo: 'no', why: 'il modello leggero non ha risposto alla descrizione' };
      return { modo: 'descritta', testo, descrittaDa: deps.lightModel };
    } catch (error) {
      return {
        modo: 'no',
        why: `la descrizione non è riuscita: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return {
    modo: 'no',
    why:
      deps.descrivi === undefined
        ? 'il modello non vede le immagini e nessuno le descrive'
        : `il modello non vede le immagini, e neanche ${deps.lightModel}`,
    rimedio: 'passa con /model a un modello che vede le immagini',
  };
}
