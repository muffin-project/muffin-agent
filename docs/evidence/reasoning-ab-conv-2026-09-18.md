# A/B conversazionale su Qwen 3.8 — round 2, 2026-09-18 (issue #498)

Harness v2 in `evals/reasoning-ab/` (task multi-turno, repliche a sessioni
fresche). Il round 1 (`reasoning-ab-qwen-2026-09-18.md`) misurava solo task
file: qui il dominio dove `off` perse il 27/08 — la history in conversazione.
Bracci A (`adaptive`+`deterministic`) contro C (`off`+`deterministic`); B
scartato dopo il round 1 (indistinguibile da A). Spesa round 2: **$1.06**
(tetto per-home $1 superato di $0.06 in totale — il guard fallisce per home,
lezione registrata per il runner).

## Risultati

| braccio | task | rep | esito | iter | tool | out |
|---|---|---|---|---|---|---|
| A | T3c | 1-2 | PASS | 3 | 1 | 238, 211 |
| A | T4c | 1-2 | PASS | 5 | 3 | 1020, 1157 |
| A | T1/T2 | 1 | PASS | 3/4 | 2/5 | 525, 576 |
| C | T3c | 1-2 | PASS | 3 | 1 | 73, 72 |
| C | T4c | 1-2 | **FAIL** | 3 | 1 | 70, 70 |
| C | T1/T2 | 1 | PASS | 3/4 | 2/5 | 92, 223 |

## Lettura

- **T3c (ricordo semplice): entrambi PASS**, C senza rilettura. La history
  breve funziona anche con `off`.
- **T4c (agire ricordando): C FAIL 2/2, A PASS 2/2.** Con `off` il modello
  *ricorda* (`bozza` nominata) ma *non agisce* (file resta `bozza`, 1 sola
  tool call contro 3): narra invece di chiamare, con `answered` e zero
  recovery. È il false-success che `completion.ts` teme — e scatta proprio
  quando il reasoning è spento.
- T1/T2 confermano il round 1: pari successo, C più parco e veloce.

## Decisione

Il default resta `adaptive`+`deterministic`, ora con evidenza in entrambe le
direzioni: `off` vince su costo/velocità ma perde sull'agire-ricordando, il
caso d'uso centrale di un agente. Rivalutare solo con task conversazionali
più lunghi o per-corsia (off già così sulle corsie memoria).
