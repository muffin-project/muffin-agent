import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ingestAttachment, type IngestDeps } from './ingest.js';

/**
 * Slice 14's `ingest` stage, as its own module.
 *
 * The strings are the test. `connectors/telegram/document-arrival.test.ts` and
 * `voice-arrival.test.ts` already assert most of them through the whole
 * connector, which is why this file's job is narrower and harder to fake: it
 * pins the sentences character by character against the copies taken from the
 * pre-slice `connector.ts` (`git show origin/dev:connectors/telegram/
 * connector.ts`), so a future edit that "tidies" one of them has to change a
 * literal here rather than pass a looser `toContain`.
 */

/** A 1×1 PNG — real bytes, because `loadImage` sniffs the header rather than trusting a name. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function vaultWith(files: Record<string, Buffer> = {}): { root: string } {
  const root = mkdtempSync(join(tmpdir(), 'muffin-ingest-'));
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(root, name), bytes);
  return { root };
}

const noIndex = (): NonNullable<IngestDeps['vault']> => ({
  root: vaultWith().root,
  reindexPath: async () => ({ skipped: [], documents: [] }),
});

describe('senza vault, lo dice invece di fingere', () => {
  it('la riga è quella e non un paraphrase', async () => {
    const arrival = await ingestAttachment({}, async () => ({ vaultPath: 'x', bytes: 1 }), 'host', 0);
    expect(arrival.line).toBe('[allegato ricevuto ma il vault non è configurato]');
    expect(arrival.image).toBeUndefined();
  });

  it('e non prova nemmeno a scaricare: il download non viene chiamato', async () => {
    let chiamato = 0;
    await ingestAttachment(
      {},
      async () => {
        chiamato++;
        return { vaultPath: 'x', bytes: 1 };
      },
      'host',
      0,
    );
    expect(chiamato).toBe(0);
  });
});

describe('un download che fallisce non fa fallire il turno', () => {
  it('la riga porta la causa e l istruzione di non inventare', async () => {
    const righe: string[] = [];
    const arrival = await ingestAttachment(
      { vault: noIndex(), log: (l) => righe.push(l) },
      async () => {
        throw new Error('413 troppo grosso');
      },
      'host',
      0,
    );
    expect(arrival.line).toBe('[allegato NON ricevuto: 413 troppo grosso. Dillo, non fingere di averlo.]');
    // §4 invariante 11: nessun nome di piattaforma qui dentro — il prefisso lo
    // mette la porta al chiamante.
    expect(righe).toEqual(['allegato non scaricato — 413 troppo grosso']);
  });
});

describe('i byte decidono, non il nome del file', () => {
  it('un `documento` che è in realtà un PNG torna come immagine, coi byte', async () => {
    const vault = vaultWith({ 'foto.dat': PNG });
    const arrival = await ingestAttachment(
      {
        vault: {
          root: vault.root,
          reindexPath: async () => ({ skipped: [{ path: 'foto.dat', why: 'nessun estrattore' }], documents: [] }),
        },
      },
      async () => ({ vaultPath: 'foto.dat', bytes: 2048 }),
      'host',
      0,
    );
    expect(arrival.line).toBe(
      '[immagine ricevuta: `foto.dat` (2KB) — te la sto mostrando in questo messaggio]',
    );
    expect(arrival.image).toBeDefined();
  });

  it('byte che non sono né immagine né audio dicono perché non sono indicizzati', async () => {
    const vault = vaultWith({ 'strano.bin': Buffer.from([0, 1, 2, 3]) });
    const arrival = await ingestAttachment(
      {
        vault: {
          root: vault.root,
          reindexPath: async () => ({ skipped: [{ path: 'strano.bin', why: 'nessun estrattore' }], documents: [] }),
        },
      },
      async () => ({ vaultPath: 'strano.bin', bytes: 1024 }),
      'host',
      0,
    );
    expect(arrival.line).toBe('[ricevuto `strano.bin` (1KB) ma non indicizzato: nessun estrattore]');
  });
});

describe('un documento indicizzato consegna la vista compatta, non un riassunto', () => {
  it('la riga è l etichetta più l outline che il vault ha costruito', async () => {
    const arrival = await ingestAttachment(
      {
        vault: {
          root: vaultWith().root,
          reindexPath: async () => ({ skipped: [], documents: [{ path: 'affitto.pdf', outline: 'p1\np2' }] }),
        },
      },
      async () => ({ vaultPath: 'affitto.pdf', bytes: 5000 }),
      'host',
      0,
    );
    expect(arrival.line).toBe('[documento acquisito]\np1\np2');
  });

  it('e senza né skip né documento la riga dice comunque dove sono finiti i byte', async () => {
    const arrival = await ingestAttachment(
      {
        vault: { root: vaultWith().root, reindexPath: async () => ({ skipped: [], documents: [] }) },
      },
      async () => ({ vaultPath: 'nota.txt', bytes: 3072 }),
      'host',
      0,
    );
    expect(arrival.line).toBe('[ricevuto e indicizzato: `nota.txt`, 3KB]');
  });
});

describe('il tier del mittente viaggia coi byte', () => {
  it('è quello che arriva a `reindexPath`, non un default di superficie', async () => {
    const visti: { tenant: string; tier: number }[] = [];
    await ingestAttachment(
      {
        vault: {
          root: vaultWith().root,
          reindexPath: async (tenantId, _path, tier) => {
            visti.push({ tenant: tenantId, tier });
            return { skipped: [], documents: [] };
          },
        },
      },
      async () => ({ vaultPath: 'a.txt', bytes: 1 }),
      'group:telegram:-100',
      2,
    );
    expect(visti).toEqual([{ tenant: 'group:telegram:-100', tier: 2 }]);
  });
});
