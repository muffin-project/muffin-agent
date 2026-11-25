# ADR-0110 — Una catena di provider in ordine per ogni corsia

**Stato: proposto il 2026-11-25** su richiesta dell'owner («più account in
ordine di priorità, generale per tutti i casi d'uso, così Muffin funziona
sempre»). Amenda ADR-0099 nel punto «non esistono fallback impliciti»: il
ripiego esiste, ma solo **esplicito**, scritto dall'owner. Amenda ADR-0105 per
la sola voce xAI: una chiave API xAI diventa un profilo come le altre; il login
con l'abbonamento SuperGrok/X Premium resta fuori.

## Problema

Il 2026-11-25 il piano ChatGPT dell'owner ha esaurito la quota
(`subscription_sharing_usage_limit_exceeded`). Ogni turno è fallito fino al
reset, anche con una chiave OpenRouter già configurata sulla corsia light.
Una corsia aveva una sola connessione; un account fermo fermava Muffin.

## Decisione

- Ogni corsia (`main`, `light`) è una **catena**: la sua connessione e il suo
  modello come anello 1, poi fino a quattro ripieghi in `config.fallbacks.<corsia>`,
  ciascuno `{provider, model}`. Il modello viaggia con l'anello perché uno slug
  vale solo sul suo endpoint.
- Una chiamata va al primo anello non in pausa. Si passa al successivo, **nella
  stessa chiamata**, solo per motivi dell'account o del servizio: quota o piano
  esaurito (`details.quota`, 402), accesso o credenziale (401, `reauthentication`,
  `credentials`), troppe richieste (429), servizio giù (5xx, 408, connessione mai
  stabilita, cioè `details.connection`). Errori della richiesta (400/404/409/422,
  output del modello non leggibile, abort, tetti locali, errori senza codice) si
  rilanciano: un altro provider non renderebbe giusta quella richiesta.
- **Un 403 nudo non è un problema d'account.** Su OpenRouter è un blocco di
  moderazione o di guardrail sull'input (`error.metadata.reasons`,
  `flagged_input`): passarlo a un altro anello aggirerebbe la moderazione, e
  mettere in pausa l'anello fermerebbe l'account per un messaggio. Si rilancia,
  senza pausa. Un 403 conta come accesso solo se l'adapter lo ha già
  classificato (`details.reauthentication`/`credentials`).
- Se anche i ripieghi rifiutano, l'errore mostrato è **quello dell'anello 1**,
  il motivo vero del guasto; il rifiuto del ripiego (es. 404 per uno slug
  sbagliato) resta in `lastFallbackError` e `muffin fallback` lo segnala.
- Fa eccezione un guasto passeggero sull'ultimo anello provato: se è un 5xx, un
  429 o una connessione caduta che l'adapter dichiara ritentabile, esce quello,
  così il backoff del loop e della corsia leggera riprova invece di chiudere il
  turno con "piano esaurito". Le pause di tutti gli anelli restano registrate.
- L'anello caduto va in pausa fino all'orario che il provider dichiara (reset del
  piano, `Retry-After`), al massimo un giorno; altrimenti 15 minuti per quota e
  accesso, 60 secondi per i limiti di frequenza, 30 per i guasti. Allo scadere
  si riprova per primo. Se tutti sono in pausa si provano comunque in ordine.
- Uno stream si sposta di anello solo prima del primo evento: dopo, cambiare
  provider cucirebbe due risposte. I ragionamenti cifrati restano all'anello
  che li ha prodotti: ogni risposta è marcata con l'anello che l'ha servita, e
  verso un altro anello si tolgono sia la continuazione in `providerMetadata`
  sia i blocchi `thinking`/`redacted_thinking` firmati di Anthropic (la firma
  vale solo per l'account che l'ha emessa).
