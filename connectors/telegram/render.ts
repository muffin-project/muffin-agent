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

/** Escapes the three characters HTML mode cares about. Nothing else needs touching. */
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

  // A NUL the input itself carried is dropped rather than restored: it cannot
  // be a valid index, and passing it through would put a control character in
  // a message.
  return text
    .replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (m, i: string) => blocks[Number(i)] ?? m)
    .replace(new RegExp(MARK, 'g'), '');
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
  /** Reopened at the head of the next piece when a cut lands inside a code block. */
  let carry = '';

  while (carry.length + rest.length > max) {
    const budget = max - carry.length;
    // Once inside a block we stay inside until its closing tag goes out: after
    // the first cut the remaining text no longer contains `<pre>`, so asking the
    // text again would answer "not in a block" and emit an unterminated one.
    // The state lives in the loop.
    const openTag = carry !== '' ? carry : openPreAt(rest, budget);

    if (openTag !== null) {
      // A code block longer than one message. Splitting it is unavoidable, so
      // close the tags here and reopen them on the other side: the reader gets
      // several readable blocks instead of one broken one, and every message is
      // well-formed on its own.
      const cut = lastLineBefore(rest, budget - CLOSE_PRE.length) ?? budget - CLOSE_PRE.length;
      out.push(`${carry}${rest.slice(0, cut).trimEnd()}${CLOSE_PRE}`);
      carry = openTag;
      rest = rest.slice(cut).replace(/^\n/, '');
      continue;
    }

    const cut = safeCut(rest, budget);
    out.push(`${carry}${rest.slice(0, cut).trimEnd()}`);
    carry = '';
    rest = rest.slice(cut).trimStart();
  }

  const tail = `${carry}${rest}`.trim();
  if (tail !== '') out.push(tail);
  return out;
}

const CLOSE_PRE = '</code></pre>';

/**
 * The opening tags of a `<pre>` that is still open at `limit`, or null.
 *
 * Returns the tags rather than a boolean so the caller can reopen them verbatim,
 * language class included — a reopened block that lost its `class` renders as
 * plain text and the reader notices.
 */
function openPreAt(html: string, limit: number): string | null {
  const window = html.slice(0, limit);
  const open = window.lastIndexOf('<pre>');
  if (open === -1 || open < window.lastIndexOf('</pre>')) return null;
  const codeTag = /<pre><code[^>]*>/.exec(html.slice(open));
  return codeTag ? codeTag[0] : '<pre><code>';
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
