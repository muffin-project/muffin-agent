import type { InputRichBlock, InputRichMessage, RichText } from '@grammyjs/types';

/**
 * Telegram Bot API 10.3 Rich Messages — the second delivery mode.
 *
 * Until Bot API 10.1 (2026-06-11) the only text surface was `sendMessage`
 * with 1–4096 characters of HTML. Bot API 10.1 added Rich Messages
 * (`sendRichMessage`, `sendRichMessageDraft`, `editMessageText.rich_message`,
 * inbound `Message.rich_message`); 10.2 added the `blocks`/`media` assembly;
 * 10.3 (2026-08-24, this file's target) added buttons/document/expandable
 * quote blocks, `is_compact` tables, `can_stop`/`keep_on_stop` drafts and the
 * `stopped_message_generation` update. Verified live against
 * `https://core.telegram.org/bots/api` and `/bots/api-changelog` on
 * 2026-09-20 (`docs/evidence/telegram-bot-api-10-3-2026-09-20.md`).
 *
 * ## Two modes, two limits — never one number
 *
 * Legacy: 4096 characters of rendered HTML per message (`render.ts`), split
 * post-render into as many messages as needed. Rich: 32768 characters and
 * 500 blocks in ONE message. `SurfaceLimits.maxMessageChars` stays 4096 —
 * it names the legacy mode — and `maxRichMessageChars` names the rich one
 * (`core/surface/types.ts`, `surface.ts`). Any code that still says
 * "Telegram max = 4096" as a platform fact is stale.
 *
 * ## Compatibility ceiling, not just protocol maximum
 *
 * The server accepting 32768 characters does not prove every client renders
 * them: peer evidence (Hermes: block-heavy ~10k–15k messages accepted but
 * partially displayed on some clients; OpenClaw: Desktop "message not
 * supported" on rich content mobile rendered fine) shows a gap between
 * server-ok and client-readable. This repository cannot measure client
 * rendering — the test harness answers with a fake Bot API, and a fake
 * `ok:true` proves nothing about a real screen (`docs/ORCHESTRATION.md`,
 * the stand-in rule). So the policy is two numbers with different owners:
 *
 * - the HARD maximum (32768 chars / 500 blocks / 16 levels) is the protocol
 *   fact: `planRich` never emits beyond the COMPAT ceiling, and
 *   `richFitsHard` refuses outright beyond the protocol maximum, client-side,
 *   so an oversized payload falls back without a wasted request;
 * - the COMPAT ceiling (8192 chars / 100 blocks) is the compatibility
 *   policy: below the lower bound of the Hermes-observed partial-display
 *   band (~10k) with margin, and one fifth of the protocol block maximum.
 *   Content beyond it is NOT truncated and NOT sent as one giant legacy
 *   message — it goes through the existing bounded legacy chunks
 *   (`renderForTelegram`), which every client demonstrably renders.
 *
 * Both ceilings are adjustable with real-client evidence; the falsifier is
 * named in `docs/evidence/telegram-bot-api-10-3-2026-09-20.md` §5. A
 * "magic" number with no provenance would be worse than a conservative one
 * with its provenance written down.
 *
 * ## What this file does NOT do
 *
 * - No network, no database, no retry. It builds payloads and reads them
 *   back; `api.ts` sends, `delivery.ts` decides what a failure means.
 * - No media upload. Outbound rich messages never carry media blocks: a
 *   model answer referencing media stays on the legacy path, honestly,
 *   instead of shipping a rich message with a dead `tg://` link.
 * - No model semantics. Input is the model's finished markdown; output is a
 *   display encoding of the same content.
 */

/** The Bot API version this surface implements. Named in tests and docs; bump with the changelog checklist. */
export const TELEGRAM_BOT_API_TARGET = '10.3';
/** When that version was published, per the official changelog. */
export const TELEGRAM_BOT_API_TARGET_DATE = '2026-08-24';
/** Oldest server behaviour the rich lane relies on (`can_stop`, stop updates: both 10.3). */
export const TELEGRAM_BOT_API_RICH_FLOOR = '10.3';

