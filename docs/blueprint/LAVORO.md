# Stato del lavoro

> ⚙️ **Blocco iniettato a ogni sessione, budget ~1.200 caratteri.** Il limite è
> il meccanismo, non un fastidio: quando è pieno si consolida o si chiude
> qualcosa. Qui sta solo ciò che è **aperto**; il chiuso è cronaca e va in
> `STATE.md`. Aggiornare a **ogni** iterazione del loop, prima di scegliere
> l'obiettivo successivo.

<!-- INIZIO BLOCCO -->
**Aggiornato**: 2026-08-17 (pomeriggio)

**Goal**: DAY-1 READY come uso reale — mandato in `gate1/MANDATO-DAY-1.md`, sequenza in `gate1/PERCORSO-CRITICO.md` §0 (riconciliato a ogni merge).

**Workflow (owner 17/08)**: verifica proporzionale alla claim — FAST/STANDARD/CRITICAL scelti *prima* di implementare (`ORCHESTRATION.md` §17). Judge fresco solo per CRITICAL; FAST/STANDARD li integra l'orchestratore. L'evidenza non si rifà per rituale; fuori scope → follow-up (§18); documenti solo dove diventano stale (§19).

**Inventario**: 13 READY · 35 BLOCKER · 7 OUT (55 righe).

**Integrate il 17/08**: #53 lease/fencing · #54 acceptance truth · #56 A1 · #57 WAL intento · #58 identità p1 · #59 init --local · #60 mappa · #63 workflow · #61 audit-mediums · #62 egress (soglia owner = 2).

**In volo**: #65 identità p2 (CI) · `session-taint` (1.2) CRITICAL: ultima del blocco 1 · corsa reale del character eval: serve l'ok dell'owner (~$0.33+$0.11).

**Owner aperte**: P34-2 segreti a riposo · audio nei 14gg · scope sandbox · `mcp.*` per-tool · `ricorda` · lingua doc.
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
