# ADR-0105 — Più account sono profili, non un login unico

**Stato: adottato per lo slice OpenRouter del 2026-11-04.** Amenda il rinvio
in ADR-0099 («non aggiungiamo un manager») solo per gli account dello stesso
provider. Non riapre ADR-0007 sull'abbonamento consumer Anthropic, e non
sostituisce il backend dei segreti.

## Problema

OpenRouter PKCE c'era ed era irraggiungibile. Il piano ChatGPT aveva già più
profile-id in un solo file di credenziali. Una seconda chiave OpenRouter non
si poteva elencare né scegliere. Un login solo che raccolga Claude, ChatGPT
e Grok non è il prodotto: l'owner ha tenuto Claude sulla chiave Console/API
e ha escluso un client OAuth xAI da questo slice.

## Decisione

- Il collegamento consigliato a OpenRouter è il PKCE già in
  `core/config/openrouter-oauth.ts` (loopback in locale, codice incollato in
  SSH). La chiave che torna è scritta nel backend autorevole col nome
  segreto OpenRouter. La corsia **main** diventa `openai-compat` con il base
  URL del catalogo. Light non cambia provider.
- Dopo il collegamento si esegue `verifyInferenceRoute`. «Configurato» non
  viene detto «funzionante» se la prova non passa. La chiave resta.
- Un account in più è un profilo: id, provider, metodo (`oauth-pkce`,
  `api-key`, `chatgpt-plan`) e nome del segreto. I token ChatGPT restano nel
  file ChatGPT; l'indice non li copia. `muffin auth list|status|switch`
  legge i due posti. `switch` cambia solo `apiKeyRef` delle corsie che usano
  già quel provider.
- Anthropic resta una chiave Console/API. `muffin auth login anthropic` e
  ogni login xAI/Grok rifiutano. Nessuna lettura di `~/.claude`, nessun
  `client_id` di Claude Code.
- Invio vuoto su un segreto non salta in silenzio: chiede conferma. Ctrl+D
  annulla subito.

## Alternative

Il registro di connessioni che ADR-0099 aveva rinviato, e un keychain nuovo
prima di ogni login, risolvono un deposito che questo slice non deve
riscrivere. Limitarsi a una sola chiave OpenRouter lascia falso l'esito
«più account elencabili».

## Falsificatore

Va rifatto se la prova di una corsia modifica provider o modello dell'altra,
se l'indice arriva a contenere una chiave, o se OpenRouter smette di
restituire una chiave usabile dall'adapter openai-compat. Un OAuth claude.ai
richiede una decisione nuova: questa ADR non lo autorizza.
