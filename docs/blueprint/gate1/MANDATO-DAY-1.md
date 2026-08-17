# Mandato DAY-1 — direttiva owner, 2026-08-17

> Testo integrale del `/goal` che l'owner ha scritto la mattina del 17/08 (il
> comando lo ha rifiutato per lunghezza — 23.379 caratteri contro 4.000 — e ne è
> stata impostata una versione corta; questa è la versione che governa il
> lavoro). È il mandato del loop finché il DAY 1 non può iniziare: `.claude/loop.md`
> e `ORCHESTRATION.md` dicono *come*; questo dice *cosa* e *quando è vero*.
> Riferimenti: audit avversariale pinnato a `e2a47ac`
> (`research/audit-2026-08-16/findings-digest.txt`), inventario `M5-BIS.md`.

Porta Muffin allo stato in cui posso installarlo sulla mia macchina reale e, da quel momento, iniziare con fiducia una finestra di 14 giorni consecutivi in cui lo uso come mio unico agente personale quotidiano, senza dover tornare al vecchio Muffin o a un altro agente per limiti, failure silenziosi, mancanza di continuità o capability fondamentali.

Questo goal NON è "completa una checklist", "fai passare i test", "chiudi M5-BIS" o "implementa tutti i TODO". DAY-1 READY è una conseguenza verificabile del goal, non il goal stesso.

Il risultato finale deve essere: Muffin è realmente usabile, installato e verificato come lo userò io, con continuità sufficiente da poter iniziare il giorno 1 dei quattordici. Non dichiarare raggiunto il goal finché questa frase non è vera.

## 1. Prima di fare qualsiasi cosa: ricostruisci la realtà

Comportati da orchestratore e owner tecnico del risultato, non da task executor.

Segui CLAUDE.md, .claude/loop.md, AGENTS.md, ORCHESTRATION.md, PRACTICES.md, BRANCHING.md e JUDGE.md. Non duplicarne il processo: usali.

All'inizio:

- leggi integralmente i documenti fondazionali e load-bearing indicati da CLAUDE.md e STATE.md, in particolare: docs/THESIS.md, docs/DESIGN-PRINCIPLES.md, docs/PRACTICES.md, docs/ORCHESTRATION.md, docs/JUDGE.md, docs/BRANCHING.md, docs/blueprint/STATE.md, docs/blueprint/LAVORO.md, docs/blueprint/M5-BIS.md, docs/blueprint/04-roadmap.md, docs/blueprint/03-threat-model.md, docs/blueprint/09-contratti-m0-m1.md, ADR rilevanti, knowledge/ indicato dal handoff.
- ricostruisci anche il sistema DAL CODICE, non soltanto dai documenti: runtime, loop, context assembly, turns, todo/wait, scheduler, memory, policy, sandbox, filesystem, provider, tracing/budget, install/upgrade, Telegram inbox/connector/surface, acceptance harness.
- ricostruisci lo stato Git reale: HEAD, dev, main, slice/worktree, PR, review, CI/check, diff non committati, deleghe aperte.
- non assumere che STATE.md, LAVORO.md o M5-BIS siano aggiornati. La repo osservata e le prove eseguite sono la realtà; i documenti sono contratti che vanno riconciliati con essa.
- l'audit avversariale precedente è pin-nato a e2a47ac, non all'HEAD attuale. Prima di usare qualsiasi finding: `git diff e2a47ac..HEAD` e classificalo: STILL PRESENT · CHANGED BUT STILL PRESENT · ALREADY FIXED · INVALIDATED · NEEDS REPRODUCTION.
- se nel worktree esistono findings-digest.txt o i test gitignored zz-* del precedente audit, leggili e riutilizzali; non assumere che esistano. Non credere al rapporto perché è dettagliato: prova a confutarlo.
- correggi subito il handoff se documenti e realtà divergono, prima di scegliere nuovo lavoro.

Non partire da "qual è il prossimo TODO?". Parti da: "cosa, oggi, mi impedirebbe concretamente di vivere con Muffin?"

## 2. Cosa stiamo costruendo

Preserva la tesi di Muffin. Muffin non è un chatbot, un framework agentico o una collezione di tool. È un unico agente personale continuo che deve:

1. FARE — compiere lavoro reale, anche multi-step e lungo, sul sistema e sui servizi;
2. CAPIRE — accumulare nel tempo evidence e beliefs utili, con provenance, temporalità e capacità di diventare realmente più personale;
3. ESSERE PRESENTE — mantenere lavoro incompleto, aspettare, riprendere, essere raggiungibile, sapere cosa è ancora dovuto, fallire onestamente e non sparire fra processi, sessioni o surface.

