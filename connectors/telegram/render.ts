/**
 * Turning what the model wrote into what Telegram will accept.
 *
 * Two decisions, both paid for by the previous system.
 *
 * **HTML, not MarkdownV2.** MarkdownV2 requires escaping eighteen characters,
 * among them `.` and `-` — characters in every ordinary sentence. A model
 * writing free prose breaks it on almost every output, not only when it means to
 * use markup. HTML requires three: `&`, `<`, `>`.
 *
 * **The length that matters is the rendered length.** The limit is 4096
 * characters of the *final* HTML, and `**grassetto**` becomes `<b>grassetto</b>`
 * — six characters longer. Splitting the raw markdown at 4000 and expanding
 * afterwards produced messages over the limit, Telegram answered 400, and the
 * whole reply was lost. That bug shipped, was rated high severity, and lost real
 * messages: it passes every manual test because manual tests are short.
 *
 * So: convert first, split second, and never split inside a tag, an entity or a
 * code fence.
 */

/** Telegram's limit for a text message. Captions are 1024, handled by the caller. */
export const TELEGRAM_MAX = 4096;

/**
 * Escapes the three characters HTML mode cares about. Nothing else needs touching.
 *
 * Exported for `progress.ts`: a status line is built from our own Italian prose
 * plus a tool/model name that ultimately comes from the model's own output
 * (`call.name` on a `tool_start`/`tool_end` event), so it goes through the same
 * escaping the answer's own text does rather than trusting it by construction.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Markdown as a model writes it, into Telegram's HTML subset.
 *
 * Code blocks are lifted out before anything else runs and put back at the end.
 * Without that, a model writing `**` inside a code sample gets it turned into a
 * bold tag in the middle of its own code — the transformation eating the thing
 * it was supposed to leave alone.
 */
