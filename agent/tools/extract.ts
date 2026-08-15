import { parseHTML } from 'linkedom';
import { Defuddle } from 'defuddle/node';

/**
 * Local article extraction, in front of `clipBody` (agent/tools/http.ts).
 *
 * `clipBody` alone ships whatever bytes came back — script, style, nav,
 * cookie banners, the article, all treated the same until a 50,000-character
 * cut lands wherever it lands. Measured on four real pages
 * (docs/blueprint/research/recupero-dal-web.md): 9,700-17,000 tokens per
 * page reaching the model, most of it markup, and pages under the clip
 * threshold ship their *entire* raw HTML. This module runs Defuddle (over a
 * linkedom document, imported as a library — never a subprocess, never a
 * third-party service; see ADR-0041) to reduce that to the page's main
 * content before `clipBody` ever sees it.
 *
 * Cleaning is not trusting. Nothing here changes the tier the caller
 * attaches to the result and nothing here changes `sys.http`'s capability
 * declaration — only how much text ends up inside the same fence.
 */

/**
 * Below this, a small extraction is unremarkable — there is nothing
 * substantial to have lost. Above it, `clipBody` would otherwise have had
 * to truncate, which is exactly the situation this module exists for.
 */
const PLAUSIBILITY_CHECK_FLOOR_RAW_CHARS = 2_000;

/**
 * The measured failure mode this guards against: on a 1,325,730-character
 * page, an extractor picked the cookie-consent banner instead of the
 * article — 217 characters, not the ~13,000 the article actually was
 * (docs/blueprint/research/recupero-dal-web.md §"Extraction, measured on
 * four real pages", note on the Anthropic docs page — that run used
 * Readability, not Defuddle, but the failure shape is the one this floor
 * exists to catch regardless of which extractor produces it). 300 sits
 * comfortably above that failure and comfortably below every real
 * extraction measured for this change (the smallest was 364 characters, a
 * two-paragraph article behind sixty navigation links).
 */
const MIN_PLAUSIBLE_EXTRACTED_CHARS = 300;

/**
 * True for `text/html` and `application/xhtml+xml`, ignoring any `charset`
 * suffix and casing. Everything else — JSON, plain text, CSV, images —
 * must pass through unexamined: running an HTML extractor over a JSON body
 * would be a worse regression than the one this module closes.
 */
export function isHtmlContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const mime = contentType.split(';')[0]?.trim().toLowerCase();
  return mime === 'text/html' || mime === 'application/xhtml+xml';
}

/**
 * Returns the page's main content as Markdown, or `null` when extraction is
 * not worth preferring over the raw body. Never throws: a page we cannot
 * parse must still be readable, so every failure mode here — Defuddle
 * throwing on input it cannot make sense of, returning nothing, or
 * returning something implausibly small next to a substantial input — is a
 * signal to fall back, not an error to propagate. The caller
 * (`agent/tools/http.ts`) treats `null` exactly like "extraction was never
 * attempted": it clips and fences the raw body instead.
 */
export async function extractMainContent(html: string, url: string): Promise<string | null> {
  if (html.trim().length === 0) return null;
  try {
    const { document } = parseHTML(html);
    const result = await Defuddle(document, url, { markdown: true });
    const content = result?.content?.trim() ?? '';
    if (content.length === 0) return null;
    if (html.length > PLAUSIBILITY_CHECK_FLOOR_RAW_CHARS && content.length < MIN_PLAUSIBLE_EXTRACTED_CHARS) {
      return null;
    }
    return content;
  } catch {
    return null;
  }
}
