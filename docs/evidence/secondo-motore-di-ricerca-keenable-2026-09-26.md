# Un secondo motore di ricerca nativo: Keenable (2026-09-26)

Evidenza datata per la claim di `slice/keenable-search-provider`. Non è autorità
corrente: il comportamento vive in `agent/tools/search.ts` e
`core/config/providers.ts`, la policy in `core/policy/decide.ts`.

## Domanda

Aggiungere Keenable come secondo motore dietro il seam esistente di `sys.search`
(`muffin search keenable`), accanto a Tavily, oppure lasciarlo raggiungibile solo
come server MCP?

## Cosa è stato osservato su Muffin

Build `252c1afb` (main) su un'installazione di prova con un modello locale
piccolo, Keenable collegato con il suo bridge stdio ufficiale
(`@keenable/mcp-server` 0.2.1) tramite `muffin mcp add`:

- ogni ricerca si ferma su una conferma dell'owner: il turno di prova ha prodotto
  `Serve la tua approvazione per "mcp.keenable" su query: ...`. È il
  comportamento dichiarato di ogni server MCP (`agent/tools/mcp.ts`:
  `effect: 'external'`, `reversible: 'no'`, ADR-0074), non un difetto del bridge;
- il bridge espone due tool (`search_web_pages`, `fetch_page_content`) che
  consumano posti nel tetto `maxToolsExposed` del profilo: con un tetto di 23 il
  tool di ricerca era tagliato e il modello ripiegava su `fetch_page_content` con
  un URL di un motore di ricerca;
- senza chiave il bridge fallisce (`Missing app identifier: X-Keenable-Title
  header is required for token-less requests`): il bridge non invia quell'header.

Chi usava quell'installazione ha giudicato la conferma per ogni ricerca
inusabile nell'uso quotidiano: la ricerca è un'azione frequente, e una conferma
a ogni query la trasforma in un'interruzione a ogni query.

