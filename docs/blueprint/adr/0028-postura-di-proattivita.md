# ADR-0028 — Postura di proattività: segnale ad alta confidenza, mai il firehose "ho notato"

**Contesto.** M5 richiede il gate di proattività — *quando* Muffin parla per primo. Il BRIEF lo chiama "la feature difficile, non la notifica": la soglia tra "parla quando serve" e "tace quando non serve". Le protezioni sono threat-model, non gusto (solo evidenza tier ≤1, quiet-hours e budget dal RoT, canale esplicito — §3). Ma *quanta* iniziativa Muffin prenda è una decisione di prodotto, portata all'owner il 2026-08-09 con tre opzioni.

**Decisione.** Postura **"segnale ad alta confidenza"** (scelta owner). Muffin parla per primo:
1. per ciò che gli è stato **chiesto esplicitamente** (job schedulati, reminder — già coperti dallo scheduler, slice 2);
2. quando un **segnale forte, verificabile e azionabile** scatta — un impegno con scadenza vicina, un fatto tier ≤1 che diventa azionabile.

Due rail, entrambi in codice:
- **Quando** (`decideProactive`, `core/scheduler/proactivity.ts`): funzione di decisione pura come il kernel di policy — ogni azione proattiva inferita ci passa. tier >1 → `deny('tainted_source')` (un messaggio di gruppo che prova ad armare un nudge è il memory-poisoning dormiente §b, negato per costruzione e testato come isolamento della DoD); quiet-hours → `defer` a fine finestra (mai droppato); budget esaurito → `defer` (una notte non presidiata non spende il mese in nudge).
- **Cosa** (vincolo owner, dall'esperienza col vecchio Muffin): la vecchia proattività era un **firehose di "ho notato X, ho notato Y"** — vaga, iper-complessa, a volte campata in aria. Quindi il `kind` di un trigger è un **insieme chiuso** di segnali azionabili (`commitment_due`, `deadline_near`, `fact_actionable`, `consolidation`) + un `anchor` per il dedup: un'"osservazione libera" non è **rappresentabile**. Il firehose è incostruibile, non solo scoraggiato. La regola di contenuto che ne segue — guida col fatto concreto, cita l'evidenza, un punto chiaro, mai analisi speculativa — è del messaggio che il detector scrive; il tipo tiene onesta la *forma*.

**Alternative scartate.** *Solo l'esplicito* (opzione A): il più sicuro, ma rinuncia al "parla quando serve" — Muffin non anticiperebbe mai nulla, contro il ruolo agente+specchio. Buona base di partenza, ma la v1 può fare di più senza rischio, dati i rail. *Specchio proattivo a cadenza* (opzione C): fa emergere pattern/osservazioni su di te periodicamente — è **esattamente** il firehose "ho notato" del vecchio Muffin, e tocca il vincolo etico del BRIEF (dipendenza cognitiva). Scartata dall'owner con motivo esperienziale diretto. *Il gate come prosa nel prompt* invece che funzione pura: la sicurezza della proattività non può dipendere dalla disciplina del modello — è threat-model, va in codice come il kernel.

**Conseguenze.** Più facile: la proattività ha un solo punto di decisione auditabile; il tipo di trigger rende il fallimento del vecchio Muffin (firehose vago) letteralmente non scrivibile; aggiungere un segnale = un detector che produce un `kind` chiuso, mai una stringa libera. Più difficile: ogni segnale nuovo è un atto deliberato (estendere l'insieme chiuso), non un'osservazione improvvisata — disciplina in più sui detector, che è il punto.

**Reversibilità.** Alta sulla postura (A→B→C è un continuum: si allarga l'insieme dei `kind` o si aggiunge un detector-a-cadenza se un domani l'owner vuole più specchio, senza toccare il gate). Media sui rail (tier/quiet/budget sono nel RoT, si cambiano solo via repo+riavvio — è il punto). Segnale che era sbagliata: l'owner silenzia/ignora ripetutamente i messaggi proattivi (troppo rumore → restringere l'insieme o alzare la soglia di confidenza) — misurabile come tasso-di-dismissal, non a intuito.

---

## Emendamento **proposto** (2026-08-10) — `gone_quiet`, e perché non è l'opzione C

**Stato: NON ratificato.** Il codice esiste, la consegna è spenta di default, e questa sezione resta una proposta finché l'owner non la accetta o la butta. È scritta qui e non decisa altrove perché tocca l'unica cosa che questo ADR aveva respinto *con motivo esperienziale diretto*.

**La tensione, detta per intero.** MVP #5 (`STATE.md`, `knowledge/04-learn-from-absence.md`) chiede il **segnale d'assenza**: accorgersi che un tema di cui parlavi è sparito. Ma "non parli più di X" è, alla lettera, un *"ho notato"* — la forma che l'owner ha respinto scegliendo la postura B, e che l'opzione C ("specchio proattivo a cadenza") incarnava. Un emendamento che non lo dicesse starebbe reintroducendo per la porta di servizio ciò che l'ADR ha chiuso dalla principale.

**Perché è comunque un oggetto diverso.** Non per intenzione, per struttura — e ognuna di queste è una riga di codice, non una promessa:

1. **Ha un'ancora e un conto.** Non "un pattern": *quell'*entità, con occasioni, arco storico, giorni di silenzio e la probabilità che li rende anomali (`core/memory/absence.ts`). L'evidenza è ispezionabile e il conto si può rifare. L'opzione C produceva osservazioni non falsificabili.
2. **Non è a cadenza, è a soglia.** Non esce niente perché è passata una settimana: esce quando il silenzio è improbabile *rispetto al ritmo di quella cosa lì*. Su una vita normale la maggior parte dei giorni non produce nulla.
3. **È tarata su un tasso di falsi allarmi dichiarato** (alpha 0,05), non su una costante ereditata. La ricerca ha mostrato che la regola del vecchio Muffin (media × 3) era un test al 16% proprio dove veniva usata — cioè il vecchio firehose era anche *statisticamente* più rumoroso di quanto sembrasse.
4. **Esce come domanda, mai come asserzione.** L'osservazione è `inferred` per costruzione, e la disciplina di provenienza la obbliga alla forma ipotetica (`knowledge/03-observing-spine.md`).
5. **Tetto basso e dedup sull'ancora**: lo stesso silenzio non si ripete. La ripetizione era metà del difetto del vecchio.

**Cosa NON pretendiamo.** Che sia gradito. Non esiste prior art sull'assenza-come-segnale né alcun benchmark su cui tararlo (`research/proattivita-quando-parlare.md`), e il tetto a tre per giro è **un'assunzione di design, non un numero citabile**. Per questo la consegna nasce spenta: `muffin observe` mostra cosa direbbe, `--send` è un atto esplicito. L'owner guarda prima che parli.

**Cosa lo falsifica.** Lo stesso segnale che l'ADR già nomina, applicato a questo `kind`: se le assenze mostrate risultano ovvie, sbagliate o irritanti, il `kind` esce dall'insieme chiuso — non si alza una soglia, si toglie il detector. E il fatto che l'insieme sia chiuso è ciò che rende questa rimozione una riga sola.

## Nota di verità (2026-08-10) — due rail su tre

Cablando il gate si è scoperto che questo ADR **afferma più di quanto il codice faccia**, e va scritto qui perché è la sezione §3 di questo documento a essere citata altrove come garanzia.

- **Il gate non era raggiunto da niente.** `decideProactive` aveva zero chiamanti fino a questa slice: rail scritti, testati, con un ADR, ed eseguiti mai. Terzo caso della stessa famiglia dopo l'allowlist egress (`docs/lessons.md`).
- **Quiet hours: vere.** Vengono da `rot/budgets.json`, dentro il sigillo (`cli/observe.ts`, `cli/jobs.ts`).
- **Budget: no.** `rot/budgets.json` dichiara `monthlyUsd` e `perTenantDailyUsd` col commento *"the agent cannot raise them itself"*, e **nessuno li legge**: ogni `BudgetEngine` nasce da `config.budget`, cioè `~/.muffin/config.json`, che sta **fuori** da ciò che `seal()` firma. I due file portano gli stessi numeri per duplicazione, quindi il comportamento sembra corretto e la garanzia non esiste. *(Verificato 2026-08-10; fix fuori da questa slice.)*
- **Canale: dichiarato, non applicato.** `ProactiveTrigger.channel` arriva al gate e il gate non lo guarda: nessun confronto con le surface abilitate. La consegna è del chiamante, il che è difendibile — ma §3 si legge come se il cancello controllasse anche quello.