/** Official `#rich-message-limits`: UTF-8 characters of rich text, incl. formula source. */
export const RICH_MAX_CHARS = 32_768;
/** Official: blocks including nested blocks, list items, table rows, quotations, details. */
export const RICH_MAX_BLOCKS = 500;
/** Official: levels of nested formatting and blocks. */
export const RICH_MAX_NESTING = 16;
/** Official: media attachments in total. We emit none, but validate inbound counts. */
export const RICH_MAX_MEDIA = 50;
/** Official: columns in a table. A wider table is not truncated — the whole answer stays legacy. */
export const RICH_MAX_TABLE_COLUMNS = 20;

/**
 * Compatibility ceiling (chars). Below the ~10k lower bound of the
 * peer-observed server-ok/client-partial band, with margin. Policy, not
 * protocol — see the file docstring.
 */
export const RICH_COMPAT_CHARS = 8_192;
/** Compatibility ceiling (blocks). One fifth of the protocol maximum. Policy, not protocol. */
export const RICH_COMPAT_BLOCKS = 100;

/** An outbound rich payload. `never`: no media flavour — this surface never uploads media inside rich. */
export type OutboundRich = InputRichMessage<never>;

export type RichPlan =
  | {
      mode: 'rich';
      message: OutboundRich;
      /** Code-point count of text + formula sources. */
      chars: number;
      /** Block count per the official enumeration. */
      blocks: number;
    }
  | {
      mode: 'legacy';
      /**
       * True when the answer HAS rich-native constructs but cannot ride
       * rich (over a ceiling): the caller must use the existing bounded
       * legacy chunks, never one giant send. False when the answer is
       * ordinary prose that belongs on the proven path anyway.
       */
      richConstructs: boolean;
    };

/**
 * Model markdown → rich or legacy decision.
 *
 * Rich wins only when it materially improves rendering — tables, task/check
 * lists, details/collapsible, math, headings/structure — AND the payload
 * fits the compatibility ceiling. Everything else stays on the proven
 * legacy HTML path byte-for-byte, including answers that WOULD fit rich
 * but gain nothing from it.
 */
export function planRich(markdown: string): RichPlan {
  const built = buildBlocks(markdown, 0);
  if (built === null || !built.native) return { mode: 'legacy', richConstructs: false };
  const message: OutboundRich = { blocks: built.blocks };
  const { chars, blocks } = countRich(message);
  if (chars > RICH_COMPAT_CHARS || blocks > RICH_COMPAT_BLOCKS) {
    return { mode: 'legacy', richConstructs: true };
  }
  const hard = richFitsHard(message);
  if (hard !== null) return { mode: 'legacy', richConstructs: true };
  return { mode: 'rich', message, chars, blocks };
}

/**
 * Client-side protocol guard: null when the payload fits the official hard
 * limits, otherwise the reason. `api.ts` turns a violation into a
 * deterministic 400-class rejection WITHOUT touching the network, so it
 * flows through the same legacy-chunks fallback as a server refusal.
 */
export function richFitsHard(message: OutboundRich): string | null {
  const { chars, blocks, depth } = countRich(message);
  if (chars > RICH_MAX_CHARS) return `rich message ${chars} chars over the ${RICH_MAX_CHARS} protocol maximum`;
  if (blocks > RICH_MAX_BLOCKS) return `rich message ${blocks} blocks over the ${RICH_MAX_BLOCKS} protocol maximum`;
  if (depth > RICH_MAX_NESTING) return `rich message nesting ${depth} over the ${RICH_MAX_NESTING} protocol maximum`;
  return null;
}

export type RichSize = { chars: number; blocks: number; depth: number };

/**
 * Our existing HTML, carried as a rich message (Bot API 10.1 accepts `html`).
 *
 * Same bytes the legacy path would send with `parse_mode: HTML`; the transport
 * changes, not the content. It is how the step trail and the answer rode rich
 * in ONE message without a second renderer over the same data.
 */
