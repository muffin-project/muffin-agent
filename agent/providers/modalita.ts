/**
 * Cosa accetta in ingresso il modello a cui stiamo parlando.
 *
 * Nasce da una decisione dell'owner sulle note vocali, il 28/08/2026: «se il
 * modello supporta audio lo mandiamo al modello direttamente, altrimenti
 * usiamo whisper.cpp». Il bivio e' giusto e ha una trappola sola — sapere *se*
 * lo supporta. Una lista di nomi scritta a mano sarebbe sbagliata il giorno
 * dopo averla scritta: su OpenRouter i modelli con audio in ingresso erano 41
 * su 387 il 28/08/2026, e quell'insieme cambia da solo.
 *
 * Quindi la domanda si fa al provider. `GET {baseUrl}/models` risponde, per
 * ogni modello, `architecture.input_modalities` — misurato quel giorno, e
 * senza chiave: il nostro `qwen/qwen3.8-27b` dice `["text","image","video"]`,
 * cioe' oggi la voce dell'owner va trascritta in casa, e il ramo diretto si
 * accende da solo il giorno in cui il modello cambia.
 *
 * La stessa risposta dice anche la vista: `image` in elenco vuol dire che il
 * modello vede le immagini. Con una differenza che conta: per l'audio
 * l'incertezza cade sul ramo locale (whisper c'è sempre), quindi il default è
 * "no"; per le immagini non esiste un trascrittore locale — descrivere vuole
 * un altro modello che ci vede — quindi l'incertezza NON chiude la strada di
 * sempre (l'immagine va al modello, come prima che questa domanda esistesse).
 * Solo un "non vede" misurato gira il bivio verso la descrizione o il rifiuto
 * dichiarato. Ollama con un modello vision continua a funzionare esattamente
 * come prima: il suo `/models` non ha `architecture`, e non sapere resta
 * "manda".
 *
 * **Il default dell'audio e' "no", e non e' pigrizia.** Rete giu', endpoint
 * che non risponde, JSON di un'altra forma, modello che non compare
 * nell'elenco: tutti finiscono su `false`, cioe' su "trascrivi in casa". E'
 * l'unico dei due rami che non puo' fare danni quando la risposta e' incerta
 * — non manda niente fuori, e non trasforma un'incertezza in un 400 che
 * perde la nota vocale. ADR-0008 (degradare dichiarando) vale per cio' che si
 * dice all'owner; qui la scelta di quale ramo prendere non ha bisogno di
 * aspettare nessuno. (Per le immagini la regola è diversa ed è scritta sopra:
 * `immagineAccettata` distingue il non-misurato dal misurato-no.)
 */

/** Cio' che ci serve leggere della risposta, non cio' che contiene. */
type ModelsPayload = {
  data?: { id?: unknown; architecture?: { input_modalities?: unknown } }[];
};

export type ModalitaDeps = {
  fetch?: typeof globalThis.fetch;
  /**
   * Mandata quando c'e'. L'elenco di OpenRouter e' pubblico — misurato: senza
   * chiave risponde uguale — ma un endpoint compatibile dietro autenticazione
   * potrebbe non esserlo, e una chiave che non serve non fa danno.
   */
  apiKey?: string | undefined;
};

/**
 * Le modalità dichiarate da un modello, una sola richiesta per
 * `(baseUrl, modello)`, per la vita del processo.
 *
 * Si memoizza la **promessa**, non il valore: due note vocali che arrivano
 * insieme — cosa normalissima su Telegram — devono fare una richiesta sola,
 * non due che si rincorrono. Vale per qualunque domanda si faccia
 * all'elenco: audio e vista leggono la stessa risposta memoizzata. Un gateway
 * vive a lungo e le modalita' di un modello non cambiano in un pomeriggio; un
 * riavvio ridomanda, che e' la scadenza piu' semplice che esista e non lascia
 * in giro un formato su disco da mantenere.
 */
const risposte = new Map<string, Promise<readonly string[] | null>>();

/** Solo per i test: nessun processo vero ha ragione di dimenticare. */
export function dimenticaModalita(): void {
  risposte.clear();
}

/**
 * Il modello accetta audio in ingresso?
 *
 * `baseUrl` assente vuol dire Anthropic (`core/config`), che audio in ingresso
 * non ne accetta in nessuna forma: si risponde senza chiamare nessuno.
 * Il resto è `false` quando non si sa: vedi il commento in testa sul perché
 * l'incertezza, per l'audio, cade sul ramo locale.
 */
export async function audioAccettato(
  baseUrl: string | undefined,
  model: string,
  deps: ModalitaDeps = {},
): Promise<boolean> {
  if (baseUrl === undefined || baseUrl === '') return false;
  return (await modalitaMisurate(baseUrl, model, deps))?.includes('audio') ?? false;
}

/**
 * Il modello vede le immagini? Tre esiti, non due: `true` misurato, `false`
 * misurato, `undefined` quando non si può misurare (baseUrl assente, endpoint
 * che non elenca `architecture`, modello assente dall'elenco, rete giù).
 * Chi chiama decide cosa fare dell'incertezza — per le immagini è "manda come
 * sempre", vedi il commento in testa.
 */
export async function immagineAccettata(
  baseUrl: string | undefined,
  model: string,
  deps: ModalitaDeps = {},
): Promise<boolean | undefined> {
  if (baseUrl === undefined || baseUrl === '') return undefined;
  const modalita = await modalitaMisurate(baseUrl, model, deps);
  if (modalita === null) return undefined;
  return modalita.includes('image');
}

async function modalitaMisurate(
  baseUrl: string,
  model: string,
  deps: ModalitaDeps,
): Promise<readonly string[] | null> {
  const chiave = `${baseUrl} ${model}`;
  const gia = risposte.get(chiave);
  if (gia !== undefined) return gia;
  const domanda = chiedi(baseUrl, model, deps);
  risposte.set(chiave, domanda);
  return domanda;
}

async function chiedi(baseUrl: string, model: string, deps: ModalitaDeps): Promise<readonly string[] | null> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  try {
    const res = await doFetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: deps.apiKey === undefined ? {} : { Authorization: `Bearer ${deps.apiKey}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as ModelsPayload;
    const voce = body.data?.find((m) => m.id === model);
    const modalita = voce?.architecture?.input_modalities;
    // Un endpoint compatibile che non e' OpenRouter — Ollama, vLLM — elenca i
    // modelli senza `architecture`. Non e' un errore da segnalare: e' un
    // provider che non sa rispondere a questa domanda. Per l'audio, non sapere
    // significa trascrivere in casa; per le immagini, chi chiama decide (una
    // risposta `null` non è un "no").
    return Array.isArray(modalita)
      ? modalita.filter((m): m is string => typeof m === 'string')
      : null;
  } catch {
    return null;
  }
}
