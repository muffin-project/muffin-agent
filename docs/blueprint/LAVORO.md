# Stato del lavoro

> ⚙️ **Blocco iniettato a ogni sessione, budget ~1.200 caratteri.** Il limite è
> il meccanismo, non un fastidio: quando è pieno si consolida o si chiude
> qualcosa. Qui sta solo ciò che è **aperto**; il chiuso è cronaca e va in
> `STATE.md`. Aggiornare a **ogni** iterazione del loop, prima di scegliere
> l'obiettivo successivo.

<!-- INIZIO BLOCCO -->
**Aggiornato**: 2026-08-15

**Obiettivo**: M5-bis per intero — la lista enumerata è `docs/blueprint/M5-BIS.md`, e il suo fondo è: righe ⛔ di §0/§1/§2/§3 verdi + le tre di §6 che sono dell'owner.

**Mergiate in dev**: #9 sicurezza · #10 CI · #11 stato del lavoro. **Aperte**: #8 slice/gateway (23 commit) · #12 disegno eventi.

**Deleghe in volo**: sandbox-linux · audit-fix · ricerca-modelli.

**Decisioni owner, aperte**: `fs.write` — registro di undo *oppure* `reversible:'no'`+ask (§1 di M5-BIS, pro e contro lì) · `ricorda` scrive o propone · lingua di README per l'open source · `identity.md` e il taglio di `persona.md`.

**Trappole note**: `episodes.kind` ha un CHECK a 5 valori non alterabile — un kind nuovo rompe ogni install esistente, la novità va in `connector` · `PRACTICES` §13 vive solo su slice/gateway, chi lavora da dev non ce l'ha · il binario dell'owner è dell'11 agosto.

**Prossima azione**: verificare le tre deleghe al rientro, una per una.
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
