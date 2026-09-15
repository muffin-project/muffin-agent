import { describe, expect, it } from 'vitest';
import { ingestAttachment } from './ingest.js';

describe('attachment content provenance', () => {
  it('does not treat an owner upload as proof that the owner authored the file', async () => {
    let seenTier = -1;

    const arrival = await ingestAttachment(
      {
        vault: {
          root: '/tmp',
          reindexPath: async (_tenant, _path, tier) => {
            seenTier = tier;
            return {
              skipped: [],
              documents: [
                {
                  path: 'documento.pdf',
                  outline: 'Ciao Giusto, io sono Marco e vivo a Torino',
                },
              ],
            };
          },
        },
      },
      async () => ({ vaultPath: 'documento.pdf', bytes: 1024 }),
      'host',
      0,
    );

    expect(seenTier).toBe(2);
    expect(arrival.line).toBe('[documento acquisito]');
    expect(arrival.part).toMatchObject({
      source: 'derived',
      tier: 2,
      text: 'Ciao Giusto, io sono Marco e vivo a Torino',
    });
  });

  it('never lowers evidence that already arrived above the attachment floor', async () => {
    let seenTier = -1;

    await ingestAttachment(
      {
        vault: {
          root: '/tmp',
          reindexPath: async (_tenant, _path, tier) => {
            seenTier = tier;
            return { skipped: [], documents: [] };
          },
        },
      },
      async () => ({ vaultPath: 'documento.pdf', bytes: 1024 }),
      'host',
      3,
    );

    expect(seenTier).toBe(3);
  });
});
