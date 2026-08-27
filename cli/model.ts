import { loadConfig, saveConfig, readSecret, type Config } from '../core/config/config.js';
import { priceOf } from '../core/budget/pricing.js';
import { makeEmbedder } from '../core/memory/embed.js';
import { PROVIDERS, providerFor, type ProviderEntry } from '../core/config/providers.js';

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
 * tabella dei prezzi fa match **per sottostringa di famiglia**, e misurato
 * contro il catalogo vivo il 2026-08-27 sottostima in cinque famiglie su otto:
 * `qwen3` è in tabella a 0.1/0.3 per MTok e il `qwen/qwen3.8-27b` che
 * l'installazione dell'owner usava costa 0.425/2.55, mentre nella stessa
 * famiglia si arriva a 2/6. L'intestazione di `pricing.ts` dichiara che essere
 * approssimativi è sicuro «in the direction that matters» perché un modello
 * sconosciuto viene addebitato al massimo tariffario — vero per uno slug che
 * **non matcha nessun pattern**, falso per uno che matcha il pattern della sua
 * famiglia e costa più della voce. Lì il tetto in `rot/budgets.json` scatta
 * tardi invece che presto, che è la direzione che quel file chiama pericolosa.
 *
 * Perché allora non prendere il prezzo dal catalogo e basta? Perché sarebbe un
 * tetto di spesa che cambia senza un diff, e `pricing.ts` è hardcoded per
 * scelta dichiarata. Il catalogo serve a **contraddire** la tabella e a farlo
 * vedere, non a sostituirla.
 */

/** Le tre corsie che un'installazione ha, e che fino a oggi si cambiavano solo a mano. */
export type Lane = 'main' | 'light' | 'embed';

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
};

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
  out(`provider   ${entry === null ? `${config.provider.kind} · ${config.provider.baseUrl ?? 'default'}` : entry.label}`);
  out(`main       ${config.models.main} — fatturato ${p(config.models.main)}`);
  out(`light      ${config.models.light} — fatturato ${p(config.models.light)}`);
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
    saveConfig({ ...config, models: { ...config.models, [lane]: slug } }, home);
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
    saveConfig({ ...config, models: { ...config.models, [lane]: slug } }, home);
    out(`${lane} → ${slug}, NON verificato.`);
    return 0;
  }

  const trovato = catalogo.find((m) => m.id === slug);
  if (trovato === undefined) {
    out(`"${slug}" non esiste su ${entry.label}. Niente scritto.`);
    const forse = vicini(slug, catalogo);
    if (forse.length > 0) out(`forse: ${forse.join(', ')}`);
    return 1;
  }

  saveConfig({ ...config, models: { ...config.models, [lane]: slug } }, home);
  out(`${lane} → ${slug} · ${usd(trovato.inputPerMTok)}/${usd(trovato.outputPerMTok)} per MTok su ${entry.label}`);
  const nota = priceNote(trovato, config.provider.baseUrl);
  if (nota !== null) out(nota);
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
