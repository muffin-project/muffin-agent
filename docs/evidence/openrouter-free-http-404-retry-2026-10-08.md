# Retry di un HTTP 404 sul router OpenRouter Free — 2026-10-08

## Domanda e claim

Quando `openrouter/free` restituisce HTTP 404 prima di una completion, Muffin
può ripetere la stessa richiesta entro il budget di trasporto durevole già
esistente, senza rendere retryable i 404 di modelli fissi o altri endpoint?

Profilo: STANDARD. La modifica è reversibile e resta nel percorso ordinario dei
retry; non cambia policy, provider, modello configurato, limiti di spesa o schema
durevole.

## Fallimento osservato e percorso attuale

Il percorso installato ha mostrato HTTP 404 terminali su `openrouter/free` prima
di token di risposta o chiamate a tool. In Muffin, l'SDK OpenAI Node ha i retry
disabilitati; `agent/providers/openai-compat.ts` converte gli status HTTP in
`ProviderError`, e `agent/loop/round.ts` ripete solo errori marcati retryable
con un contatore persistito e limitato. `wrap()` marca 408, 429 e 5xx retryable,
ma non 404, quindi il turno si chiude senza provare di nuovo la route dinamica.
I dettagli dei trace restano nell'installazione e non sono inclusi in questo
report.

## Decision table

| Opzione | Evidenza a favore | Contro / rischio |
|---|---|---|
| A. Retry HTTP 404 per ogni modello | Semplice; può recuperare un modello appena ritirato | Un 404 su un modello fisso di solito indica slug o configurazione errati; un retry non li corregge |
| B. Configurare modelli fallback | OpenRouter supporta una lista esplicita di modelli fallback | Non conserva la scelta `openrouter/free`; un fallback non vincolato potrebbe non essere gratuito e diventa un secondo routing da mantenere |
| C. Non ritentare, mostrare solo una diagnosi | Mantiene la semantica conservativa dei 4xx | Lascia terminale un errore di upstream sulla route che seleziona un modello free compatibile a ogni richiesta |
| Scelta: retry solo per `openrouter/free` su OpenRouter, tranne il 404 regionale documentato | Riusa il budget durevole esistente; i modelli compatibili della route cambiano nel tempo | Invia di nuovo lo stesso prompt; non garantisce un upstream diverso e può non recuperare un guasto persistente |

OpenRouter documenta che `openrouter/free` seleziona casualmente modelli free
che soddisfano i parametri richiesti; il catalogo dei modelli free cambia nel
tempo. Il Node SDK ufficiale di OpenAI, da cui Muffin usa solo il transport,
ritenta 408, 409, 429 e 5xx, non 404. Conservare quella regola per le route
fisse e restringere l'eccezione all'alias dinamico evita di mascherare una
configurazione errata.

L'adapter mantiene un `session_id` stabile per conversazione. La documentazione
OpenRouter sullo sticky routing dice che un errore del provider memorizzato non
aggiorna la cache, permettendo al tentativo successivo di essere instradato di
nuovo. Questo supporta il retry con la stessa sessione, ma non garantisce
esplicitamente che ogni 404 del router Free scelga un upstream diverso: resta
un falsificatore da verificare live.

La documentazione ufficiale sull'instradamento regionale aggiunge un caso
opposto: `us.openrouter.ai` ed `eu.openrouter.ai` restituiscono HTTP 404 con
`No endpoints found supporting your data region.` quando nessun provider
compatibile è disponibile nella regione consentita. È un limite intenzionale,
non una route upstream transitoria. L'adapter ora lascia terminale quel
caso documentato anche per `openrouter/free`; gli altri 404 dell'alias restano
retryable. Il riconoscimento usa il testo strutturato del body restituito
dall'SDK, senza cambiare la classificazione degli errori in-band.

## Accettazione e falsificatori

- Un HTTP 404 per l'alias esatto `openrouter/free` sull'host OpenRouter diventa
  retryable e attraversa `round.ts`/il contatore durevole già esistente, salvo
  il messaggio regionale documentato qui sotto.
- Il 404 documentato `No endpoints found supporting your data region.` resta
  terminale su entrambi gli host regionali, anche per `openrouter/free`.
- Un HTTP 404 per un modello fisso o per lo stesso slug su un altro endpoint
  resta non retryable.
- Un secondo tentativo riuscito chiude il turno; il contatore diminuisce una
  volta e nessun tool viene eseguito dal tentativo fallito.
