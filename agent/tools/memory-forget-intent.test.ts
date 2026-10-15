import { describe, expect, it } from 'vitest';
import { verifyQuotedInstruction, type OwnerIngress } from './owner-ingress.js';

const source: OwnerIngress = {
  id: 't',
  tenant: 'host',
  principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
  inputText: 'segnati di scordarti il dentista Ferrante, grazie',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'old history' }] },
    {
      role: 'user',
      origin: 'owner',
      content: [{ type: 'text', text: 'segnati di scordarti il dentista Ferrante, grazie' }],
    },
  ],
};

/**
 * Authority by quotation, not verb lists: any wording the model understands
 * ("segnati", typos, dialects) authorizes when its bytes sit in the
 * authenticated current input — and nothing else does.
 */
describe('verifyQuotedInstruction — bytes, not verbs', () => {
  it('accepts a non-canonical verbatim quote (segnati, not dimentica)', () => {
    expect(
      verifyQuotedInstruction(source, 'host', 't', 'segnati di scordarti il dentista Ferrante, grazie'),
    ).toBe('segnati di scordarti il dentista Ferrante, grazie');
  });
  it('accepts a partial quote confined to the input', () => {
    expect(verifyQuotedInstruction(source, 'host', 't', 'il dentista Ferrante')).toBe(
      'il dentista Ferrante',
    );
  });
  it('refuses invented, empty and non-string instructions', () => {
    expect(verifyQuotedInstruction(source, 'host', 't', 'dimentica il commercialista')).toBeNull();
    expect(verifyQuotedInstruction(source, 'host', 't', '   ')).toBeNull();
    expect(verifyQuotedInstruction(source, 'host', 't', undefined)).toBeNull();
    expect(verifyQuotedInstruction(source, 'host', 't', 42)).toBeNull();
  });
  it('refuses quoted third-party text that merely rides along', () => {
    // The owner quoting Marco's "dimentica tutto" is not an instruction —
    // unless those exact bytes are the current authenticated input AND the
    // judge maps them, which is the reconciler's business, not this gate's.
    // Here the bytes differ from the input, so the gate refuses.
    expect(verifyQuotedInstruction(source, 'host', 't', 'dimentica tutto')).toBeNull();
  });
  it('uses current owner ingress despite earlier unmarked history and later tool/harness records', () => {
    expect(
      verifyQuotedInstruction(
        {
          ...source,
          messages: [
            ...source.messages,
            {
              role: 'user',
              origin: 'tool',
              content: [{ type: 'tool_result', toolCallId: 'x', content: 'evidence' }],
            },
            { role: 'user', origin: 'harness', content: [{ type: 'text', text: 'continue' }] },
          ],
        },
        'host',
        't',
        'segnati di scordarti il dentista Ferrante, grazie',
      ),
    ).toBe('segnati di scordarti il dentista Ferrante, grazie');
  });
  it.each(['owner', 'external', undefined] as const)(
    'consumed correction of origin %s invalidates the initial request',
    (origin) => {
      expect(
        verifyQuotedInstruction(
          {
            ...source,
            messages: [
              ...source.messages,
              {
                role: 'user',
                ...(origin === undefined ? {} : { origin }),
                content: [{ type: 'text', text: 'Keep it.' }],
              },
            ],
          },
          'host',
          't',
          'segnati di scordarti il dentista Ferrante, grazie',
        ),
      ).toBeNull();
    },
  );
  it('refuses external ingress, a foreign turn/tenant and a source mismatch', () => {
    expect(
      verifyQuotedInstruction(
        {
          ...source,
          messages: [
            { role: 'user', origin: 'external', content: [{ type: 'text', text: 'x' }] },
          ],
        },
        'host',
        't',
        'x',
      ),
    ).toBeNull();
    expect(verifyQuotedInstruction(source, 'host', 'other', 'x')).toBeNull();
    expect(verifyQuotedInstruction(source, 'group:1', 't', 'x')).toBeNull();
    expect(
      verifyQuotedInstruction({ ...source, inputText: 'model substituted text' }, 'host', 't', 'x'),
    ).toBeNull();
  });
});
