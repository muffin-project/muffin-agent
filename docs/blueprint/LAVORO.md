# Stato del lavoro

> ⚙️ **Blocco iniettato a ogni sessione, budget ~1.200 caratteri.** Il limite è
> il meccanismo, non un fastidio: quando è pieno si consolida o si chiude
> qualcosa. Qui sta solo ciò che è **aperto**; il chiuso è cronaca e va in
> `STATE.md`. Aggiornare a **ogni** iterazione del loop, prima di scegliere
> l'obiettivo successivo.

<!-- INIZIO BLOCCO -->
**Aggiornato**: 2026-08-16

**Obiettivo**: DAY-1 READY → 14 giorni personali → gruppi. Ordine: turno > permessi > superficie privata > memoria > acceptance.

**Inventario**: `M5-BIS.md` autoritativo. Oggi: E4, C4/C6, B8/B14, taint (#28) READY. Restano ~30 `?`: uno scenario ciascuno.

**Non integrato**: solo #41 turno sospeso (ultime 2 correzioni). Poi `dev`→`main` con verifica nuova.

**Metodo (16/08 sera)**: una slice = una riga, ≤500 righe, un judge sonnet, 2 giri max, una alla volta; meccanica all'orchestratore.

**Prossime slice**: A9 `init --local` · D12 «l'ASK dice cosa» · D2/D3/D11 journal per turno · prompt in `defaults/prompts/` · audit CLI+slash · C8 whisper · E1 budget per-job.

**Decisioni owner prese**: reversibilità (4 classi+journal) · audio (whisper) · shell dopo lettura = ASK · prompt in .md. **Aperte**: sandbox scope · `mcp.*` per-tool · `ricorda` · lingua doc.
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