- Se il retry aumenta errori terminali, duplica effetti, supera budget o non
  recupera mai la route, rimuovere l'eccezione e mantenere la diagnosi 404.

## Verifica

- Ripetuta il 2026-10-09 sul `dev` corrente (`31f1f6064e727102ecfcf12fffa0cce609901768`), dopo la fusione di #854.
- `npm test -- agent/providers/openai-compat.test.ts agent/loop/round.test.ts`:
  86 test superati. Il test del loop usa una risposta HTTP 404 e una completion
  sintetiche, e verifica retry, risposta finale e decremento singolo del budget
  persistito. Mantiene attiva la discovery reasoning predefinita del provider,
  con metadata sintetici, così il retry attraversa la stessa configurazione di
  produzione senza richieste di rete. Verifica inoltre che entrambi i POST
  mantengano l'alias `openrouter/free` e lo stesso `session_id`. Il test
  provider verifica anche che il testo regionale documentato resti terminale
  su `us.openrouter.ai` ed `eu.openrouter.ai`.
- Il tentativo Vitest dalla worktree si è fermato perché Vite non poteva creare
  il file temporaneo accanto alla config (`EPERM`). Lo stesso comando è stato
  eseguito in una copia temporanea sotto `/private/tmp`, con hash SHA-256
  identici per i due file provider e il test del loop.
- `npm run typecheck`: superato.
- `git diff --check`: superato.
- Prova live, usando la configurazione installata senza mostrarne o copiare la
  chiave e inviando soltanto contesto/tool sintetici: OpenRouter Free ha
  selezionato `cohere/north-mini-code:free` (upstream Cohere) e ha emesso una
  tool call `probe` valida. Un primo controllo testuale con tetto di 16 token
  non ha prodotto testo visibile; non è stato contato come esito riuscito.
- Prova live di `runRounds` con un 404 sintetico iniettato sul primo POST e i
  POST successivi diretti alla rete: il turno è terminato `answered` in 3
  iterazioni; i tre POST hanno mantenuto `openrouter/free` e la stessa
  `session_id`; il budget durevole è passato da 2 a 1; il tool sintetico è
  stato eseguito una volta con `muffin-free-route` e il modello ha riportato
  `probe-result:muffin-free-route`. La route installata ha mantenuto
  `data_collection: deny`. Il DB era in-memory e la directory temporanea è
  stata rimossa al termine.
- Prova live aggiuntiva con il `fs_read` prodotto da `makeFsTools` e un file
  temporaneo confinato alla sua `FsScope`: il tool è stato selezionato ed
  eseguito una volta; `runRounds` si è chiuso `answered` in 3 iterazioni e la
  risposta conteneva il marker esatto. La directory è stata rimossa al termine.
- Prova live del percorso di discovery su `runTurn`, con database in memoria,
  stato temporaneo e `openrouter/free` configurato con `data_collection: deny`:
  impostando il solo limite dello schema a 1, la prima richiesta reale ha
  esposto esclusivamente `capability_search`; il modello l'ha chiamato, la
  richiesta successiva ha esposto esclusivamente `fs_read`, che il modello ha
  chiamato sul file sintetico nella `FsScope` temporanea. L'handler reale è
  stato eseguito una volta, il turno ha chiuso `answered` in 3 iterazioni e la
  risposta finale conteneva il marker esatto. La route ha selezionato due
  upstream free durante il turno; nessun contenuto di memoria o dato personale
  è entrato nel prompt, e lo stato temporaneo è stato rimosso.
- Prova live aggiuntiva del bootstrap completo `buildRuntime` + `runTurn` su una
  home/workspace temporanei: l'installazione effimera ha usato il provider
  OpenAI-compatible configurato su `openrouter/free` con `data_collection:
  deny` e Ollama esplicitamente solo come embedder locale. Con il limite di
  esposizione impostato a uno per il probe, il modello ha chiamato
  `capability_search`; la richiesta seguente ha esposto `fs_read`, che è stato
  eseguito dall'handler reale sul solo `probe.txt` temporaneo. Il turno è
  terminato `answered` e la risposta conteneva il marker esatto. OpenRouter ha
  selezionato upstream free Novita, AtlasCloud e Cohere nel turno. La memoria
  effimera era vuota, quindi non è stata inviata alcuna richiesta di embedding;
  il test non ha incluso memoria o dati personali.
