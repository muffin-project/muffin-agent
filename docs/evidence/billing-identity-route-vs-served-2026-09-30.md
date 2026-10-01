# Identità di fatturazione: route richiesta vs modello servito

**Decisione che questo documento deve cambiare:** #499 — il seam di spesa deve
distinguere `requestedModel` (il contratto di fatturazione del provider, per
esempio `openrouter/free`) da `responseModel` (chi ha effettivamente servito,
per esempio `qwen/...`), senza perdere l'osservabilità del secondo.

**Osservato su** `dev` @ `2bd71e59` (2026-09-30, ricerca delegata read-only;
il merge di #790 successivo tocca solo `.github/workflows/install.yml`).
Riproduzione: script in `/tmp/repro499/red-before.mts` che importa i moduli
reali del repo (`OpenAICompatProvider`, `lightLane`, `runTurn`, `costUsd`) con
un provider finto iniettato: nessuna chiamata di rete.

## La catena di produzione (file:riga)

- **Richiesta**: il main loop conosce il modello richiesto in `deps.model`
  (`agent/loop/types.ts:481`, costruito in `agent/runtime.ts:1372`, hot-swap a
  `:1235`); diventa `ChatCall.model` in `agent/loop/round.ts:407`. La light
  lane lo scrive in `agent/runtime.ts:1061` (consolidamento) e `:710`/`:1280`
  (reranker). **Entrambi i siti di registrazione hanno già l'identità richiesta
  in scope.**
- **Risposta**: `ChatResult.model` nasce in `agent/providers/openai-compat.ts:333`
  (non-streaming) e `:382-394` (streaming, ultimo chunk), oppure
  `agent/providers/anthropic.ts:354`. `ChatResult` non riporta il modello
  richiesto verso l'alto.
- **Spesa, main loop**: `agent/loop/round.ts:732-743` registra `model:
  result.model` — **riga 735: fattura il modello risolto**. La formula è in
  `agent/runtime.ts:615-623` (`costUsd(entry.model, entry, baseUrl)` →
  `budget.record`), con `baseUrl` del provider.
- **Spesa, light lane**: `agent/providers/light-lane.ts:241-253` registra
  `model: result.model || call.model` — **riga 244**, con un commento che
  dichiara l'invariante attuale («the price table is keyed on what served the
  request»): è l'invariante che #499 chiede di rivedere.
- **Prezzi**: `core/budget/pricing.ts:112-121` — `LOCAL_HINTS` (substring su
  `model+baseUrl`) → `null` = $0; `isOpenRouterFreeRoute` (`:99-110`, host
  esatto `openrouter.ai` + slug `openrouter/free` o suffisso `:free`) → FREE;
  famiglie `PRICES` (qwen3 $2/$6, …); altrimenti UNKNOWN $15/$75.
