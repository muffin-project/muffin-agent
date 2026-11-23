# ADR-0108 — Telegram: prima il risultato

**Data:** 2026-11-22. **Stato:** proposto nella candidata locale.

La chat è il luogo in cui si affida un lavoro e se ne riceve l'esito. Il
processo tecnico resta nelle tracce e nel registro degli effetti. Il
[confronto e la riproduzione](../evidence/telegram-result-first-2026-11-22.md)
spiegano perché sostituiamo la scelta di #723, #724 e #726 per le risposte
ordinarie, preservando l'approvazione concreta di ADR-0093.

- In privato: bozza nativa con Stop, stato breve durante l'attesa e testo
  provvisorio quando il modello fa streaming. I preamboli non diventano
  un registro. Esito finale in un messaggio, salvo i limiti di Telegram.
- In gruppo e nei topic: digitazione mentre il turno gira, poi l'esito
  nel topic d'origine. Nessuna bolla durevole dedicata all'attività.
- Una richiesta di approvazione è un messaggio reale con azione, risorsa e
  pulsanti. Il risultato può aggiornare quello stesso messaggio, lasciando
  la ricevuta sotto la risposta. Una risposta di rete ambigua non autorizza
  l'invio di una seconda tastiera.

Questa scelta riguarda la presentazione. Il routing, la policy, la consegna
journaled, il formato dei piani congelati e la ripresa restano gli stessi.
