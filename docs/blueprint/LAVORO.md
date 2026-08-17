# Stato del lavoro

> ⚙️ **Blocco iniettato a ogni sessione, budget ~1.200 caratteri.** Il limite è
> il meccanismo, non un fastidio: quando è pieno si consolida o si chiude
> qualcosa. Qui sta solo ciò che è **aperto**; il chiuso è cronaca e va in
> `STATE.md`. Aggiornare a **ogni** iterazione del loop, prima di scegliere
> l'obiettivo successivo.

<!-- INIZIO BLOCCO -->
**Aggiornato**: 2026-08-17

**Goal**: DAY-1 READY come uso reale — mandato in `gate1/MANDATO-DAY-1.md` (12 invarianti, capability §5, battery di cutover, ultimo audit). Fallback definito in `04-roadmap.md` §Gate 1.

**Audit e2a47ac**: 1 CRITICAL, 4 HIGH, 19 MEDIUM, tutti ancora presenti (`research/audit-2026-08-16/README.md`). Ordine: fs containment (in corso) → lock/lease/fencing → acceptance truth → scheduler/job → egress params → injection canale fidato → segreti a riposo → standalone.

**In volo**: `slice/fs-containment` (CRITICAL P29/P28) · #49 giudice memoria (judge). Poi una alla volta (max 2 non sovrapposte).

**Capability §5 aperte**: A2/A3 (owner) · A6/A7/A8 update/migrazione/backup · A9 · D2/D3/D11 journal · D12 ASK · B15 · C8 · E1 · prompt in `defaults/prompts/` · audit CLI/slash · B2 al test di prod.

**Piani (ADR-0045 §rev. 17/08)**: Evidence · Beliefs · Work · Effects · Authority — nessuno store è due piani; SessionStore/turn_tool_calls/delivery sono le cuciture note.
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
