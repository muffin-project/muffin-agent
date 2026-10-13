import { describe, expect, it } from 'vitest';
import { type ForgetSource, ownerForgetRequest } from './memory-forget-intent.js';

const request = 'Dimentica il dentista Ferrante';
const source: ForgetSource = {
  id: 't',
  tenant: 'host',
  principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
  inputText: request,
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'old history' }] },
    { role: 'user', origin: 'owner', content: [{ type: 'text', text: request }] },
  ],
};
describe('forget intent is current authenticated ingress, not model narration', () => {
  it('uses current owner ingress despite earlier unmarked history and later tool/harness records', () => {
    expect(
      ownerForgetRequest(
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
      ),
    ).toBe(request);
  });
  it.each(['owner', 'external', undefined] as const)(
    'consumed correction of origin %s invalidates the initial request',
    (origin) => {
      expect(
        ownerForgetRequest(
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
        ),
      ).toBeNull();
    },
  );
  it('refuses external ingress, a foreign turn/tenant and a source mismatch', () => {
    expect(
      ownerForgetRequest(
        {
          ...source,
          messages: [
            { role: 'user', origin: 'external', content: [{ type: 'text', text: request }] },
          ],
        },
        'host',
        't',
      ),
    ).toBeNull();
    expect(ownerForgetRequest(source, 'host', 'other')).toBeNull();
    expect(ownerForgetRequest(source, 'group:1', 't')).toBeNull();
    expect(
      ownerForgetRequest({ ...source, inputText: 'model substituted text' }, 'host', 't'),
    ).toBeNull();
  });
});
