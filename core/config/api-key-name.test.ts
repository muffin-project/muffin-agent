import { describe, expect, it } from 'vitest';
import { ALL_API_KEY_NAMES, LEGACY_API_KEY_NAME, apiKeyCandidates, apiKeyNameFor } from './providers.js';

/**
 * `provider_api_key` non dice quale provider. Con un catalogo in albero
 * (`core/config/providers.ts`) il nome diventa attivamente sbagliato il giorno
 * che i provider sono due: la stessa installazione avrebbe due chiavi e un nome
 * solo per descriverle.
 *
 * Ma **non è un rename secco e non può esserlo.** `config.provider.apiKeyRef`
 * punta al nome vecchio su ogni installazione già fatta: cambiarlo senza
 * leggere anche il vecchio spegne l'installazione al primo `update`. Questi
 * test guardano la migrazione, non il nome.
 */
describe('come si chiama la chiave', () => {
  it('un provider del catalogo dà il proprio nome', () => {
    expect(apiKeyNameFor({ kind: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1' })).toBe('openrouter_api_key');
  });

  /**
   * Fuori dal catalogo — un Ollama locale, un vLLM, l'API nativa di Anthropic —
   * non c'è un nome migliore da dare, e il generico resta quello giusto: è
   * letteralmente ciò che descrive.
   */
  it('fuori dal catalogo il generico non è un ripiego, è il nome giusto', () => {
    expect(apiKeyNameFor({ kind: 'anthropic' })).toBe(LEGACY_API_KEY_NAME);
    expect(apiKeyNameFor({ kind: 'openai-compat', baseUrl: 'http://localhost:11434/v1' })).toBe(LEGACY_API_KEY_NAME);
  });

  /**
   * L'ordine **è** la migrazione: prima il nome del provider, poi il generico.
   * Un'installazione vecchia trova solo il secondo e continua a funzionare
   * senza che nessuno tocchi niente.
   */
  it("i candidati mettono il nome del provider davanti a quello vecchio", () => {
    expect(apiKeyCandidates({ kind: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1' })).toEqual([
      'openrouter_api_key',
      LEGACY_API_KEY_NAME,
    ]);
  });

  /** E non lo cerca due volte quando i due nomi coincidono. */
  it('fuori dal catalogo il generico compare una volta sola', () => {
    expect(apiKeyCandidates({ kind: 'anthropic' })).toEqual([LEGACY_API_KEY_NAME]);
  });

  /**
   * `ALL_API_KEY_NAMES` serve a chi cerca **senza sapere ancora quale provider
   * sia**: la guardia su `MUFFIN_API_KEY` gira prima che esista un
   * `config.json`, e `muffin uninstall` deve nominare ogni copia persistente
   * che sopravvive alla cancellazione. Se un provider nuovo entra nel catalogo
   * senza finire qui, la sua chiave diventa invisibile a entrambi.
   */
  it('la lista completa contiene ogni nome del catalogo, più il vecchio', () => {
    expect(ALL_API_KEY_NAMES).toContain('openrouter_api_key');
    expect(ALL_API_KEY_NAMES).toContain(LEGACY_API_KEY_NAME);
    expect(new Set(ALL_API_KEY_NAMES).size).toBe(ALL_API_KEY_NAMES.length);
  });
});
