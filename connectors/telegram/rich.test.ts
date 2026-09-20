import { describe, expect, it } from 'vitest';
import {
  countRich,
  inlineRich,
  normalizeInboundRich,
  planRich,
  richFitsHard,
  RICH_COMPAT_BLOCKS,
  RICH_COMPAT_CHARS,
  RICH_MAX_BLOCKS,
  RICH_MAX_CHARS,
  RICH_MAX_NESTING,
  RICH_MAX_TABLE_COLUMNS,
  TELEGRAM_BOT_API_TARGET,
  unknownRichPlaceholder,
} from './rich.js';

/**
 * Bot API 10.3 rich policy (`rich.ts`): WHEN rich may ride, WHAT it carries,
 * and WHERE the ceilings sit. The delivery/WAL behaviour lives in
 * `rich-delivery.test.ts`; the wire methods in `api.test.ts`'s rich block;
 * ingress in `inbound-rich.test.ts`.
 */

describe('telegram rich · version and limits are explicit surface facts', () => {
  it('names the implemented Bot API level', () => {
    expect(TELEGRAM_BOT_API_TARGET).toBe('10.3');
  });

  it('declares the official protocol limits, not the legacy ones', () => {
    expect(RICH_MAX_CHARS).toBe(32_768);
    expect(RICH_MAX_BLOCKS).toBe(500);
    expect(RICH_MAX_NESTING).toBe(16);
    expect(RICH_MAX_TABLE_COLUMNS).toBe(20);
  });

  it('keeps the compatibility ceiling strictly below the protocol maximum', () => {
    expect(RICH_COMPAT_CHARS).toBeLessThan(RICH_MAX_CHARS);
    expect(RICH_COMPAT_BLOCKS).toBeLessThan(RICH_MAX_BLOCKS);
  });
});

describe('telegram rich · simple prose stays on the proven legacy path', () => {
  it('plain prose with bold/italic/code is legacy, not rich', () => {
    const plan = planRich('Ciao, ecco il resoconto con **grassetto**, *corsivo* e `codice`.');
    expect(plan).toEqual({ mode: 'legacy', richConstructs: false });
  });

  it('a plain bullet list without structure is legacy', () => {
    const plan = planRich('- uno\n- due\n- tre');
    expect(plan.mode).toBe('legacy');
  });

  it('a long prose answer is legacy, not truncated rich', () => {
    const plan = planRich('parola '.repeat(3000));
    expect(plan.mode).toBe('legacy');
  });
});

describe('telegram rich · structured answers ride rich', () => {
  it('a table becomes one table block', () => {
    const plan = planRich('| nome | prezzo |\n| --- | ---: |\n| pane | 2 |\n| latte | 3 |');
    expect(plan.mode).toBe('rich');
    if (plan.mode !== 'rich') return;
    expect(plan.message.blocks).toHaveLength(1);
    const table = plan.message.blocks[0]!;
    expect(table.type).toBe('table');
    if (table.type !== 'table') return;
    expect(table.cells).toHaveLength(3); // header + 2 rows
    expect(table.cells[0]![0]).toMatchObject({ is_header: true });
    expect(table.cells[0]![1]).toMatchObject({ align: 'right' });
  });

  it('a checklist becomes a list with checkboxes', () => {
    const plan = planRich('- [x] pane\n- [ ] latte');
    expect(plan.mode).toBe('rich');
    if (plan.mode !== 'rich') return;
    const list = plan.message.blocks[0]!;
    expect(list.type).toBe('list');
    if (list.type !== 'list') return;
    expect(list.items[0]).toMatchObject({ has_checkbox: true, is_checked: true });
    expect(list.items[1]).toMatchObject({ has_checkbox: true });
    expect(list.items[1]).not.toHaveProperty('is_checked');
  });

  it('headings become heading blocks with size', () => {
    const plan = planRich('# Titolo\n\nUn paragrafo.');
    expect(plan.mode).toBe('rich');
    if (plan.mode !== 'rich') return;
    expect(plan.message.blocks[0]).toMatchObject({ type: 'heading', size: 1 });
    expect(plan.message.blocks[1]).toMatchObject({ type: 'paragraph' });
  });

  it('details become a details block with summary', () => {
    const plan = planRich('<details>\n<summary>Spiegazione</summary>\nIl contenuto.\n</details>');
    expect(plan.mode).toBe('rich');
    if (plan.mode !== 'rich') return;
    expect(plan.message.blocks[0]).toMatchObject({ type: 'details' });
  });

  it('math becomes a mathematical_expression block', () => {
    const plan = planRich('$$E = mc^2$$');
    expect(plan.mode).toBe('rich');
    if (plan.mode !== 'rich') return;
    expect(plan.message.blocks[0]).toMatchObject({ type: 'mathematical_expression', expression: 'E = mc^2' });
  });

  it('inline emphasis survives inside rich paragraphs', () => {
    const plan = planRich('# Nota\n\nTesto con **grassetto** e un [collegamento](https://example.test/x).');
    expect(plan.mode).toBe('rich');
    if (plan.mode !== 'rich') return;
    const para = plan.message.blocks[1]!;
    expect(para.type).toBe('paragraph');
    const flat = JSON.stringify(para);
    expect(flat).toContain('"bold"');
    expect(flat).toContain('"url"');
  });

  it('a rich answer past 4096 chars is still rich, not legacy-split for crossing 4096', () => {
    // 80 data rows: chars cross 4096 while blocks (table + 81 rows) stay under the compat ceiling.
    const rows = Array.from({ length: 80 }, (_, k) => `| voce numero ${k} con descrizione estesa e dettagli | ${k} | nota aggiuntiva ${k} qui |`).join('\n');
    const plan = planRich(`| nome | q | nota |\n| --- | --- | --- |\n${rows}`);
    expect(plan.mode).toBe('rich');
    if (plan.mode !== 'rich') return;
    expect(plan.chars).toBeGreaterThan(4096);
    expect(plan.chars).toBeLessThanOrEqual(RICH_COMPAT_CHARS);
  });
});

