# Stato del lavoro

> ⚙️ **Blocco iniettato a ogni sessione, budget ~1.200 caratteri.** Il limite è
> il meccanismo, non un fastidio: quando è pieno si consolida o si chiude
> qualcosa. Qui sta solo ciò che è **aperto**; il chiuso è cronaca e va in
> `STATE.md`. Aggiornare a **ogni** iterazione del loop, prima di scegliere
> l'obiettivo successivo.

<!-- INIZIO BLOCCO -->
**Aggiornato**: 2026-08-15

**Obiettivo**: M5-bis (`M5-BIS.md`), ordinato per **irreversibilita**: prima cio che non si potra piu cambiare. Forma del turno > modello dei permessi > schema > tutto il resto. Un flag CLI si cambia domani, la forma di un turno no.

**A ogni giro del loop, prima di scegliere l'obiettivo**: aggiorna questo blocco E ripubblica la plancia (scratchpad/plancia.html, stesso URL). Se plancia e M5-BIS divergono ha ragione il file.

**Deleghe in volo**: gate1 x4 · reasoning-budget · superfici+streaming · confronto-permessi · documentazione · radice-Deliver · turno-sospendibile.

**La tesi in verifica**: B2+B3+B5 non sono tre feature ma una proprieta — un turno dev'essere sospendibile e ripristinabile. Se e vera, costruirle separate darebbe tre meccanismi che non compongono.

**Decisioni owner aperte**: scope di lettura sandbox · `mcp.*` per-tool · modello di reversibilita · `ricorda` scrive o propone · lingua doc pubblici · identity.md e persona.md.

**Trappole note**: `episodes.kind` CHECK non alterabile · il kernel legge `reversible` solo in `case medium`, irreversibile collassa su allow · `approve` cablato solo nel REPL · una base incompleta produce inventari falsi.
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
