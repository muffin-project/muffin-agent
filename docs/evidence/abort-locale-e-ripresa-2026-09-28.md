# L'abort locale letto come risposta vuota, e la ripresa che non riprendeva — 2026-09-28

Misura in sola lettura su `~/.muffin` (database, `traces/`, `gateway.err`) più
una probe sull'SDK installato. Serve ADR-0092; non contiene testo dell'owner.

## 1. La forma del guasto

Il 28/09 fra le 08:44 e le 08:49 un turno Telegram (`d3897100…`) ha bruciato
due lease senza rispondere:

| lease | chiamate | durata di ogni chiamata | classe | upstream |
|---|---|---|---|---|
| 0 | 4 | 30.037, 30.019, 30.007, 30.003 s | `provider_empty` | Alibaba |
| 1 | 4 | 30.006, 30.002, 30.006, 30.005 s | `provider_empty` | Alibaba |

Tutte con `usage = 0/0`, `first_activity_at` assente, `stop_reason: error`.
La distribuzione delle `provider_empty` dal 19/09 (20 lease) è tutta fra
30.000 e 30.037 s, **su cinque upstream diversi** (Alibaba, Reka, Wafer,
DekaLLM, DeepInfra). Cinque operatori indipendenti non si allineano al
millisecondo: quel timer era locale, non loro.

## 2. Perché l'abort diventava un completamento

`ExecutionBudget` armava un watchdog di prima attività a 30 s
(`firstActivityTimeoutMs`, profilo `consumer-local`) che abortiva la chiamata.
L'SDK OpenAI v7.9.0 termina **pulitamente** l'iterazione SSE abortita:
`Stream.fromSSEResponse` cattura l'`AbortError` e fa `return` invece di
rilanciare (sorgente in `node_modules/openai/core/streaming.js`). Probe diretta
sul pacchetto installato, con un server SSE che non invia dati e un abort dopo
1,5 s:

```json
{ "kind": "clean-end", "events": 0, "ms": 1506 }
```

Quindi `chatStream` usciva dal `for await` senza eccezione, `finish_reason`
nullo, zero token: `classifyProviderFailure` leggeva `provider_empty` — la
forma che OpenRouter documenta per un upstream che non genera contenuto — e il
loop spendeva tre re-drive contro la stessa macchina prima di cedere la lease
con la diagnosi sbagliata («il provider ha restituito risposte vuote»).
La coda vera del modello (312 chiamate riuscite, `ttft_ms`): mediana 5,5 s,
p90 20,9 s, massimo 29,7 s — il taglio a 30 s colpiva la coda legittima.

## 3. La ripresa che non riprendeva

Alle 08:47:11 l'owner ha scritto «Riprendi» 11 secondi dopo la diagnosi. Il
resolver ha trovato **due** righe continuabili nella stessa sessione: quella
appena invitata e una di 20 ore prima (`af0b6bca…`, ancora dentro la TTL di
24 h). Due candidati → domanda di disambiguazione con riassunti che dicevano
solo «turno provider_empty (…, N tool call)», senza il testo della richiesta.
L'owner ha risposto «1», la lease nuova è partita, e ha rieseguito la stessa
chiamata: altri 4 × 30 s, di nuovo continuabile.

Il database aveva, al 28/09, **8 righe `continuable`**, la più vecchia del
19/09. Una di quelle — il turno `ca216a6e55d2…`, legato all'update
`99666230` del 19/09 22:38 — non era mai stata continuata: `recover()`
rimandava l'update a ogni avvio del gateway perché lo stato non era `done`,
e nessuno l'avrebbe mai reso `done` senza un «riprendi» entro la TTL.
`gateway.err` lo registrava da nove giorni: `evento 99666230 già legato al
turno ca216a6e55d2 (continuable) — rimando`.

## 4. Difetto collaterale di wiring

La domanda di disambiguazione veniva scritta con un id nuovo
(`randomBytes(16)`), mentre la composition dell'evento puntava all'id
reclamato dal bind: `telegram:update:99666304 → aafed382…` **senza riga in
`turns`**, mentre la riga vera (`791b913b…`, la domanda consegnata) restava
`delivery = pending`. Conseguenza: bookkeeping di consegna sul fantasma,
`doctor` che segnala una consegna non confermata, e un crash nella finestra
fra bind e domanda che avrebbe rifatto la domanda invece di risolverla.

## 5. La risposta della ripresa non arrivava (trovato in revisione, 28/09)

Il piano write-ahead di Telegram è congelato per turno. Nella catena reale la
lease 0 consegna il diagnostico di cessione sotto il turno A; il «riprendi»
lega l'evento ad A; la nuova lease produce la risposta; `deliverTo(A, …)`
trova le parti di A tutte `sent`, le salta e risponde `sent` — **la risposta
non viene mai inviata e il turno risulta consegnato**. Riprodotto con un test
sul percorso reale del connettore (diagnostico pre-congelato per la lease 0,
«riprendi» accettato, risposta assente da `h.sent`): rosso prima della
correzione, verde dopo. Il difetto esiste da P0-B e non era mai emerso perché
l'unico test di continuazione seminava la riga senza far passare il
diagnostico dalla WAL.

## 6. Cosa non era il problema

I 6 «turni con risposta senza indirizzo» del banner (`delivery =
'undeliverable'`) sono turni CLI del 27/08–08/09, stabili e vecchi: rumore,
non il guasto di oggi.