export function richFromHtml(html: string): OutboundRich {
  return { html };
}

/** Code-point count (UTF-8 characters, approximated) + official-enumeration block count + nesting depth. */
export function countRich(message: OutboundRich): RichSize {
  // A rich message may carry `html`/`markdown` instead of `blocks` (exactly one
  // of the three). The text is the payload; there is one block and no nesting
  // to walk, so the hard-limit check is a character count.
  if (typeof message.html === 'string') {
    return { chars: codePoints(message.html), blocks: 1, depth: 1 };
  }
  if (typeof message.markdown === 'string') {
    return { chars: codePoints(message.markdown), blocks: 1, depth: 1 };
  }
  let chars = 0;
  let blocks = 0;
  let depth = 0;
  const text = (rt: RichText | undefined, level: number): void => {
    depth = Math.max(depth, level);
    if (typeof rt === 'string') {
      chars += codePoints(rt);
      return;
    }
    if (Array.isArray(rt)) {
      for (const part of rt) text(part, level + 1);
      return;
    }
    if (rt !== null && typeof rt === 'object') {
      const o = rt as unknown as Record<string, unknown>;
      if ('text' in o) text(o['text'] as RichText, level + 1);
      if (typeof o['expression'] === 'string') chars += codePoints(o['expression']);
    }
  };
  const block = (b: InputRichBlock<never>, level: number): void => {
    depth = Math.max(depth, level);
    blocks += 1;
    const o = b as unknown as Record<string, unknown>;
    switch (b.type) {
      case 'paragraph':
      case 'heading':
      case 'pre':
      case 'footer':
      case 'mathematical_expression':
        text(o['text'] as RichText | undefined, level + 1);
        if (b.type === 'mathematical_expression' && typeof o['expression'] === 'string') {
          chars += codePoints(o['expression']);
        }
        break;
      case 'divider':
        break;
      case 'list':
        for (const item of (o['items'] as { blocks: InputRichBlock<never>[] }[] | undefined) ?? []) {
          blocks += 1; // list items count per the official enumeration
          for (const inner of item.blocks) block(inner, level + 1);
        }
        break;
      case 'table':
        for (const row of (o['cells'] as { text?: RichText }[][] | undefined) ?? []) {
          blocks += 1; // table rows count per the official enumeration
          for (const cell of row) text(cell.text, level + 1);
        }
        if (o['caption'] !== undefined) text(o['caption'] as RichText, level + 1);
        break;
      case 'blockquote':
      case 'details':
      case 'collage':
      case 'slideshow':
        for (const inner of (o['blocks'] as InputRichBlock<never>[] | undefined) ?? []) block(inner, level + 1);
        if (o['summary'] !== undefined) text(o['summary'] as RichText, level + 1);
        if (o['credit'] !== undefined) text(o['credit'] as RichText, level + 1);
        if (o['caption'] !== undefined) {
          const caption = o['caption'] as { text?: RichText };
          text(caption.text, level + 1);
        }
        break;
      case 'expandable_blockquote':
      case 'pullquote':
        text(o['text'] as RichText | undefined, level + 1);
        if (o['credit'] !== undefined) text(o['credit'] as RichText, level + 1);
        break;
      default:
        break;
    }
  };
  for (const b of message.blocks ?? []) block(b, 1);
  return { chars, blocks, depth };
}

function codePoints(s: string): number {
  return Array.from(s).length;
}

/* ------------------------------------------------------------------ */
/* Outbound builder: model markdown → typed blocks.                    */
/* ------------------------------------------------------------------ */

type Built = { blocks: InputRichBlock<never>[]; native: boolean } | null;

/** Depth cap for nested structures (details > list > …). Far under the protocol 16; deeper nests stay legacy. */
const BUILD_MAX_DEPTH = 4;

