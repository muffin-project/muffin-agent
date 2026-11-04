import { createHash } from 'node:crypto';
import {
  discoverOpenAICompatModels,
  type ModelDiscovery,
} from '../agent/providers/models-discovery.js';
import { verifyInferenceRoute } from '../agent/providers/verify.js';
import { isOpenRouterFreeRoute, priceOf } from '../core/budget/pricing.js';
import { ChatGPTConnection } from '../core/config/chatgpt-oauth.js';
import {
  type Config,
  type InferenceLane,
  type InferenceProviderConfig,
  inferenceProvider,
  loadConfig,
  readSecret,
  saveConfig,
  withInferenceProvider,
  writeAuthoritativeSecret,
} from '../core/config/config.js';
import { buildEndpointsUrl, parseEndpointTags } from '../core/config/endpoints.js';
import { type EndpointEvidence, resolveModelSwitch } from '../core/config/model-resolve.js';
import { PROVIDERS, type ProviderEntry, providerFor } from '../core/config/providers.js';
import { askGateway } from '../core/gateway/control-socket.js';
import { makeEmbedder } from '../core/memory/embed.js';
import { openChatGPTBrowser } from './chatgpt-browser.js';
import { promptLine, promptSecret } from './prompt.js';

/**
 * `muffin model` — scegliere un modello, e sapere cosa costa prima di sceglierlo.
 *
 * **Non è un comando che scrive un JSON.** Quello lo sa fare un editor. Questo
 * fa le due cose che un editor non può fare: chiede al provider se lo slug
 * esiste — un refuso altrimenti si scopre al primo 404, cioè al primo turno
 * dopo — e confronta il prezzo vero del catalogo con quello con cui
 * `core/budget/pricing.ts` fattura davvero.
 *
 * Quel secondo confronto è la ragione per cui il comando vale la pena. La
 * tabella dei prezzi fa match **per sottostringa di famiglia**; il passaggio del
 * 04/09 l'ha riallineata verso il ceiling conservativo delle famiglie
 * open-weight proprio perché prima sottostimava diversi host reali. Il catalogo
 * vivo resta utile per contraddire quella tabella quando cambia di nuovo.
 *
 * Perché allora non prendere il prezzo dal catalogo e basta? Perché sarebbe un
 * tetto di spesa che cambia senza un diff, e `pricing.ts` è hardcoded per
 * scelta dichiarata. Il catalogo serve a **contraddire** la tabella e a farlo
 * vedere, non a sostituirla.
 *
 * Un router è una terza forma che il vecchio output non nominava: lo slug
 * configurato (`openrouter/free`) può non essere il modello che il provider
 * restituisce (`qwen/...`). Il primo è la richiesta/contratto, il secondo è
 * ciò che ha realmente servito il turno. Il comando mostra quindi esplicitamente
 * quando una corsia è un router gratuito invece di far sembrare che Qwen abbia
 * sostituito di nascosto la configurazione.
 */

/** Le tre corsie che un'installazione ha, e che fino a oggi si cambiavano solo a mano. */
type Lane = 'main' | 'light' | 'embed';

export type CatalogueModel = { id: string; inputPerMTok: number; outputPerMTok: number };

class CatalogueRedirectError extends Error {
  constructor(provider: string, status: number) {
    super(`catalogo di ${provider}: redirect HTTP ${status} rifiutato`);
    this.name = 'CatalogueRedirectError';
  }
}

/**
 * Il catalogo del provider.
 *
 * Verificato sul vivo il 2026-08-27: `GET https://openrouter.ai/api/v1/models`
 * risponde 200 **senza `Authorization`**, `{data, total_count, links}`, 417
 * modelli, e `pricing.prompt`/`pricing.completion` sono stringhe in USD **per
 * token** — non per milione. La moltiplicazione per 1e6 è qui e non altrove
 * perché è l'unico punto in cui quel formato entra nel programma.
 *
 * `fetchImpl` iniettabile: un test che chiede un modello non deve toccare la
 * rete, e un `muffin model` offline deve poter dire «non ho potuto verificare»
 * invece di sembrare rotto.
 */