- **Ledger**: `core/budget/budget.ts:125-150`, tabella `spend` con una sola
  colonna `model` (l'issue rinvia il campo `requestedModel` persistito).

## Riproduzione red (osservata)

Fake OpenRouter wire: richiesta `openrouter/free`, risposta con
`model: "qwen/qwen3.8-27b"` (la forma avversaria descritta dall'issue e da
`docs/evidence/openrouter-free-accounting-2026-09-11.md`), 10k token in / 2k out:

```
== A. light lane: requested openrouter/free, served qwen ==
  LightSpend.model (cosa fattura la lane):            qwen/qwen3.8-27b
  costUsd di produzione:                              $0.032000
  se il seam tenesse requestedModel:                  $0.000000
== B. main loop: deps.model openrouter/free, result.model qwen ==
  SpendEntry.model (round.ts:735):                    qwen/qwen3.8-27b
  usd del recordSpend di produzione:                  $0.032000
```

**$0.032 > 0 falsifica oggi l'accettazione di #499 su entrambi i seam.**
Matrice di identità (solo pricing, nessuna chiamata):

```
openrouter/free        openrouter.ai/api/v1      free=true  $0
qwen/qwen3.8-27b:free  openrouter.ai/api/v1      free=true  $0
openrouter/auto        openrouter.ai/api/v1      free=false UNKNOWN $15/$75
openrouter/free        my-proxy.example/v1       free=false UNKNOWN $15/$75
qwen/qwen3.8-27b       openrouter.ai/api/v1      free=false qwen $2/$6
qwen/qwen3.8-27b       192.168.1.10:8080/v1      free=false qwen $2/$6   ← GPU LAN fatturata
qwen/qwen3.8-27b       localhost:8080/v1         price=null $0           ← proxy locale azzerato
```

Le ultime due righe sono il controesempio del maintainer: `LOCAL_HINTS` sbaglia
in **entrambe** le direzioni e non è un confine di fatturazione.

## Fonti primarie (lette 2026-09-30)

- Free Models Router (`openrouter.ai/docs/guides/routing/routers/free-router`):
  «completely free… Requests routed to free models»; l'esempio di risposta
  porta un slug `:free`.
- Auto Router (stesso sito, `routers/auto-router`): «You pay the standard rate
  for whichever model is selected» — base primaria per «per una richiesta
  exact-model, il modello servito resta l'identità di prezzo» e perché
  `openrouter/auto` non eredita il gratuito.

**Coincidenza da nominare:** lo zero di oggi dipende dalla stringa di risposta
(`:free`), non dal contratto richiesto. Una normalizzazione/alias che perde il
suffisso fattura la famiglia. Il test deve inchiodare il **contratto**, non la
stringa.

## Candidate

- **A (minimale, proposta)**: aggiungere `requestedModel` opzionale a
  `SpendEntry` e `LightSpend`; i due siti lo passano (`round.ts:732` →
  `deps.model`; `light-lane.ts:241` → `call.model`); il price seam
  (`runtime.ts:615-623`) decide il contratto: route free richiesta → FREE,
  altrimenti prezzi il `model` servito come oggi. `model` nel ledger resta il
  modello servito; l'osservabilità esiste già (`gen_ai.request.model`/
  `response.model` sugli span, `round.ts:450/751/760/788-796`). Blast radius:
  2 tipi, 2 siti, 1 seam; niente schema, niente euristiche, niente LOCAL_HINTS.
- **B (caso GPU LAN, decisione aperta)**: dichiarazione owner-only sealed
  (stessa forma di `rot/budgets.json`, non `config.json` che il modello può
  steerare) che dichiara endpoint esatti non metered; al price seam chi combacia
  → $0. Sceglie il maintainer la casa (nuovo file RoT vs esistente).
  La sopravvivenza di `LOCAL_HINTS` dopo B è materia da ADR a parte: rimuoverlo
  invertirebbe il comportamento di installazioni locali esistenti.
- **Scartate**: riscrivere `ChatResult.model` con lo slug richiesto (distrugge
  l'osservabilità che l'issue esige); fatturare sempre da `requestedModel`
  (contraddetto dalla fonte primaria dell'Auto Router: under-billing).

## Falsificatori (test red, oggi falliscono per costruzione)

Nel harness `runtime-wiring.test.ts` (buildRuntime → runTurn → budget, precedenti
`:1008-1025`): main = `openrouter/free` + baseUrl openrouter + provider stub che
risponde `qwen/...` → `budget.monthToDateUsd() === 0` e riga `model =
qwen/...`; `openrouter/auto` richiesto + qwen servito → non zero;
`openrouter/free` su baseUrl non-openrouter → UNKNOWN non zero. Gemella in
`consolidation-wiring.test.ts:280-299` per la light lane. Non-regressione:
`pricing.test.ts:23,28-29` già pinnano lo scoping per host e auto→UNKNOWN.

## Incertezze

1. Forma risolta lato provider non osservabile senza una chiave: una traccia
   reale dall'installazione owner prima della slice chiuderebbe la domanda
   «quanto è accidentale lo zero di oggi».
2. `:free` blanket non verificato per-modello.
3. Possibile fallback del free router su modelli non-free (zero sbagliato
   nell'altra direzione): non stabilito dalle fonti lette.
4. Casa della dichiarazione endpoint (candidato B): decisione owner.

## Conclusione

Il difetto è reale e riprodotto rosso su entrambi i seam di produzione; l'identità
richiesta è già in scope e già osservabile sulla traccia; la correzione più
piccola (A) è un seam a due identità senza alcuna euristica. Il caso GPU LAN
entra nel contratto di endpoint owner-only (B) e va deciso prima del codice.