Modelli, prompting, retrieval strategy e harness devono restare sostituibili. La continuità durevole deve appartenere all'agente: ciò che è successo; ciò che crede; ciò che deve ancora fare; ciò che ha fatto o può aver fatto al mondo; le autorizzazioni costituzionali che non può imparare ad aggirare.

Non introdurre architettura futura solo perché elegante. World state, multi-hop memory, gruppi, computer-use, hardware/pendant, nuove surface e altra ricerca non entrano nel Gate 1 se non emerge evidenza che sono necessarie per i 14 giorni personali. Allo stesso tempo YAGNI non è una scusa per togliere capability necessarie: se senza una primitiva reale io sarei costretto a usare un altro agente, quella primitiva è Gate 1.

## 3. Il criterio di uscita è l'uso reale

Prima di dichiarare il goal raggiunto devono essere vere TUTTE queste cose.

- A. L'inventario Gate 1, dopo essere stato corretto contro la realtà, contiene zero BLOCKER e zero "?" per la finestra personale dei 14 giorni. Una voce non necessaria può essere OUT soltanto con una ragione concreta legata alla finestra, non perché è difficile.
- B. Ogni READY significa davvero: implementazione; unit test; integration test; produzione realmente cablata; failure path; scenario di accettazione che attraversa il percorso vero; documentazione/handoff aggiornati.
- C. Una garanzia security/durability non può essere dichiarata READY sulla sola happy path. Fault injection e crash point fanno parte della prova.
- D. Nessun critical/high dell'audit corrente resta non risolto, non invalidato con prova o deliberatamente accettato dall'owner dopo una decisione istruita.
- E. Le affermazioni portanti di threat model, contratti, STATE e M5-BIS concordano con ciò che il codice realmente garantisce. Se è sbagliata la promessa e non il codice, correggi la promessa/decisione: non implementare ciecamente la prosa.
- F. L'installazione reale dell'owner passa un acceptance/cutover finale, non soltanto un HOME temporaneo con provider finto.
- G. dev integrato viene giudicato come insieme, non soltanto come somma di slice. Solo dopo un verdetto terminale si promuove verso main secondo BRANCHING.md.
- H. La build verificata viene realmente installata/aggiornata sull'installazione dell'owner, `muffin doctor` è sano o ogni warning residuo è compreso e deliberatamente accettato.
- I. A quel punto deve essere possibile dire: "Domani non devo sviluppare altro prima di poter usare Muffin. Posso semplicemente usarlo."

Questo è DAY 1. Non simulare né dichiarare completati i 14 giorni: il goal iniziale termina quando il giorno 1 può iniziare davvero. Durante la finestra /loop continua a correggere ciò che l'uso fa emergere.

## 4. Non fidarti delle garanzie locali: prova le catene

Il failure mode tipico di questa repo non è più soltanto "meccanismo scritto ma non cablato". È anche: "la stessa garanzia regge in un percorso e si perde in un percorso parallelo". Ragiona quindi per invarianti trasversali e lifecycle. In particolare, prima del Day 1 devi rieseguire o creare probe per almeno queste proprietà. Sono IPOTESI DA CONFUTARE, non fix prescritti.

