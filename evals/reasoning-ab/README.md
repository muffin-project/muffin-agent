# A/B execution policy (issue #498)

Pilot che confronta modi di chiedere al mismo modello, a parità di task e
strumenti. I bracci vivono nei profili spediti o in override documentati —
mai in `if` sul nome del modello nel loop.

## Bracci

- `A` — status quo: profilo shipped intatto (`adaptive` + `deterministic`).
- `B` — `adaptive` + `model-default`: solo la temperature resta al provider.
- `C` — `off` + `deterministic` (via `thinking: 'off'` nella home usa-e-getta).

Il braccio `low/bounded reasoning` della issue non è esprimibile:
`ReasoningRequest.effort/maxTokens` non ha superficie in profilo/config.

## Uso

```sh
npx tsx evals/reasoning-ab/con-la-chiave.ts --model qwen/qwen3.8-27b [--arms A,B,C] [--max-usd 2] [--signal-ms 360000] [--dry-run]
```

Chiave solo da ambiente nel figlio (mai argv/disco); home+workspace per
braccio in tmp e rimossi alla fine; approver allow-all con conteggio ask;
tetto di spesa e timeout per turno onesti (`aborted` registrato, non nascosto).
Metriche dalle righe `turns` che il turno scrive da sé.

## Costo indicativo

12 turni Qwen 3.8 ≈ $0.90 (contesto di recall ~25-60k token a turno domina).
