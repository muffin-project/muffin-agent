# Stato del lavoro

> ⚙️ **Blocco iniettato a ogni sessione, budget ~1.200 caratteri.** Il limite è
> il meccanismo, non un fastidio: quando è pieno si consolida o si chiude
> qualcosa. Qui sta solo ciò che è **aperto**; il chiuso è cronaca e va in
> `STATE.md`. Aggiornare a **ogni** iterazione del loop, prima di scegliere
> l'obiettivo successivo.

<!-- INIZIO BLOCCO -->
**Aggiornato**: 2026-08-16

**Obiettivo**: Muffin regge **14 giorni**. Verifica end-to-end anche il gia-fatto. Ordine: turno > permessi > superfici > schema.

**Inventario**: 51 righe · 27 non verificate · 18 BLOCKER · 5 READY · 1 OUT. Fondo: zero BLOCKER e zero `?`.

**Non integrato**: accettazione E4 · turno sospeso B2-B5 · superfici B8/B14-B16 · memoria-tempo C4/C6 (worktree) · taint/Hermes (branch). Mai READY prima dell'accettazione.

**Direzione**: ADR-0045/0046 — agente continuo; surface = owner da ID autenticato protetto + contenuto parsato/provenanced/tainted; autonomia scoped.

**Checkpoint**: PR **#32** `dev`→`main` ha ricevuto `ADJUST`: tenant allegati,
bound/parti DOCX, symlink rileggibili e handoff senza GitHub. Correzioni su
`slice/adjust-main-promotion`; serviranno CI e judge nuovi.

**Critica**: una garanzia deve essere obbligatoria nel tipo e raggiunta dalla produzione; logica isolata verde non basta.

**Decisioni owner aperte**: scope lettura sandbox · `mcp.*` per-tool · modello di reversibilita · `ricorda` scrive o propone · lingua doc pubblici · identity/persona.
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
