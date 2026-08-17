# Character eval — stima dry-run

generato: 2026-08-17T14:25:18.281Z
modelli: claude-sonnet-5, claude-haiku-4-5-20251001

- claude-sonnet-5: ~109687 token stimati (lato input, 17 probe) a 3$/Mtok → ~$0.3291 per corsa (solo input; output e giudice non stimati qui)
- claude-haiku-4-5-20251001: ~109115 token stimati (lato input, 17 probe) a 1$/Mtok → ~$0.1091 per corsa (solo input; output e giudice non stimati qui)

Stima grezza (char/4), come `evals/acceptance/provider.ts` e `muffin prompt show`. Non conta: output del modello, il giudice (non gira sotto --dry-run), eventuali chiamate di consolidamento in background che il runtime reale può innescare durante una corsa lunga.

| Probe | Modello | Chiamate | Token sistema | Token turno |
|---|---|---|---|---|
| casual-hey | claude-sonnet-5 | 1 | 5620 | 4 |
| fun-no-task | claude-sonnet-5 | 1 | 5620 | 32 |
| weak-technical-choice | claude-sonnet-5 | 1 | 5620 | 164 |
| insists-against-evidence | claude-sonnet-5 | 2 | 11240 | 199 |
| muffin-was-wrong | claude-sonnet-5 | 1 | 5620 | 296 |
| dry-technical-question | claude-sonnet-5 | 1 | 5620 | 184 |
| memory-relevant | claude-sonnet-5 | 1 | 5620 | 353 |
| memory-absent | claude-sonnet-5 | 1 | 5620 | 249 |
| inferred-pattern | claude-sonnet-5 | 1 | 5620 | 332 |
| multistep-technical-task | claude-sonnet-5 | 1 | 5620 | 291 |
| long-task | claude-sonnet-5 | 2 | 5786 | 820 |
| tool-fails | claude-sonnet-5 | 1 | 5620 | 372 |
| crash-uncertain-outcome | claude-sonnet-5 | 2 | 5786 | 1028 |
| runtime-debugging | claude-sonnet-5 | 1 | 5620 | 427 |
| mcp-tool-use | claude-sonnet-5 | 2 | 5786 | 997 |
| serious-no-humour | claude-sonnet-5 | 2 | 5786 | 1010 |
| just-talk-no-work | claude-sonnet-5 | 2 | 5786 | 939 |
| casual-hey | claude-haiku-4-5-20251001 | 1 | 5620 | 4 |
| fun-no-task | claude-haiku-4-5-20251001 | 1 | 5620 | 32 |
| weak-technical-choice | claude-haiku-4-5-20251001 | 1 | 5620 | 148 |
| insists-against-evidence | claude-haiku-4-5-20251001 | 2 | 11240 | 193 |
| muffin-was-wrong | claude-haiku-4-5-20251001 | 1 | 5620 | 296 |
| dry-technical-question | claude-haiku-4-5-20251001 | 1 | 5620 | 184 |
| memory-relevant | claude-haiku-4-5-20251001 | 1 | 5620 | 353 |
| memory-absent | claude-haiku-4-5-20251001 | 1 | 5620 | 249 |
| inferred-pattern | claude-haiku-4-5-20251001 | 1 | 5620 | 332 |
| multistep-technical-task | claude-haiku-4-5-20251001 | 1 | 5620 | 291 |
| long-task | claude-haiku-4-5-20251001 | 1 | 5620 | 360 |
| tool-fails | claude-haiku-4-5-20251001 | 1 | 5620 | 372 |
| crash-uncertain-outcome | claude-haiku-4-5-20251001 | 2 | 5786 | 1028 |
| runtime-debugging | claude-haiku-4-5-20251001 | 1 | 5620 | 427 |
| mcp-tool-use | claude-haiku-4-5-20251001 | 2 | 5786 | 1021 |
| serious-no-humour | claude-haiku-4-5-20251001 | 2 | 5786 | 1010 |
| just-talk-no-work | claude-haiku-4-5-20251001 | 2 | 5786 | 991 |
