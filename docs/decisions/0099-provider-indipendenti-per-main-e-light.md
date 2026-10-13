# ADR-0099 — Provider indipendenti per main e light

Stato: adottato per la convergenza concordata con l'owner il 12 ottobre 2026.
Amenda ADR-0036 sul percorso interattivo di `muffin config`; conserva la lettura
senza terminale e la distinzione tra configurazione, segreti e Root of Trust.

## Problema e decisione

Un provider globale e due identificatori di modello non consentono di assegnare
compute indipendente alle due corsie. Il percorso ChatGPT precedente cambiava
entrambi i modelli anche quando veniva nominata soltanto light. Menu, scorciatoie
CLI e comando conversazionale devono raggiungere la stessa selezione.

Estendiamo lo schema esistente con una connessione light esplicita. La connessione
principale conserva il campo precedente per compatibilità. La migrazione in
lettura conserva modello, endpoint, riferimento al segreto e policy su entrambe
le corsie, senza riscrivere il file. Cambiare una corsia non cambia l'altra.
La factory, il reload, le verifiche, le modalità e la contabilizzazione leggono
la connessione della corsia selezionata. I segreti rimangono nel loro store.

`muffin config` nel terminale apre il percorso guidato; la vista non interattiva
e `--json` mantengono l'inventario. `muffin model`, `/model` e l'alias ChatGPT
riusano la selezione. Il login personale richiede il consenso OAuth nel browser;
il comando conversazionale non lo simula. Endpoint compatibili personalizzati
riusano l'adapter esistente. Una nuova destinazione non eredita credenziali da
quella precedente: il collegamento è esplicito.

## Alternative e limiti

Un registro di connessioni nominate può diventare utile per account multipli o
altri consumer; oggi aggiungerebbe riferimenti, migrazioni e stati mancanti senza
eliminare un difetto ulteriore misurato. Due connessioni che usano lo stesso
endpoint possono duplicare impostazioni, ma condividono il riferimento al
segreto quando scelto esplicitamente. Non aggiungiamo un manager.

Light resta il ruolo corrente di memoria e descrizione delle immagini. Non è il
giudice System One e non decide la futura architettura cognitiva. Rimuovere o
cambiare il consolidatore richiede la valutazione separata della memoria.

Il catalogo misura disponibilità dichiarata, non prova entitlement o successo
del turno. Manteniamo la scelta esplicita non verificata sugli endpoint generici;
ChatGPT conserva il probe reale prima della selezione. Non esistono fallback
impliciti verso provider o modelli a pagamento. Quota di piano e stime API in USD
restano grandezze distinte.

Ricerca, alternative e falsificatori:
[`provider-model-convergence-2026-10-12.md`](../evidence/provider-model-convergence-2026-10-12.md).
