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
  esaurito (`details.quota`, 402), accesso o credenziale (401, 403,
  `reauthentication`, `credentials`), troppe richieste (429), servizio giù (5xx,
  408/409, connessione mai stabilita). Errori della richiesta (400/404/422,
  output del modello non leggibile, abort, tetti locali) si rilanciano: un altro
  provider non renderebbe giusta quella richiesta.
- L'anello caduto va in pausa fino all'orario che il provider dichiara (reset del
  piano, `Retry-After`), al massimo un giorno; altrimenti 15 minuti per quota e
  accesso, 60 secondi per i limiti di frequenza, 30 per i guasti. Allo scadere
  si riprova per primo. Se tutti sono in pausa si provano comunque in ordine.
- Uno stream si sposta di anello solo prima del primo evento: dopo, cambiare
  provider cucirebbe due risposte. I ragionamenti cifrati restano all'anello
  che li ha prodotti.
- La spesa si conta come l'anello che ha risposto (`ChatResult.route`): una
  corsia ChatGPT che ripiega su un endpoint a consumo non resta a $0 e i tetti
  di budget valgono anche per i ripieghi.
- Lo stato (anello attivo, pause, motivo, orario) sta in
  `<home>/provider-chain.json`, senza segreti. `muffin doctor` e `muffin fallback`
  lo leggono e dicono chi risponde e perché. La sonda online di `doctor` prova
  solo l'anello 1: un ripiego che risponde non deve far sembrare sano un
  account fermo.
- Il nucleo non nomina provider. Gli anelli si costruiscono dal catalogo
  (`core/config/providers.ts`) con `muffin fallback add <provider> <modello>
  [--light] [--account <id>]`; un secondo account è un altro nome segreto.
  Nessun comando conversazionale scrive la catena: un anello nomina un endpoint
  e un riferimento a un segreto, la stessa fiducia di `provider`.
- xAI entra nel catalogo come API per sviluppatori (`https://api.x.ai/v1`,
  OpenAI-compatibile, chiave da console.x.ai, a consumo).

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

Il profilo del modello resta quello dell'anello 1 anche quando risponde un
ripiego. Un secondo account ChatGPT nella stessa catena non è supportato: il
file ChatGPT ha un profilo attivo per installazione.

## Falsificatore

Va rifatta se un errore della richiesta passa a un altro anello, se un turno
servito da un ripiego a consumo viene contabilizzato a $0, se lo stato su disco
contiene un segreto, o se una corsia senza ripieghi smette di essere l'adapter
nudo di prima.
