import { describe, expect, it } from 'vitest';
import { buildEndpointsUrl, parseEndpointTags } from './endpoints.js';

/**
 * Il formato degli endpoint è un contratto con un server, non una nostra
 * scelta: questi test tengono la direzione di guasto — verso `null`
 * (sconosciuto), mai verso un insieme che accusa i pin di non servire.
 */

describe('buildEndpointsUrl', () => {
  it('indirizza autore/slug sotto baseUrl', () => {
    expect(buildEndpointsUrl('https://openrouter.ai/api/v1', 'google/gemma-4-31b-it')).toBe(
      'https://openrouter.ai/api/v1/models/google/gemma-4-31b-it/endpoints',
    );
  });

  it('null quando non si può indirizzare: slug senza autore, vuoto, base con slash', () => {
    expect(buildEndpointsUrl('https://openrouter.ai/api/v1/', 'google/gemma-4-31b-it')).toContain('/models/google/');
    expect(buildEndpointsUrl('https://x/v1', 'llama3')).toBeNull();
    expect(buildEndpointsUrl('https://x/v1', '/slug')).toBeNull();
    expect(buildEndpointsUrl('https://x/v1', 'a/b/c')).toBeNull();
  });
});

describe('parseEndpointTags', () => {
  it('legge tag e nomi, minuscoli e senza doppioni', () => {
    expect(
      parseEndpointTags({
        data: { endpoints: [{ tag: 'Google', provider_name: 'Google' }, { tag: 'alibaba', provider_name: 'Alibaba' }] },
      }),
    ).toEqual(['google', 'alibaba']);
  });

  it('null su tutto ciò che non è la forma: non-oggetto, senza endpoints, vuoto', () => {
    expect(parseEndpointTags(null)).toBeNull();
    expect(parseEndpointTags({})).toBeNull();
    expect(parseEndpointTags({ data: {} })).toBeNull();
    expect(parseEndpointTags({ data: { endpoints: [] } })).toBeNull();
    expect(parseEndpointTags({ data: { endpoints: [{ foo: 1 }] } })).toBeNull();
    // La forma del catalogo /models scambiata per endpoint: non è evidenza.
    expect(parseEndpointTags({ data: [{ id: 'x' }] })).toBeNull();
  });
});
