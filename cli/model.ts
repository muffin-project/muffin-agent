import { loadConfig, saveConfig, readSecret, type Config } from '../core/config/config.js';
import { buildEndpointsUrl, parseEndpointTags } from '../core/config/endpoints.js';
import { resolveModelSwitch, type EndpointEvidence } from '../core/config/model-resolve.js';
import { askGateway } from '../core/gateway/control-socket.js';
import { isOpenRouterFreeRoute, priceOf } from '../core/budget/pricing.js';
import { makeEmbedder } from '../core/memory/embed.js';
import { PROVIDERS, providerFor, apiKeyCandidates, type ProviderEntry } from '../core/config/providers.js';

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
  if (entry.modelsPath === undefined) throw new Error(`${entry.label} non espone un catalogo dei modelli`);
  const res = await fetchImpl(`${entry.baseUrl}${entry.modelsPath}`, {
    headers: entry.catalogueNeedsKey && apiKey !== undefined ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  if (!res.ok) throw new Error(`catalogo di ${entry.label}: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { id?: unknown; pricing?: { prompt?: unknown; completion?: unknown } }[] };
  const out: CatalogueModel[] = [];
  for (const m of body.data ?? []) {
    if (typeof m.id !== 'string') continue;
    const inp = Number(m.pricing?.prompt);
    const outp = Number(m.pricing?.completion);
    // Un prezzo illeggibile non è zero: il modello resta elencabile e
    // selezionabile, ma il confronto con la tabella lo salta invece di
    // dichiarare un divario inventato.
    out.push({
      id: m.id,
      inputPerMTok: Number.isFinite(inp) ? inp * 1e6 : Number.NaN,
      outputPerMTok: Number.isFinite(outp) ? outp * 1e6 : Number.NaN,
    });
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
function vicini(slug: string, catalogo: CatalogueModel[]): string[] {
  const coda = (id: string): string => (id.includes('/') ? id.slice(id.indexOf('/') + 1) : id).toLowerCase();
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
    return [`Gateway vivo${pid}: i nuovi turni usano già ${active.main} · ${active.light} — niente riavvio.`];
  }
  return [
    `Gateway vivo${pid} ancora su ${active.main} · ${active.light}: ` +
      `dal prossimo turno passa a ${main} · ${light}, senza riavvio. ` +
      `Un turno già in volo finisce sul vecchio.`,
  ];
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
  // Senza `dimensions` il ramo openai-compat rifiuta di costruirsi: qui si sta
  // per misurarla, quindi si passa un valore qualsiasi e si guarda il vettore.
  const embedder = makeEmbedder({ ...scelta, dimensions: scelta.dimensions ?? 1 }, (ref) => readSecret(ref, home));
  const [v] = await embedder.embed(['muffin']);
  if (v === undefined || v.length === 0) throw new Error(`l'embedder "${slug}" ha risposto senza vettore`);
  return v.length;
}

function mostra(config: Config, entry: ProviderEntry | null, out: (l: string) => void): void {
  const p = (slug: string): string => {
    const price = priceOf(slug, config.provider.baseUrl);
    return price === null ? 'locale, non fatturato' : `${usd(price.inputPerMTok)}/${usd(price.outputPerMTok)} per MTok`;
  };
  const route = (slug: string): string =>
    isOpenRouterFreeRoute(slug, config.provider.baseUrl)
      ? ' · router gratuito (il modello servito può cambiare per richiesta)'
      : '';
  out(`provider   ${entry === null ? `${config.provider.kind} · ${config.provider.baseUrl ?? 'default'}` : entry.label}`);
  out(`main       ${config.models.main} — fatturato ${p(config.models.main)}${route(config.models.main)}`);
  out(`light      ${config.models.light} — fatturato ${p(config.models.light)}${route(config.models.light)}`);
  const emb = config.embedder;
  out(
    emb === undefined
      ? 'embed      ollama:qwen3-embedding:0.6b (default) · 1024 dim'
      : `embed      ${emb.kind}:${emb.model ?? 'default'} · ${emb.dimensions ?? '?'} dim` +
        (emb.fallback === undefined ? '' : ` · fallback ${emb.fallback.kind}:${emb.fallback.model ?? 'default'}`),
  );
}

/**
 * Una funzione sola dietro `muffin model` e `/model`.
 *
 * Il chiamante passa dove si scrive — stdout per la CLI, la riga di stato per il
 * REPL — e riceve un exit code. Due implementazioni della stessa manopola sono
 * la cucitura che `docs/JUDGE.md` descrive: corrette separatamente, capaci di
 * non essere d'accordo il giorno che una delle due cambia.
 */
export async function cmdModel(home: string, argv: string[], deps: ModelDeps): Promise<number> {
  const { out } = deps;
  const config = loadConfig(home);
  const entry = providerFor(config.provider);

  if (argv.length === 0) {
    mostra(config, entry, out);
    if (entry === null) {
      out('');
      out(`(endpoint fuori dal catalogo: ${Object.values(PROVIDERS).map((e) => e.label).join(', ')} sono i provider conosciuti)`);
    }
    return 0;
  }

  const [primo, ...resto] = argv;
  const lane: Lane = primo === 'main' || primo === 'light' || primo === 'embed' ? primo : 'main';
  const slug = lane === primo ? resto[0] : primo;

  if (primo === '--list') {
    if (entry === null) {
      out('nessun catalogo: questo endpoint non è fra i provider conosciuti.');
      return 1;
    }
    const filtro = (resto[0] ?? '').toLowerCase();
    const catalogo = await fetchCatalogue(entry, keyOf(config, home), deps.fetchImpl);
    const righe = catalogo.filter((m) => m.id.toLowerCase().includes(filtro));
    for (const m of righe.slice(0, 60)) out(`${m.id}  ${usd(m.inputPerMTok)}/${usd(m.outputPerMTok)} per MTok`);
    if (righe.length > 60) out(`… e altri ${righe.length - 60}. Restringi con \`muffin model --list <filtro>\`.`);
    return 0;
  }

  if (slug === undefined || slug.startsWith('-')) {
    out('uso: muffin model [main|light|embed] <slug> · muffin model --list [filtro] · muffin model');
    return 2;
  }

  // Persistito contro attivo (issue #500), su ogni strada che scrive: il
  // gateway vivo applica ai nuovi turni senza riavvio, e lo si dice con i
  // valori che il gateway stesso dichiara — mai indovinando. Qui `slug` è
  // ristretto a stringa dal ramo qui sopra.
  const attiva = async (cfg: Config): Promise<void> => {
    const query = deps.gatewayStatus ?? (() => askGateway(home, 'status') as Promise<GatewayStatus | null>);
    let status: GatewayStatus | null = null;
    try {
      status = await query();
    } catch {
      status = null;
    }
    for (const line of activationNotes(lane, slug, cfg.models.main, cfg.models.light, status)) out(line);
  };

  if (lane === 'embed') {
    // Nessun catalogo da interrogare: OpenRouter instrada chat, non embedding.
    // Quello che si può fare — ed è di più — è **chiamarlo**: se risponde
    // esiste, e il vettore che torna dice la dimensione.
    let dim: number;
    try {
      dim = await (deps.probe ?? probeDimensions)(config, slug, home);
    } catch (error) {
      out(`l'embedder "${slug}" non ha risposto: ${error instanceof Error ? error.message : String(error)}`);
      out('Niente scritto: un modello che non risponde adesso non indicizzerebbe niente dopo.');
      return 1;
    }
    const prima = config.embedder?.dimensions;
    saveConfig({ ...config, embedder: { ...(config.embedder ?? { kind: 'ollama' }), model: slug, dimensions: dim } }, home);
    out(`embed → ${slug} · ${dim} dimensioni, misurate chiamandolo`);
    out(
      prima !== undefined && prima !== dim
        ? `La dimensione cambia (${prima} → ${dim}): l'indice vettoriale si rifà da sé al prossimo consolidamento.`
        : "Le righe embeddate col modello di prima vengono buttate e rifatte: due modelli sono due spazi vettoriali.",
    );
    return 0;
  }

  if (entry === null) {
    out(`endpoint fuori dal catalogo: scrivo "${slug}" su ${lane} senza poterlo verificare.`);
    // Senza provider noto non c'è evidenza: il resolver tiene tutto e lo dice
    // solo se c'è davvero un routing da rivalidare.
    const switched = resolveModelSwitch(config, lane, slug, null);
    saveConfig(switched.config, home);
    for (const note of switched.notes) out(note);
    await attiva(switched.config);
    return 0;
  }

  let catalogo: CatalogueModel[];
  try {
    catalogo = await fetchCatalogue(entry, keyOf(config, home), deps.fetchImpl);
  } catch (error) {
    // Irraggiungibile ≠ inesistente. Si scrive, e si dice a voce alta che non è
    // stato verificato: rifiutare qui bloccherebbe un owner offline su una
    // scelta perfettamente valida.
    out(`catalogo di ${entry.label} irraggiungibile (${error instanceof Error ? error.message : String(error)}).`);
    const switched = resolveModelSwitch(config, lane, slug, null);
    saveConfig(switched.config, home);
    out(`${lane} → ${slug}, NON verificato.`);
    for (const note of switched.notes) out(note);
    await attiva(switched.config);
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
  const live = await endpointEvidence(entry, slug, keyForEndpoints(config, home), deps.fetchImpl);
  const switched = resolveModelSwitch(config, lane, slug, live);
  saveConfig(switched.config, home);
  out(`${lane} → ${slug} · ${usd(trovato.inputPerMTok)}/${usd(trovato.outputPerMTok)} per MTok su ${entry.label}`);
  const nota = priceNote(trovato, config.provider.baseUrl);
  if (nota !== null) out(nota);
  for (const note of switched.notes) out(note);
  await attiva(switched.config);
  if (lane === 'main') out('Il profilo si risceglie da solo dal nome del modello: `muffin doctor` dice quale.');
  return 0;
}

/** La chiave, solo se il catalogo la pretende — su OpenRouter non serve, e non si legge un segreto per niente. */
function keyOf(config: Config, home: string): string | undefined {
  const entry = providerFor(config.provider);
  if (entry === null || !entry.catalogueNeedsKey) return undefined;
  try {
    return readSecret(config.provider.apiKeyRef, home);
  } catch {
    return undefined;
  }
}

/**
 * La chiave per gli endpoint del modello, che a differenza del catalogo la
 * pretendono (BearerAuth nella spec OpenRouter). Si prova ogni nome noto, in
 * ordine di migrazione — senza, la rivalidazione del routing sarebbe morta
 * proprio sull'installazione che ne ha bisogno. Non si stampa mai.
 */
export function keyForEndpoints(config: Config, home: string): string | undefined {
  for (const name of apiKeyCandidates(config.provider)) {
    try {
      return readSecret(`secret://${name}`, home);
    } catch {
      continue;
    }
  }
  return undefined;
}
