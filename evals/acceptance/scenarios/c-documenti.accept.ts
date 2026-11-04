import DatabaseCtor from 'better-sqlite3';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe } from 'vitest';
import { install } from '../harness.js';
import { HEADLESS_TURN_TIMEOUT_SECONDS, headlessTestTimeoutMs } from '../turn-budget.js';
import { scenario } from '../scenario.js';
import { buildPdf, pagesWithoutText } from '../../../core/documents/fixtures/pdf.js';

/**
 * A real DOCX written by someone else's serialiser (macOS `textutil`), the
 * same file `core/documents/extract.test.ts` checks the reader against — so
 * the acceptance leg below meets bytes no Muffin code ever produced, not a
 * fixture built to match the parser.
 */
const RELAZIONE_DOCX = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'core',
  'documents',
  'fixtures',
  'relazione.docx',
);

/**
 * C7 · Documents — a real PDF reaches an episode and its index, and a scan
 * fails explicitly instead of indexing nothing as if it were read.
 *
 * `connectors/telegram/document-arrival.test.ts` already proves the
 * attachment→vault→reindex→episode path in-process, and the fake Telegram
 * (`evals/acceptance/telegram.ts`) does not serve file downloads — so this
 * takes the path the row itself names as reachable from the CLI: `muffin
 * vault add`, which (`cli/vault.ts`'s `cmdVaultAdd`) copies the file into the
 * vault and indexes it in the same command, through `core/vault/vault.ts`'s
 * `reindexPath` → `core/documents/extract.ts`'s `extractDocument` — the real
 * binary, a real (if minimal) PDF, a real sqlite database.
 *
 * The two fixtures are built byte-for-byte by `core/documents/fixtures/
 * pdf.ts` (already used by `core/documents/extract.test.ts`), not sampled
 * from a committed file — grepping the repo for `.pdf` found none. `buildPdf`
 * produces a real cross-reference table and content stream pdf.js actually
 * parses; `pagesWithoutText` is the same construction with the `Tj` text
 * operators left out, which is a byte-level property a stubbed extractor
 * could not stand in for.
 *
 * **Falsifier**: if `extractDocument`'s `no_text_layer` branch were removed
 * (returning `{ ok: true, document: { text: '', ... } }` for a scan the way
 * `unpdf` itself does — see that function's own docstring, "a two-page PDF
 * with no text operators returns `{ text: ["", ""] }`"), `scansione.pdf`
 * would index as an empty, silently "read" document instead of failing with
 * exit 1 and a named reason — the exact failure this row's own text calls
 * out.
 *
 * The DOCX half (legs f–i) closes the gap the row's own text names outright:
 * a real `.docx` through `muffin vault add`, found again by `memory search`,
 * and opened mid-turn through the `document_read` tool — driven here through
 * a real scripted turn the way `c-tempo.accept.ts` drives `memory_search`,
 * asserting the DOCX's own text on the model's next request.
 *
 * **Falsifier (DOCX)**: point leg (f) at an empty file, or disconnect the
 * `document_read` tool registration in `agent/runtime.ts`, and the scenario
 * goes red on content — no episode carrying "Ricavi 2026", or no
 * `turn_tool_calls` row for `document_read` carrying the DOCX's text. The leg
 * asserts the durable tool-call record rather than the follow-up request on
 * purpose: recall alone could surface the same words into the model's
 * context, so only the tool's own result row proves the tool ran.
 */

