import { describe, expect, it } from 'vitest';
import { branchDichiaratiVivi, prDichiarateVive, riconcilia, righeLogiche } from './riconcilia.mjs';

const lavoro = `# Lavoro corrente

- **#81 \`slice/docs-authority\` — FAST, draft.** Refactor docs.
- **#78 \`slice/inbound-unit\` — CRITICAL, open.** Exactly once.
- **#73 \`slice/product-open-source-direction\` — merged.** Assorbita altrove.

Cronaca: ieri sono entrate #60 e #61.
`;

describe('riconcilia operational handoff', () => {
  it('keeps wrapped markdown bullets as logical lines', () => {
    const righe = righeLogiche('- **#81 `slice/docs-authority` — draft.** Riga\n  continuata qui.\n');
    expect(righe.join('\n')).toContain('Riga continuata qui.');
  });

  it('extracts only PRs and branches explicitly described as live', () => {
    expect(prDichiarateVive(lavoro)).toEqual([78, 81]);
    expect(branchDichiaratiVivi(lavoro)).toEqual([
      'slice/docs-authority',
      'slice/inbound-unit',
    ]);
  });

  it('is quiet when live declarations match Git/GitHub', () => {
    expect(
      riconcilia({
        testo: lavoro,
        statoPr: {
          78: { state: 'OPEN', headRefName: 'slice/inbound-unit' },
          81: { state: 'OPEN', headRefName: 'slice/docs-authority' },
        },
        branchRemoti: ['slice/docs-authority'],
        branchLocali: ['slice/inbound-unit'],
      }),
    ).toEqual([]);
  });

  it('reports a PR that is already merged but still called live', () => {
    const reperti = riconcilia({
      testo: lavoro,
      statoPr: {
        78: { state: 'MERGED', headRefName: 'slice/inbound-unit' },
        81: { state: 'OPEN', headRefName: 'slice/docs-authority' },
      },
      branchRemoti: ['slice/docs-authority', 'slice/inbound-unit'],
      branchLocali: [],
    });
    expect(reperti.join('\n')).toMatch(/#78 è mergiata/);
  });

  it('reports a live branch that disappeared everywhere', () => {
    const reperti = riconcilia({
      testo: lavoro,
      statoPr: {
        78: { state: 'OPEN', headRefName: 'slice/inbound-unit' },
        81: { state: 'OPEN', headRefName: 'slice/docs-authority' },
      },
      branchRemoti: ['slice/docs-authority'],
      branchLocali: [],
    });
    expect(reperti.join('\n')).toMatch(/slice\/inbound-unit.*non esiste/);
  });

  it('does not treat historical PR references as live work', () => {
    const testo = '# Lavoro\n\nCronaca: merged #12. In passato #13 era open.\n';
    expect(prDichiarateVive(testo)).toEqual([]);
    expect(branchDichiaratiVivi(testo)).toEqual([]);
  });
});
