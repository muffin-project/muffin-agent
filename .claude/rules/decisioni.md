---
paths:
  - "docs/decisions/*.md"
---

# Il numero di un ADR è una risorsa condivisa senza lock

Prima di scrivere un ADR nuovo, il numero non si deduce da `ls` sul tuo branch.

Il 2026-08-17 **tre slice in volo lo stesso giorno** hanno rivendicato
**ADR-0042** — il record del turno, i documenti, il taint in ingresso — e nessuna
poteva accorgersene: ognuna era partita da un `dev` che non conteneva ancora le
altre. Con più worktree in parallelo la collisione è la regola, non l'incidente.

`docs/decisions/adr.test.ts` è il lock che il filesystem non dà, ma scatta **al
merge**, quando costa una rinumerazione e la riscrittura delle citazioni.
Prendere il numero giusto costa una riga:

```bash
git fetch --quiet --prune origin
for b in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin); do
  git ls-tree -r --name-only "$b" -- docs/decisions/ docs/blueprint/adr/ 2>/dev/null
done | sed 's|.*/||' | grep -oE '^[0-9]{4}' | sort -n | tail -1
```

Il tuo ADR prende il numero successivo a quello stampato.

**`sed 's|.*/||'` non è cosmetico.** `git ls-tree --name-only` stampa il
**percorso completo**, non il basename: senza quel passaggio il `grep` ancorato a
inizio riga non trova mai niente e il comando restituisce la **stringa vuota,
senza errore**. È esattamente com'era scritto qui dal 2026-08-30 al 2026-08-31 —
un comando cieco che sembrava funzionare.

**Perché guarda anche `docs/blueprint/adr/`.** Gli ADR sono in
`docs/decisions/` dal 2026-08-31, ma quel giorno **sei branch remoti vivi** erano
ancora basati sul layout precedente: uno che aggiunga un ADR lo scriverebbe sotto
il path vecchio, e cercare solo nel nuovo darebbe un massimo troppo basso — cioè
proprio la collisione che questa regola esiste per evitare.

Il secondo path **non sparisce da solo**: va tolto con una modifica esplicita a
questo file, quando nessun branch remoto lo contiene più. La condizione si
verifica così, e va rieseguita prima di toglierlo:

```bash
for b in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin); do
  git ls-tree -r --name-only "$b" -- docs/blueprint/adr/ 2>/dev/null
done | wc -l    # 0 => il path vecchio si può togliere da questa regola
```

Il costo di sbagliare è specifico e differito: un ADR non è un file, è **una
citazione**. Se due documenti rispondono allo stesso numero, la riga che diceva
«questo è normativo (ADR-00NN)» smette di indicare qualcosa — e non si vede
leggendo il codice, si vede mesi dopo seguendo un riferimento che porta altrove.
