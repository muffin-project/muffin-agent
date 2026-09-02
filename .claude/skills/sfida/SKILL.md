---
description: Esegue il challenge pass prima di implementare, come lo definisce docs/RESEARCH.md — osserva il sistema reale, ricostruisce la decisione esistente, confronta peer per problema, cerca evidenza contraria e scrive il criterio di falsificazione prima del codice. Usala prima di una modifica materiale a runtime, harness, sicurezza, authority, provenienza, memoria, person model, processi, schema durevole, o quando una scelta è giustificata soprattutto dall'intuizione o da un vecchio ADR.
---

# Sfida

Il protocollo **non è qui**: è in `docs/RESEARCH.md`, che vale per Claude come
per Codex e per un umano. Leggilo ed eseguilo contro la claim corrente. Questa
skill esiste per farlo arrivare al momento giusto, non per ricopiarlo — se
divergesse, il documento ha ragione.

Prima di aprirlo, fissa due cose:

- **la claim in una frase falsificabile** — cosa dovrebbe diventare vero, e come
  si vedrebbe se non lo fosse;
- **quale trigger di `docs/RESEARCH.md` stai soddisfacendo**. Se non ne
  soddisfi nessuno, il pass non serve e dirlo è un risultato: una review della
  letteratura per un bug meccanico è cerimonia.

Due esiti valgono quanto «costruiscilo», e questa skill fallisce se non li
mette sul tavolo:

- **semplificare o rimuovere** il meccanismo, quando il pass mostra che
  l'assunzione che lo giustificava è scaduta;
- **non farlo adesso**, con il finding registrato come evidence.

Chiudi scrivendo, **prima del codice**, la tabella delle alternative e
l'osservazione che potrebbe falsificare la scelta. La ricerca durevole va nel
corpus evidence come snapshot datato: non diventa current authority per
freschezza, e non sostituisce ARCHITECTURE, SECURITY o un ADR.