- Resoconto storico non riproducibile al momento: una verifica sintetica
  separata aveva riportato lo stesso percorso `OllamaEmbedder` → indice vettoriale
  → recupero parafrasato, ma senza trace, log o output conservati. Il 2026-10-09
  il probe sintetico eseguito dentro il sandbox Codex è terminato con HTTP 500
  (`failed to create command queue` / allocazione Metal); anche `num_gpu: 0`
  per singola richiesta non ha aggirato il backend, e il server temporaneo è
  stato fermato. Fuori dal sandbox Codex, lo stesso giorno, la verifica
  riproducibile del percorso di Muffin ha usato `OllamaEmbedder`
  (`qwen3-embedding:0.6b`, 1024 dimensioni), `MemoryStore` e `VectorIndex` con
  SQLite in-memory: ha indicizzato un episodio sintetico, scritto un vettore e
  recuperato quell'episodio con una query parafrasata (`indexed=1`, `vectors=1`,
  `hits=1`). Il modello era già installato; nessun download, configurazione o
  dato persistente è stato usato. Il backend locale per gli embeddings è quindi
  **Live Verified fuori dal sandbox Codex**; il test `buildRuntime` sopra non
  aveva episodi e non ha richiesto embeddings, e il database personale non è
  stato letto o modificato.
- Dogfood live sull'installazione, 2026-10-09: `muffin run` è stato inoltrato
  al Gateway attivo della build `31f1f6064e72` con una richiesta sintetica di
  leggere un file temporaneo nel workspace e ripeterne il marker. La trace
  conferma `fs_read` una volta con `fs.read=allow`, due chiamate chat a
  `openrouter/free` (upstream AtlasCloud e Novita), stato `answered` e marker
  esatto; il file e la directory temporanei sono stati rimossi. La normale
  fase `memory.recall` è comunque avvenuta: il prompt e il file erano
  sintetici, ma non si assume che il contesto effettivo fosse privo di memoria
  personale. La config installata, letta senza segreti, ha
  `provider.routing.dataCollection=deny`; nessun contenuto di memoria o ID
  trace è stato copiato in questo documento. Questo verifica il percorso
  installato Gateway → provider → discovery/tool → risposta su un file
  sintetico, non il completamento di un'attività personale o l'uso di account.
- Stato sandbox sull'installazione: il controllo host generale Seatbelt non
  sostituisce il self-test dei hook Git. Il `doctor` della build installata
  restituisce `git_hooks_unprotected` e tiene `shell_run` e i job disabilitati;
  nessuna shell dell'agente è stata invocata nel dogfood sopra. Il fix hook è
  stato integrato in `dev` da #878 (`0d101d6343feba30815759a0ca436a2ed59e1e1d`),
  ma l'installazione resta sulla build `31f1f6064e72`; questa prova non dichiara
  accettato il percorso shell installato.
- Stato del claim di retry: **Implemented / Wired / Tested**. Il percorso live
  `runRounds` ha iniettato localmente il primo HTTP 404 e inviato i tentativi
  successivi a OpenRouter Free: verifica il wiring sul provider reale, ma non
  dimostra il recupero di un 404 originato da OpenRouter. La verifica
  dell'errore upstream reale resta aperta. Le prove separate di discovery,
  `fs_read`, bootstrap, Gateway installato e vector index mantengono gli stati
  descritti sopra; il dogfood su attività personali e account personali resta
  da verificare.

## Fonti primarie

- [OpenRouter Free Models Router](https://openrouter.ai/openrouter/free):
  selezione casuale di modelli free compatibili con gli strumenti e parametri
  della richiesta.
- [OpenRouter In-Region Routing](https://openrouter.ai/blog/announcements/us-in-region-routing/):
  gli endpoint regionali restituiscono il 404 `No endpoints found supporting
  your data region.` quando nessun endpoint compatibile è disponibile nella
  regione consentita.
- [OpenRouter sticky routing](https://openrouter.ai/docs/guides/best-practices/prompt-caching):
  un errore del provider memorizzato non aggiorna la cache sticky e permette il
  rerouting al tentativo successivo.
- [OpenAI Node SDK 7.9.0 retry behavior](https://github.com/openai/openai-node/blob/v7.9.0/src/client.ts):
  status di retry del transport SDK. Muffin imposta `maxRetries: 0` e mantiene
  un solo budget applicativo durevole.
