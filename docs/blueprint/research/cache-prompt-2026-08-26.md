# La cache di prompt non prende — misura, non diagnosi (26/08/2026)

Trovato accendendo `muffin trace turn <id>` (PR #133): la vista per step mostra
i token di ogni chiamata, e la colonna «da cache» è quasi sempre zero.

Questo file registra **cosa è stato misurato** e cosa quella misura esclude.
Non conclude quale sia la causa: la misura che la deciderebbe è in fondo, e non
è stata fatta.

## Il numero

Tutte le `chat_call` vere di una giornata sull'installazione dell'owner
(`~/.muffin/traces/2026-08-26.jsonl`), modello `qwen/qwen3.8-27b` via
OpenRouter:

- **18 chiamate**, 174012 token di input complessivi;
- **4800** letti da cache, cioè **2.8%**;
- **17 su 18** riportano l'attributo `muffin.usage.cache_read_tokens`, quindi la
  strumentazione c'è e funziona: il valore è zero, non assente;
- **una sola** chiamata ha letto dalla cache.

## Cosa esclude, e come

Il turno `131af17c8652` ha fatto undici chiamate. Le prime quattro:

| iterazione | input | letti da cache | intervallo dalla precedente |
|---|---|---|---|
| 1 | 5607 | 0 | — |
| 2 | 5759 | 0 | 0.0s |
| 3 | 5938 | **4800** | 0.0s |
| 4 | 6093 | 0 | 0.0s |

Quattro chiamate **nello stesso secondo**, con un prefisso condiviso di oltre
cinquemila token che cresce di poche centinaia per volta. Una legge dalla cache
e tre no.

Questo esclude le due spiegazioni che verrebbero in mente per prime:

- **Non è la scadenza della cache.** Un TTL, qualunque sia, non scade fra due
  chiamate a 0.0s di distanza.
- **Non è un prefisso instabile da parte nostra.** Se il prefisso cambiasse a
  ogni chiamata — un orario nel system prompt, un richiamo di memoria diverso —
  non leggerebbe dalla cache *nemmeno* la terza. E se cambiasse solo in coda,
  l'input non crescerebbe in modo monotono da 5607 a 6093.

Esclude anche che manchi il meccanismo: `agent/providers/openai-compat.ts`
manda i marcatori `cache_control` quando l'endpoint è OpenRouter
(`explicitCache`, deciso per hostname), ed è una scelta presa apposta dopo aver
verificato la documentazione OpenRouter l'11/08.

## L'ipotesi, dichiarata come tale

Resta compatibile con i dati che la cache sia scritta su un'istanza upstream e
riletta da un'altra: OpenRouter bilancia fra istanze dello stesso modello, e una
cache scritta su una non è leggibile dall'altra. Spiegherebbe l'irregolarità —
un colpo ogni tanto, senza rapporto con la distanza temporale.

**Non è dimostrato.** È l'ipotesi che i dati non smentiscono, il che è molto
meno di una causa.

## La misura che deciderebbe

Mandare la stessa identica richiesta due volte di fila e leggere, nella risposta
di OpenRouter, **quale provider upstream** ha servito ciascuna (OpenRouter lo
riporta nel corpo della risposta). Se i due colpi vengono da istanze diverse e
il secondo non legge dalla cache, l'ipotesi regge; se vengono dalla stessa
istanza e comunque non legge, la causa è altrove e questo file va riscritto.

Finché quella misura non c'è, l'unica affermazione difendibile è quella del
titolo: la cache non prende, e non è colpa del nostro prefisso.

## Un buco nei dati, notato di passaggio

Una `chat_call` (`74d13c9c8379`) porta `input_tokens: 0`, `output_tokens: 0` e
**nessun** attributo di cache. Una chiamata che non registra consumo non è una
chiamata gratis: è una chiamata di cui non sappiamo il costo. Da guardare
insieme al resto, non qui.
