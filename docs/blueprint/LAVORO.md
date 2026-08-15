# Stato del lavoro

> ⚙️ **Blocco iniettato a ogni sessione, budget ~1.200 caratteri.** Il limite è
> il meccanismo, non un fastidio: quando è pieno si consolida o si chiude
> qualcosa. Qui sta solo ciò che è **aperto**; il chiuso è cronaca e va in
> `STATE.md`. Aggiornare a **ogni** iterazione del loop, prima di scegliere
> l'obiettivo successivo.

<!-- INIZIO BLOCCO -->
**Aggiornato**: 2026-08-15

**Obiettivo**: chiudere i buchi trovati dagli audit e portare la slice su `dev`.

**PR aperte**: #8 slice/gateway (23 commit) · #9 tre fix sicurezza su dev · #10 CI+template (verde).

**Deleghe in volo**: sandbox-linux (opus) · audit-fix (sonnet) · ricerca-modelli (sonnet) · disegno-eventi (opus).

**Decisioni dell'owner, aperte**: livello «chi è questa persona» a budget sopra il grafo · forma di MuffinBus e confine vault/workspace · lingua di README/CONTRIBUTING per l'open source · `ricorda` scrive o propone (ADR-0032 §9) · `identity.md` e il taglio di `persona.md` sono solo suoi.

**Rischi noti**: il contenimento del sandbox è provato solo su macOS, non su Linux che è la produzione · `fs.write` rifiuta ogni draft (registro undo assente) · il binario che l'owner usa è del 2026-08-11 e non contiene niente di questa slice.

**Prossima azione**: verificare le quattro deleghe quando rientrano, una per una, senza fidarsi del report.
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