1. **EFFECT WAL** — Simula il fallimento della persistenza di startToolCall() prima di una capability con effetto non-rerunnable. Proprietà: nessun side effect può iniziare se il suo intent write-ahead non è durevole. "Provo a registrare l'intent e, se fallisce, continuo" NON soddisfa la proprietà.
2. **TAINT ATTRAVERSO LA SESSION HISTORY** — Turno owner pulito → legge contenuto tier 2/3 → risposta assistant derivata → nuovo turno nella stessa sessione → la risposta precedente viene reiniettata nel context. Proprietà: qualunque byte fisicamente presente nel nuovo context conserva il massimo trust tier delle fonti da cui deriva. Una sessione/transcript non è una lavanderia del taint.
3. **PROVENANCE DEGLI EPISODI DELL'AGENTE** — Fai produrre a Muffin in un contesto tier 0 un'affermazione che l'owner non ha mai detto; salvala; recuperala in seguito via recall. Proprietà: le parole precedenti dell'agente non possono essere renderizzate o interpretate come "tu/owner ha detto". Trust tier e speaker/actor sono due dimensioni diverse.
4. **INBOUND EVENT → EXACTLY ONE WORK UNIT** — Telegram: update durevole → creazione turn → esecuzione → risposta → ack inbox. Inietta crash nei seam, soprattutto: dopo creazione/enqueue del turn ma prima dell'ack dell'update; dopo send riuscito ma prima di markProcessed. Proprietà: lo stesso update_id non deve creare un secondo lavoro né rieseguire effetti. Il PK dell'inbox da solo non dimostra questa proprietà. B2 non è chiuso sostituendo meccanicamente runTurn() con enqueueTurn(): deve mantenere l'idempotenza dell'evento attraverso il confine inbox→turn.
5. **DURABLE RESULT + DELIVERY** — Uccidi il processo dopo che la computazione ha prodotto la risposta ma prima che la delivery sia definitivamente registrata. Proprietà: il lavoro già completato non deve richiamare modello/tool solo per riconsegnare il risultato; il risultato finale deve essere recuperabile durevolmente; "non ancora inviato" e "forse inviato prima del crash" non devono essere confusi; una delivery incerta non viene automaticamente duplicata. Valuta se la delivery debba usare la stessa semantica intent/outcome degli altri effetti.
6. **FILESYSTEM CONTAINMENT** — Riproduci: terminal symlink in lettura; denyRead attraverso terminal symlink; directory-symlink/ancestor in scrittura di un nuovo file; hardlink/case/symlink già coperti. Proprietà: il path che la policy autorizza deve essere il path che l'OS toccherà.
7. **EGRESS / NON-INTERFERENCE** — Leggi byte dal filesystem o da altra fonte tier ≥2 e prova a inserirli in: web_search query; URL path/query; altri argomenti outbound. Non limitarti all'host allowlist. La promessa da verificare o correggere è: contenuto non fidato non può trasformare dati del tenant in parametri di egress senza una boundary deliberata. Se la soluzione temporanea è ASK, chiamala mitigazione, non fingere che equivalga alla non-interference.
8. **LOCK / LEASE / FENCING** — Prova: holder realmente vivo oltre stale horizon; laptop sleep; PID reuse; due processi; writer precedente che torna dopo che un altro ha reclamato. Non applicare semplicemente "stale && alive => held" senza risolvere PID reuse. Proprietà: un'esecuzione che non possiede più il claim non può continuare a mutare lo stato come proprietario. Valuta identità di processo/lease generation/fencing token se necessario.
9. **ACCEPTANCE TRUTHFULNESS** — Il report deve fallire se una riga dichiarata READY ha ancora uno scenario `atteso-rosso`, anche se `it.fails` sta fallendo "correttamente". Riconcilia almeno B8, C4 e D10 in base alla semantica ATTUALE, non al testo storico. Un expected-red deve preferibilmente provare la failure signature attesa, non "qualsiasi throw è quello giusto".
10. **MIGRATION** — Non provare soltanto un database fresco. Parti da uno schema realmente precedente e popolato, esegui upgrade, riapertura, doctor, turn, memory, scheduler, backup/restore. Day 1 è il momento dopo il quale reset del dataset non è più un rimedio.
11. **APPROVAL / ASK** — Qualunque ASK deve mostrare l'azione specifica: comando+cwd, URL/query pertinente, pid+processo, resource, motivo del taint. Per lavoro autonomo/scheduler: "ASK-in-coda" deve avere una semantica durevole reale se il contratto dice che aspetta l'owner; una notifica che chiude il turno e ripete domani non è una coda.
12. **OBSERVABILITY / SECRETS / MONEY** — errori delle trace devono passare dalla redaction; il costo deve essere normalizzato correttamente per provider, incluso cache read/write; unknown/degraded state deve fallire nella direzione conservativa; doctor deve rilevare ciò che un owner deve sapere prima di affidarsi al sistema.

Aggiungi qualsiasi altra proprietà scoperta durante il lavoro a M5-BIS: "non ci avevamo pensato" non è un motivo per rimandarla se impedisce il Day 1.

## 5. Chiudi le capability che mi costringerebbero a uscire da Muffin

Non assumere che i blocker attuali siano tutti corretti: rivalutali. Ma la finestra personale deve almeno coprire nel percorso reale: install/init/config/secret; aggiornamento senza perdita dati; migrazione; backup E restore provato; doctor operativo; identity/persona sufficienti a non sembrare un template; CLI/REPL; Telegram privato owner; session continuity; memoria attraverso restart; file/document attachment; streaming/presence; long-running turn fuori dal thread del connector; wait e resume; crash recovery; todo/work persistente; filesystem read; filesystem write realmente utilizzabile in sicurezza; journal/checkpoint/undo; shell sandboxata; process management necessario; HTTP/search; MCP/skills se sono esposti nel Day 1; scheduler e delivery se dichiarati utilizzabili; approval comprensibile; limiti di spesa e act caps; tracing/proprioception; failure visibili e recuperabili.