export async function fetchCatalogue(
  entry: ProviderEntry,
  apiKey: string | undefined,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<CatalogueModel[]> {
  if (entry.modelsPath === undefined)
    throw new Error(`${entry.label} non espone un catalogo dei modelli`);
  const out: CatalogueModel[] = [];
  let afterId: string | undefined;
  // Anthropic paginates its native catalog with after_id/has_more. Keep the
  // request bounded even if a broken endpoint keeps returning has_more.
  for (let page = 0; page < 10; page += 1) {
    const url = new URL(`${entry.baseUrl}${entry.modelsPath}`);
    if (entry.kind === 'anthropic') {
      url.searchParams.set('limit', '1000');
      if (afterId !== undefined) url.searchParams.set('after_id', afterId);
    }
    const headers: Record<string, string> = {};
    if (entry.catalogueNeedsKey && apiKey !== undefined) {
      if (entry.kind === 'anthropic') {
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
      } else {
        headers.Authorization = `Bearer ${apiKey}`;
      }
    }
    const res = await fetchImpl(url, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
    if (res.status >= 300 && res.status < 400)
      throw new CatalogueRedirectError(entry.label, res.status);
    if (!res.ok) throw new Error(`catalogo di ${entry.label}: HTTP ${res.status}`);
    const body = (await res.json()) as {
      data?: { id?: unknown; pricing?: { prompt?: unknown; completion?: unknown } }[];
      has_more?: boolean;
    };
    for (const m of body.data ?? []) {
      if (typeof m.id !== 'string') continue;
      const inp = Number(m.pricing?.prompt);
      const outp = Number(m.pricing?.completion);
      // An absent price is unknown, never free. Anthropic's native catalog
      // does not publish pricing on this endpoint.
      out.push({
        id: m.id,
        inputPerMTok: Number.isFinite(inp) ? inp * 1e6 : Number.NaN,
        outputPerMTok: Number.isFinite(outp) ? outp * 1e6 : Number.NaN,
      });
    }
    const lastId = body.data?.at(-1)?.id;
    if (entry.kind !== 'anthropic' || body.has_more !== true || typeof lastId !== 'string') break;
    afterId = lastId;
  }
  return out;
}

const usd = (n: number): string => (Number.isFinite(n) ? `$${Number(n.toFixed(4))}` : '?');

/**
 * Gli slug dei provider che servono un modello, o `null` quando non lo si sa.
 *
 * `GET {baseUrl}/models/:author/:slug/endpoints` (autenticato: la risposta
 * varia per chiave) → `data.endpoints[]` con `tag` (lo slug usato in
 * `provider.routing`) e `provider_name` (il nome display). Si raccolgono
 * entrambi, minuscoli; se non se ne ricava nessuno si restituisce `null` —
 * un insieme vuoto fabbricherebbe la prova che nessun pin serve il modello,
 * e il resolver cancellerebbe un routing sano.
 *
 * `fetchImpl` iniettabile come il catalogo: stesso motivo, stessa forma.
 */
export async function fetchEndpointTags(
  entry: ProviderEntry,
  model: string,
  apiKey: string | undefined,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string[] | null> {
  const url = buildEndpointsUrl(entry.baseUrl, model);
  if (url === null) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetchImpl(url, {
      headers: {
        accept: 'application/json',
        ...(apiKey === undefined ? {} : { Authorization: `Bearer ${apiKey}` }),
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return parseEndpointTags(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** L'evidenza che il resolver vuole, o `null` quando non la si è potuta costruire. */
async function endpointEvidence(
  entry: ProviderEntry,
  slug: string,
  apiKey: string | undefined,
  fetchImpl: typeof globalThis.fetch | undefined,
): Promise<EndpointEvidence> {
  // Endpoint-specific routing evidence is an OpenRouter catalog contract; a
  // similarly shaped URL on a native provider would be fabricated evidence.
  if (entry.id !== 'openrouter') return null;
  const tags = await fetchEndpointTags(entry, slug, apiKey, fetchImpl ?? globalThis.fetch);
  if (tags === null) return null;
  const set = new Set(tags);
  return { serves: (pin) => set.has(pin.toLowerCase()) };
}

/**
 * Cosa dire del divario fra il prezzo del catalogo e quello con cui si fattura.
 *
 * Pura, perché è l'unica parte che vale la pena provare senza rete. Nomina solo
 * la **sottostima**: sovrastimare fa scattare il tetto presto, che
 * l'intestazione di `pricing.ts` chiama esplicitamente la direzione sicura, e
 * un avviso per ogni scarto trasformerebbe il segnale che conta in rumore.
 */
export function priceNote(reale: CatalogueModel, baseUrl: string | undefined): string | null {
  const fatturato = priceOf(reale.id, baseUrl);
  if (fatturato === null) return null; // modello locale: non si fattura, e `priceOf` lo dice con `null`
  if (!Number.isFinite(reale.inputPerMTok) || !Number.isFinite(reale.outputPerMTok)) return null;
  const sottostima =
    reale.inputPerMTok > fatturato.inputPerMTok || reale.outputPerMTok > fatturato.outputPerMTok;
  if (!sottostima) return null;
  return (
    `⚠ costa ${usd(reale.inputPerMTok)}/${usd(reale.outputPerMTok)} per MTok, ma il registro lo fattura ` +
    `${usd(fatturato.inputPerMTok)}/${usd(fatturato.outputPerMTok)}: /spend sottostima e il tetto in ` +
    `rot/budgets.json scatta tardi. Correggi la famiglia in core/budget/pricing.ts.`
  );
}

/**
 * I candidati più vicini a uno slug che non esiste — perché «non esiste» da
 * solo lascia l'owner a indovinare.
 *
 * Prefisso condiviso sulla parte dopo lo `/`, non sottostringa: il refuso vero
 * è quasi sempre in coda (`claude-sonnet-9` per `claude-sonnet-5`, `qwen3.9`
 * per `qwen3.8`), e un `includes` in quel caso non trova niente proprio quando
 * servirebbe. Soglia a 6 caratteri per non proporre mezzo catalogo a chi ha
 * scritto `gpt`.
 */
function vicini(slug: string, catalogo: readonly { id: string }[]): string[] {
  const coda = (id: string): string =>
    (id.includes('/') ? id.slice(id.indexOf('/') + 1) : id).toLowerCase();
  const bersaglio = coda(slug);
  const comune = (a: string, b: string): number => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
    return i;
  };
  return catalogo
    .map((m) => ({ id: m.id, n: comune(bersaglio, coda(m.id)) }))
    .filter((c) => c.n >= 6)
    .sort((a, b) => b.n - a.n)
    .slice(0, 5)
    .map((c) => c.id);
}

export type ModelDeps = {
  out: (line: string) => void;
  fetchImpl?: typeof globalThis.fetch;
  /** Account lifecycle is read-only here; conversational callers never sign in or prompt for keys. */
  chatgpt?: Pick<ChatGPTConnection, 'listModels' | 'session' | 'signIn'>;
  verify?: typeof verifyInferenceRoute;
  ask?: (question: string) => Promise<string | undefined>;
  interactive?: boolean;
  /** Sonda l'embedder per misurarne la dimensione. Iniettabile: un test non ha un embedder acceso. */
  probe?: (config: Config, slug: string, home: string) => Promise<number>;
  /**
   * Il modello attivo del gateway, quando ce n'è uno vivo. Iniettabile: un
   * test non apre un socket. Default: domanda vera al gateway di questa home
   * (`status`, con timeout e `null` quando non risponde nessuno).
   */
  gatewayStatus?: () => Promise<GatewayStatus | null>;
};

/** Il sottoinsieme di `status` che a `muffin model` serve: chi è vivo e su cosa gira. */
export type GatewayStatus = {
  pid?: number | undefined;
  models?: { main?: string | undefined; light?: string | undefined } | undefined;
};

/**
 * Persistito contro attivo, senza ambiguità (issue #500).
 *
 * Pura: il chiamante ha già chiesto al gateway (o ha deciso di non farlo) e
 * passa ciò che sa. `null` = nessun gateway ha risposto — socket assente,
 * build vecchia che tace, timeout — mai «gateway morto», e le righe lo
 * dicono di conseguenza. Argomenti piatti perché `models` non ha la corsia
 * `embed` e indicizzarlo per `Lane` non compila né avrebbe senso.
 */
export function activationNotes(
  lane: string,
  slug: string,
  main: string,
  light: string,
  status: GatewayStatus | null,
): string[] {
  if (status === null) {
    return [`Nessun gateway vivo su questa home: ${lane} → ${slug} vale dal prossimo avvio.`];
  }
  const pid = status.pid !== undefined ? ` (pid ${status.pid})` : '';
  const active = status.models;
  if (active?.main === undefined || active?.light === undefined) {
    return [
      `Gateway vivo${pid}, di una build che non dichiara il modello: i nuovi turni applicano la config; ` +
        `verifica sul trace (gen_ai.request.model).`,
    ];
  }
  if (active.main === main && active.light === light) {
    return [
      `Gateway vivo${pid}: i nuovi turni usano già ${active.main} · ${active.light} — niente riavvio.`,
    ];
  }
  return [
    `Gateway vivo${pid} ancora su ${active.main} · ${active.light}: ` +
      `dal prossimo turno passa a ${main} · ${light}, senza riavvio. ` +
      `Un turno già in volo finisce sul vecchio.`,
  ];
}

function providerConfigFor(
  current: InferenceProviderConfig,
  id: string,
): InferenceProviderConfig | null {
  const entry = Object.values(PROVIDERS).find((candidate) => candidate.id === id);
  if (entry === undefined) return null;
  const same =
    entry.kind === current.kind &&
    (entry.kind === 'openai-chatgpt' ||
      (entry.kind === 'anthropic' &&
        (current.baseUrl === undefined ||
          canonicalEndpoint(current.baseUrl) === canonicalEndpoint(entry.baseUrl))) ||
      (entry.kind !== 'anthropic' &&
        canonicalEndpoint(current.baseUrl) === canonicalEndpoint(entry.baseUrl)));
  if (same) return { ...current, baseUrl: entry.baseUrl };
  return {
    kind: entry.kind,
    baseUrl: entry.baseUrl,
    apiKeyRef: `secret://${entry.secretName}`,
  } as InferenceProviderConfig;
}

function endpointConfigFor(
  current: InferenceProviderConfig,
  baseUrl: string,
  keyRef?: string,
): InferenceProviderConfig {
  const sameEndpoint =
    current.kind === 'openai-compat' &&
    canonicalEndpoint(current.baseUrl) === canonicalEndpoint(baseUrl);
  const generatedRef = `secret://custom_endpoint_${createHash('sha256').update(canonicalEndpoint(baseUrl)).digest('hex').slice(0, 16)}_api_key`;
  return {
    kind: 'openai-compat',
    baseUrl,
    apiKeyRef: keyRef ? `secret://${keyRef}` : sameEndpoint ? current.apiKeyRef : generatedRef,
  };
}

function canonicalEndpoint(value: string | undefined): string {
  if (!value) return '';
  const parsed = new URL(value);
  return parsed.toString().replace(/\/$/, '');
}

function providerLabel(provider: InferenceProviderConfig): string {
  if (provider.kind === 'openai-chatgpt') return PROVIDERS.chatgpt.label;
  return (
    providerFor(provider)?.label ??
    `${provider.kind} · ${provider.baseUrl ?? 'endpoint configurato'}`
  );
}

function sameLaneState(a: Config, b: Config, lane: InferenceLane): boolean {
  return (
    JSON.stringify({ provider: inferenceProvider(a, lane), model: a.models[lane] }) ===
    JSON.stringify({ provider: inferenceProvider(b, lane), model: b.models[lane] })
  );
}

/**
 * Misura la dimensione di un embedder invece di chiederla all'owner.
 *
 * `config.embedder.dimensions` è l'unico campo dello schema che la sua stessa
 * docstring dichiara senza default sensato — «è cotta nella tabella
 * vettoriale, quindi indovinarla sbagliata significa un indice che si rifà da
 * solo». Un comando che la chiede a chi lo lancia sposta l'indovinello, non lo
 * toglie: una chiamata e un `vector.length` lo tolgono.
 */
async function probeDimensions(config: Config, slug: string, home: string): Promise<number> {
  const scelta = { ...(config.embedder ?? { kind: 'ollama' as const }), model: slug };
  const embedder = makeEmbedder(scelta, (ref) => readSecret(ref, home));
  if (embedder.probeDimensions === undefined) {
    throw new Error(`l'embedder "${slug}" non può misurare la dimensione del vettore`);
  }
  return embedder.probeDimensions();
}

function mostra(config: Config, out: (l: string) => void): void {
  const laneProvider = (lane: InferenceLane) => inferenceProvider(config, lane);
  const p = (lane: InferenceLane): string => {
    const price = priceOf(config.models[lane], laneProvider(lane).baseUrl);
    return price === null
      ? 'locale, non fatturato'
      : `${usd(price.inputPerMTok)}/${usd(price.outputPerMTok)} per MTok`;
  };
  const route = (lane: InferenceLane): string =>
    isOpenRouterFreeRoute(config.models[lane], laneProvider(lane).baseUrl)
      ? ' · router gratuito (il modello servito può cambiare per richiesta)'
      : '';
  const label = (lane: InferenceLane): string => providerLabel(laneProvider(lane));
  const rate = (lane: InferenceLane): string =>
    laneProvider(lane).kind === 'openai-chatgpt'
      ? 'quota/crediti del piano, non stimati in USD'
      : p(lane);
  out(`main       ${config.models.main} · ${label('main')} — ${rate('main')}${route('main')}`);
  out(`light      ${config.models.light} · ${label('light')} — ${rate('light')}${route('light')}`);
  const emb = config.embedder;
  out(
    emb === undefined
      ? 'embed      ollama:qwen3-embedding:0.6b (default) · 1024 dim'
      : `embed      ${emb.kind}:${emb.model ?? 'default'} · ${emb.dimensions ?? '?'} dim` +
          (emb.fallback === undefined
            ? ''
            : ` · fallback ${emb.fallback.kind}:${emb.fallback.model ?? 'default'}`),
  );
}

/**
 * Una funzione sola dietro `muffin model` e `/model`.
 *
 * Il chiamante passa dove si scrive — stdout per la CLI, la riga di stato per il
 * REPL — e riceve un exit code. Due implementazioni della stessa manopola sono
 * la cucitura che `docs/development/JUDGE.md` descrive: corrette separatamente, capaci di
 * non essere d'accordo il giorno che una delle due cambia.
 */
export async function cmdModel(home: string, argv: string[], deps: ModelDeps): Promise<number> {
  const { out } = deps;
  const original = loadConfig(home);

  if (argv.length === 0 && deps.interactive) {
    return guidedModelSelection(home, original, deps);
  }
  if (argv[0] === '--select') {
    if (!deps.interactive) {
      out(
        'Il menu provider/modello è disponibile da `muffin config` nel terminale; qui usa `/model [main|light] --provider <id> <slug>`.',
      );
      return 2;
    }
    return guidedModelSelection(home, original, deps);
  }

  const [first, ...afterFirst] = argv;
  const laneSpecified = first === 'main' || first === 'light' || first === 'embed';
  const lane: Lane = laneSpecified ? first : 'main';
  const switchLane: InferenceLane = lane === 'light' ? 'light' : 'main';
  const laneProvider =
    lane === 'embed' ? original.provider : inferenceProvider(original, switchLane);
  // The selector accepts the same shortcut whether or not the lane is named:
  // `model --provider anthropic <slug>` means `model main --provider ...`.
  const commandArgs = laneSpecified ? afterFirst : argv;
  const providerFlagIndex = commandArgs.indexOf('--provider');
  const endpointFlagIndex = commandArgs.indexOf('--endpoint');
  const keyRefFlagIndex = commandArgs.indexOf('--key-ref');
  for (const [flag, index] of [
    ['--provider', providerFlagIndex],
    ['--endpoint', endpointFlagIndex],
    ['--key-ref', keyRefFlagIndex],
  ] as const) {
    if (index >= 0 && commandArgs.lastIndexOf(flag) !== index) {
      out(`Opzione duplicata: ${flag}.`);
      return 2;
    }
  }
  if (
    lane === 'embed' &&
    (providerFlagIndex >= 0 || endpointFlagIndex >= 0 || keyRefFlagIndex >= 0)
  ) {
    out('Le opzioni provider/endpoint valgono solo per main e light.');
    return 2;
  }
  if (providerFlagIndex >= 0 && endpointFlagIndex >= 0) {
    out('Scegli un provider noto oppure un endpoint compatibile, non entrambi.');
    return 2;
  }
  let requestedProvider: string | undefined;
  let requestedEndpoint: string | undefined;
  let requestedKeyRef: string | undefined;
  let args = commandArgs;
  if (providerFlagIndex >= 0) {
    requestedProvider = commandArgs[providerFlagIndex + 1];
    if (requestedProvider === undefined || commandArgs[providerFlagIndex + 2] === '--provider') {
      out(
        'uso: muffin model [main|light] --provider <openrouter|anthropic|chatgpt> [slug|--list [filtro]]',
      );
      return 2;
    }
    args = commandArgs.filter((_, i) => i !== providerFlagIndex && i !== providerFlagIndex + 1);
  }
  if (endpointFlagIndex >= 0) {
    requestedEndpoint = commandArgs[endpointFlagIndex + 1];
    if (requestedEndpoint === undefined || commandArgs[endpointFlagIndex + 2] === '--endpoint') {
      out('uso: muffin model [main|light] --endpoint <url> [slug|--list [filtro]]');
      return 2;
    }
    try {
      const parsed = new URL(requestedEndpoint);
      if (
        !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.hash
      ) {
        throw new Error('invalid endpoint');
      }
      requestedEndpoint = parsed.toString().replace(/\/$/, '');
    } catch {
      out('Endpoint non valido: usa un URL http(s) senza credenziali o frammenti.');
      return 2;
    }
    args = commandArgs.filter((_, i) => i !== endpointFlagIndex && i !== endpointFlagIndex + 1);
  }
  if (keyRefFlagIndex >= 0) {
    requestedKeyRef = commandArgs[keyRefFlagIndex + 1];
    if (
      requestedEndpoint === undefined ||
      requestedKeyRef === undefined ||
      !/^[a-z0-9_]+$/i.test(requestedKeyRef)
    ) {
      out('uso: muffin model [main|light] --endpoint <url> --key-ref <nome-segreto> <slug|--list>');
      return 2;
    }
    args = commandArgs.filter((_, i) => i !== keyRefFlagIndex && i !== keyRefFlagIndex + 1);
  }
  if (keyRefFlagIndex < 0 && requestedEndpoint !== undefined) {
    // A headless custom-host change must name the exact stored credential.
    // Guided mode assigns a per-endpoint ref and prompts before catalog access.
    const sameEndpoint =
      laneProvider.kind === 'openai-compat' &&
      canonicalEndpoint(laneProvider.baseUrl) === canonicalEndpoint(requestedEndpoint);
    if (!sameEndpoint && !deps.interactive) {
      out(
        'Un endpoint diverso richiede --key-ref <nome> con un segreto già salvato; configurazione preservata.',
      );
      return 1;
    }
  }
  args = commandArgs.filter(
    (_, i) =>
      ![
        ...(providerFlagIndex >= 0 ? [providerFlagIndex, providerFlagIndex + 1] : []),
        ...(endpointFlagIndex >= 0 ? [endpointFlagIndex, endpointFlagIndex + 1] : []),
        ...(keyRefFlagIndex >= 0 ? [keyRefFlagIndex, keyRefFlagIndex + 1] : []),
      ].includes(i),
  );
  const [primo, ...resto] = args;
  if (resto.length > (primo === '--list' ? 1 : 0)) {
    out('Argomenti in eccesso: specifica un solo modello oppure --list [filtro].');
    return 2;
  }
  const slug = primo;
  const selectedProvider =
    requestedEndpoint !== undefined
      ? endpointConfigFor(laneProvider, requestedEndpoint, requestedKeyRef)
      : requestedProvider === undefined
        ? laneProvider
        : providerConfigFor(laneProvider, requestedProvider);
  if (selectedProvider === null) {
    out(`provider sconosciuto: ${requestedProvider}. Scegli ${Object.keys(PROVIDERS).join(', ')}.`);
    return 2;
  }
  const config =
    lane === 'embed' ? original : withInferenceProvider(original, switchLane, selectedProvider);
  const entry = lane === 'embed' ? providerFor(config.provider) : providerFor(selectedProvider);
  const chatgpt = selectedProvider.kind === 'openai-chatgpt';

  if (
    !chatgpt &&
    deps.interactive &&
    (requestedProvider !== undefined || requestedEndpoint !== undefined)
  ) {
    if (keyForEndpoints(selectedProvider, home) === undefined) {
      const entryForSecret = providerFor(selectedProvider);
      const name = selectedProvider.apiKeyRef.replace(/^secret:\/\//, '');
      const key = await promptSecret(
        `Chiave API per ${entryForSecret?.label ?? selectedProvider.kind}${requestedEndpoint === undefined ? ' (nascosta; invio annulla)' : ' (nascosta; endpoint locale senza auth: inserisci local)'}: `,
      );
      if (!key) {
        out('Selezione annullata. Configurazione preservata.');
        return 1;
      }
      writeAuthoritativeSecret(name, key, home);
    }
  } else if (!chatgpt && (requestedProvider !== undefined || requestedEndpoint !== undefined)) {
    const selectedEntry = providerFor(selectedProvider);
    if (
      (requestedEndpoint !== undefined || (slug !== '--list' && selectedEntry !== null)) &&
      keyForEndpoints(selectedProvider, home) === undefined
    ) {
      out(
        `${selectedEntry?.label ?? selectedProvider.baseUrl} requires a saved key reference. Use --key-ref <name> with an existing secret, or connect it with muffin config in a terminal; configuration preserved.`,
      );
      return 1;
    }
  }

  if (argv.length === 0) {
    mostra(original, out);
    if (
      providerFor(inferenceProvider(original, 'main')) === null ||
      providerFor(inferenceProvider(original, 'light')) === null
    ) {
      out('');
      out(
        `(endpoint fuori dal catalogo: ${Object.values(PROVIDERS)
          .map((e) => e.label)
          .join(', ')} sono i provider conosciuti)`,
      );
    }
    return 0;
  }

  const generico = genericEndpoint(selectedProvider, entry);

  const isList = primo === '--list' || slug === '--list';
  if (isList) {
    const filtroArgs = primo === '--list' ? resto : resto.slice(1);
    if (chatgpt) {
      try {
        const models = await (deps.chatgpt ?? new ChatGPTConnection(home)).listModels();
        const filtro = (filtroArgs[0] ?? '').toLowerCase();
        for (const model of models
          .filter((candidate) => candidate.slug.toLowerCase().includes(filtro))
          .slice(0, 60))
          out(`${model.slug} — ${model.displayName}`);
        return 0;
      } catch (error) {
        out(error instanceof Error ? error.message : 'ChatGPT model catalog unavailable.');
        return 1;
      }
    }
    if (generico !== null) {
      const found = await discoverOpenAICompatModels({
        baseUrl: generico,
        apiKey: providerKey(selectedProvider, home),
        fetch: deps.fetchImpl,
      });
      if (found.status !== 'known') {
        out(`${generico}/models non verificabile (${perche(found)}).`);
        return 1;
      }
      const filtro = (filtroArgs[0] ?? '').toLowerCase();
      const righe = found.models.filter((id) => id.toLowerCase().includes(filtro));
      if (found.models.length === 0) out(`${generico} non dichiara nessun modello.`);
      for (const id of righe.slice(0, 60)) out(id);
      if (righe.length > 60)
        out(`… e altri ${righe.length - 60}. Restringi con \`muffin model --list <filtro>\`.`);
      return 0;
    }
    if (entry === null) {
      out('nessun catalogo: questo endpoint non è fra i provider conosciuti.');
      return 1;
    }
    const filtro = (filtroArgs[0] ?? '').toLowerCase();
    const catalogo = await fetchCatalogue(entry, keyOf(selectedProvider, home), deps.fetchImpl);
    const righe = catalogo.filter((m) => m.id.toLowerCase().includes(filtro));
    for (const m of righe.slice(0, 60))
      out(`${m.id}  ${usd(m.inputPerMTok)}/${usd(m.outputPerMTok)} per MTok`);
    if (righe.length > 60)
      out(`… e altri ${righe.length - 60}. Restringi con \`muffin model --list <filtro>\`.`);
    return 0;
  }

  // Persistito contro attivo (issue #500), su ogni strada che scrive: il
  // gateway vivo applica ai nuovi turni senza riavvio, e lo si dice con i
  // valori che il gateway stesso dichiara, mai indovinando.
  const attiva = async (cfg: Config, scelto: string): Promise<void> => {
    const query =
      deps.gatewayStatus ?? (() => askGateway(home, 'status') as Promise<GatewayStatus | null>);
    let status: GatewayStatus | null = null;
    try {
      status = await query();
    } catch {
      status = null;
    }
    for (const line of activationNotes(lane, scelto, cfg.models.main, cfg.models.light, status))
      out(line);
  };

  const persistLaneModel = (
    slugToSave: string,
    live: EndpointEvidence,
  ): { config: Config; notes: string[] } | null => {
    const latest = loadConfig(home);
    if (!sameLaneState(original, latest, switchLane)) return null;
    const laneConfig = withInferenceProvider(latest, switchLane, selectedProvider);
    const switched = resolveModelSwitch(laneConfig, switchLane, slugToSave, live);
    saveConfig(switched.config, home);
    return switched;
  };

  // Endpoint compat generico (issue #763): `/models` è un indizio, non
  // un'autorità (un proxy con route wildcard elenca modelli finti), quindi
  // uno slug assente avvisa e si scrive lo stesso, e un fallimento della
  // lettura vuol dire «non verificato», mai «non esiste».
  const scriviGenerico = async (
    corsia: 'main' | 'light',
    baseUrl: string,
    scelto: string,
    found: ModelDiscovery,
  ): Promise<number> => {
    if (found.status === 'known' && found.models.includes(scelto)) {
      out(`"${scelto}" è servito da ${baseUrl} (visto in /models).`);
    } else if (found.status === 'known') {
      const n = found.models.length;
      const anteprima =
        n === 0 ? '' : `: ${found.models.slice(0, 5).join(', ')}${n > 5 ? ', …' : ''}`;
      out(
        `⚠ "${scelto}" non compare in ${baseUrl}/models (${n === 1 ? '1 modello' : `${n} modelli`}${anteprima}). ` +
          `Su un endpoint generico quella lista è un indizio, non un'autorità: lo scrivo lo stesso.`,
      );
      const forse = vicini(
        scelto,
        found.models.map((id) => ({ id })),
      );
      if (forse.length > 0) out(`forse: ${forse.join(', ')}`);
    } else {
      out(
        `${baseUrl}/models non verificabile (${perche(found)}): scrivo "${scelto}" su ${corsia}, NON verificato.`,
      );
    }
    const switched = persistLaneModel(scelto, null);
    if (switched === null) {
      out('La corsia è cambiata mentre verificavo il modello. Configurazione preservata; riprova.');
      return 1;
    }
    for (const note of switched.notes) out(note);
    await attiva(switched.config, scelto);
    if (corsia === 'main')
      out('Il profilo si risceglie da solo dal nome del modello: `muffin doctor` dice quale.');
    return 0;
  };

  if (slug === '--served' && lane !== 'embed') {
    if (generico === null) {
      out(
        '--served vale solo per un endpoint openai-compat fuori catalogo' +
          (entry === null
            ? '.'
            : `: il catalogo di ${entry.label} è autorevole, scegli con \`muffin model <slug>\`.`),
      );
      return 2;
    }
    const found = await discoverOpenAICompatModels({
      baseUrl: generico,
      apiKey: providerKey(selectedProvider, home),
      fetch: deps.fetchImpl,
    });
    if (found.status !== 'known') {
      out(`Non so cosa serve ${generico} (${perche(found)}): niente scritto.`);
      return 1;
    }
    const [unico, ...altri] = found.models;
    if (unico === undefined) {
      out(`${generico} non dichiara nessun modello: niente scritto.`);
      return 1;
    }
    if (altri.length > 0) {
      // Anteprima e non elenco: un proxy con route wildcard ne dichiara
      // centinaia (200, misurato), e una riga sola di migliaia di caratteri
      // non si legge in un terminale e supera il limite di un messaggio Telegram.
      const n = found.models.length;
      out(
        `${generico} serve ${n} modelli, non ne scelgo uno a caso: ` +
          `${found.models.slice(0, 5).join(', ')}${n > 5 ? `, … (\`muffin model --list\` li elenca)` : ''}.`,
      );
      out(
        `Scegli con \`muffin model ${lane === 'main' ? '' : `${lane} `}<slug>\`. Niente scritto.`,
      );
      return 1;
    }
    return scriviGenerico(lane, generico, unico, found);
  }

  if (slug === undefined || slug.startsWith('-')) {
    out(
      'uso: muffin model [main|light|embed] <slug> · muffin model [main|light] [--provider <id>|--endpoint <url>] <slug> · muffin model [main|light] --list [filtro] [--provider <id>] · muffin model --select',
    );
    return 2;
  }

  if (lane === 'embed') {
    // Nessun catalogo da interrogare: OpenRouter instrada chat, non embedding.
    // Quello che si può fare — ed è di più — è **chiamarlo**: se risponde
    // esiste, e il vettore che torna dice la dimensione.
    let dim: number;
    try {
      dim = await (deps.probe ?? probeDimensions)(config, slug, home);
    } catch (error) {
      out(
        `l'embedder "${slug}" non ha risposto: ${error instanceof Error ? error.message : String(error)}`,
      );
      out('Niente scritto: un modello che non risponde adesso non indicizzerebbe niente dopo.');
      return 1;
    }
    const fallbackChoice = config.embedder?.fallback;
    if (fallbackChoice !== undefined) {
      const fallbackDimensions = makeEmbedder(fallbackChoice, (ref) => readSecret(ref, home)).dimensions;
      if (fallbackDimensions !== dim) {
        out(
          `La dimensione misurata (${dim}) non coincide con il fallback (${fallbackDimensions}): ` +
            'allinea i due embedder prima di cambiare modello.',
        );
        out('Niente scritto: il fallback non indicizzerebbe nella stessa tabella vettoriale.');
        return 1;
      }
    }
    const prima = config.embedder?.dimensions;
    saveConfig(
      {
        ...config,
        embedder: { ...(config.embedder ?? { kind: 'ollama' }), model: slug, dimensions: dim },
      },
      home,
    );
    out(`embed → ${slug} · ${dim} dimensioni, misurate chiamandolo`);
    out(
      prima !== undefined && prima !== dim
        ? `La dimensione cambia (${prima} → ${dim}): l'indice vettoriale si rifà da sé al prossimo consolidamento.`
        : 'Le righe embeddate col modello di prima vengono buttate e rifatte: due modelli sono due spazi vettoriali.',
    );
    return 0;
  }

  if (chatgpt) {
    try {
      const connection = deps.chatgpt ?? new ChatGPTConnection(home);
      const models = await connection.listModels();
      if (!models.some((model) => model.slug === slug)) {
        out('Model absent from this account catalog. Configuration preserved.');
        return 1;
      }
      const candidate = { ...config, models: { ...config.models, [switchLane]: slug } };
      const verify = deps.verify ?? verifyInferenceRoute;
      const checked = await verify({
        home,
        config: candidate,
        lane: switchLane,
        model: slug,
        ...(switchLane === 'light' ? { thinking: 'low' as const } : {}),
        timeoutMs: 60_000,
      });
      if (checked.status !== 'working' || checked.resolvedModel !== slug) {
        out(`Model verification failed: ${checked.diagnostic}. Configuration preserved.`);
        return 1;
      }
      const latest = loadConfig(home);
      if (!sameLaneState(original, latest, switchLane)) {
        out(
          'La corsia è cambiata mentre verificavo il modello. Configurazione preservata; riprova.',
        );
        return 1;
      }
      const saved = withInferenceProvider(latest, switchLane, selectedProvider);
      saveConfig({ ...saved, models: { ...saved.models, [switchLane]: slug } }, home);
      out(`${switchLane} → ${slug} · ${PROVIDERS.chatgpt.label}. No provider fallback.`);
      out(`Manage plan usage and credit permissions: https://chatgpt.com/settings/usage`);
      return 0;
    } catch (error) {
      out(error instanceof Error ? error.message : 'ChatGPT connection failed.');
      return 1;
    }
  }

  if (generico !== null) {
    const found = await discoverOpenAICompatModels({
      baseUrl: generico,
      apiKey: providerKey(selectedProvider, home),
      fetch: deps.fetchImpl,
    });
    return scriviGenerico(lane, generico, slug, found);
  }

  if (entry === null) {
    out(`endpoint fuori dal catalogo: scrivo "${slug}" su ${lane} senza poterlo verificare.`);
    // Senza provider noto non c'è evidenza: il resolver tiene tutto e lo dice
    // solo se c'è davvero un routing da rivalidare.
    const switched = persistLaneModel(slug, null);
    if (switched === null) {
      out('La corsia è cambiata mentre verificavo il modello. Configurazione preservata; riprova.');
      return 1;
    }
    for (const note of switched.notes) out(note);
    await attiva(switched.config, slug);
    return 0;
  }

  let catalogo: CatalogueModel[];
  try {
    catalogo = await fetchCatalogue(entry, keyOf(selectedProvider, home), deps.fetchImpl);
  } catch (error) {
    if (error instanceof CatalogueRedirectError) {
      out(`${error.message}. Configurazione preservata.`);
      return 1;
    }
    // Irraggiungibile ≠ inesistente. Si scrive, e si dice a voce alta che non è
    // stato verificato: rifiutare qui bloccherebbe un owner offline su una
    // scelta perfettamente valida.
    out(
      `catalogo di ${entry.label} irraggiungibile (${error instanceof Error ? error.message : String(error)}).`,
    );
    const switched = persistLaneModel(slug, null);
    if (switched === null) {
      out('La corsia è cambiata mentre verificavo il modello. Configurazione preservata; riprova.');
      return 1;
    }
    out(`${lane} → ${slug}, NON verificato.`);
    for (const note of switched.notes) out(note);
    await attiva(switched.config, slug);
    return 0;
  }

  const trovato = catalogo.find((m) => m.id === slug);
  if (trovato === undefined) {
    out(`"${slug}" non esiste su ${entry.label}. Niente scritto.`);
    const forse = vicini(slug, catalogo);
    if (forse.length > 0) out(`forse: ${forse.join(', ')}`);
    return 1;
  }

  // Lo slug esiste: prima di scriverlo si rivalida il routing contro gli
  // endpoint vivi del modello nuovo (issue #501). Senza evidenza il resolver
  // tiene tutto e lo dice — la riga NON verificato qui sotto resta vera.
  const live = await endpointEvidence(
    entry,
    slug,
    keyForEndpoints(selectedProvider, home),
    deps.fetchImpl,
  );
  const switched = persistLaneModel(slug, live);
  if (switched === null) {
    out('La corsia è cambiata mentre verificavo il modello. Configurazione preservata; riprova.');
    return 1;
  }
  out(
    `${lane} → ${slug} · ${usd(trovato.inputPerMTok)}/${usd(trovato.outputPerMTok)} per MTok su ${entry.label}`,
  );
  const nota = priceNote(trovato, selectedProvider.baseUrl);
  if (nota !== null) out(nota);
  for (const note of switched.notes) out(note);
  await attiva(switched.config, slug);
  if (lane === 'main')
    out('Il profilo si risceglie da solo dal nome del modello: `muffin doctor` dice quale.');
  return 0;
}

async function guidedModelSelection(
  home: string,
  config: Config,
  deps: ModelDeps,
): Promise<number> {
  const ask = deps.ask ?? promptLine;
  const laneAnswer = await ask(
    `Corsia (${config.models.main} main · ${config.models.light} light) [main/light]: `,
  );
  if (laneAnswer !== 'main' && laneAnswer !== 'light') {
    deps.out('Selezione annullata.');
    return 1;
  }
  const current = inferenceProvider(config, laneAnswer);
  const choices = [
    ...Object.values(PROVIDERS).map((provider) => `${provider.id} (${provider.label})`),
    'custom (endpoint OpenAI-compatible)',
  ].join(' · ');
  const providerAnswer = await ask(
    `Provider [${choices}] (invio mantiene ${providerLabel(current)}): `,
  );
  if (providerAnswer === 'custom') {
    const endpoint = await ask('Endpoint base http(s) (es. http://localhost:11434/v1): ');
    if (!endpoint) {
      deps.out('Selezione annullata.');
      return 1;
    }
    const model = await ask('Modello esatto (invio annulla): ');
    if (!model) {
      deps.out('Selezione annullata.');
      return 1;
    }
    return cmdModel(home, [laneAnswer, '--endpoint', endpoint, model], deps);
  }
  const id = providerAnswer || providerFor(current)?.id;
  if (!id) {
    const model = await ask('Modello per il provider personalizzato (invio annulla): ');
    return model ? cmdModel(home, [laneAnswer, model], { ...deps, interactive: false }) : 1;
  }
  const entry = PROVIDERS[id as keyof typeof PROVIDERS];
  if (entry === undefined) {
    deps.out(`Provider sconosciuto: ${id}.`);
    return 2;
  }
  if (entry.kind === 'openai-chatgpt') {
    try {
      const connection = deps.chatgpt ?? new ChatGPTConnection(home);
      const session = await connection.session();
      if (!session?.connected) {
        if (!deps.interactive) {
          deps.out(
            'Collega prima l’account dal terminale con `muffin config`; nessuna autorizzazione viene avviata dalla conversazione.',
          );
          return 1;
        }
        await connection.signIn({ openBrowser: openChatGPTBrowser });
      }
    } catch (error) {
      deps.out(error instanceof Error ? error.message : 'ChatGPT connection unavailable.');
      return 1;
    }
  }
  const providerArgs = providerAnswer ? ['--provider', id] : [];
  const listCode = await cmdModel(home, [laneAnswer, '--list', ...providerArgs], deps);
  if (listCode !== 0) return listCode;
  const model = await ask(`Modello esatto da ${entry.label} (invio annulla): `);
  if (!model) {
    deps.out('Selezione annullata.');
    return 1;
  }
  return cmdModel(home, [laneAnswer, ...providerArgs, model], deps);
}

/**
 * L'endpoint compat generico di questa installazione, o `null`: un
 * openai-compat con un `baseUrl` che non è nel catalogo (un llama-server, un
 * vLLM, un Ollama, un proxy). L'API nativa di Anthropic parla un altro
 * protocollo e resta fuori: questa lettura è quella OpenAI-compatibile.
 */
function genericEndpoint(
  provider: InferenceProviderConfig,
  entry: ProviderEntry | null,
): string | null {
  if (entry !== null || provider.kind !== 'openai-compat') return null;
  return provider.baseUrl ?? null;
}

/**
 * La credenziale con cui il runtime parla a questo endpoint (la stessa che
 * `agent/providers/verify.ts` legge), perché un server con `--api-key` rifiuta
 * `/models` senza. Va solo a `baseUrl`, mai stampata.
 */
function providerKey(provider: InferenceProviderConfig, home: string): string | undefined {
  return keyForEndpoints(provider, home);
}

/** Perché `/models` non ha detto niente, in parole dell'owner — con il rimedio, mai solo il lamento. */
function perche(found: Exclude<ModelDiscovery, { status: 'known' }>): string {
  if (found.status === 'unsupported') return `nessuna lista dei modelli: ${found.detail}`;
  const motivo = {
    network: 'irraggiungibile',
    timeout: 'nessuna risposta in tempo',
    auth: 'credenziale rifiutata',
    http: 'errore HTTP',
  };
  const rimedio = {
    network: 'controlla rete/proxy, poi riprova',
    timeout: 'riprova — se persiste, il provider è lento, non rotto',
    auth: 'ruota la chiave e riprova',
    http: 'riprova più tardi',
  };
  return `${motivo[found.reason]}: ${found.detail} — ${rimedio[found.reason]}`;
}

/** La chiave, solo se il catalogo la pretende — su OpenRouter non serve, e non si legge un segreto per niente. */
function keyOf(provider: InferenceProviderConfig, home: string): string | undefined {
  const entry = providerFor(provider);
  if (entry === null || !entry.catalogueNeedsKey) return undefined;
  return keyForEndpoints(provider, home);
}

/**
 * La chiave per gli endpoint del modello, che a differenza del catalogo la
 * pretendono (BearerAuth nella spec OpenRouter). Usa lo stesso riferimento
 * esplicito del runtime; una chiave di un'altra connessione non è un fallback.
 * Le Home precedenti conservano il loro riferimento durante la migrazione.
 */
export function keyForEndpoints(
  provider: InferenceProviderConfig,
  home: string,
): string | undefined {
  try {
    return readSecret(provider.apiKeyRef, home);
  } catch {
    return undefined;
  }
}
