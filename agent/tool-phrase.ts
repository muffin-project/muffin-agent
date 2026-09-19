/**
 * Come si dice, a una persona, quello che l'agente sta facendo.
 *
 * Sta qui e non in `cli/` per la direzione della dipendenza: un connettore che
 * importa dalla CLI è un connettore che ha bisogno del terminale per parlare.
 * Le due superfici che descrivono un turno in corso — il terminale e Telegram
 * — leggono da questo file, così una frase nuova arriva a entrambe o a
 * nessuna.
 */

/**
 * Il nome del tool → cosa sta facendo, in italiano, in prima persona.
 *
 * `memory_search` è il nome di una funzione; «cerco in memoria» è quello che
 * sta succedendo. La distinzione è la stessa che `formatProgressLine` faceva
 * già per il resto (B13: «l'owner's own wording, not the trace's `muffin.*`
 * vocabulary») e che si fermava al confine dei tool.
 *
 * Una mappa e non un campo su `ToolSpec`: la frase è come si parla a una
 * persona, non una proprietà del tool, e un campo obbligatorio su ogni tool è
 * il tipo di peso che poi nessuno toglie. Il prezzo — che una mappa a mano
 * invecchia quando arriva un tool nuovo — lo paga il test di drift accanto a
 * questa riga, non un lettore che se ne accorge in produzione leggendo
 * `send_file…`.
 *
 * **La premessa che c'era qui è caduta il 28/08/2026.** Diceva «la frase è di
 * *questa* superficie: Telegram non stampa passi», ed era vero finché Telegram
 * era spenta. Accesa, stampava `passaggio 3 · sto usando fs_list · 47s` mentre
 * il terminale diceva `guardo una cartella: core/memory` — due vocabolari per
 * la stessa cosa, letti dalla stessa persona, che è esattamente ciò che il
 * commento in `connectors/telegram/progress.ts` prometteva di non fare.
 */
const TOOL_PHRASE: Readonly<Record<string, string>> = {
  memory_search: 'cerco in memoria',
  memory_why: 'guardo da dove viene',
  memory_forget: 'dimentico',
  fs_read: 'leggo un file',
  fs_list: 'guardo una cartella',
  fs_search: 'cerco nei file',
  fs_write: 'scrivo un file',
  fs_edit: 'modifico un pezzo di file',
  vault_save: 'salvo nel vault della stanza',
  document_read: 'leggo un documento',
  http_get: 'apro una pagina',
  web_search: 'cerco sul web',
  shell_run: 'guardo con un comando',
  shell_run_write: 'eseguo un comando',
  process_list: 'guardo i processi',
  process_kill: 'chiudo un processo',
  send_file: 'ti mando un file',
  skill_read: 'leggo una skill',
  sys_inspect: 'mi guardo dentro',
  sys_effects: 'rileggo cosa ho fatto',
  todo: 'aggiorno il piano',
  wait: 'mi metto in attesa',
  schedule_recurring: 'programmo un promemoria ricorrente',
};

/**
 * Quale argomento vale la pena vedere, per ogni tool.
 *
 * Il difetto che chiude, misurato sul WAL il 28/08/2026: un turno ha fatto
 * **sette** `memory_search` con sette `args_digest` **diversi**, e a schermo
 * erano sette righe identiche — `✓ cerco in memoria`, sette volte. Si legge
 * come un giro a vuoto e non lo era: nell'intero store non esiste una sola
 * coppia (tool, args) ripetuta. Il difetto era la riga, non il loop, ed è il
 * tipo di difetto che fa diagnosticare la cosa sbagliata — l'ho fatto io.
 *
 * Un campo solo per tool, quello che risponde a «su cosa?». Non un dump degli
 * argomenti: `fs_write` porta anche `content`, e stampare quello vuol dire
 * rovesciare un file intero nello scrollback a ogni scrittura.
 *
 * I nomi vengono dagli schemi veri (`agent/tools/*.ts`), letti, non ricordati.
 */
const TOOL_SUBJECT: Readonly<Record<string, string | readonly string[]>> = {
  memory_search: 'query',
  memory_why: 'query',
  web_search: 'query',
  fs_read: 'path',
  fs_list: 'path',
  // Due campi, provati in quest'ordine: `fs_search` cerca dentro i file con
  // `query`, oppure — quando non sai dove sta una cosa — i file stessi con
  // `name`. Un solo campo lascerebbe muta metà delle chiamate.
  fs_search: ['query', 'name'],
  fs_write: 'path',
  // `path` e non `oldText`: la stessa ragione di `fs_write` qui sopra — gli
  // argomenti li scrive il modello e rovesciare il blocco modificato nello
  // scrollback a ogni edit è il difetto che questa mappa esiste per evitare.
  fs_edit: 'path',
  vault_save: 'titolo',
  document_read: 'path',
  http_get: 'url',
  shell_run: 'command',
  shell_run_write: 'command',
  skill_read: 'name',
  send_file: 'path',
  schedule_recurring: 'goal',
};

/** Quanto sta su una riga accanto alla frase, senza mandarla a capo. */
const SOGGETTO_MASSIMO = 48;

/**
 * Il soggetto da mostrare accanto alla frase, o `''` se non c'è.
 *
 * Gli argomenti li ha scritti il **modello**: possono contenere a capo, escape
 * e qualunque cosa. Si appiattiscono e si accorciano prima di toccare un
 * terminale — una sequenza di escape dentro un percorso, stampata cruda, muove
 * il cursore del riquadro che sta appena sotto.
 */
export function toolSubject(name: string, args: unknown): string {
  const campo = TOOL_SUBJECT[name];
  if (campo === undefined || args === null || typeof args !== 'object') return '';
  const campi = typeof campo === 'string' ? [campo] : campo;
  const grezzo = campi.map((c) => (args as Record<string, unknown>)[c]).find((v) => typeof v === 'string' && v !== '');
  if (typeof grezzo !== 'string' || grezzo === '') return '';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: il modello ha scritto grezzo, i caratteri di controllo vanno tolti prima del terminale
  const piatto = grezzo.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (piatto === '') return '';
  return piatto.length > SOGGETTO_MASSIMO ? `${piatto.slice(0, SOGGETTO_MASSIMO - 1)}…` : piatto;
}

/** La frase, col suo soggetto quando ce n'è uno. */
export function toolLine(name: string, args: unknown): string {
  const soggetto = toolSubject(name, args);
  return soggetto === '' ? toolPhrase(name) : `${toolPhrase(name)}: ${soggetto}`;
}

/** Il nome grezzo è il fallback, mai un errore: un tool MCP non è in questa mappa e non può esserlo. */
export function toolPhrase(name: string): string {
  return TOOL_PHRASE[name] ?? name;
}

/** Ogni tool che questa build registra ha una frase — letto dal test di drift. */
export const TOOL_PHRASES: Readonly<Record<string, string>> = TOOL_PHRASE;
