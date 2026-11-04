# A/B execution policy, braccio D — pilot su qwen3.8-27b via OpenRouter

Misurato il 02/10/2026 per #498 (run `evals/reasoning-ab`, bracci A/B/C/D su
`qwen/qwen3.8-27b`, 4 task tool identici per braccio). Dura finché dura: un
pilot da 4 task giocattolo, un campione per cella.

## Bracci

- `A` — profilo shipped così com'è (`consumer-qwen3`, `xhigh`) + `deterministic`
- `B` — profilo shipped + `model-default` (nessuna temperature sul filo)
- `C` — `thinking: 'off'` + `deterministic`
- `D` — `thinking: 'low'` + `deterministic` (esprimibile dalla #789)

## Risultati

| braccio | pass | out T1 | out T1b | out T2 | out T3 | muro T2 | $ braccio |
|---|---|---|---|---|---|---|---|
| A xhigh | 4/4 | 310 | 363 | 744 | 184 | 41 s | 0.35 |
| B xhigh+model-default | 4/4 | 334 | 635 | 667 | 196 | 19 s | 0.33 |
| C off | 3/4 (T1 risposta sbagliata) | 92 | 94 | 183 | 73 | 11 s | 0.31 |
| D low | 4/4 (al re-run) | 389 | 549 | 749 | 155 | 25 s | 0.35 |

Spesa totale: $1.21 (primo giro) + $0.35 (re-run D) ≈ $1.56, dentro il tetto
`--max-usd` di ogni run.

## Lettura

1. `low` contro `xhigh` non cambia niente di misurabile qui: stessi pass
   (4/4 entrambi), token in uscita e muri indistinguibili (T2: 749 vs 744).
   Abbassare il default di conversazione non compra nulla su questi task.
2. L'unico braccio che risparmia davvero (`off`: ~3× meno output, ~3× più
   veloce su T2) è anche l'unico che sbaglia una risposta facile (T1: somma
   sbagliata con 92 token in uscita). È la stessa classe di regressione
   dell'evidenza negativa dell'owner che ha motivato la #498.
3. Il primo giro di D è contaminato e scartato: T2/T3 morti con HTTP 401
   (trasporto, stesso wire dei task passati). Re-run pulito 4/4.

## Decisione

Il default shipped resta `xhigh` (`consumer-qwen3`): l'A/B non giustifica né
`off` (rischio qualità misurato) né `low` (nessun guadagno misurato). La #498
resta aperta per una misura sulla conversazione vera, dove il ragionamento
pesa più che su task tool da quattro righe.