describe('acceptance · C7 · documenti reali attraverso il binario', () => {
  scenario(
    'C7',
    async () => {
      const inst = await install({
        main: [
          // The document_read leg: the model opens the DOCX by its vault
          // path, then answers from whatever came back.
          { tool: { name: 'document_read', args: { path: 'relazione.docx' } } },
          { text: 'i ricavi 2026 nella relazione sono 1.240.000 euro' },
        ],
      });
      try {
        const contractPath = join(inst.workspace, 'contratto.pdf');
        const scanPath = join(inst.workspace, 'scansione.pdf');

        writeFileSync(
          contractPath,
          buildPdf({
            pages: [['Il contratto con il fornitore Fringuello scade il 31 dicembre 2026.']],
            title: 'Contratto Fringuello',
          }),
        );
        writeFileSync(scanPath, pagesWithoutText(2));

        // --- (a) a real PDF with a text layer: added, indexed, exit 0.
        const added = await inst.muffin(['vault', 'add', contractPath, '--tier', '0']);
        if (added.code !== 0) throw new Error(`vault add contratto.pdf: exit ${added.code}\n${added.out}\n${added.err}`);
        if (!added.out.includes('chunk')) {
          throw new Error(`\`vault add\` non riporta chunk scritti per il PDF con testo:\n${added.out}`);
        }

        // --- (b) a scanned PDF, no text layer: refused explicitly, exit 1,
        // named reason — never silently indexed as an empty document.
        const scanned = await inst.muffin(['vault', 'add', scanPath, '--tier', '0']);
        if (scanned.code !== 1) {
          throw new Error(`vault add scansione.pdf: atteso exit 1, letto ${scanned.code}\n${scanned.out}\n${scanned.err}`);
        }
        if (!scanned.err.includes('OCR') && !scanned.err.includes('scansione')) {
          throw new Error(`\`vault add\` non nomina il motivo del rifiuto sulla scansione:\n${scanned.err}`);
        }

        // --- (c) the episode landed for the real PDF, content and all —
        // through the store, not through this scenario's own reading of the
        // output.
        const contractEpisodes = inst.db(
          (db) =>
            db
              .prepare(`SELECT content FROM episodes WHERE connector = 'vault' AND vault_path = 'contratto.pdf'`)
              .all() as Array<{ content: string }>,
        );
        if (contractEpisodes.length === 0) {
          throw new Error('nessun episodio scritto per contratto.pdf');
        }
        if (!contractEpisodes.some((e) => e.content.includes('Fringuello'))) {
          throw new Error(
            `nessun episodio di contratto.pdf porta il testo del PDF:\n${JSON.stringify(contractEpisodes)}`,
          );
        }

        // --- (d) the scan never reached an episode at all — the failure is
        // total, not a document indexed with empty text.
        const scanEpisodes = inst.db(
          (db) =>
            (
              db.prepare(`SELECT count(*) AS n FROM episodes WHERE vault_path = 'scansione.pdf'`).get() as {
                n: number;
              }
            ).n,
        );
        if (scanEpisodes !== 0) {
          throw new Error(`scansione.pdf ha scritto ${scanEpisodes} episodi — doveva fallire del tutto`);
        }

        // --- (e) findable afterward: a plain `muffin memory search` on a
        // word from the PDF, no capitalisation tricks needed (unlike C4's
        // graph hop) — this is full-text over the indexed chunk.
        const found = await inst.muffin(['memory', 'search', 'Fringuello']);
        if (found.code !== 0) throw new Error(`memory search Fringuello: exit ${found.code}\n${found.err}`);
        if (!found.out.includes('Fringuello')) {
          throw new Error(`il testo del PDF indicizzato non si trova più a ricerca:\n${found.out}`);
        }

        // --- (f) a real DOCX from a third-party writer: added, indexed,
        // exit 0 — the same `vault add` door as the PDF above, through the
        // same `reindexPath` → `extractDocument` production path.
        const relazionePath = join(inst.workspace, 'relazione.docx');
        writeFileSync(relazionePath, readFileSync(RELAZIONE_DOCX));
        const docx = await inst.muffin(['vault', 'add', relazionePath, '--tier', '0']);
        if (docx.code !== 0) throw new Error(`vault add relazione.docx: exit ${docx.code}\n${docx.out}\n${docx.err}`);
        if (!docx.out.includes('chunk')) {
          throw new Error(`\`vault add\` non riporta chunk scritti per il DOCX vero:\n${docx.out}`);
        }

        // --- (g) the episode landed for the real DOCX, carrying its own
        // text — "Ricavi 2026" is what someone else's serialiser wrote, not
        // what this scenario invented.
        const docxEpisodes = inst.db(
          (db) =>
            db
              .prepare(`SELECT content FROM episodes WHERE connector = 'vault' AND vault_path = 'relazione.docx'`)
              .all() as Array<{ content: string }>,
        );
        if (docxEpisodes.length === 0) {
          throw new Error('nessun episodio scritto per relazione.docx');
        }
        if (!docxEpisodes.some((e) => e.content.includes('Ricavi 2026'))) {
          throw new Error(
            `nessun episodio di relazione.docx porta il testo del DOCX:\n${JSON.stringify(docxEpisodes).slice(0, 500)}`,
          );
        }

        // --- (h) findable afterward, same full-text door as the PDF.
        const docxFound = await inst.muffin(['memory', 'search', 'Ricavi']);
        if (docxFound.code !== 0) throw new Error(`memory search Ricavi: exit ${docxFound.code}\n${docxFound.err}`);
        if (!docxFound.out.includes('Ricavi')) {
          throw new Error(`il testo del DOCX indicizzato non si trova più a ricerca:\n${docxFound.out}`);
        }

        // --- (i) the tool leg: a real scripted turn opens the DOCX through
        // `document_read`. The assertion is on the durable tool-call record,
        // not on the follow-up request: recall could surface the same words
        // into the model's context on its own, so only a `turn_tool_calls`
        // row for `document_read` carrying the DOCX's text proves the tool
        // itself ran and answered (verified by hand: with the tool
        // disconnected in `agent/runtime.ts` this leg stays without such a
        // row and goes red, while the request transcript alone would not).
        const turn = await inst.muffin([
          'run',
          '--session',
          'c7-docx',
          '--timeout',
          String(HEADLESS_TURN_TIMEOUT_SECONDS),
          'cosa dice la relazione trimestrale sui ricavi?',
        ]);
        if (turn.code !== 0) throw new Error(`run: exit ${turn.code}\n${turn.err}`);
        const docReads = inst.db(
          (db) =>
            db
              .prepare(
                `SELECT tool, content, is_error AS isError FROM turn_tool_calls WHERE tool = 'document_read' ORDER BY started_at DESC LIMIT 1`,
              )
              .all() as Array<{ tool: string; content: string; isError: number }>,
        );
        if (docReads.length === 0) {
          throw new Error('il turno non ha mai chiamato document_read — il tool non è raggiunto dal binario');
        }
        const lastRead = docReads[0]!;
        if (lastRead.isError) {
          throw new Error(`document_read ha risposto errore invece del testo del DOCX:\n${lastRead.content}`);
        }
        if (!lastRead.content.includes('Ricavi 2026')) {
          throw new Error(
            `il risultato di document_read non porta il testo del DOCX:\n${lastRead.content.slice(0, 2000)}`,
          );
        }
      } finally {
        await inst.cleanup();
      }
    },
    headlessTestTimeoutMs(1),
  );
});