Per l'audio: oggi M5-BIS lo considera BLOCKER. Verifica se è realmente necessario alla finestra dell'owner. Se sì, chiudilo nella forma già decisa (native model capability quando esiste, fallback locale quando serve). Se no, proporre OUT è una decisione prodotto da portare all'owner, non una riclassificazione autonoma.

Identity/persona sono contenuto dell'owner: non inventarli. Prepara il minimo necessario, mostra esattamente cosa manca e chiedi soltanto le decisioni personali che nessun agente può dedurre legittimamente. Nel frattempo continua tutto il lavoro tecnico indipendente.

## 6. Reversibilità: l'autonomia deve diventare usabile

Non chiudere D2/D3/D11 mettendo semplicemente un backup dentro fs_write. Leggi la decisione owner e verifica la forma contro tutto il lifecycle degli effetti. Il problema generale è: prima di un effetto devo sapere cosa sto per fare; se è reversibile devo poter conservare lo stato necessario a disfarlo; dopo un crash devo distinguere fatto / forse fatto / non iniziato; undo deve riallineare il mondo E lo stato che Muffin conserva su quel lavoro.

Ragiona quindi, se l'evidenza lo conferma, in termini di effect lifecycle/journal riutilizzabile: policy → durable intent → eventuale snapshot/undo token → effect → durable outcome → eventuale delivery → eventuale undo. Non imporre questa forma se trovi una migliore, ma non implementare la reversibilità come eccezione locale che domani outward/process/config devono reinventare. In particolare, un retry della stessa tool call non deve sostituire lo snapshot pre-effect originale con uno snapshot dello stato già modificato.

## 7. Non fare il grande refactor per sentirti più sicuro

agent/loop.ts è grande e accoppia molte semantiche. Non aprire una slice "refactor loop" solo per questo. Prima rendi esplicite le primitive e le invarianti necessarie al Day 1. Se da PreparedToolCall/effect journal/result durability/evidence provenance emergono confini naturali, estraili come conseguenza. Il goal è un agente usabile, non una codebase esteticamente perfetta.

Allo stesso modo: niente nuova ontologia; niente multi-hop memory solo perché PR #46 lo propone; niente subagent architecture generale; niente world-state schema prima del consumer; niente pendant/hardware; niente computer-use; niente nuovi benchmark ornamentali. Il golden set "a trappola" della memoria può entrare se serve a provare una garanzia; il multi-hop entra solo se una richiesta Gate-1 reale lo rende necessario.

## 8. Come lavori

Sei l'orchestratore. Usa subagenti quando riducono context pollution o permettono verifiche indipendenti, scegliendo il modello in base a rischio/complessità/costo. Ma: il worker non certifica il proprio lavoro; il suo summary non è evidenza; verifica personalmente le affermazioni che reggono una decisione; per finding medium+ importanti usa uno skeptic/judge fresco quando utile; per security/durability prova a confutare; non rifare un audit largo da 70 agenti: abbiamo già pagato quel costo. Fai probe piccoli e mirati agli invarianti ancora aperti.

Ricerca esterna soltanto quando decide realmente una forma o un comportamento instabile, e usa fonti primarie/Context7. Hermes e altri agenti sono lenti comparativi, non specifiche da copiare. Preferisci una proprietà chiusa end-to-end a dieci moduli parzialmente migliorati.

Usa slice piccole e reviewabili secondo BRANCHING/ORCHESTRATION. Una slice dovrebbe normalmente chiudere una riga/invariante. Se due righe condividono la stessa primitiva e separarle produrrebbe due implementazioni divergenti, documenta perché la slice deve attraversarle entrambe.

Ogni fix importante: 1. riproduzione sul codice corrente; 2. test rosso reale; 3. implementazione; 4. test verde; 5. wiring test / mutation quando appropriato; 6. failure path; 7. scenario di accettazione; 8. suite; 9. documenti e viste derivate; 10. judge nuovo; 11. merge solo su verdetto terminale.

Dopo ogni merge: RICOSTRUISCI LO STATO. Non assumere che il piano precedente sia ancora il miglior prossimo passo.

## 9. Le decisioni su cui devi fermarti

