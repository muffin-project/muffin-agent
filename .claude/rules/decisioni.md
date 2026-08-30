---
paths:
  - "docs/blueprint/adr/*.md"
---

# Il numero di un ADR è una risorsa condivisa senza lock

Prima di scrivere un ADR nuovo, il numero non si deduce da `ls` sul tuo branch.

Il 2026-08-17 **tre slice in volo lo stesso giorno** hanno rivendicato
**ADR-0042** — il record del turno, i documenti, il taint in ingresso — e nessuna
poteva accorgersene: ognuna era partita da un `dev` che non conteneva ancora le
altre. Con più worktree in parallelo la collisione è la regola, non l'incidente.

`adr/adr.test.ts` è il lock che il filesystem non dà, ma scatta **al merge**,
quando costa una rinumerazione e la riscrittura delle citazioni. Prendere il
numero giusto costa una riga:

```bash
git ls-remote --heads origin | awk '{print $2}' | sed 's#refs/heads/##' \
  | while read b; do git ls-tree --name-only "origin/$b" docs/blueprint/adr/ 2>/dev/null; done \
  | grep -oE '^[0-9]{4}' | sort -n | tail -1
```

Il costo di sbagliare è specifico e differito: un ADR non è un file, è **una
citazione**. Se due documenti rispondono allo stesso numero, la riga che diceva
«questo è normativo (ADR-00NN)» smette di indicare qualcosa — e non si vede
leggendo il codice, si vede mesi dopo seguendo un riferimento che porta altrove.