function buildBlocks(markdown: string, depth: number): Built {
  if (depth > BUILD_MAX_DEPTH) return null;
  const lines = markdown.split('\n');
  const blocks: InputRichBlock<never>[] = [];
  let native = false;
  let para: string[] = [];
  const flushPara = (): void => {
    if (para.length === 0) return;
    const text = para.join('\n').trim();
    para = [];
    if (text !== '') blocks.push({ type: 'paragraph', text: inlineRich(text) });
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    // Fenced code → pre. Unclosed fence is partial-stream text, not a block:
    // leave it a paragraph so a draft tick never emits a broken structure.
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && lines[j] !== '```') {
        body.push(lines[j] ?? '');
        j++;
      }
      if (j >= lines.length) {
        para.push(line);
        i++;
        continue;
      }
      flushPara();
      blocks.push({
        type: 'pre',
        text: body.join('\n'),
        ...(fence[1] !== '' ? { language: fence[1] } : {}),
      });
      i = j + 1;
      continue;
    }
    // Block math → mathematical_expression. Same partial-stream guard.
    if (line.trim() === '$$') {
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && (lines[j] ?? '').trim() !== '$$') {
        body.push(lines[j] ?? '');
        j++;
      }
      if (j >= lines.length) {
        para.push(line);
        i++;
        continue;
      }
      flushPara();
      blocks.push({ type: 'mathematical_expression', expression: body.join('\n') });
      native = true;
      i = j + 1;
      continue;
    }
    const inlineMath = /^\$\$(.+)\$\$\s*$/.exec(line);
    if (inlineMath) {
      flushPara();
      blocks.push({ type: 'mathematical_expression', expression: inlineMath[1] ?? '' });
      native = true;
      i++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushPara();
      blocks.push({ type: 'heading', text: inlineRich(heading[2] ?? ''), size: heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6 });
      native = true;
      i++;
      continue;
    }
    if (/^\s*---\s*$/.test(line)) {
      flushPara();
      blocks.push({ type: 'divider' });
      i++;
      continue;
    }
    if (/^\s*<details>\s*$/.test(line)) {
      const inner: string[] = [];
      let j = i + 1;
      while (j < lines.length && !/^\s*<\/details>\s*$/.test(lines[j] ?? '')) {
        inner.push(lines[j] ?? '');
        j++;
      }
      if (j >= lines.length) {
        para.push(line);
        i++;
        continue;
      }
      const summaryMatch = /^\s*<summary>(.*)<\/summary>\s*$/.exec(inner[0] ?? '');
      const innerBuilt = buildBlocks(inner.slice(summaryMatch ? 1 : 0).join('\n'), depth + 1);
      if (innerBuilt === null) return null;
      flushPara();
      blocks.push({
        type: 'details',
        summary: inlineRich(summaryMatch?.[1] ?? 'dettagli'),
        blocks: innerBuilt.blocks.length > 0 ? innerBuilt.blocks : [{ type: 'paragraph', text: '…' }],
      });
      native = true;
      i = j + 1;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?[\s:|-]*$/.test(lines[i + 1] ?? '') && (lines[i + 1] ?? '').includes('-')) {
      const table = buildTable(lines, i);
      if (table === null) return null;
      flushPara();
      blocks.push(table.block);
      native = true;
      i = table.next;
      continue;
    }
    const quoteRun = takeWhile(lines, i, (l) => /^\s*&gt;|^\s*>/.test(l));
    if (quoteRun.length > 0) {
      flushPara();
      const quoted = quoteRun.map((l) => l.replace(/^\s*(&gt;|>)\s?/, '')).join('\n');
      // Same shape as the legacy `quoteBlocks` threshold: a long quotation
      // arrives closed, not burying the answer underneath it.
      const long = quoteRun.length > 10 || quoted.length > 500;
      if (long) {
        blocks.push({ type: 'expandable_blockquote', text: inlineRich(quoted) });
      } else {
        blocks.push({ type: 'blockquote', blocks: [{ type: 'paragraph', text: inlineRich(quoted) }] });
      }
      i += quoteRun.length;
      continue;
    }
    const listRun = takeWhile(lines, i, (l) => /^\s*[-*]\s+\[[ xX]\]\s+/.test(l) || /^\s*(?:[-*]|\d+[.)])\s+/.test(l));
    if (listRun.length > 0) {
      const list = buildList(listRun, depth);
      if (list === null) return null;
      flushPara();
      blocks.push(list.block);
      if (list.checklist) native = true;
      i += listRun.length;
      continue;
    }
    // Media references have no honest rich form here (no uploads): the whole
    // answer stays legacy rather than shipping a dead tg:// link.
    if (/!\[[^\]]*\]\([^)]*\)/.test(line)) return null;
    if (line.trim() === '') {
      flushPara();
      i++;
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return { blocks, native };
}