- La forma della richiesta segue l'anello che servirà: `kind` della catena è
  quello del prossimo anello, così le corsie di memoria (judge, extract,
  rerank) chiedono il ragionamento nel dialetto giusto. Un ripiego che non sa
  onorare `thinking`/`reasoning` li riceve omessi; l'anello 1 resta rigoroso.
- La spesa si conta come l'anello che ha risposto (`ChatResult.route`): una
  corsia ChatGPT che ripiega su un endpoint a consumo non resta a $0 e i tetti
  di budget valgono anche per i ripieghi.
- Lo stato (anello attivo, pause, motivo, orario) sta in
  `<home>/provider-chain.json`, senza segreti. `muffin doctor` e `muffin fallback`
  lo leggono e dicono chi risponde e perché. La sonda online di `doctor` prova
  solo l'anello 1: un ripiego che risponde non deve far sembrare sano un
  account fermo. Degradato vuol dire «l'anello 1 è in pausa adesso», letto dal
  file anche dopo un riavvio; una pausa scaduta non lo è più.
- Le pause si tolgono da sole quando l'owner sistema l'account: un nuovo
  segreto (`muffin secret set`, login OpenRouter) o un nuovo login ChatGPT
  azzera le pause degli anelli che usano quel riferimento; `muffin fallback
  reset [--light|--main]` le azzera tutte. Un processo in corsa rilegge il file
  quando cambia (mtime), quindi il reset vale dal messaggio successivo.
- Lo stato si scrive in modo atomico (file temporaneo + rename); su due
  processi vince l'ultimo che scrive, per corsia: è uno stato d'avviso, non un
  registro.
- Il nucleo non nomina provider. Gli anelli si costruiscono dal catalogo
  (`core/config/providers.ts`) con `muffin fallback add <provider> <modello>
  [--light] [--account <id>]`; un secondo account è un altro nome segreto.
  Nessun comando conversazionale scrive la catena: un anello nomina un endpoint
  e un riferimento a un segreto, la stessa fiducia di `provider`.
- xAI entra nel catalogo come API per sviluppatori (`https://api.x.ai/v1`,
  OpenAI-compatibile, chiave da console.x.ai, a consumo), con i prezzi di
  listino in `core/budget/pricing.ts` (docs.x.ai, 2026-11-25).

## Alternative rifiutate

- **Login con l'abbonamento SuperGrok/X Premium.** xAI lo ha annunciato per
  OpenCode e Kilo Code, ma non pubblica un client OAuth né un programma per
  agenti terzi: chi lo fa (OpenCode, Hermes, OpenClaw) riusa il `client_id` del
  Grok CLI, contro un host proxy diverso dall'API pubblica, e xAI decide lato
  server quali account ricevono token (403 segnalati su piani standard). È una
  decisione dell'owner, non un dettaglio: questa ADR non la prende.
- **Un router esterno** (OpenRouter come unico ingresso): non copre l'account
  ChatGPT né un secondo account dello stesso provider.
- **Riprovare lo stesso anello più a lungo**: è quello che falliva.

## Limiti

Il profilo del modello (finestra di contesto, strumenti) resta quello
dell'anello 1 anche quando risponde un ripiego. Un secondo account ChatGPT nella stessa catena non è supportato: il
file ChatGPT ha un profilo attivo per installazione.
Due casi noti falliscono in modo sicuro o per difetto: un passaggio Anthropic → Anthropic a metà di un giro di strumenti con il ragionamento esteso riceve un 400 (il blocco `thinking` dell'altro anello viene tolto; il turno resta un rifiuto con l'errore del principale); e un prompt xAI da 200k token in su viene contato alla tariffa sotto i 200k, cioè meno di quanto xAI fattura.

## Falsificatore

Va rifatta se un errore della richiesta o un blocco di moderazione passa a un
altro anello o lo mette in pausa, se un turno
servito da un ripiego a consumo viene contabilizzato a $0, se lo stato su disco
contiene un segreto, o se una corsia senza ripieghi smette di essere l'adapter
nudo di prima.