Affermazione falsificabile: con una ricerca nativa, una ricerca chiesta
dall'owner a taint basso passa senza conferma, attraverso gli stessi gate
(`gateParams` sulla query, allowlist di `rot/egress.json` sull'endpoint) che già
governano Tavily.

## Il percorso di produzione

- `agent/runtime.ts` chiama `diagnoseSearch` (`agent/tools/search.ts`): il
  backend si costruisce dal catalogo, e `web_search` si registra solo se la
  chiave si risolve **e** l'host dell'endpoint è in `rot/egress.json`.
- `searchCapability` (`sys.search`) è `effect: 'egress'`, `reversible: 'yes'`,
  `resourceKind: 'query'`, `hostOnly: true`: la query passa da `gateParams` con
  `searchMaxTaint`; i risultati tornano recintati e di tier 3.
- `core/config/providers.ts` tiene `SEARCH_PROVIDERS` (id, label, keysUrl,
  secretName, endpoint); lo schema di config deriva l'enum da lì; lo `switch` di
  `diagnoseSearch` è esaustivo, quindi un id nuovo senza backend è un errore di
  compilazione.
- `cli/search-setup.ts` scrive chiave e config e apre l'host in egress con
  `widenEgressForCapability` (ADR-0058). L'unico riferimento cablato a Tavily è
  l'esempio `pass show tavily` nel rimedio stampato.

Il seam dichiara di aspettarsi questo cambio: «the shape exists so that swapping
it is a new file and a config value rather than an edit to the tool, the
capability and the fencing all at once».

## La decisione esistente

- ADR-0058: chiedere un motore è l'autorizzazione a parlargli; una sola porta
  apre chiave, config ed egress.
- ADR-0066 e `sys.search`: il modello sceglie la query, mai la destinazione;
  l'endpoint è una costante di config.
- ADR-0074: la conferma è per l'irreversibile. Una ricerca è egress gated sui
  byte della query, non un effetto irreversibile; un server MCP invece è opaco
  per il kernel e resta `reversible: 'no'`.
- `core/mcp/connect.ts`: i server MCP remoti (HTTP) sono fuori scope v1.

Nessun ADR limita la ricerca a Tavily: la scelta di un solo motore era di
ampiezza, non di sicurezza.

## Peer, per problema

- OpenClaw (docs.openclaw.ai/tools/web, letto il 2026-09-26): un solo tool
  `web_search`, provider scelto con `tools.web.search.provider` fra una quindicina
  (Brave, Tavily, Perplexity, Exa, Firecrawl, SearXNG, ...), validato contro i
  manifest dei plugin; se la chiave del provider scelto non si risolve,
  l'avvio fallisce subito.
- Hermes Agent (hermes-agent.nousresearch.com, guida Web Search e plugin
  WebSearchProvider, letti il 2026-09-26): un solo `web_search`, backend scelto
  con `web.search_backend` fra una decina, Keenable e Tavily compresi; tutti i
  provider sono plugin sotto `plugins/web/<name>/`.

Entrambi confermano la forma: un tool, un provider scelto in config. Entrambi
mettono i provider in plugin, non nel core.

## Evidenza contraria

- Nucleo stretto (ARCHITECTURE, sezione 9): le capacità stanno ai bordi. Un
  secondo motore allarga il codice di core. Mitigazione: il seam è già in core e
  pensato per più voci; il modello a pacchetti delle estensioni non esiste ancora
  (post DAY-1). Resta una domanda per il maintainer.
- Hermes, senza credenziali, instrada le ricerche a rotazione su un anello di
  provider senza chiave (Exa, Parallel, Firecrawl, Keenable); un utente l'ha
  segnalato come instradamento silenzioso delle ricerche verso terzi (thread
  r/hermesagent, 2026). Per Muffin è un argomento **contro** la modalità senza
  chiave e contro ogni selezione automatica: il motore lo nomina l'owner.
- La documentazione Keenable è del fornitore: dichiara integrazioni e qualità,
  non le misura. La qualità dei risultati rispetto a Tavily non è misurata qui;
  la privacy policy di Keenable non è stata valutata (le query escono verso un
  terzo, come con Tavily).
- La modalità pubblica di Keenable (`/v1/search/public`) richiede di dichiarare
  il nome dell'applicazione con `X-Keenable-Title`: è una scelta di identità del
  progetto verso un terzo, non tecnica.

## Tabella delle alternative

| | Candidata | Pro | Contro |
|---|---|---|---|
| A | Keenable come seconda voce di `SEARCH_PROVIDERS`, un backend accanto a `tavilyBackend` | nessun cambio di policy; una ricerca a taint basso non chiede; un tool solo; stessa recinzione e stesso egress | un secondo motore nel core |
| B | Restare su MCP e cambiare la policy MCP per i tool di sola lettura | generale per ogni MCP di ricerca | le annotazioni MCP (`readOnlyHint`) le dichiara il server, non l'owner: fidarsene darebbe autorità a un testo non fidato; un mapping sigillato per tool sarebbe una nuova superficie del Root of Trust, CRITICAL e con ADR |
| C | Nessun motore nativo nuovo, solo MCP con conferma | zero codice | una conferma per ogni ricerca, giudicata inusabile nell'uso reale |
| D | Aspettare il modello a estensioni e farne un pacchetto | allineato al nucleo stretto | non esiste; rimanda un bisogno misurato senza data |

Scelta: **A**, con chiave obbligatoria e selezione esplicita (`muffin search
keenable`), senza modalità pubblica, senza `fetch`, senza parametri extra
(`mode`, filtri temporali) esposti al modello. Il parametro `mode` resta al
default del fornitore.

## Cosa falsificherebbe la scelta

- Un test di wiring in cui, con `provider: 'keenable'`, chiave presente e
  `api.keenable.ai` in egress, `web_search` **non** si registra, oppure si
  registra senza l'host in egress: la claim è falsa.
- Una decisione del kernel che chiede conferma all'owner a taint 0 per
  `sys.search` con backend Keenable, o che non la chiede sopra `searchMaxTaint`.
- Su un'installazione reale con chiave valida: un turno dell'owner che cerca sul
  web e riceve risultati recintati di tier 3 senza conferma. Se chiede conferma,
  o se i risultati non arrivano recintati, la scelta va rivista.
- Criterio di rimozione: se il maintainer decide che i motori appartengono al
  futuro modello a estensioni, questa voce migra lì invece di restare nel core.