describe('telegram rich · over-ceiling content falls back, never truncates', () => {
  it('a table past the compat chars ceiling is legacy-with-constructs', () => {
    const rows = Array.from({ length: 400 }, (_, k) => `| voce ${k} | descrizione numero ${k} con un po di testo |`).join('\n');
    const plan = planRich(`| nome | dettaglio |\n| --- | --- |\n${rows}`);
    expect(plan).toEqual({ mode: 'legacy', richConstructs: true });
  });

  it('a table past 20 columns is legacy, not a truncated table', () => {
    const wide = `| ${Array.from({ length: 21 }, (_, k) => `c${k}`).join(' | ')} |\n| ${Array(21).fill('---').join(' | ')} |\n| ${Array(21).fill('x').join(' | ')} |`;
    expect(planRich(wide).mode).toBe('legacy');
  });

  it('an image reference keeps the whole answer legacy (no dead tg:// links)', () => {
    expect(planRich('# Foto\n\n![foto](https://example.test/a.jpg)').mode).toBe('legacy');
  });

  it('richFitsHard refuses an oversized payload with a reason', () => {
    const tooLong = { blocks: [{ type: 'paragraph' as const, text: 'x'.repeat(RICH_MAX_CHARS + 1) }] };
    expect(richFitsHard(tooLong)).toContain(String(RICH_MAX_CHARS));
  });

  it('countRich follows the official enumeration (lists items, table rows)', () => {
    const message = {
      blocks: [
        { type: 'paragraph' as const, text: 'ciao' },
        {
          type: 'list' as const,
          items: [
            { blocks: [{ type: 'paragraph' as const, text: 'a' }] },
            { blocks: [{ type: 'paragraph' as const, text: 'b' }] },
          ],
        },
      ],
    };
    // 1 paragraph + 1 list + 2 items + 2 item paragraphs = 6; 'ciao'+'a'+'b' = 6 chars
    expect(countRich(message).blocks).toBe(6);
    expect(countRich(message).chars).toBe(6);
  });
});

describe('telegram rich · inline builder', () => {
  it('plain text stays a string', () => {
    expect(inlineRich('solo testo')).toBe('solo testo');
  });

  it('snake_case is not italic', () => {
    expect(inlineRich('nome_variabile')).toBe('nome_variabile');
  });

  it('links keep label and url apart', () => {
    expect(inlineRich('vedi [qui](https://example.test/q)')).toEqual(['vedi ', { type: 'url', text: ['qui'], url: 'https://example.test/q' }]);
  });
});

describe('telegram rich · inbound smoke (full matrix in inbound-rich.test.ts)', () => {
  it('absent rich_message is null, not an error', () => {
    expect(normalizeInboundRich({})).toBeNull();
  });

  it('unknown block kinds get a bounded placeholder, never silence', () => {
    const text = normalizeInboundRich({ rich_message: { blocks: [{ type: 'teletrasporto', frobnicate: 'x'.repeat(5000) }] } });
    expect(text).toBe(unknownRichPlaceholder('teletrasporto'));
    expect(text!.length).toBeLessThan(200);
  });
});
