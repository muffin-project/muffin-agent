import DatabaseCtor from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe } from 'vitest';
import { install } from '../harness.js';
import { scenario } from '../scenario.js';
import { buildPdf, pagesWithoutText } from '../../../core/documents/fixtures/pdf.js';

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
 */

describe('acceptance · C7 · documenti reali attraverso il binario', () => {
  scenario(
    'C7',
    async () => {
      const inst = await install({ main: [{ text: 'ok' }] });
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
      } finally {
        await inst.cleanup();
      }
    },
    30_000,
  );
});
