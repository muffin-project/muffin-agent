import { TelegramError, type InlineButton, type TelegramApiLike } from './api.js';
import { splitHtml, toTelegramHtml } from './render.js';
import { richFitsHard, richFromHtml, countRich, RICH_COMPAT_CHARS, type OutboundRich } from './rich.js';

/**
 * La presentazione di un messaggio owner-visible **fuori dal turno**.
 *
 * ## Il problema che chiude
 *
 * Rich-first esisteva solo nella macchina del turno (`delivery.deliverTelegram`
 * per il finale, `transcript.sendHtml` per la trascrizione): saluto, avvisi,
 * pairing, risposte ai comandi e la consegna fuori banda chiamavano le
 * primitive legacy direttamente, ognuno per conto suo. Non era una scelta —
 * era inerzia: nessuno di quei producer aveva una politica di presentazione da
 * seguire, quindi ognuno mandava il proprio `sendMessage`.
 *
 * Questo modulo è la **waist minima** condivisa: un producer semantico
 * costruisce una `Presentation` (la rappresentazione ricca + i pezzi legacy
 * congelati) e `present()` la consegna — rich-first, con un fallback legacy
 * **deterministico** quando il server rifiuta il ricco.
 *
 * ## Cosa non fa, e perché
 *
 * - **Non trasforma un avviso in un Turn.** Niente store, niente lease, niente
 *   trascrizione: `present` è trasporto più la scelta della famiglia.
 * - **Non toglie le primitive legacy.** `sendMessage`/`editMessageText`
 *   restano il trasporto e il fallback; è la *policy* che smette di essere
 *   ad hoc, non l'API che si restringe.
 * - **Non perde il chunking.** Il fallback sono i pezzi di `splitHtml`, gli
 *   stessi che `renderForTelegram` produceva prima.
 * - **Non cambia la semantica di consegna.** `effect()` (un tentativo, nessun
 *   retry) e il confine fra rifiuto deterministico (`status > 0` → si scende
 *   al legacy) e fallimento ambiguo (`status 0` → risale al chiamante) sono
 *   quelli di `delivery.ts`/`transcript.ts`, letti dalla stessa tassonomia.
 *
 * ## La scelta della famiglia
 *
 * Due tetti, due proprietari (`rich.ts`): `richFitsHard` è il massimo di
 * **protocollo** (32768 caratteri, 500 blocchi) — oltre, il payload ricco non
 * parte nemmeno; il tetto di **compatibilità** (8192) è la policy verso i
 * client, e sopra si va ai pezzi legacy, che ogni client rende (la banda
 * 10k–15k osservata parzialmente da Hermes). L'unica eccezione dichiarata è il
 * messaggio del turno in DM (`turnRichMessage`), che non passa da qui.
 */

export type Presentation = {
  /** Il payload ricco, quando entra nei tetti; `null` quando non entra. */
  rich: OutboundRich | null;
  /** I pezzi legacy, congelati: il fallback deterministico. */
  fallback: string[];
};

/** HTML già reso (un producer che fa escape o render da sé). */
export function presentationOfHtml(html: string): Presentation {
  if (html.trim() === '') return { rich: null, fallback: [] };
  const rich = richFromHtml(html);
  const dentro = richFitsHard(rich) === null && countRich(rich).chars <= RICH_COMPAT_CHARS;
  return { rich: dentro ? rich : null, fallback: splitHtml(html) };
}

/** Testo/markdown: la conversione è quella di sempre (`renderForTelegram`). */
export function presentationOf(markdown: string): Presentation {
  return presentationOfHtml(toTelegramHtml(markdown));
}

export type PresentTarget = {
  chatId: number;
  /** Il topic del forum, quando il messaggio nasce dentro uno. */
  threadId?: number;
  /** Il messaggio a cui rispondere, quando è una send. */
  replyTo?: number;
  /** Quando c'è, è un edit di quel messaggio invece di una send. */
  editMessageId?: number;
  /** Tastiera inline: sul messaggio ricco, o sull'ultimo pezzo legacy. */
  keyboard?: InlineButton[][];
};

/**
 * `message is not modified`: l'edit identico non è un fallimento — il
 * messaggio è già come lo volevamo (stessa lettura di `transcript.ts`).
 */
function nonModificato(error: unknown): boolean {
  return /message is not modified/i.test(error instanceof Error ? error.message : String(error));
}

/**
 * Consegna la presentazione: ricca se possibile, legacy se il ricco viene
 * rifiutato **deterministicamente**, o se non entra nei limiti di protocollo.
 *
 * Ritorna la famiglia che è partita davvero. Un fallimento ambiguo (status 0)
 * risale: il messaggio potrebbe essere già arrivato, e ritentarlo qui sarebbe
 * il doppione che `effect()` esiste per evitare.
 *
 * `onSent` riceve l'id di ogni messaggio **nuovo** che parte davvero (mai gli
 * edit, che riusano un messaggio esistente): la domanda di approvazione di
 * ripiego lo usa per registrare dove si è mostrata (#784). Opzionale e fuori
 * dal tipo di ritorno — che resta la famiglia — così i producer che non hanno
 * niente da registrare non cambiano.
 */
export async function present(
  api: TelegramApiLike,
  target: PresentTarget,
  p: Presentation,
  onSent?: (messageId: number) => void,
): Promise<'rich' | 'legacy'> {
  if (p.fallback.length === 0) return 'legacy';
  const topic = target.threadId === undefined ? {} : { threadId: target.threadId };
  if (p.rich !== null) {
    try {
      if (target.editMessageId !== undefined) {
        await api.editMessageRichText(target.chatId, target.editMessageId, p.rich, target.keyboard === undefined ? {} : { keyboard: target.keyboard });
      } else {
        const mandato = await api.sendRichMessage(target.chatId, p.rich, {
          ...topic,
          ...(target.replyTo === undefined ? {} : { replyTo: target.replyTo }),
          ...(target.keyboard === undefined ? {} : { keyboard: target.keyboard }),
        });
        onSent?.(mandato.message_id);
      }
      return 'rich';
    } catch (error) {
      if (nonModificato(error)) return 'rich';
      // Solo un rifiuto deterministico fa scendere al legacy; uno status 0 è
      // ambiguo e risale al chiamante, che lo registra senza ritentare.
      if (!(error instanceof TelegramError && error.status > 0)) throw error;
    }
  }

  const pezzi = p.fallback;
  for (const [i, html] of pezzi.entries()) {
    const primo = i === 0;
    const ultimo = i === pezzi.length - 1;
    // La tastiera sta sul messaggio che la porta: quello editato, o l'ultimo
    // pezzo di una send. `keyboard: []` è la rimozione esplicita.
    const keyboard = target.editMessageId !== undefined ? (primo ? target.keyboard : undefined) : ultimo ? target.keyboard : undefined;
    const options = {
      ...(primo && target.editMessageId === undefined && target.replyTo !== undefined ? { replyTo: target.replyTo } : {}),
      ...(keyboard === undefined ? {} : { keyboard }),
    };
    try {
      if (primo && target.editMessageId !== undefined) {
        await api.editMessageText(target.chatId, target.editMessageId, html, options);
      } else {
        const mandato = await api.sendMessage(target.chatId, html, { ...topic, ...options });
        onSent?.(mandato.message_id);
      }
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      if (pezzi.length > 1) {
        throw new Error(
          `parte ${i + 1} di ${pezzi.length}${i > 0 ? ' (le precedenti sono arrivate)' : ''}: ${why}`,
        );
      }
      throw error;
    }
  }
  return 'legacy';
}
