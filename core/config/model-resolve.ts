import type { Config } from './config.js';

/**
 * Il cambio modello che non rompe l'instradamento (issue #501).
 *
 * Il guasto osservato: `provider.routing.only: ["alibaba"]` scritto per Qwen
 * sopravviveva al passaggio a Gemma/`:free`, e ogni richiesta reale diventava
 * impossibile — mentre i modelli appena scelti funzionavano su altri provider.
 * `muffin model` cambiava solo lo slug.
 *
 * La distinzione che ripara senza una provenance da mantenere è scritta nello
 * schema (`core/config/config.ts`): i pin di identità (`only`/`order`/`ignore`)
 * nominano *macchine* e dipendono dal modello; le manopole di policy
 * (`dataCollection`, `quantizations`, `sort`, `requireParameters`) nominano
 * *vincoli dell'owner* e non si toccano mai qui. I peer fanno lo stesso:
 * Hermes azzera `base_url` al cambio provider, Claude Code rifiuta prima di
 * salvare, Codex blocca gli override non fidati — nessuno preserva in silenzio
 * uno stato derivato incompatibile.
 *
 * Regole, in ordine:
 *
 * 1. stesso slug → niente da fare;
 * 2. stessa famiglia (prefisso autore) e niente router di mezzo → i pin
 *    restano significativi, si tengono senza una riga di rumore;
 * 3. altrimenti i pin si rivalidano contro gli endpoint vivi del modello
 *    nuovo: cade solo ciò che risulta **non servire** il modello, con una nota
 *    che dice cosa e come rimetterlo;
 * 4. senza evidenza (offline, senza chiave, risposta illeggibile) non si
 *    distrugge niente: si tiene tutto e lo si dice a voce alta — la stessa
 *    filosofia di `cmdModel` («irraggiungibile ≠ inesistente»);
 * 5. un `only` svuotato si elimina (fail-open verso il default del router),
 *    mai lasciato come divieto totale.
 */

export type SwitchLane = 'main' | 'light';

/**
 * Gli slug dei provider che servono il modello nuovo, o `null` quando non lo
 * si sa (offline, senza chiave, risposta illeggibile). Chi costruisce
 * l'evidenza normalizza (minuscole); il confronto qui è esatto sul normalizzato.
 */
export type EndpointEvidence = {
  serves: (pin: string) => boolean;
} | null;

export type ResolveResult = {
  config: Config;
  /** Una riga per fatto che l'owner deve vedere: rimozioni, tenute non verificate. Mai vuote di rimedio. */
  notes: string[];
};

/** Dal set di slug al tipo che il resolver vuole; `null` resta `null` (sconosciuto). */
export function tagsToEvidence(tags: string[] | null): EndpointEvidence {
  if (tags === null) return null;
  const set = new Set(tags);
  return { serves: (pin) => set.has(pin.toLowerCase()) };
}

/** La famiglia di uno slug: il prefisso autore. `openrouter/free` è un router, non una famiglia. */
export function familyOf(slug: string): string {
  if (slug === 'openrouter/free') return 'router';
  const cut = slug.indexOf('/');
  return cut < 0 ? slug : slug.slice(0, cut);
}

type IdentityKey = 'only' | 'order' | 'ignore';

const IDENTITY_KEYS: readonly IdentityKey[] = ['only', 'order', 'ignore'];

type Routing = NonNullable<Config['provider']['routing']>;

function partition(
  pins: readonly string[],
  live: Exclude<EndpointEvidence, null>,
): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const pin of pins) {
    if (live.serves(pin)) kept.push(pin);
    else dropped.push(pin);
  }
  return { kept, dropped };
}

function revalidate(routing: Routing, slug: string, live: Exclude<EndpointEvidence, null>): { routing: Routing; notes: string[] } {
  const notes: string[] = [];
  const repaired: Routing = { ...routing };
  for (const key of IDENTITY_KEYS) {
    const pins = repaired[key];
    if (pins === undefined) continue;
    const { kept, dropped } = partition(pins, live);
    if (dropped.length > 0) {
      notes.push(
        `routing.${key}: rimossi ${dropped.join(', ')} — non servono ${slug}. ` +
          `Per rimetterli: provider.routing.${key} in config.json.`,
      );
    }
    if (kept.length === 0) delete repaired[key];
    else repaired[key] = kept;
  }
  if (repaired.only !== undefined && repaired.only.length === 0) {
    // Un `only: []` arrivato da mano resta un divieto totale: fail-open,
    // detto a voce alta. (Lo schema lo rifiuta con nonempty, ma la difesa
    // qui non costa niente.)
    const { only: _dropped, ...rest } = repaired;
    return { routing: rest, notes: [...notes, `routing.only vuoto rimosso: vietava tutti i provider per ${slug}.`] };
  }
  return { routing: repaired, notes };
}