function takeWhile(lines: string[], from: number, pred: (l: string) => boolean): string[] {
  const out: string[] = [];
  for (let k = from; k < lines.length; k++) {
    const l = lines[k] ?? '';
    if (l.trim() === '') break;
    if (!pred(l)) break;
    out.push(l);
  }
  return out;
}

function buildTable(lines: string[], from: number): { block: InputRichBlock<never>; next: number } | null {
  const rows: string[][] = [];
  let k = from;
  // Header row.
  rows.push(splitRow(lines[k] ?? ''));
  // Delimiter row: alignment only.
  const aligns = splitRow(lines[k + 1] ?? '').map((cell) => {
    const c = cell.trim();
    if (/^:-+:$/.test(c)) return 'center' as const;
    if (/^-+:$/.test(c)) return 'right' as const;
    return 'left' as const;
  });
  k += 2;
  while (k < lines.length && /^\s*\|.*\|\s*$/.test(lines[k] ?? '')) {
    rows.push(splitRow(lines[k] ?? ''));
    k++;
  }
  const width = Math.max(...rows.map((r) => r.length));
  // Over the protocol column count the table cannot ride rich at all — and a
  // truncated table would be a lie, so the WHOLE answer stays legacy. Ragged
  // rows are padded, not rejected: a missing trailing cell is sloppy, not
  // structural.
  if (width > RICH_MAX_TABLE_COLUMNS) return null;
  for (const r of rows) while (r.length < width) r.push('');
  const header = rows[0] ?? [];
  const body = rows.slice(1);
  // A delimiter with no body rows is not a table, it is paragraphs.
  if (body.length === 0) return null;
  const cells: { text?: RichText; is_header?: true; align: 'left' | 'center' | 'right'; valign: 'top' | 'middle' | 'bottom' }[][] = [
    header.map((cell, c) => ({
      text: inlineRich(cell.trim()),
      is_header: true as const,
      align: aligns[c] ?? 'left',
      valign: 'top' as const,
    })),
    ...body.map((row) =>
      row.map((cell, c) => ({
        text: inlineRich(cell.trim()),
        align: aligns[c] ?? 'left',
        valign: 'top' as const,
      })),
    ),
  ];
  return { block: { type: 'table', cells, is_bordered: true }, next: k };
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\||\|$/g, '');
  return trimmed.split('|');
}

function buildList(run: string[], depth: number): { block: InputRichBlock<never>; checklist: boolean } | null {
  if (depth > BUILD_MAX_DEPTH) return null;
  const ordered = /^\s*\d+[.)]\s+/.test(run[0] ?? '');
  let checklist = false;
  const items: { blocks: InputRichBlock<never>[]; has_checkbox?: true; is_checked?: true }[] = [];
  for (const line of run) {
    const check = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (check) {
      checklist = true;
      const done = check[1]!.toLowerCase() === 'x';
      items.push({
        blocks: [{ type: 'paragraph', text: inlineRich(check[2] ?? '') }],
        has_checkbox: true,
        ...(done ? { is_checked: true as const } : {}),
      });
      continue;
    }
    const text = line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '');
    items.push({ blocks: [{ type: 'paragraph', text: inlineRich(text) }] });
  }
  if (ordered) {
    return { block: { type: 'list', items: items.map((it) => ({ ...it, type: '1' as const })) }, checklist };
  }
  return { block: { type: 'list', items }, checklist };
}

