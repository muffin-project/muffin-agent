import type { ApprovalRequest, Approver } from '../../agent/loop.js';
import {
  allowLabelFor,
  formatApprovalCard,
  renderApprovalCardPlain,
} from '../../core/approvals/card.js';
import { type InlineButton, type TelegramApi, type TelegramApiLike, TelegramError } from './api.js';
import { present, presentationOfHtml } from './present.js';
import { escapeHtml } from './render.js';

/**
 * La domanda di approvazione su Telegram: un solo vocabolario per due strade.
 *
 * Prima di questo modulo la domanda viveva in un posto solo, `cli/surface.ts`,
 * e la sua unica forma era un **messaggio a parte** con la tastiera. Il
 * 2026-09-29 l'owner ha guardato un turno con quattro comandi e ha visto
 * quattro bolle residue sotto la risposta: la domanda è un passo del turno,
 * non un canale collaterale, e quando la trascrizione del turno è viva la
 * domanda vive **sul suo messaggio** (visibile mentre è in attesa, ricevuta
 * sotto la risposta quando è decisa).
 *
 * Questo file è il vocabolario condiviso fra le due strade:
 *
 * - `askHtml`/`askPlain`: cosa mostra la domanda, in italiano chiaro, dal
 *   formatore condiviso in `core/approvals/card.ts`. Le stesse parole sia sul
 *   messaggio del turno sia, in ripiego, sul messaggio autonomo.
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
 * **Cosa mostra.** Cosa vuole fare, perché lo chiede quando c'è una ragione
 * vera, e l'oggetto intero dell'azione (URL o comando, mai tagliato). D12
 * resta: «approvi sys.shell?» non è una domanda a cui qualcuno possa
 * rispondere. Il gergo del kernel (`taint`, `sys.http`, «parametri scelti dal
 * contenuto») resta nei log e nel registro, non sulla card. Dal 03/09 anche
 * la frase del modello su *cosa fa* il comando (`ApprovalRequest.description`),
 * **sopra** il comando e mai al suo posto.
 *
 * **Intera, sempre.** L'owner ha ricevuto un comando lungo tagliato nel
 * messaggio stesso che gli chiedeva se eseguirlo (`summarizeCallArgs` tagliava
 * a 220; non più). Qui il testo si spezza con `splitHtml` come una risposta
 * qualunque: se non entra in un messaggio ne prende due, e i pulsanti stanno
 * sull'ultimo — la domanda è sempre l'ultima cosa che si legge.
 */

/**
 * Owner-facing wording comes from `core/approvals/card.ts`, shared with the
 * CLI. The kernel prompt and the taint number stay in the request (and in
 * the registry); they are not rendered here.
 */
export function askHtml(request: ApprovalRequest): string {
  const card = formatApprovalCard(request);
  const righe = [`⚠ <b>${escapeHtml(card.what)}</b>`];
  if (card.why !== null) righe.push(escapeHtml(card.why));
  if (card.description !== null) righe.push(`<i>${escapeHtml(card.description)}</i>`);
  if (card.object !== null) righe.push(`<pre><code>${escapeHtml(card.object)}</code></pre>`);
  return righe.join('\n\n');
}

/** La stessa domanda senza markup, per il rendering a blocchi del rich. */
export function askPlain(request: ApprovalRequest): string {
  return renderApprovalCardPlain(request);
}

/** I due pulsanti della domanda, con l'id già scritto nel registro. */
export function askKeyboard(capability: string, approvalId: string): InlineButton[][] {
  return [
    [
      { text: allowLabelFor(capability), callback_data: `ok:${approvalId}`, style: 'success' },
      { text: 'Rifiuta', callback_data: `no:${approvalId}`, style: 'danger' },
    ],
  ];
}

/**
 * La domanda registrata dove si è mostrata (#784): chi manda la domanda la
 * scrive nel registro con l'id che il filo ha restituito, così la chiusura
 * terminale del turno può toglierle la tastiera anche dopo un riavvio.
 */
export type DomandaMostrata = (mostrata: { approvalId: string; messageId: number }) => void;

export function approvatoreTelegram(
  api: TelegramApi | TelegramApiLike,
  onAsked?: DomandaMostrata,
  attempt?: { begin: () => boolean; reject: () => void },
  canAttempt?: () => boolean,
): Approver {
  return async (request, where) => {
    const chatId = where.replyTo?.['chatId'];
    // Nessun indirizzo durevole vuol dire nessun posto dove far comparire la
    // domanda. Non si inventa la chat dell'owner: un turno il cui indirizzo non
    // sappiamo leggere è un turno di cui non sappiamo a chi stiamo parlando.
    const { approvalId } = where;
    if (typeof chatId !== 'number' || approvalId === undefined) return 'unavailable';

    // Il topic del forum, quando la domanda nasce dentro uno: la bolla di
    // ripiego è un pezzo del turno come gli altri, e senza il thread finirebbe
    // in *General* mentre l'owner guarda il suo topic — un turno che degrada
    // in silenzio nel gruppo padre. Su ogni pezzo, non solo sull'ultimo: una
    // domanda lunga si spezza, e ogni metà deve restare nel topic.
    const threadId = where.replyTo?.['threadId'];
    const topic = typeof threadId === 'number' ? { threadId } : {};

    // La politica è la stessa delle altre uscite fuori-turno (`present`):
    // ricca se entra, legacy a pezzi sotto il limite, con la tastiera
    // sull'ultimo pezzo — la domanda è l'ultima cosa che si legge.
    let mayHaveKeyboard = false;
    try {
      const outcome = await present(
        api,
        {
          chatId,
          ...topic,
          keyboard: askKeyboard(request.capability, approvalId),
          ...(canAttempt === undefined ? {} : { canAttempt }),
          sendWithKeyboard: async (send) => {
            if (attempt?.begin() === false) {
              mayHaveKeyboard = true;
              throw new Error('Telegram approval keyboard write already pending');
            }
            let receipt: { message_id: number };
            try {
              receipt = await send();
            } catch (error) {
              if (error instanceof TelegramError && error.status > 0) attempt?.reject();
              else mayHaveKeyboard = true;
              throw error;
            }
            try {
              onAsked?.({ approvalId, messageId: receipt.message_id });
            } catch {
              // The keyboard already landed; do not turn bookkeeping into failure.
            }
            return receipt;
          },
        },
        presentationOfHtml(askHtml(request)),
      );
      if (outcome === 'deferred') return 'unavailable';
    } catch (error) {
      // A lost prefix has no buttons. A lost keyboard receipt may still be
      // followed by a callback, so the existing approval must stay actionable.
      if (!mayHaveKeyboard) throw error;
    }
    return 'asked';
  };
}
