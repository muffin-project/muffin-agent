---
paths:
  - "docs/blueprint/LAVORO.md"
---

# Il handoff ha un tetto, e sopra quello viene troncato

`LAVORO.md` non è un documento come gli altri: un hook `SessionStart`
(`.claude/hooks/inject-state.mjs`) lo inietta **intero** nel contesto d'avvio di
ogni sessione.

Il budget è **4.000 caratteri** meno il preambolo, cioè ~3.813. Sopra quella
soglia il contenuto non viene rifiutato: viene **tagliato**, con un marcatore in
coda che una sessione nuova non ha modo di distinguere dal testo mancante.

Misurato il 2026-08-30: aggiungendo una decisione owner il file è passato a 3.893
caratteri e `inject-state.test.ts` è diventato rosso. Senza quel test la sessione
successiva avrebbe ereditato un handoff amputato senza che niente lo dicesse.

Quindi, quando scrivi qui:

- **non alzare il budget** per far entrare più stato. Esiste perché il contesto
  d'avvio non diventi un manuale, ed è la sola cosa che tiene onesto questo file.
- **espelli prima il lavoro chiuso.** Una PR integrata, un incidente risolto, una
  cronaca che non cambia più la prossima mossa: via. Fare spazio è manutenzione
  normale, non una perdita.
- **misura in caratteri, non in byte** — l'hook conta `String.length`, e questo
  file è pieno di accenti e trattini lunghi.

`LAVORO.md` è contesto operativo **sacrificabile**: deve essere possibile
cancellarlo senza perdere conoscenza di prodotto. Una conoscenza durevole che
finisce solo qui è nel posto sbagliato, non in un file da allargare.
