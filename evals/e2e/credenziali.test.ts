import { describe, expect, it } from 'vitest';
import { type Installazione, risolviCredenziali } from './credenziali.js';

/**
 * Il 04/09/2026 questo banco ha chiesto all'owner tre segreti mentre due erano
 * già sul suo disco — la chiave del modello in `provider.apiKeyRef` e la sua
 * user id in `surfaces.telegram.ownerUserId` — e gli ha proposto un `.env` a
 * un'installazione che ha un vault. Ogni caso qui sotto è quel giorno.
 */

const installato: Installazione = {
  apiKey: 'sk-dal-vault',
  ownerId: 42,
  tokenDedicato: '',
  tokenInstallato: 'bot-installato',
  gatewayVivo: false,
};

const chiedeAncora = (m: readonly string[], parte: string): boolean => m.some((r) => r.includes(parte));

describe('le credenziali dell e2e', () => {
  it("non chiede ciò che l'installazione ha già", () => {
    const esito = risolviCredenziali({}, installato);
    expect(esito.ok).toBe(true);
    if (!esito.ok) return;
    expect(esito.credenziali).toEqual({ apiKey: 'sk-dal-vault', token: 'bot-installato', ownerId: 42 });
  });

  it("l'ambiente vince: una corsa può puntare altrove senza toccare la config", () => {
    const esito = risolviCredenziali(
      { apiKey: 'sk-env', token: 'bot-env', ownerId: '7' },
      installato,
    );
    expect(esito.ok).toBe(true);
    if (!esito.ok) return;
    expect(esito.credenziali).toEqual({ apiKey: 'sk-env', token: 'bot-env', ownerId: 7 });
  });

  it('un bot dedicato batte quello installato', () => {
    const esito = risolviCredenziali({}, { ...installato, tokenDedicato: 'bot-e2e' });
    expect(esito.ok).toBe(true);
    if (!esito.ok) return;
    expect(esito.credenziali.token).toBe('bot-e2e');
  });

  it('con un gateway vivo sullo stesso bot si ferma, e dice quale comando', () => {
    const esito = risolviCredenziali({}, { ...installato, gatewayVivo: true });
    expect(esito.ok).toBe(false);
    if (esito.ok) return;
    expect(chiedeAncora(esito.motivi, 'muffin gateway stop')).toBe(true);
    expect(chiedeAncora(esito.motivi, '409')).toBe(true);
  });

  it('un bot dedicato toglie il conflitto anche a gateway vivo', () => {
    const esito = risolviCredenziali({}, { ...installato, tokenDedicato: 'bot-e2e', gatewayVivo: true });
    expect(esito.ok).toBe(true);
  });

  it('a installazione muta chiede tutte e tre le cose, ognuna con le sue due strade', () => {
    const esito = risolviCredenziali(
      {},
      { apiKey: '', ownerId: 0, tokenDedicato: '', tokenInstallato: '', gatewayVivo: false },
    );
    expect(esito.ok).toBe(false);
    if (esito.ok) return;
    expect(esito.motivi).toHaveLength(3);
    expect(chiedeAncora(esito.motivi, 'provider.apiKeyRef')).toBe(true);
    expect(chiedeAncora(esito.motivi, 'muffin secret set e2e_telegram_token')).toBe(true);
    expect(chiedeAncora(esito.motivi, 'surfaces.telegram.ownerUserId')).toBe(true);
  });
});
