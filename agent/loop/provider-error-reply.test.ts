import { describe, expect, it } from 'vitest';
import { ProviderError } from '../providers/types.js';
import { providerErrorReply } from './provider-error-reply.js';

describe('safe provider error replies', () => {
  it('reports a numeric HTTP status without echoing upstream text', () => {
    const reply = providerErrorReply(
      new ProviderError('secret gateway payload', true, 502, 'transport'),
    );
    expect(reply).toContain('HTTP 502');
    expect(reply).not.toContain('secret gateway payload');
  });

  it('handles a connection failure without status', () => {
    expect(
      providerErrorReply(
        new ProviderError('private connection detail', true, undefined, 'transport'),
      ),
    ).toBe('Non sono riuscito a contattare il provider. Riprova tra poco.');
  });

  it('does not imply a transport failure for invalid model output', () => {
    const reply = providerErrorReply(
      new ProviderError('private malformed response', false, 400, 'output'),
    );
    expect(reply).toContain('risposta non valida');
    expect(reply).not.toContain('400');
    expect(reply).not.toContain('private malformed response');
  });
});
