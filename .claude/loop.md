# Il control loop di Muffin

Porta Muffin al **DAY-1 READY** definito dal mandato Gate, usando
`docs/blueprint/M5-BIS.md` come inventario di stato e
`docs/blueprint/gate1/PERCORSO-CRITICO.md` come ordine. Non fare manutenzione
generica: scegli una claim reale e chiudila secondo `docs/ORCHESTRATION.md`.

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
3. Leggi soltanto la voce corrente di
   `docs/blueprint/gate1/PERCORSO-CRITICO.md` e le righe toccate di
   `docs/blueprint/M5-BIS.md`.
4. Carica altra documentazione solo quando la claim la rende load-bearing.

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
| taint, provenance, egress, secrets, sandbox | `docs/SECURITY.md`, config/codice pertinenti, ADR che spiegano la decisione |
| memoria, recall, estrazione, person model | `docs/blueprint/knowledge/` pertinente + ADR/store coinvolti |
| schema, migrazioni, durabilità | schema/migration code + `docs/ARCHITECTURE.md` + ADR dello store |
| turni, work, gateway, scheduler, delivery | `docs/ARCHITECTURE.md` + ADR 0022/0035/0042/0047 o successivi pertinenti |
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

Scegli **FAST / STANDARD / CRITICAL** usando la procedura e i trigger canonici in
`docs/ORCHESTRATION.md`. Scrivi profile e motivo nella PR.

Non copiare qui la matrice dei profili: una modifica a ORCHESTRATION deve cambiare
la policy di verifica in un solo posto.

La dimensione del diff non decide il profilo. Se durante il lavoro emerge un
boundary più rischioso, escalare è normale; un downgrade opportunistico no.

## 4. Scegli il prossimo obiettivo dal Gate reale

- Prima chiudi ciò che impedirebbe concretamente l'inizio dei quattordici giorni.
- Le decisioni che possono rendere costosa la forma durevole vengono prima che
  l'installazione inizi ad accumulare dati reali.
- Questa generazione parte con memoria nativa nuova (ADR-0049); dopo il suo
  confine di nascita, reset del canonical state non è un recovery path normale.
- Una decisione prodotto, sicurezza, privacy, schema o irreversibile che non è
  già stata presa richiede opzioni, costi e una domanda precisa all'owner. Non
  scegliere in silenzio.
- Non aggiungere architettura futura soltanto perché il mondo 2026 la rende
  interessante. Registra il finding; entra nel Gate solo se il criterio Day1 lo
  rende necessario.

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

## 6. Scope firewall

Un nuovo finding entra nella slice solo se invalida la claim, impedisce la sua
verifica, crea un rischio Day1 concreto o è tecnicamente inseparabile. Altrimenti
va registrato come follow-up/debt e la slice corrente si chiude.

Segui `docs/ORCHESTRATION.md` per la regola canonica; non trasformare `/loop` in
un secondo manuale di scope.

## 7. Chiusura e handoff

Una claim è chiusa quando il suo evidence budget è soddisfatto e nessun blocker
noto la invalida. FAST/STANDARD seguono l'integrazione prevista da
ORCHESTRATION; CRITICAL richiede il verdetto terminale indipendente previsto lì.

Dopo un merge:

1. ricostruisci lo stato osservato;
2. aggiorna `M5-BIS.md` **solo** se cambia status/evidence Gate;
3. aggiorna `PERCORSO-CRITICO.md` **solo** se cambia ordine/dipendenza;
4. aggiorna `LAVORO.md` con il minimo handoff operativo;
5. rigenera viste derivate se la loro fonte è cambiata;
6. non "rinfrescare" audit/history per farli sembrare correnti.

Non dichiarare DAY-1 READY perché compila o perché un documento dice READY. Il
criterio finale resta il mandato: zero blocker personali reali, percorso integrato
provato come lo userà l'owner, owner-machine acceptance e nessun motivo già
conoscibile che lo costringa a tornare a un altro agente nei quattordici giorni.