export function toTelegramHtml(markdown: string): string {
  const blocks: string[] = [];
  // NUL as the delimiter, because it is the one byte a model cannot produce
  // and a human cannot type. Written as an escape rather than a literal, so
  // the source file stays text and `grep` keeps working on it.
  const MARK = '\u0000';
  const park = (html: string): string => `${MARK}${blocks.push(html) - 1}${MARK}`;

  let text = markdown;

  // Fenced code first, then inline: otherwise the inline rule eats the fences.
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang: string, body: string) =>
    park(`<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>${escapeHtml(body.replace(/\n$/, ''))}</code></pre>`),
  );
  text = text.replace(/`([^`\n]+)`/g, (_m, body: string) => park(`<code>${escapeHtml(body)}</code>`));

  text = escapeHtml(text);

  // Links before emphasis: the label can contain emphasis, the URL must not be
  // touched at all.
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, href: string) =>
    park(`<a href="${href}">${label}</a>`),
  );

  text = text
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<i>$2</i>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>');

  // Headings have no Telegram equivalent; bold is the closest honest rendering.
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // Le citazioni per ultime, e su `&gt;` invece che su `>`: a questo punto
  // `escapeHtml` è già passato, e cercare il carattere originale non
  // troverebbe niente. I blocchi di codice sono già parcheggiati, quindi una
  // freccia dentro un esempio di shell non diventa mai una citazione.
  text = quoteBlocks(text);

  // A NUL the input itself carried is dropped rather than restored: it cannot
  // be a valid index, and passing it through would put a control character in
  // a message.
  return text
    .replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (m, i: string) => blocks[Number(i)] ?? m)
    .replace(new RegExp(MARK, 'g'), '');
}

/**
 * Righe consecutive che cominciano con `>` in una citazione sola.
 *
 * Telegram ha `<blockquote>` da Bot API 6.4 e `<blockquote expandable>` da
 * 7.10 — prima di questa funzione una citazione arrivava come `&gt; testo`,
 * cioè il carattere grezzo, che è il modo in cui una risposta ben scritta
 * arriva brutta.
 *
 * **Lunga vuol dire richiudibile.** Una citazione di quaranta righe in cima
 * seppellisce la risposta sotto ciò che si stava citando: `expandable` la
 * mostra chiusa, e chi vuole leggerla la apre. La soglia è sulle righe *e*
 * sui caratteri perché entrambe le forme sono capaci di riempire lo schermo,
 * una riga lunghissima e quaranta righe corte.
 *
 * Righe consecutive diventano **un** blocco: Telegram non annida le
 * citazioni, e una sequenza di blocchi da una riga l'una si legge come una
 * cosa rotta invece che come una citazione.
 */
function quoteBlocks(text: string): string {
  const righe = text.split('\n');
  const out: string[] = [];
  let citate: string[] | null = null;

  const chiudi = (): void => {
    if (citate === null) return;
    const corpo = citate.join('\n');
    const lungo = citate.length > 10 || corpo.length > 500;
    out.push(`<blockquote${lungo ? ' expandable' : ''}>${corpo}</blockquote>`);
    citate = null;
  };

  for (const riga of righe) {
    const m = /^&gt;\s?(.*)$/.exec(riga);
    if (m) {
      citate ??= [];
      citate.push(m[1] ?? '');
      continue;
    }
    chiudi();
    out.push(riga);
  }
  chiudi();
  return out.join('\n');
}

/**
 * Splits rendered HTML into pieces Telegram will accept.
 *
 * Never inside a tag, and never inside a `<pre>`: a fence split across two
 * messages leaves both malformed, and Telegram rejects each of them separately.
 * Preference order for the cut is paragraph, then line, then sentence, then a
 * hard break — the same descent the chunker uses, for the same reason.
 */
export function splitHtml(html: string, max = TELEGRAM_MAX): string[] {
  if (html.length <= max) return [html];

  const out: string[] = [];
  let rest = html;
  /** Reopened at the head of the next piece when a cut lands inside a block. */
  let carry: Blocco | null = null;

  while ((carry?.open.length ?? 0) + rest.length > max) {
    const budget: number = max - (carry?.open.length ?? 0);
    // Once inside a block we stay inside until its closing tag goes out: after
    // the first cut the remaining text no longer contains `<pre>`, so asking the
    // text again would answer "not in a block" and emit an unterminated one.
    // The state lives in the loop.
    const aperto: Blocco | null = carry ?? openBlockAt(rest, budget);

    if (aperto !== null) {
      // A code block longer than one message. Splitting it is unavoidable, so
      // close the tags here and reopen them on the other side: the reader gets
      // several readable blocks instead of one broken one, and every message is
      // well-formed on its own.
      const cut = lastLineBefore(rest, budget - aperto.close.length) ?? budget - aperto.close.length;
      out.push(`${carry?.open ?? ''}${rest.slice(0, cut).trimEnd()}${aperto.close}`);
      carry = aperto;
      rest = rest.slice(cut).replace(/^\n/, '');
      continue;
    }

    const cut = safeCut(rest, budget);
    out.push(`${carry?.open ?? ''}${rest.slice(0, cut).trimEnd()}`);
    carry = null;
    rest = rest.slice(cut).trimStart();
  }

  const tail = `${carry?.open ?? ''}${rest}`.trim();
  if (tail !== '') out.push(tail);
  return out;
}

/** Un blocco che va richiuso di qua e riaperto di là, tag verbatim. */
type Blocco = { open: string; close: string };

const CLOSE_PRE = '</code></pre>';

/**
 * Il blocco ancora aperto a `limit`, o `null`.
 *
 * Restituisce i tag e non un booleano perché il chiamante li riapre
 * **verbatim**: un blocco riaperto che ha perso la sua `class` viene reso come
 * testo semplice, e un `<blockquote expandable>` riaperto senza `expandable`
 * si apre da solo a metà citazione — differenze che si vedono.
 *
 * Due famiglie, e vince quella aperta più tardi: è quella dentro cui il
 * taglio sta davvero cadendo.
 */
function openBlockAt(html: string, limit: number): Blocco | null {
  const window = html.slice(0, limit);

  const pre = window.lastIndexOf('<pre>');
  const preAperto = pre !== -1 && pre > window.lastIndexOf('</pre>') ? pre : -1;

  const bq = window.lastIndexOf('<blockquote');
  const bqAperto = bq !== -1 && bq > window.lastIndexOf('</blockquote>') ? bq : -1;

  if (preAperto === -1 && bqAperto === -1) return null;
  if (preAperto > bqAperto) {
    const codeTag = /<pre><code[^>]*>/.exec(html.slice(preAperto));
    return { open: codeTag ? codeTag[0] : '<pre><code>', close: CLOSE_PRE };
  }
  const bqTag = /<blockquote[^>]*>/.exec(html.slice(bqAperto));
  return { open: bqTag ? bqTag[0] : '<blockquote>', close: '</blockquote>' };
}

function lastLineBefore(html: string, limit: number): number | null {
  const at = html.lastIndexOf('\n', limit);
  return at > limit / 2 ? at : null;
}

function safeCut(html: string, max: number): number {
  const window = html.slice(0, max);

  for (const marker of ['\n\n', '\n', '. ', ' ']) {
    const at = window.lastIndexOf(marker);
    // Not too close to the start, or a long unbreakable run produces a stream of
    // tiny messages.
    if (at > max / 2) return at + marker.length;
  }

  // Nothing to break on. Do not cut inside a tag.
  const openTag = window.lastIndexOf('<');
  const closeTag = window.lastIndexOf('>');
  return openTag > closeTag ? openTag : max;
}

/** Convert and split in one step: the two are never useful apart. */
export function renderForTelegram(markdown: string, max = TELEGRAM_MAX): string[] {
  return splitHtml(toTelegramHtml(markdown), max);
}
