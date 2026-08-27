/**
 * I provider da cui si sceglie un modello.
 *
 * Oggi ce n'è **uno**, e il file esiste lo stesso: «provider» era un concetto
 * sparso in tre posti che non si parlavano — `config.provider.kind` (come si
 * parla), `config.provider.baseUrl` (con chi), e una manciata di
 * `includes('openrouter')` in `cli/onboarding.ts` e nei runner degli eval (dove
 * si prendono le chiavi, quali modelli proporre). Scegliere un modello ha
 * bisogno di una quarta cosa che non stava da nessuna parte — **dove sta il
 * catalogo** — e a quel punto la domanda «chi è il provider di questa
 * installazione» ha smesso di poter restare implicita.
 *
 * Una voce sola non è un'astrazione prematura: è la forma che rende il secondo
 * provider un'**aggiunta di dati** invece di una riscrittura. La prova che
 * serviva è già in albero: `speaksReasoningEffort` e `wantsExplicitCache`
 * (`agent/providers/openai-compat.ts`) decidono la forma della richiesta
 * guardando l'hostname, ognuna per conto suo, perché non c'era un posto dove
 * dire «questo endpoint è OpenRouter e queste sono le cose che sa fare».
 *
 * Quello che **non** c'è qui, deliberatamente: i prezzi. Stanno in
 * `core/budget/pricing.ts`, hardcoded e datati, per la ragione scritta nella
 * sua intestazione — un valore di tuning che vive nell'ambiente è un valore che
 * differisce fra il portatile e il server. Il catalogo di rete serve a
 * **confrontarsi** con quella tabella e a dire quando sbaglia, non a
 * sostituirla: un prezzo preso al volo da un endpoint è un tetto di spesa che
 * cambia senza un diff.
 */

/** Gli id dei provider conosciuti. Un `enum` di stringhe, così un id sconosciuto in config non passa lo schema. */
export type ProviderId = 'openrouter';

export type ProviderEntry = {
  id: ProviderId;
  /** Come si chiama parlando con l'owner. */
  label: string;
  /** Quale adapter lo serve — lo stesso vocabolario di `config.provider.kind`. */
  kind: 'openai-compat' | 'anthropic';
  baseUrl: string;
  /** Dove l'owner va a prendersi una chiave, quando gliene serve una. */
  keysUrl: string;
  /**
   * Il catalogo dei modelli, relativo a `baseUrl`.
   *
   * `undefined` per un provider che non ne espone uno: allora `muffin model`
   * non può validare uno slug e lo dice, invece di far finta di averlo fatto.
   */
  modelsPath?: string;
  /**
   * Se il catalogo va interrogato con la chiave.
   *
   * Su OpenRouter no — verificato il 27/08/2026: `GET
   * https://openrouter.ai/api/v1/models` risponde 200 senza `Authorization`,
   * 417 modelli, `{data, total_count, links}`. Vale la pena che sia un campo e
   * non un'assunzione: un provider che invece la pretende fallirebbe con un 401
   * che non dice niente sul perché.
   */
  catalogueNeedsKey: boolean;
};

export const PROVIDERS: Readonly<Record<ProviderId, ProviderEntry>> = {
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai-compat',
    baseUrl: 'https://openrouter.ai/api/v1',
    keysUrl: 'https://openrouter.ai/keys',
    modelsPath: '/models',
    catalogueNeedsKey: false,
  },
};

/**
 * L'hostname di un URL, minuscolo, o `null` se non è un URL.
 *
 * Confronto per **hostname e non per sottostringa**, che è la stessa regola —
 * e la stessa ragione — di `wantsExplicitCache` in
 * `agent/providers/openai-compat.ts`: `openrouter.ai.evil.tld` contiene
 * «openrouter» e non è OpenRouter. Il punto finale viene tolto perché
 * `https://openrouter.ai./api/v1` è lo stesso endpoint.
 */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

/**
 * Quale provider del catalogo è quello di questa installazione — dedotto
 * dall'endpoint, non richiesto in config.
 *
 * Dedurre invece di aggiungere un campo obbligatorio è la scelta che evita una
 * migrazione: ogni `config.json` già scritto continua a valere, e non esiste il
 * caso in cui `provider.id` dica una cosa e `provider.baseUrl` ne faccia
 * un'altra. Quando arriverà un secondo provider con lo stesso hostname di uno
 * esistente — non succede — sarà quello il momento di un campo esplicito.
 *
 * `null` significa un endpoint che non è nel catalogo: un Ollama locale, un
 * vLLM, l'API nativa di Anthropic. Non è un errore ed è il motivo per cui
 * questa funzione non lancia — è la condizione normale di metà delle
 * installazioni che questo repo dichiara di supportare.
 */
export function providerFor(provider: { kind: string; baseUrl?: string | undefined }): ProviderEntry | null {
  if (provider.baseUrl === undefined) {
    // Nessun `baseUrl` = l'endpoint di default dell'adapter. Per `anthropic` è
    // l'API nativa, che nel catalogo non c'è; per `openai-compat` non esiste un
    // default sensato e `buildRuntime` lo passa comunque.
    return null;
  }
  const host = hostOf(provider.baseUrl);
  if (host === null) return null;
  for (const entry of Object.values(PROVIDERS)) {
    if (hostOf(entry.baseUrl) === host && entry.kind === provider.kind) return entry;
  }
  return null;
}