Non chiedermi conferma per implementazione banale. Fermati invece davanti a: prodotto/scope del Day 1; privacy; sicurezza con tradeoff; modifica della costituzione/kernel; schema o formato durevole che inizieremo ad accumulare dal Day 1; migrazione che può perdere dati; comportamento irreversibile; cambio sostanziale della semantica di autonomy/approval.

Quando ti fermi non chiedere "che vuoi fare?". Porta: problema preciso; evidenza; opzioni reali; failure mode di ciascuna; costo/reversibilità; tua raccomandazione; una domanda esatta a cui devo rispondere. Non interrompere invece tutto il goal per una decisione che non blocca il lavoro indipendente: registra il bivio e continua ciò che può procedere.

## 10. Battery di cutover

Prima di propormi DAY-1 READY costruisci ed esegui una battery finale che provi il sistema COME SISTEMA. Non limitarti a questa lista se emerge altro, ma deve dimostrare almeno: installazione pulita e setup locale realistico; build artifact reale e comando `muffin` realmente eseguibile; upgrade da installazione precedente senza perdita; backup → distruzione controllata della copia → restore → verifica; doctor sull'installazione risultante; sessione CLI con memoria → processo chiuso → ripresa; Telegram owner DM reale quando le credenziali sono disponibili; streaming/progress e attachment sul percorso Telegram; turno Telegram lungo restituisce controllo alla surface e viene completato dalla lane; SIGKILL durante turno → resume corretto; wait attraverso restart; todo attraverso restart; crash nei seam dell'inbound Telegram senza doppio lavoro; crash dopo model/effect/result senza riesecuzione indebita; write → verifica filesystem → undo → filesystem e work state riallineati; read untrusted → shell: policy prevista e ASK dettagliato quando consentito; tier 3 → capability sensibile: confinement previsto; filesystem symlink adversarial cases; disk bytes → egress/search adversarial case; scheduler/job attraverso restart e delivery; approval autonoma persistente se la semantica la richiede; cap di spesa realmente ferma la chiamata successiva; pricing coerente con usage dei provider usati; trace permette di ricostruire il perché senza esporre segreti; memory recall non attribuisce all'owner parole dell'agente; history non lava la provenance; database vecchio migra davvero; `npm run compile` produce l'artifact che installiamo; naming degli script (`build` vs `compile`) non deve permettere a una persona di credere di avere costruito `dist` quando non è successo.

Dove non puoi eseguire una prova reale per mancanza di una capability/credential dell'ambiente, non sostituirla silenziosamente con un mock e chiamarla chiusa. O trova una prova equivalente che dimostra la stessa proprietà, o dichiarala come prova dovuta all'owner e guidami nell'eseguirla.

## 11. L'ultimo checkpoint

Quando pensi che Muffin sia pronto: NON dichiararlo subito. Fai un ultimo audit integrato a contesto fresco sulla build candidata. La domanda del judge non è: "i blocker che conoscevamo sono chiusi?" È: "se oggi l'owner disinstalla mentalmente il vecchio agente e vive dentro questo Muffin per 14 giorni, quale cosa concreta lo farà uscire?"

Attacca: happy path; crash; sleep/restart; dati vecchi; output grandi; tool lunghi; rete che fallisce; delivery incerta; provider che fallisce; injection; replay; budget; install/upgrade; una giornata d'uso, non una singola richiesta.

Se emerge un nuovo blocker, il goal NON è fallito: hai trovato esattamente ciò che questo goal esiste per trovare. Aggiungilo all'inventario e chiudilo.

Solo quando l'audit finale non trova un motivo concreto per rimandare il Day 1: 1. porta dev allo stato integrato verificato; 2. aggiorna integralmente STATE.md, LAVORO.md, M5-BIS e viste derivate; 3. fai il checkpoint dev→main previsto da BRANCHING.md con judge nuovo; 4. installa/promuovi la build verificata sull'installazione reale; 5. esegui doctor + battery finale owner-side; 6. mostra un report conciso: commit/build esatta; cosa è stato provato; cosa resta OUT e perché non serve nei 14 giorni; limiti noti non bloccanti; comandi di recovery/backup; costo/budget configurato; eventuali azioni personali ancora dovute all'owner; 7. chiedimi esplicitamente di iniziare DAY 1.

Il goal è raggiunto soltanto quando la risposta onesta alla domanda "C'è qualcosa che sappiamo già che mi costringerebbe a smettere di usare Muffin durante i prossimi 14 giorni?" è: "no". Non ottimizzare per arrivare presto a quella parola. Ottimizza perché sia vera.
