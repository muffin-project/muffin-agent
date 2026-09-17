# A/B execution policy su Qwen 3.8 — pilot 2026-09-18 (issue #498)

Harness: `evals/reasoning-ab/` (commitato, riusabile). Modello
`qwen/qwen3.8-27b` via OpenRouter, runtime di produzione su home usa-e-getta,
4 task file-only deterministici, approver allow-all, timeout 6m/turno.
Spesa pilot: **$0.93** (12 turni).

## Risultati

| braccio | task | esito | iter | tool | rec | out | $ | muro |
|---|---|---|---|---|---|---|---|---|
| A adaptive+det | T1 | PASS | 3 | 2 | 0 | 477 | .0736 | 14.8s |
| A | T1b | PASS | 3 | 2 | 0 | 333 | .0735 | 11.2s |
| A | T2 | PASS | 5 | 4 | 0 | 555 | .1252 | 20.9s |
| A | T3 | PASS | 2 | 1 | 0 | 197 | .0489 | 6.3s |
| B adaptive+def | T1 | PASS | 3 | 2 | 0 | 399 | .0729 | 12.6s |
| B | T1b | PASS | 3 | 2 | 0 | 582 | .0756 | 17.5s |
| B | T2 | PASS | 5 | 4 | 0 | 635 | .1275 | 15.8s |
| B | T3 | PASS | 2 | 1 | 0 | 208 | .0490 | 7.4s |
| C off+det | T1 | PASS | 3 | 2 | 0 | 122 | .0705 | 5.6s |
| C | T1b | PASS | 3 | 2 | 0 | 94 | .0716 | 3.8s |
| C | T2 | PASS | 4 | 3 | 0 | 161 | .0965 | 6.3s |
| C | T3 | PASS | 2 | 1 | 0 | 69 | .0478 | 2.9s |

## Lettura

- **Successo identico (12/12) in tutti i bracci.** Iterazioni e tool call
  uguali entro il rumore (A≈B esatti; C una iterazione in meno su T2).
  Nessuna risposta vuota e zero recovery in nessun braccio: la patologia del
  15-16/09 non si è riprodotta — dipende dal prompt/contesto, non da questa
  manopola.
- **C (`off`) è 2-3x più veloce e 3-5x più parco in output**, a pari successo
  su task tool. Il risparmio in $ è modesto (l'input da recall domina).
- **B non si distingue da A** su task tool: la temperature tocca il sapore
  del campionamento, non la capacità.
- **Non misurato: la qualità conversazionale** — il dominio della regressione
  del 27/08 (`off` = risposte che rimbalzano, history non vista). Il pilot
  non può quindi raccomandare `off` come default.

## Decisione

**Resta `adaptive` + `deterministic` per consumer-local (nessun cambio).**
La #498 vietava un default `off` senza A/B: l'A/B c'è e non basta
(n=1 per cella, solo task file). Rivalutare `off` (o per-corsia: off sulla
memoria già così, adaptive in conversazione) solo con misura su task
conversazionali.

## Gap registrati (non in questa slice)

- `effort`/`maxTokens` senza superficie in profilo/config: il braccio D della
  issue non è eseguibile finché non esiste la manopola.
- `REASONING_HEADROOM` resta: le corsie memoria lo usano con `off` chiesto da
  sé, e il pilot non le tocca.
- Riusare l'harness per la domanda Gemma-sampling (temperature 0 vs default).
- Nota di igiene: un `consolidamento: fallito — database connection is not
  open` a cavallo fra bracci (teardown della home usa-e-getta, artefatto
  dell'harness, metriche integre).