/**
 * Una funzione sola dietro `muffin model`, `muffin update` e (domani) il probe
 * di `doctor --online` (#523): stessa semantica ovunque, un solo posto da
 * leggere quando un pin cade. Pura e sincrona — la rete resta al chiamante,
 * che la passa come evidenza già normalizzata.
 */
export function resolveModelSwitch(
  config: Config,
  lane: SwitchLane,
  slug: string,
  live: EndpointEvidence,
): ResolveResult {
  const before = config.models[lane];
  const routing = config.provider.routing;
  if (routing === undefined) {
    if (before === slug) return { config, notes: [] };
    return { config: { ...config, models: { ...config.models, [lane]: slug } }, notes: [] };
  }

  const oldFamily = familyOf(before);
  const newFamily = familyOf(slug);
  // Il marcatore dice per cosa i pin sono stati validati l'ultima volta,
  // qualunque corsia li abbia prodotti: finché una corsia viva lo conferma,
  // non c'è niente da rivalidare (fail-open verso il silenzio in caso dubbio).
  const fams = new Set([familyOf(config.models.main), familyOf(config.models.light), newFamily]);
  const staleMarker =
    config.provider.routingForFamily !== undefined &&
    !fams.has(config.provider.routingForFamily) &&
    ![...fams].includes('router');
  if (before === slug && !staleMarker) return { config, notes: [] };
  if (!staleMarker && oldFamily === newFamily && newFamily !== 'router') {
    // Stessa famiglia: i pin nominano macchine che servono anche il modello
    // nuovo (stesso autore). Nessun rumore.
    return {
      config: before === slug ? config : { ...config, models: { ...config.models, [lane]: slug } },
      notes: [],
    };
  }

  const next: Config = { ...config, models: { ...config.models, [lane]: slug } };
  const notes: string[] = [];
  if (live === null) {
    const count = IDENTITY_KEYS.reduce((n, k) => n + (routing[k]?.length ?? 0), 0);
    if (count > 0) {
      notes.push(
        `routing non verificato per ${slug} (endpoint irraggiungibili): tenuti ${count} pin ` +
          `da ${before}. Se le richieste falliscono, ricontrolla provider.routing in config.json.`,
      );
    }
    return { config: next, notes };
  }

  const { routing: repaired, notes: dropped } = revalidate(routing, slug, live);
  // Validato con evidenza: il marcatore avanza, e `doctor` potrà confrontarlo
  // offline. Senza evidenza non si scrive niente — un marcatore non validato
  // spegnerebbe l'unico avviso che resta.
  next.provider = { ...next.provider, routing: repaired, routingForFamily: newFamily };
  return { config: next, notes: [...notes, ...dropped] };
}

/**
 * Il confronto offline per `doctor` (issue #501): i pin esistono, il marcatore
 * dice per quale famiglia sono stati validati, i modelli dicono un'altra
 * famiglia. Nessuna rete, nessun indovinello — quando non lo si può provare
 * (niente routing, niente marcatore, un router di mezzo, una corsia che il
 * marcatore conferma) si tace.
 */
export function diagnoseRoutingStaleness(config: Config): { detail: string; remedy: string } | null {
  const routing = config.provider.routing;
  const marker = config.provider.routingForFamily;
  if (routing === undefined || marker === undefined) return null;
  const pins = [...(routing.only ?? []), ...(routing.order ?? []), ...(routing.ignore ?? [])];
  if (pins.length === 0) return null;
  const fams = new Set([familyOf(config.models.main), familyOf(config.models.light)]);
  if (fams.has('router') || fams.has(marker)) return null;
  return {
    detail:
      `i pin di routing (${pins.join(', ')}) derivano per la famiglia "${marker}", ` +
      `i modelli sono ${[...fams].join(' + ')}`,
    remedy:
      `rivalida con \`muffin model ${config.models.main}\` (anche lo stesso slug ricontrolla) ` +
      `oppure sistema provider.routing in config.json`,
  };
}
/**
 * La riparazione per le installazioni esistenti (`muffin update`, issue #501):
 * lo stesso nucleo di rivalidazione, applicato al modello già configurato
 * contro gli endpoint vivi di oggi. Un pin di un'altra era cade con evidenza;
 * senza evidenza non si tocca niente.
 */
export function repairStaleRouting(config: Config, lane: SwitchLane, live: EndpointEvidence): ResolveResult {
  const slug = config.models[lane];
  const routing = config.provider.routing;
  if (routing === undefined || live === null) return { config, notes: [] };
  const { routing: repaired, notes } = revalidate(routing, slug, live);
  const provider = { ...config.provider, routing: repaired, routingForFamily: familyOf(slug) };
  if (notes.length === 0 && provider.routingForFamily === config.provider.routingForFamily) {
    return { config, notes };
  }
  return { config: { ...config, provider }, notes };
}
