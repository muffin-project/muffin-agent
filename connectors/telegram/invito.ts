/**
 * Muffin è stato aggiunto da qualche parte: ci resta o se ne va?
 *
 * Direzione owner, 04/09/2026: *«se qualcuno aggiunge muffin in un gruppo
 * dove non c'è l'owner deve uscire subito»*, dicendo qualcosa nel gruppo e
 * scrivendo in privato al suo umano chi l'ha aggiunto e dove.
 *
 * Perché è una difesa e non una regola di galateo: un gruppo è un **tenant**
 * (`group:telegram:<chatId>`), e un tenant nuovo è memoria nuova, budget
 * nuovo e una superficie da cui si può parlare a Muffin. Chiunque conosca lo
 * username del bot può crearne uno — su Telegram aggiungere un bot a un
 * gruppo non richiede il permesso di nessuno. Senza questo, l'unico limite a
 * quanti inquilini esistono è quante persone hanno voglia di aggiungerlo.
 *
 * La decisione sta qui, pura, e l'I/O resta nel connettore: la domanda «c'è
 * il mio umano in questa stanza?» è una chiamata di rete, e una funzione che
 * la fa non si può provare senza una rete finta.
 */

/** Quello che l'update `my_chat_member` dice, ridotto a ciò che decide. */
export type Invito = {
  readonly chatId: number;
  readonly titolo: string;
  readonly tipo: string;
  /** Chi ha aggiunto. `0` quando Telegram non l'ha detto (admin anonimo, canale). */
  readonly daId: number;
  readonly daNome: string;
  readonly daUsername?: string | undefined;
  /** `new_chat_member.status` — `member`, `administrator`, `left`, `kicked`, … */
  readonly statoNuovo: string;
};

export type EsitoInvito =
  | { readonly azione: 'resta'; readonly perche: string }
  | { readonly azione: 'esci'; readonly perche: string };

/** Gli stati in cui il bot **è dentro** la stanza. Tutto il resto è un'uscita. */
const DENTRO = new Set(['member', 'administrator', 'creator', 'restricted']);

/**
 * `ownerPresente` è una risposta a tre valori, non due.
 *
 * `undefined` vuol dire «non sono riuscito a chiederlo» — rete caduta, o
 * Telegram che risponde con un errore. Vale **esci**, ed è la scelta
 * scomoda: restare in una stanza dove non ho potuto verificare che ci sia il
 * mio umano è il rischio che questa funzione esiste per togliere, mentre
 * uscire per sbaglio da un gruppo legittimo costa all'owner un re-invito.
 * Un errore recuperabile contro uno che non si recupera.
 */
export function decidiInvito(invito: Invito, ownerPresente: boolean | undefined): EsitoInvito {
  // Una chat privata non è una stanza: `my_chat_member` arriva anche quando
  // qualcuno apre una conversazione col bot, e uscire da lì vorrebbe dire
  // rifiutare di parlare con chiunque.
  if (invito.tipo === 'private') {
    return { azione: 'resta', perche: 'una chat privata non è un gruppo' };
  }

  // Un `my_chat_member` che dice `left`/`kicked` è l'uscita stessa, spesso
  // proprio la nostra: senza questo ramo, uscire genererebbe l'update che ci
  // farebbe uscire di nuovo.
  if (!DENTRO.has(invito.statoNuovo)) {
    return { azione: 'resta', perche: `stato "${invito.statoNuovo}": non è un ingresso` };
  }

  if (ownerPresente === true) {
    return { azione: 'resta', perche: 'il mio umano è in questa stanza' };
  }

  return {
    azione: 'esci',
    perche:
      ownerPresente === false
        ? 'il mio umano non è in questa stanza'
        : 'non ho potuto verificare se il mio umano è qui',
  };
}

/** Come si chiama chi ha aggiunto, per un umano che legge. Mai un id nudo. */
export function chiHaAggiunto(invito: Invito): string {
  const nome = invito.daNome.trim();
  const at = invito.daUsername === undefined || invito.daUsername === '' ? '' : ` (@${invito.daUsername})`;
  if (nome === '' && at === '') return 'qualcuno che Telegram non ha nominato';
  return `${nome === '' ? 'senza nome' : nome}${at}`;
}

/**
 * Quello che Muffin dice nel gruppo prima di uscire.
 *
 * Corto e senza rimprovero: chi l'ha aggiunto quasi sempre non sta attaccando
 * niente, ha solo pensato che fosse un bot pubblico. E niente di specifico
 * sull'owner — nome, username, id: la stanza da cui sto uscendo è l'ultimo
 * posto a cui raccontare chi è il mio umano.
 */
export const SALUTO_NEL_GRUPPO = 'Dove è il mio umano? Qui non lo vedo, quindi vado. 👋';

/**
 * Il messaggio in privato all'owner.
 *
 * È l'unico posto dove finiscono i dettagli, ed è **l'unica ragione** per cui
 * questa funzione esiste separata dall'uscita: uscire in silenzio
 * lascerebbe l'owner senza sapere che qualcuno ci ha provato, che è
 * esattamente l'informazione che serve quando succede due volte.
 */
export function avvisoAllOwner(invito: Invito, esito: EsitoInvito): string {
  const dove = invito.titolo.trim() === '' ? `chat ${invito.chatId}` : invito.titolo.trim();
  return [
    `Mi hanno aggiunto a «${dove}» (${invito.tipo}, id ${invito.chatId}).`,
    `Chi: ${chiHaAggiunto(invito)}${invito.daId === 0 ? '' : `, id ${invito.daId}`}.`,
    esito.azione === 'esci'
      ? `Sono uscito subito: ${esito.perche}.`
      : `Sono rimasto: ${esito.perche}.`,
  ].join('\n');
}
