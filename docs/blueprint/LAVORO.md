# Stato del lavoro

> ⚙️ **Blocco iniettato a ogni sessione, budget ~1.200 caratteri.** Il limite è
> il meccanismo, non un fastidio: quando è pieno si consolida o si chiude
> qualcosa. Qui sta solo ciò che è **aperto**; il chiuso è cronaca e va in
> `STATE.md`. Aggiornare a **ogni** iterazione del loop, prima di scegliere
> l'obiettivo successivo.

<!-- INIZIO BLOCCO -->
**Aggiornato**: 2026-08-15

**Obiettivo**: M5-bis (`M5-BIS.md`) per **irreversibilita**: forma del turno > permessi > superfici > schema. Un flag CLI si cambia domani, la forma di un turno no.

**Ogni giro**: aggiorna questo blocco, ripubblica plancia e mappa (stessi URL), `node docs/blueprint/mappa/ancore.mjs` finche esce 0.

**Deleghe in volo**: documenti/PDF (C7) · taint in ingresso · superfici+Discord (B8).

**Prossimo**: consumatori del record del turno (ADR-0042 costruito) — `wait`, `todo`, resume. Poi: doc Hermes da inglobare.

**La critica di fondo**: le garanzie stanno sui chiamanti, non sui dati — `tier?` opzionale, redazione solo nel tracer, `markRan` cieco alla consegna. Dove una proprieta e' portante, l'assenza non dev'essere rappresentabile: vedi `rerunnable`.

**Decisioni owner aperte**: scope lettura sandbox · `mcp.*` per-tool · modello di reversibilita · `ricorda` scrive o propone · lingua doc pubblici · identity/persona.

**Trappole**: il kernel legge `reversible` solo in `case medium` · `approve` solo nel REPL.
<!-- FINE BLOCCO -->

---

## Perché questo file esiste

`ORCHESTRATION.md` §5 lo chiedeva e non esisteva — il difetto di famiglia di
questo repo, *dichiarato e non collegato*, prodotto mentre lo si cercava altrove.

Il modo in cui falliva è preciso: lo stato del lavoro viveva solo nella
conversazione. Una conversazione lunga non lo perde gradualmente, lo riduce a
«l'ultima cosa di cui si è parlato». Da lì ogni messaggio dell'owner arriva come
un imperativo isolato e viene eseguito da solo — che è il task loop che §1
vieta. Il sintomo osservato dall'owner: *"ogni cosa non sembra considerare tutto
il resto"*.

Il budget stretto è deliberato e viene da una misura fatta su Hermes: il loro
`USER.md` sta in ~1.375 caratteri **senza schema**, e la struttura emerge perché
il limite costringe a consolidare. Stessa idea qui: un elenco che cresce senza
tetto smette di essere letto entro una settimana — è già successo al blocco di
`STATE.md`, due volte in una settimana, e la cura è stata la stessa.
