# A/B sampling su Gemma 4 — 2026-09-18 (issue #498)

Harness `evals/reasoning-ab/` (bracci T0/DEF/T07), modello
`google/gemma-4-31b-it` via OpenRouter, light `gemma-4-26b-a4b-it`, runtime di
produzione, task T3c(x2)/T4c(x2)/T1(x1). Spesa: **$0.11** (18 turni; Gemma
costa ~15x meno di Qwen a turno).

## Risultati

| braccio | T3c | T4c r1 | T4c r2 | T1/T2 |
|---|---|---|---|---|
| T0 (temp 0, status quo) | PASS | **FAIL** (3 iter, 1 tool, narra) | PASS (5/3) | PASS |
| DEF (default provider) | PASS | PASS (4/2) | PASS (5/3) | PASS |
| T07 (temp 0.7) | PASS | **FAIL** (3 iter, 1 tool, narra) | PASS (4/3) | PASS |

## Lettura

- **Solo DEF fa 6/6.** Entrambi i bracci a temperatura pinnata — 0 *e* 0.7 —
  falliscono T4c r1 nella stessa forma: stop dopo 1 tool call, prosa che
  descrive l'azione non fatta, `answered`, zero recovery. Non è il valore a
  essere sbagliato: è il pinnare. Il default del provider (per Gemma: il suo
  stesso 1.0 canonico, scelto da chi serve il modello) lascia la varianza con
  cui il modello arriva alle call invece di commettere presto sulla narrazione.
- L'ipotesi ingenua («0.7 è canonico, mettiamo 0.7») è falsificata dallo
  stesso dato che falsifica lo status quo. Minimo intervento vince.
- Caveat onesto: n=2 repliche su T4c, T0-r2 e T07-r2 passano — lo stallo è
  stocastico. Ma la direzione è coerente (2 fail su 4 turni pinnati, 0 su 6
  a default) e il costo di sbagliare è asimmetrico: `model-default` non forza
  niente, è ciò che ogni altro utente OpenRouter riceve.

## Decisione

Nuovo profilo `gemma` (match `*gemma*`, tolto da consumer-local):
`sampling: model-default`, resto identico a consumer-local (thinking
adaptive, cascade completa con requireTool, 21 tool, nessun tetto numerico,
horizon 15m). Effetto collaterale voluto: la light Gemma perde il
`temperature: 0` hardcoded delle corsie memoria (strippato come frontier) —
per la stessa ragione misurata qui; il determinismo memoria resta non
misurato per Gemma (gap noto).
