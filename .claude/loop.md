# Il control loop di Muffin

Porta Muffin verso il goal corrente usando lo stato osservato, le autorità di
repo e il protocollo in `docs/ORCHESTRATION.md`. Quando il goal è DAY-1, usa
`docs/blueprint/M5-BIS.md` come inventario di stato e
`docs/blueprint/gate1/PERCORSO-CRITICO.md` come ordine. Non fare manutenzione
generica: scegli una claim reale e chiudila.

**Ogni giro nomina la claim/goal che fa avanzare.** Se non la sai nominare, quel
giro non è lavoro sul goal: è manutenzione che entra perché sta dentro un tick,
ed è il modo in cui il loop smette di andare da qualche parte pur restando
occupato.

**Il loop si ferma da solo.** Quando l'unico lavoro rimasto è dell'owner — un
segreto che solo lui ha, un pagamento, un demone giù sulla sua macchina, una PR
che solo lui mergia — fermati, dillo in una riga e chiudi il loop invece di
ticchettare su ciò che resta. Idem quando il criterio finale del goal è
soddisfatto. Un loop che continua dopo essere arrivato non prova di essere
arrivato: nasconde che non lo è.

## 0. Prima del codice: challenge pass quando la claim lo richiede

`AGENTS.md` e `docs/RESEARCH.md` valgono anche qui. Per una modifica materiale a
runtime/harness, hooks/guardrails, sicurezza/authority/provenance, memoria/person
model, processi/servizi, subagent, estensioni o schema durevole:

1. osserva il problema reale in Muffin e traccia il production path;
2. ricostruisci la decisione e le assunzioni esistenti;
3. guarda peer correnti per **lo stesso problema** — Hermes Agent e OpenClaw sono
   default, non il limite;
4. aggiungi i peer specialisti del dominio (es. Letta/Mem0 per memoria,
   CaMeL/Progent per security, sistemi di durable workflow per recovery);
5. cerca evidenza primaria/scientifica sia a favore sia contro;
6. considera esplicitamente anche l'opzione di semplificare/rimuovere il
   meccanismo;
7. definisci l'eval/osservazione che potrebbe falsificare la scelta **prima** di
   implementare.

Per un bug meccanico con comportamento desiderato già non ambiguo non serve una
review della letteratura. Se il bug espone un'assunzione architetturale, il pass
diventa obbligatorio.

La ricerca durevole va in `docs/blueprint/research/`; il current state resta nel
suo authoritative home. Una ricerca più nuova non sostituisce automaticamente
ARCHITECTURE/SECURITY/ADR.

## 1. Startup: osserva prima, leggi il minimo

Il contesto è una risorsa. `AGENTS.md`, `CLAUDE.md` e `docs/README.md` sono mappe;
non autorizzano a caricare tutto il repo a ogni ciclo.

All'inizio normale:

1. Ricostruisci lo **stato osservato**. Esegui
   `node .claude/deleghe.mjs riprendi`: deleghe aperte, chiuse o parcheggiate e
   diagnosi dello stato interrotto. Poi osserva worktree/branch, PR, check,
   commit non pushati e conflitti. Una review aperta o uno stato danneggiato
   precedono nuovo lavoro.
2. Confronta l'osservato con `docs/blueprint/LAVORO.md`. Git/realtà vincono sul
   handoff se divergono; correggi il handoff prima che una nuova sessione erediti
   una bugia.
3. Leggi l'autorità di ordering/status del goal corrente; per DAY-1, la voce
   corrente di `PERCORSO-CRITICO.md` e le righe toccate di `M5-BIS.md`.
4. Carica altra documentazione solo quando la claim la rende load-bearing.
5. Se la claim dipende dall'installazione vera, usa `docs/MUFFIN-HOME.md` per
   scegliere **quale classe** di stato osservare; non dumpare ricorsivamente
   `~/.muffin` nel context.

`node .claude/riconcilia.mjs` resta un controllo stretto sul drift che sa vedere.
Non estenderlo in un framework universale soltanto perché esiste un altro tipo di
disaccordo.

Delegare non è il default. Una task piccola e locale la fa l'orchestratore.
Prima di un fanout usa `node .claude/deleghe.mjs preventivo <n>`; una delega si
registra prima di partire e, se muore per quota/sessione, si parcheggia con stato
riprendibile invece di sparire.

## 2. Progressive disclosure: cosa caricare quando

`docs/README.md` decide **dove cercare**, non la verità della singola claim.

