import type { ApprovalRequest, Approver } from '../../agent/loop.js';
import { escapeHtml, splitHtml } from './render.js';
import type { InlineButton, TelegramApi, TelegramApiLike } from './api.js';

/**
 * La domanda di approvazione su Telegram: un solo vocabolario per due strade.
 *
 * Prima di questo modulo la domanda viveva in un posto solo, `cli/surface.ts`,
 * e la sua unica forma era un **messaggio a parte** con la tastiera. Il
 * 2026-09-29 l'owner ha guardato un turno con quattro comandi e ha visto
 * quattro bolle residue sotto la risposta: la domanda è un passo del turno,
 * non un canale collaterale, e quando la trascrizione del turno è viva la
 * domanda vive **sul suo messaggio** (visibile mentre è in attesa, ripiegata
 * nel Processo quando è decisa).
 *
 * Questo file è il vocabolario condiviso fra le due strade:
 *
 * - `askHtml`/`askPlain`: cosa mostra la domanda (il testo del kernel riportato
 *   com'è, la frase del modello su cosa fa il comando, il comando intero, il
 *   taint). Le stesse parole sia sul messaggio del turno sia, in ripiego, sul
 *   messaggio autonomo.
 * - `askKeyboard`: i due pulsanti, con l'id già scritto nel registro.
 * - `approvatoreTelegram`: la strada di ripiego — un messaggio autonomo —
 *   usata quando nessuna trascrizione viva può ospitare la domanda (processo
 *   riavviato fra domanda e risposta, turno ripreso da un'altra lane, superficie
 *   senza segmento). Non è la strada normale: è quella che garantisce che la
 *   domanda esista sempre, anche dove il messaggio del turno non c'è.
 *
 * **Torna `asked`, non una promessa.** La funzione manda il messaggio e
 * finisce; la risposta arriverà come un `callback_query`, forse fra un'ora,
 * forse a un altro processo dopo un riavvio. È il turno a sospendersi su una
 * barriera persistita (`approval:<id>`), e questa è l'unica forma che
 * sopravvive a un riavvio: tenere aperta una promessa in memoria vorrebbe dire
 * che spegnere il gateway perde la domanda e il lavoro dietro.
 *
 * **Cosa mostra.** L'azione concreta e il taint del turno — i due fatti che
 * DAY-1 requirement D12 chiede per non fare teatro: «approvi sys.shell?» non è una
 * domanda a cui qualcuno possa rispondere. Il testo del kernel è riportato
 * com'è: parafrasarlo è l'occasione di far sembrare la richiesta più piccola di
 * quello che è. Dal 03/09 anche la frase del modello su *cosa fa* il comando
 * (`ApprovalRequest.description`), **sopra** il comando e mai al suo posto.
 *
 * **Intera, sempre.** L'owner ha ricevuto un comando lungo tagliato nel
 * messaggio stesso che gli chiedeva se eseguirlo (`summarizeCallArgs` tagliava
 * a 220; non più). Qui il testo si spezza con `splitHtml` come una risposta
 * qualunque: se non entra in un messaggio ne prende due, e i pulsanti stanno
 * sull'ultimo — la domanda è sempre l'ultima cosa che si legge.
 */

/** Le stesse quattro etichette di `cli/surface.ts` (e del messaggio autonomo). */
const ETICHETTA_TAINT = ['', 'contatto noto', 'gruppo/sconosciuto', 'contenuto esterno (web o tool)'];

/** La domanda in HTML, intera: prompt, descrizione, comando, taint. */
export function askHtml(request: ApprovalRequest): string {
  const righe = [`⚠ <b>${escapeHtml(request.prompt)}</b>`];
  if (request.description !== undefined && request.description !== '') {
    righe.push(`<i>${escapeHtml(request.description)}</i>`);
  }
  if (request.resource !== undefined && request.resource !== '') {
    righe.push(`<pre><code>${escapeHtml(request.resource)}</code></pre>`);
  }
  if (request.taint > 0) {
    const etichetta = ETICHETTA_TAINT[request.taint];
    righe.push(
      `contesto: turno a taint ${request.taint}${etichetta ? ` — ${etichetta}` : ''} ` +
        `(contenuto non tuo è già entrato in questo turno)`,
    );
  }
  return righe.join('\n\n');
}

/** La stessa domanda senza markup, per il rendering a blocchi del rich. */
export function askPlain(request: ApprovalRequest): string {
  const righe = [`⚠ ${request.prompt}`];
  if (request.description !== undefined && request.description !== '') righe.push(request.description);
  if (request.resource !== undefined && request.resource !== '') righe.push(request.resource);
  if (request.taint > 0) {
    const etichetta = ETICHETTA_TAINT[request.taint];
    righe.push(
      `contesto: turno a taint ${request.taint}${etichetta ? ` — ${etichetta}` : ''} ` +
        `(contenuto non tuo è già entrato in questo turno)`,
    );
  }
  return righe.join('\n\n');
}

/** I due pulsanti della domanda, con l'id già scritto nel registro. */
export function askKeyboard(capability: string, approvalId: string): InlineButton[][] {
  return [
    [
      { text: `Consenti "${capability}"`, callback_data: `ok:${approvalId}`, style: 'success' },
      { text: 'Rifiuta', callback_data: `no:${approvalId}`, style: 'danger' },
    ],
  ];
}

export function approvatoreTelegram(api: TelegramApi | TelegramApiLike): Approver {
  return async (request, where) => {
    const chatId = where.replyTo?.['chatId'];
    // Nessun indirizzo durevole vuol dire nessun posto dove far comparire la
    // domanda. Non si inventa la chat dell'owner: un turno il cui indirizzo non
    // sappiamo leggere è un turno di cui non sappiamo a chi stiamo parlando.
    if (typeof chatId !== 'number' || where.approvalId === undefined) return 'unavailable';

    const parti = splitHtml(askHtml(request));
    for (let i = 0; i < parti.length - 1; i++) await api.sendMessage(chatId, parti[i]!);
    await api.sendMessage(chatId, parti[parti.length - 1] ?? '', {
      keyboard: askKeyboard(request.capability, where.approvalId),
    });
    return 'asked';
  };
}
