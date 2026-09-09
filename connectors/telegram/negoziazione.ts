import { MUTA, type Negotiation, type Place } from '../../core/surface/types.js';

/**
 * Cosa Telegram sa fare in ciascuna stanza — la tabella `(porta, stanza)`
 * della decisione dell'owner del 06/09/2026, scritta dove vive la conoscenza
 * di Telegram e in nessun altro posto.
 *
 * ## La DM: l'anteprima torna, col rinnovo
 *
 * `sendMessageDraft` è documentata come *«a temporary 30-second preview»* di
 * una chat **privata**. La PR #388 l'ha tolta il 04/09 perché scadeva: il
 * processo moriva a metà turno, l'anteprima spariva da sola pochi secondi
 * dopo, e la risposta vera arrivava minuti più tardi — «scritta, poi
 * cancellata, poi riscritta» (`docs/evidence/turno-sospendibile.md`). Ma
 * quello è il difetto di un'anteprima **non rinnovata**, non di un'anteprima:
 * il rimedio è `draftTtlMs` più un rinnovo dentro la finestra, e il fatto che
 * un processo morto smetta di rinnovare è esattamente ciò che si vuole — una
 * bozza morta scompare, mentre un messaggio vero abbandonato resta lì a
 * mentire. La risposta finale continua a essere un messaggio **vero**, come
 * dal 04/09: la bozza mostra il testo mentre si forma, non lo consegna.
 *
 * ## Il gruppo: nessuna anteprima, e due limiti invece di uno
 *
 * In un gruppo l'anteprima non esiste — non per prudenza ma per grammatica:
 * `assertNegotiable` rifiuta `'draft'` fuori da `'direct'`. Restano gli edit,
 * e i limiti pubblicati della Bot API sono due: circa un messaggio al secondo
 * verso una chat, circa venti al minuto verso un gruppo. Fino al 06/09 il
 * codice ne applicava uno solo (`MIN_EDIT_GROUP_MS = 3000`, cioè la media
 * spalmata sul picco), e il contatore di un passo lungo si muoveva un terzo
 * di quanto poteva.
 *
 * `'topic'` è il gruppo: un topic non ha limiti suoi, li eredita dalla chat.
 * Ciò che cambia in un topic è *dove* si scrive (`message_thread_id`), che è
 * già una `SendOptions`, non una capacità.
 *
 * ## I file
 *
 * `'native'` finché i byte stanno sotto `maxUploadBytes` (50 MB per
 * `sendDocument`), e poi `'say'`: dire dov'è il file è peggio che allegarlo,
 * ed è molto meglio del `{delivered:false}` che l'owner riceveva prima —
 * «non te lo do» senza dire dove sta.
 */

/** Pavimento fra due chiamate verso una chat: il limite per-chat della Bot API. */
const EDIT_EVERY_MS = 1_000;
/** Tetto documentato verso un gruppo, su una finestra di un minuto. */
const GROUP_EDITS_PER_MINUTE = 20;
/** In una DM il tetto è quello che il pavimento stesso lascia passare. */
const DIRECT_EDITS_PER_MINUTE = 40;
/** «a temporary 30-second preview». */
const DRAFT_TTL_MS = 30_000;

const DIRETTA: Negotiation = {
  stream: ['draft', 'edit', 'off'],
  editEveryMs: 1_500,
  maxEditsPerMinute: DIRECT_EDITS_PER_MINUTE,
  draftTtlMs: DRAFT_TTL_MS,
  files: ['native', 'say'],
};

const STANZA: Negotiation = {
  stream: ['edit', 'off'],
  editEveryMs: EDIT_EVERY_MS,
  maxEditsPerMinute: GROUP_EDITS_PER_MINUTE,
  draftTtlMs: 0,
  files: ['native', 'say'],
};

/** Le stanze che Telegram serve. Non `'terminal'`: quello è un'altra porta. */
export const TELEGRAM_PLACES: readonly Place[] = ['direct', 'group', 'topic'] as const;

export function negoziazioneTelegram(place: Place): Negotiation {
  switch (place) {
    case 'direct':
      return DIRETTA;
    case 'group':
    case 'topic':
      return STANZA;
    case 'terminal':
      return MUTA;
  }
}

/**
 * La stanza di un messaggio in arrivo, dalle due cose che l'ingresso già sa.
 *
 * Una funzione sola perché il calcolo è una decisione (un topic è una stanza,
 * non un inquilino — vedi `IncomingIdentity.threadId`) e due copie di una
 * decisione sono due decisioni.
 */
export function stanzaDi(incoming: { readonly isPrivate: boolean; readonly threadId?: number | undefined }): Place {
  if (incoming.isPrivate) return 'direct';
  return incoming.threadId === undefined ? 'group' : 'topic';
}