/**
 * Inline markdown → RichText. Handles the same emphasis the legacy renderer
 * does (`**` bold, `*`/`_` italic, `` ` `` code, `~~` strike, `[t](url)`
 * links) so a rich table cell does not read poorer than its legacy row.
 * Unknown markup (`||spoiler||`, custom emoji) stays literal text — never
 * invented semantics.
 */
export function inlineRich(text: string): RichText {
  const parts = splitInline(text, 0);
  if (parts.length === 1 && typeof parts[0] === 'string') return parts[0];
  return parts;
}

const INLINE_MAX_DEPTH = 8;

function splitInline(text: string, depth: number): RichText[] {
  if (depth > INLINE_MAX_DEPTH) return [text];
  const out: RichText[] = [];
  // Links first (labels may carry emphasis), then code, then emphasis —
  // the same order `toTelegramHtml` uses, for the same reason.
  const token = /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(`([^`\n]+)`)|(\*\*([^*\n]+)\*\*)|(~~([^~\n]+)~~)|((?:^|[\s(])\*([^*\n]+)\*)|((?:^|[\s(])_([^_\n]+)_)/;
  let rest = text;
  for (;;) {
    const m = token.exec(rest);
    if (!m) {
      if (rest !== '') out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    if (m[1] !== undefined) {
      out.push({ type: 'url', text: splitInline(m[2] ?? '', depth + 1) as unknown as RichText, url: m[3] ?? '' });
    } else if (m[4] !== undefined) {
      out.push({ type: 'code', text: m[5] ?? '' });
    } else if (m[6] !== undefined) {
      out.push({ type: 'bold', text: splitInline(m[7] ?? '', depth + 1) as unknown as RichText });
    } else if (m[8] !== undefined) {
      out.push({ type: 'strikethrough', text: splitInline(m[9] ?? '', depth + 1) as unknown as RichText });
    } else if (m[10] !== undefined) {
      const lead = /^[\s(]/.test(m[10]) ? m[10][0]! : '';
      if (lead !== '') out.push(lead);
      out.push({ type: 'italic', text: splitInline(m[11] ?? '', depth + 1) as unknown as RichText });
    } else if (m[12] !== undefined) {
      const lead = /^[\s(]/.test(m[12]) ? m[12][0]! : '';
      if (lead !== '') out.push(lead);
      out.push({ type: 'italic', text: splitInline(m[13] ?? '', depth + 1) as unknown as RichText });
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out.length > 0 ? out : [text];
}

/* ------------------------------------------------------------------ */
/* Inbound: rich blocks → agent-readable semantic text.                */
/* ------------------------------------------------------------------ */

/**
 * A received or forwarded Rich Message, normalised into agent-readable
 * semantic content. Returns null when the message carries no
 * `rich_message` at all; returns '' only when it carries an empty one
 * (no blocks), which the caller treats like any other contentless message.
 *
 * Structure is preserved (headings, lists, tables, quotes, details, code)
 * because "a table" and "a paragraph that mentions cells" are different
 * questions to answer. Block kinds this surface does not understand emit an
 * explicit bounded placeholder — never silence, never invented content.
 *
 * Defensive by construction: the wire type may claim required fields a real
 * payload omits (`api.ts`'s own warning), so every field is read as
 * `unknown` and coerced, never trusted.
 */
export function normalizeInboundRich(message: { rich_message?: unknown }): string | null {
  const rich = message.rich_message as { blocks?: unknown } | undefined;
  if (rich === null || typeof rich !== 'object' || rich === undefined) return null;
  if (!Array.isArray(rich.blocks)) return null;
  const lines: string[] = [];
  for (const block of rich.blocks) lines.push(...blockToLines(block, 0));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Placeholder for an unknown rich block kind. Type name only: bounded by construction, no content dump. */
export function unknownRichPlaceholder(kind: string): string {
  const safe = kind.replace(/[^\w-]/g, '').slice(0, 40) || 'sconosciuto';
  return `[rich: blocco «${safe}» non interpretato — contenuto non disponibile]`;
}

function blockToLines(block: unknown, depth: number): string[] {
  if (block === null || typeof block !== 'object') return [];
  const o = block as Record<string, unknown>;
  const kind = typeof o['type'] === 'string' ? o['type'] : '';
  const text = (v: unknown): string => richPlain(v, 0);
  switch (kind) {
    case 'paragraph':
      return text(o['text']) === '' ? [] : [text(o['text'])];
    case 'heading': {
      const size = typeof o['size'] === 'number' ? Math.min(6, Math.max(1, Math.round(o['size']))) : 1;
      const t = text(o['text']);
      return t === '' ? [] : [`${'#'.repeat(size)} ${t}`];
    }
    case 'pre': {
      const t = text(o['text']);
      const lang = typeof o['language'] === 'string' && o['language'] !== '' ? o['language'] : '';
      return ['```' + lang, t, '```'];
    }
    case 'footer': {
      const t = text(o['text']);
      return t === '' ? [] : [`— ${t}`];
    }
    case 'divider':
      return ['---'];
    case 'mathematical_expression': {
      const expr = typeof o['expression'] === 'string' ? o['expression'] : text(o['text']);
      return expr === '' ? [] : [`$${expr}$`];
    }
    case 'anchor': {
      const t = text(o['text']);
      return t === '' ? [] : [`[ancora: ${t}]`];
    }
    case 'list': {
      if (!Array.isArray(o['items'])) return [unknownRichPlaceholder('list')];
      return (o['items'] as unknown[]).flatMap((item, index) => itemToLines(item, index, depth));
    }
    case 'blockquote':
    case 'pullquote': {
      const inner = Array.isArray(o['blocks'])
        ? (o['blocks'] as unknown[]).flatMap((b) => blockToLines(b, depth + 1))
        : text(o['text']) === ''
          ? []
          : [text(o['text'])];
      const credit = typeof o['credit'] === 'string' || typeof o['credit'] === 'object' ? text(o['credit']) : '';
      const quoted = inner.map((l) => `> ${l}`);
      return credit !== '' ? [...quoted, `> — ${credit}`] : quoted;
    }
    case 'expandable_blockquote': {
      const t = text(o['text']);
      return t === '' ? [] : ['<details>', '<summary>citazione</summary>', ...t.split('\n').map((l) => `> ${l}`), '</details>'];
    }
    case 'collage':
    case 'slideshow': {
      const inner = Array.isArray(o['blocks']) ? (o['blocks'] as unknown[]).flatMap((b) => blockToLines(b, depth + 1)) : [];
      const caption = o['caption'] !== null && typeof o['caption'] === 'object' ? text((o['caption'] as Record<string, unknown>)['text']) : '';
      return [...inner, ...(caption !== '' ? [`[didascalia: ${caption}]`] : [])];
    }
    case 'table':
      return tableToLines(o);
    case 'details': {
      const summary = text(o['summary']);
      const inner = Array.isArray(o['blocks']) ? (o['blocks'] as unknown[]).flatMap((b) => blockToLines(b, depth + 1)) : [];
      return ['<details>', `<summary>${summary === '' ? 'dettagli' : summary}</summary>`, '', ...inner, '</details>'];
    }
    case 'map': {
      const loc = o['location'] !== null && typeof o['location'] === 'object' ? (o['location'] as Record<string, unknown>) : {};
      const lat = typeof loc['latitude'] === 'number' ? loc['latitude'] : '?';
      const lon = typeof loc['longitude'] === 'number' ? loc['longitude'] : '?';
      return [`[mappa: ${lat}, ${lon}]`];
    }
    case 'buttons': {
      const labels = Array.isArray(o['buttons'])
        ? (o['buttons'] as Record<string, unknown>[]).map((b) => (typeof b?.['text'] === 'string' ? (b['text'] as string) : text(b?.['text']))).filter((l) => l !== '')
        : [];
      return [`[pulsanti: ${labels.join(' · ') || 'nessuna etichetta'}]`];
    }
    case 'animation':
    case 'audio':
    case 'document':
    case 'photo':
    case 'video':
    case 'voice_note':
      return [mediaDescriptor(kind, o)];
    case 'thinking':
      // Draft-only per the official docs ("can't be received in messages");
      // named, not dropped, in case a server ever sends one anyway.
      return ['[rich: indicatore di elaborazione del mittente]'];
    default:
      return [unknownRichPlaceholder(kind)];
  }
}

function itemToLines(item: unknown, index: number, depth: number): string[] {
  if (item === null || typeof item !== 'object') return [];
  const o = item as Record<string, unknown>;
  const inner = Array.isArray(o['blocks']) ? (o['blocks'] as unknown[]).flatMap((b) => blockToLines(b, depth + 1)) : [];
  const first = inner[0] ?? '';
  const rest = inner.slice(1).map((l) => `  ${l}`);
  let marker: string;
  if (o['has_checkbox'] === true) {
    marker = o['is_checked'] === true ? '- [x] ' : '- [ ] ';
  } else if (typeof o['value'] === 'number' || typeof o['type'] === 'string') {
    marker = `${typeof o['value'] === 'number' ? o['value'] : index + 1}. `;
  } else {
    marker = '- ';
  }
  if (first === '' && rest.length === 0) return [];
  return [`${marker}${first}`, ...rest];
}

function tableToLines(o: Record<string, unknown>): string[] {
  if (!Array.isArray(o['cells']) || (o['cells'] as unknown[]).length === 0) return [unknownRichPlaceholder('table')];
  const rows = (o['cells'] as unknown[][]).map((row) =>
    row.map((cell) => {
      if (cell === null || typeof cell !== 'object') return '';
      const c = cell as Record<string, unknown>;
      // Backslashes first: escaping a bare `|` by prefixing `\` is not enough
      // when the cell already ends in `\` — that turns the prefix into an
      // escaped backslash and leaves the `|` live as a cell separator
      // (`js/incomplete-sanitization`). Escaping `\` first keeps every pipe
      // escaped no matter what the sender wrote.
      return richPlain(c['text'], 0).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    }),
  );
  const width = Math.max(...rows.map((r) => r.length));
  if (width === 0) return [unknownRichPlaceholder('table')];
  const pad = (r: string[]): string[] => [...r, ...Array(Math.max(0, width - r.length)).fill('')];
  const lines = [`| ${pad(rows[0] ?? []).join(' | ')} |`, `| ${Array(width).fill('---').join(' | ')} |`];
  for (const row of rows.slice(1)) lines.push(`| ${pad(row).join(' | ')} |`);
  const caption = typeof o['caption'] === 'string' || typeof o['caption'] === 'object' ? richPlain(o['caption'], 0) : '';
  if (caption !== '') lines.push(`[didascalia tabella: ${caption}]`);
  return lines;
}

function mediaDescriptor(kind: string, o: Record<string, unknown>): string {
  const names: Record<string, string> = {
    animation: 'animazione',
    audio: 'audio',
    document: 'documento',
    photo: 'foto',
    video: 'video',
    voice_note: 'messaggio vocale',
  };
  const label = names[kind] ?? kind;
  const captionRaw = o['caption'];
  const caption =
    captionRaw !== null && typeof captionRaw === 'object' ? richPlain((captionRaw as Record<string, unknown>)['text'], 0) : richPlain(captionRaw, 0);
  return caption !== '' ? `[${label}: ${caption}]` : `[${label}]`;
}

/** Any RichText (string | array | typed object) → its plain readable text, defensively. */
export function richPlain(rt: unknown, depth: number): string {
  if (typeof rt === 'string') return rt;
  if (Array.isArray(rt)) {
    if (depth > RICH_MAX_NESTING) return '';
    return rt.map((part) => richPlain(part, depth + 1)).join('');
  }
  if (rt !== null && typeof rt === 'object') {
    const o = rt as Record<string, unknown>;
    if (typeof o['expression'] === 'string') return `$${o['expression']}$`;
    if ('text' in o) return richPlain(o['text'], depth + 1);
    return '';
  }
  return '';
}
