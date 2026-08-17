# Stato del lavoro

> ⚙️ **Blocco iniettato a ogni sessione, budget ~1.200 caratteri.** Il limite è
> il meccanismo, non un fastidio: quando è pieno si consolida o si chiude
> qualcosa. Qui sta solo ciò che è **aperto**; il chiuso è cronaca e va in
> `STATE.md`. Aggiornare a **ogni** iterazione del loop, prima di scegliere
> l'obiettivo successivo.

<!-- INIZIO BLOCCO -->
**Aggiornato**: 2026-08-17

**Goal**: DAY-1 READY come uso reale — mandato in `gate1/MANDATO-DAY-1.md`; sequenza in `gate1/PERCORSO-CRITICO.md`.

**Triage 17/08 fatto**: `M5-BIS.md` riscritto riga per riga — 9 READY · 37 BLOCKER · 7 OUT · 0 INVALIDATED (54 righe). `?` ritirato salvo B8/D10 (li tocca #54, in giudizio sulla stessa riga).

**In volo**: PR #53 `slice/lease-fencing` e PR #54 `slice/acceptance-truth` (giudizio g2, non in scrittura) · `slice/a1-continuita` (A1 lettura forte, l'unica slice attiva — tetto due non sovrapposte).

**Prossime tre slice (PC §1)**: `wal-intent` (1.1, intent WAL per tool call) · `session-taint` (1.2, taint attraverso la history) · `recall-speaker` (1.3, episodio agente ≠ "tu").

**Decisioni owner aperte**: P34-2 segreti a riposo · audio nei 14gg sì/no · scope lettura sandbox · `mcp.*` per-tool · `ricorda` scrive/propone · lingua doc pubblici.
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
