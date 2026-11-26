# ADR-0111 — Telegram: prima il risultato

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
  la ricevuta sotto la risposta. Se l'edit della ricevuta può essere ancora
  in volo, il risultato va su un messaggio nuovo. Una risposta di rete ambigua
  non autorizza l'invio di una seconda tastiera per lo stesso ID, anche dopo
  un riavvio.

Questa scelta riguarda la presentazione. Il routing, la policy, la consegna
journaled, il formato dei piani congelati e la ripresa restano gli stessi.

## Emendamento — 26 novembre 2026 (Europe/Rome)

Il parlato conversazionale breve, già scritto dal modello accanto a una
chiamata tool, può diventare un messaggio durevole. Non è un ritorno del
registro «Processo»: zero log tecnico, zero blocchi di ragionamento, zero
frasi sintetizzate dal runtime. Si promuove al più un preambolo qualificato
per turno (frase breve e completa, dopo redazione, tetto e filtro
conservativo), oppure un `work_message` già previsto, su DM dell'owner, nei
gruppi, nei topic (stesso `message_thread_id` d'origine) e nel REPL
interattivo. I job e i prompt `minimal` restano esclusi.

Dopo un interim durevole in DM la bozza `"sto lavorando · Ns"` si abbandona e
si riapre con un nuovo `draft_id`. L'esito finale è sempre un messaggio
nuovo: non edita mai un interim. Nei gruppi e nei topic l'interim entra
nella stanza, la digitazione resta attiva mentre girano i tool, e l'esito
arriva dopo come messaggio nuovo. In memoria a lungo termine resta solo
l'esito.

Falsificatore: un giro multi-tool mostra al più un acknowledgment breve (se
il modello lo ha scritto e passa il filtro) e/o `work_message` entro cap,
mai nomi tool o query, poi un esito su un messaggio nuovo; un preambolo
«inizio di risposta» come «Ecco cosa ho trovato» non si sdoppia; uno scrub
di segreto tiene l'interim omesso; un restart non duplica l'interim
journaled; la bozza di stato non resta stantia.
