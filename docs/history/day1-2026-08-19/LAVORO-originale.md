# Stato del lavoro

> ⚙️ **Blocco iniettato a ogni sessione, budget ~1.200 caratteri.** Il limite è
> il meccanismo, non un fastidio: quando è pieno si consolida o si chiude
> qualcosa. Qui sta solo ciò che è **aperto**; il chiuso è cronaca e va in
> `STATE.md`. Aggiornare a **ogni** iterazione del loop, prima di scegliere
> l'obiettivo successivo.

<!-- INIZIO BLOCCO -->
**Aggiornato**: 2026-08-17 (pomeriggio)

**Goal**: DAY-1 READY come uso reale — mandato in `gate1/MANDATO-DAY-1.md`, sequenza in `gate1/PERCORSO-CRITICO.md` §0 (riconciliato a ogni merge).

**Workflow (owner 17/08)**: verifica proporzionale alla claim — FAST/STANDARD/CRITICAL scelti *prima* (`ORCHESTRATION.md` §17). Judge fresco solo per CRITICAL. Fuori scope → follow-up (§18); documenti solo dove diventano stale (§19).

**Inventario**: 13 READY · 35 BLOCKER · 7 OUT (55 righe).

**Integrate 17–18/08**: #53→#76 (quindici slice). **Blocco 1 chiuso**: WAL intento, taint history, egress, segreti, provenienza in ingresso, identità dell'occorrenza.

**Prossimo**: `inbound-unit` (update_id → un turno, sulla forma di job_fires), poi blocco 2 (schema-evolution, update/backup, undo-journal). In volo: #73 (altra sessione).

**CI ferma**: minuti Free esauriti dal 18/08 — si integra sulla verifica locale (build+suite+accettazione+report+ancore), deroga dell'owner scritta in BRANCHING checkpoint 4.

**Serve l'owner**: corsa reale del character eval (~$0.33 Sonnet + ~$0.11 Haiku, solo input) · audio nei 14gg · scope sandbox · `mcp.*` per-tool · `ricorda` · lingua doc.

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
