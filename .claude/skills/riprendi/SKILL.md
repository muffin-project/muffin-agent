---
description: Orienta una sessione senza contesto su muffin-agent — ricostruisce lo stato osservato (deleghe, worktree, PR, check), lo confronta col handoff e sceglie la prossima claim. Usala a inizio sessione, dopo una compattazione, o quando l'utente chiede da dove riprendere, cosa c'è da fare, o qual è lo stato del lavoro.
---

# Riprendi

Lo stato Git, già raccolto:

!`git status --short --branch`

!`git log --oneline -6`

## Completa l'osservazione

Esegui questi tre, e leggi l'output prima di decidere qualsiasi cosa:

```
node .claude/deleghe.mjs riprendi
node scripts/agent/repo-state.mjs
gh pr list --state open
```

> **Perché questi tre non sono inlinati come i due blocchi Git.** Un blocco di
> iniezione dinamica gira *prima* che la skill arrivi, e se il comando non
> riesce — permesso non concesso, binario assente — **l'intera skill viene
> annullata senza un errore**: `/riprendi` restituisce vuoto e sembra non
> esistere. Misurato il 2026-08-30 con `node`. Una chiamata normale come sopra
> è visibile, e se viene rifiutata si vede.
>
> Stessa trappola scrivendo questa nota: la sintassi di iniezione **viene
> eseguita anche dentro un code span**. Non citarla in nessuna forma qui
> dentro; descrivila a parole.

## Cosa farne

1. **L'osservato e' il controllo.** Il programma e il lavoro attivo vengono da
   Git/GitHub e da `repo-state.mjs`, non da una nota di sessione.
2. **Chiudi prima ciò che è rotto.** Una review aperta, una delega morta, un
   worktree sporco o un rosso che ha davvero eseguito vengono prima di lavoro
   nuovo. Un check rosso a zero step non è un difetto del codice.
3. **Nomina la claim.** Una sola, in una frase falsificabile. Se non sai
   nominarla, non hai ancora scelto: non cominciare.
4. **Carica solo ciò che la claim rende load-bearing.** `docs/README.md` dice
   quale documento possiede quale domanda. Non caricare la storia per default.
5. **Sfida prima di implementare** quando la claim tocca runtime, harness,
   sicurezza/authority, memoria/person model, processi o schema durevole: usa
   `/sfida`.
6. **Classifica il profilo** con `docs/development/ORCHESTRATION.md` e scrivi profilo e
   motivo nella PR.

Non fare manutenzione generica: per quella c'è `/loop`. Per portare una claim
alla chiusura turno dopo turno c'è `/goal`, con un criterio **eseguibile** —
mai uno stato in prosa.
