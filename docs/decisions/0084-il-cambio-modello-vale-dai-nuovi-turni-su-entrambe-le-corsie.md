# ADR-0084 — Il cambio modello vale dai nuovi turni, su entrambe le corsie

**Stato:** accettato · 2026-09-18 · chiude #500 (con #501/ADR-0083 per la configurazione).

## Contesto

`muffin model` scriveva `config.json`, ma `buildRuntime` congelava quasi tutto
al boot: la corsia main si riagganciava già a `prepareTurn`
(`refreshMainModel`), la light no — wrapper, profilo, base di spesa, reranker
e snapshot esposto restavano quelli dell'avvio. Su un cambio famiglia della
light (il caso che #501 ha reso possibile senza rompere il routing), la
memoria avrebbe continuato sul modello e sul profilo vecchi: con un profilo
che manda `temperature: 0` a un modello che lo rifiuta con 400, ogni
consolidamento falliva. E il comando non distingueva persistito da attivo: la
stessa riga valeva per «salvato» e per «in esecuzione», su processi diversi.

## Decisione

1. **`refreshLightModel` a `prepareTurn`, accanto al main.** Stesso punto
   sicuro (fra turni, mai dentro), stessa regola: fingerprint su
   provider+slug, skip quando niente è cambiato. Ricostruisce wrapper,
   profilo (per id del nuovo modello), base di spesa, reranker e snapshot
   `runtime.light`; `runtimeInfo.lightModel` segue. I riferimenti condivisi
   (`recallDeps`, chiusure che leggono i binding) propagano da soli; una
   consolidation in volo tiene i vecchi e finisce su quelli.
2. **`config.models` condiviso sincronizzato da entrambi i refresh.** I call
   site della memoria leggono `config.models.light` a ogni chiamata: senza la
   sincronizzazione leggevano lo slug del boot anche col wrapper nuovo.
3. **`status` del gateway dichiara i modelli vivi**, letti dall'oggetto config
   che i refresh mutano — mai da uno snapshot. Campo additivo, i client vecchi
   lo ignorano (`askGateway` torna `null`/parziale e chi legge lo tratta come
   «non lo so», non come «spento»).
4. **`muffin model` stampa persistito contro attivo** su ogni strada che
   scrive: gateway allineato («niente riavvio»), indietro («dal prossimo
   turno», con l'avviso sul volo), assente («vale dal prossimo avvio»), muto
   («verifica sul trace»). Il REPL eredita tutto passando da `cmdModel`.

Non si tocca: nessun reset di DB/memoria/turni per cambiare modello (i turni
in volo tengono gli snapshot che già possiedono); nessuna temperatura (regola
#498); nessun nuovo verbo di protocollo — `status` si estende, non si
biforca.

## Alternative considerate

- **Riavvio obbligatorio con messaggio.** Respinto: il meccanismo a caldo
  esisteva già a metà (main) e completarlo costa un refresh simmetrico; un
  riavvio per cambiare un modello è la frizione che #500 chiede di togliere.
- **Ricostruire tutto il runtime a ogni turno.** Respinto: il fingerprint
  rende lo stato stabile a costo di una lettura di config; ricostruire
  embedder/indici/vault a ogni giro per cambiare (forse) un modello è
  sproporzionato.
- **Query dedicata invece di estendere `status`.** Respinta: un verbo in più
  è superficie di protocollo in più da mantenere e securizzare; due stringhe
  in una risposta esistente non lo sono.

## Cosa può smentire la scelta

- Un refresh che corre mentre una consolidation scrive: oggi è sicuro per
  costruzione (riferimenti tenuti dai closure), ma se una corsia futura muta
  stato condiviso invece di leggerlo, serve una barriera vera e non due
  refresh in sequenza.
- `status` che mente perché il gateway gira codice vecchio: è già il caso
  «muto» sopra; se diventa frequente, la versione di protocollo deve entrare
  nella risposta invece di restare implicita.
- La light che cambia famiglia a ogni turno (router instabile): il fingerprint
  ricostruirebbe wrapper e reranker di continuo — misurare prima di
  ottimizzare, il costo oggi è una manciata di allocazioni.
