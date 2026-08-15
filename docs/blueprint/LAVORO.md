# Stato del lavoro

> ⚙️ **Blocco iniettato a ogni sessione, budget ~1.200 caratteri.** Il limite è
> il meccanismo, non un fastidio: quando è pieno si consolida o si chiude
> qualcosa. Qui sta solo ciò che è **aperto**; il chiuso è cronaca e va in
> `STATE.md`. Aggiornare a **ogni** iterazione del loop, prima di scegliere
> l'obiettivo successivo.

<!-- INIZIO BLOCCO -->
**Aggiornato**: 2026-08-15

**Obiettivo**: M5-bis per intero. Inventario Gate 1: `docs/blueprint/M5-BIS.md`. Fondo = zero BLOCKER, ogni riga READY o FUORI-con-ragione.

**Mergiate in dev**: #8 slice/gateway (24 commit) · #9 · #10 · #11. **Aperte**: #12 eventi · #14 audit-fix · #15 inventario · #16 modelli.

**Deleghe in volo**: sandbox-linux · reversibilita · gate1 x4 (installazione, continuita, capability, memoria+osservabilita).

**Decisioni owner, aperte**: modello di reversibilita sotto `fs.write` · `ricorda` scrive o propone · lingua README open-source · `identity.md` e taglio `persona.md`.

**Trappole note**: `episodes.kind` ha un CHECK a 5 valori non alterabile — la novita va in `connector` · `agent/loop.ts:379` cabla `maxOutputTokens: 4096` e `openai-compat` non manda mai un budget di reasoning e scarta `thinking: []` al ritorno: un modello che ragiona di default (qwen3.8, gemini 3.7, grok 4.6) paga il ragionamento e lo butta · lanciare agenti da una base incompleta produce inventari falsi.

**Prossima azione**: verificare le sei deleghe al rientro col metro di ORCHESTRATION §11.
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
