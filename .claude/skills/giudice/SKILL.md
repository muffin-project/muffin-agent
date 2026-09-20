---
description: Review indipendente di una claim CRITICAL secondo docs/development/JUDGE.md. Solo su invocazione esplicita, in una sessione fresca che non ha scritto il codice.
disable-model-invocation: true
---

# Giudice

Il protocollo è in `docs/development/JUDGE.md`. Leggilo ed eseguilo; non è ricopiato qui.

**Prima di cominciare, verifica di poter essere il giudice.** Questa skill non
si auto-invoca — ma il flag che lo impedisce toglie *una* strada all'errore, non
produce indipendenza. L'indipendenza è la congiunzione di tre cose, e le altre
due nessun flag può garantirle:

1. **contesto fresco** — non la sessione che ha scritto il codice, né la sua
   continuazione dopo un compact;
2. **nessuna proprietà dell'implementazione** — se hai scritto tu la cucitura
   che stai per giudicare, non stai giudicando: stai rileggendo;
3. **il protocollo di `docs/development/JUDGE.md`**, incluse le cinque domande obbligatorie
   e i soli moduli d'attacco pertinenti alla claim.

Se una delle prime due non è vera, **dillo e fermati**. Una self-review che
porta il nome del giudice è peggio di nessuna review: consuma il budget di
verifica e restituisce fiducia che nessuno ha guadagnato.

Il giudice non tocca il lavoro che giudica: niente `git checkout`, niente
commit, push o merge. Il verdetto è un rapporto, e la sua forma è in
`docs/development/JUDGE.md`.