| Se la task tocca… | Carica anche… |
|---|---|
| taint, provenance, egress, secrets, sandbox | `docs/SECURITY.md`, config/codice pertinenti, ADR che spiegano la decisione + challenge in `docs/RESEARCH.md` |
| memoria, recall, estrazione, person model | `docs/blueprint/knowledge/` pertinente + ADR/store coinvolti + peer/eval memory in `docs/RESEARCH.md` |
| schema, migrazioni, durabilità | schema/migration code + `docs/ARCHITECTURE.md` + ADR dello store |
| turni, work, gateway, scheduler, delivery | `docs/ARCHITECTURE.md` + ADR pertinenti + `docs/RESEARCH.md` se cambia una primitive del harness |
| processi/background/service | `docs/ARCHITECTURE.md` + `docs/MUFFIN-HOME.md` + supervisor/process code + challenge peer/runtime |
| identità, prompt, Root of Trust | `defaults/` rilevanti + SECURITY/ADR pertinenti |
| una review | `docs/JUDGE.md` |
| pratica ingegneristica | `docs/PRACTICES.md` |
| Git/merge/promotion | `docs/BRANCHING.md` |
| perché/cosa stiamo costruendo | `docs/THESIS.md` + `docs/VISION.md` + `docs/DESIGN-PRINCIPLES.md` |
| evidence storica | il research/audit datato pertinente, mai l'intera cartella |

Non usare `STATE.md`, il vecchio threat model o i contratti rebuild-era come
shortcut per lo stato corrente. Possono essere evidence/history quando la task
richiede la loro lineage.

## 3. Classifica la claim prima di implementare

Dopo aver scelto la claim (e completato l'eventuale challenge pass), scegli
**FAST / STANDARD / CRITICAL** usando la procedura e i trigger canonici in
`docs/ORCHESTRATION.md`. Scrivi profile e motivo nella PR.

Non copiare qui la matrice dei profili: una modifica a ORCHESTRATION deve cambiare
la policy di verifica in un solo posto.

La dimensione del diff non decide il profilo. Se durante il lavoro emerge un
boundary più rischioso, escalare è normale; un downgrade opportunistico no.

## 4. Scegli il prossimo obiettivo dal goal reale

- Prima chiudi ciò che impedisce concretamente il goal corrente.
- Le decisioni che possono rendere costosa la forma durevole vengono prima che
  l'installazione inizi ad accumulare altro stato reale.
- Una decisione prodotto, sicurezza, privacy, schema o irreversibile che non è
  già stata presa richiede opzioni, costi e una domanda precisa all'owner. Non
  scegliere in silenzio.
- Non aggiungere architettura futura soltanto perché il mondo 2026 la rende
  interessante. Registra il finding; entra nel goal solo se una failure/claim
  corrente la rende necessaria.
- Non mantenere un meccanismo perché “lo abbiamo già costruito”: se il challenge
  pass mostra che un'assunzione è scaduta, semplificare/rimuovere è un risultato
  valido.

## 5. Verifica il percorso, non il modulo

Prima di implementare, traccia produttore → consumer → failure path → vista
derivata della garanzia. Controlla branch/worktree non integrati per non duplicare
una primitiva o sovrascrivere lavoro migliore.

Un valore valido oggi per host, Telegram, un modello o una macchina non diventa
una costante per comodità. Principal, tenant, surface, provider, budget,
provenance e capability attraversano i confini come dati/config espliciti.

Quando la claim riguarda un meccanismo di sicurezza/durabilità, l'evidenza deve
fallire quando si rimuove **la cucitura che rende vera la claim**, non soltanto
quando si rompe la funzione locale.

Quando la claim nasce da un confronto architetturale, verifica anche il criterio
che ha fatto vincere la scelta: task success, attack success, approval inutili,
recovery, latenza/costo, recall quality o altro indicatore definito prima del
codice.

## 6. Scope firewall

Un nuovo finding entra nella slice solo se invalida la claim, impedisce la sua
verifica, crea un rischio corrente concreto o è tecnicamente inseparabile.
Altrimenti va registrato come follow-up/debt/evidence e la slice corrente si
chiude.

Segui `docs/ORCHESTRATION.md` per la regola canonica; non trasformare `/loop` in
un secondo manuale di scope.

## 7. Chiusura e handoff

Una claim è chiusa quando il suo evidence budget è soddisfatto e nessun blocker
noto la invalida. FAST/STANDARD seguono l'integrazione prevista da
ORCHESTRATION; CRITICAL richiede il verdetto terminale indipendente previsto lì.

Dopo un merge:

1. ricostruisci lo stato osservato;
2. aggiorna status/ordering authority **solo** se cambia davvero il goal;
3. aggiorna `LAVORO.md` con il minimo handoff operativo;
4. aggiorna ARCHITECTURE/SECURITY/etc. solo se la loro semantica è cambiata;
5. conserva research come evidence, non come current truth;
6. rigenera viste derivate se la loro fonte è cambiata;
7. non "rinfrescare" audit/history per farli sembrare correnti.

Non dichiarare il goal raggiunto perché compila o perché un documento dice
READY. Il criterio finale è l'outcome integrato, provato come lo userà davvero
l'owner.
