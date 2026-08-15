# Stato del lavoro

> ⚙️ **Blocco iniettato a ogni sessione, budget ~1.200 caratteri.** Il limite è
> il meccanismo, non un fastidio: quando è pieno si consolida o si chiude
> qualcosa. Qui sta solo ciò che è **aperto**; il chiuso è cronaca e va in
> `STATE.md`. Aggiornare a **ogni** iterazione del loop, prima di scegliere
> l'obiettivo successivo.

<!-- INIZIO BLOCCO -->
**Aggiornato**: 2026-08-15

**Obiettivo**: M5-bis per intero (`M5-BIS.md`). Fondo = zero BLOCKER.

**Deleghe in volo**: gate1 x4 · reasoning-budget · superfici+streaming · confronto-permessi · documentazione.

**CODA — aggiunte dell'owner, non ancora iniziate.** Un suo messaggio si AGGIUNGE, non sostituisce l'obiettivo:
1. Validare ogni affermazione dei doc fondazionali; quelle eseguibili diventano check (ORCHESTRATION §13).
2. Passata *table stakes*: cosa hanno tutti gli agenti maturi e noi no — e' la categoria cieca agli audit interni (cosi e' sfuggito lo streaming).
3. Fasce enterprise/consumer + qwen3.8 via Ollama.
4. Eval del modello nuovo, DOPO il reasoning budget.

**Decisioni owner aperte**: scope di lettura del sandbox · spezzare `mcp.*` per-tool (entrambe in ricerca sui peer) · `ricorda` scrive o propone · lingua dei doc pubblici · `identity.md` e taglio `persona.md`.

**Trappole note**: `episodes.kind` ha un CHECK a 5 valori non alterabile · il kernel legge `reversible` solo dentro `case medium`, quindi irreversibile collassa su allow · `approve` e' cablato solo nel REPL.
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
