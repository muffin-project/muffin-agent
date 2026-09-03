# Esistenza fuori dal turno — la sveglia c'è, manca chi la carica

**Data:** 2026-09-03 · **Stato:** evidence datata, non authority · **Head:**
`slice/ricerca-fuori-dal-turno` su `dev` `9840e91` · **Macchina:** macOS 25.0,
worktree pulito. Nessuna riga di runtime cambiata, nessuna ADR: questo memo
porta una raccomandazione che l'owner accetta o rifiuta.

Commissionato dalla riga che `docs/ROADMAP.md` mette prima di tutte, con
l'argomento che Muffin ha dato all'owner: *«Zero job, niente heartbeat: esisto
solo quando mi chiami. Se tra un mese c'è una promessa che avevi fatto di
sfuggita e nessuno mi sveglia, non succede niente.»*

## La raccomandazione, in tre frasi

La sveglia esiste e batte ogni 30 secondi da settimane: ciò che manca non è il
meccanismo che si sveglia ma **chi scrive la sveglia**, perché in tutto l'albero
esiste una sola porta di produzione che crea un job — `muffin jobs add`, battuta
a mano dall'owner — e la memoria di lavoro che potrebbe scriverla, `todos`, non
ha un'ora e vive dentro una sessione che un job non apre mai. Il passo più
piccolo **non** è un tool `jobs` per il modello: è dare a `todos` una scadenza
opzionale e collegarla al produttore che `ProactiveKind` dichiara da sempre e
nessuno ha mai scritto — `commitment_due` — perché quella tabella porta già la
colonna `tier` col taint del turno che l'ha scritta e `decideProactive` nega già
per costruzione tutto ciò che arriva sopra tier 1, mentre un job oggi gira a
`taint: 0` con principale di sistema e lava la provenienza in silenzio. Il resto
è una decisione di prodotto che spetta all'owner e la risposta giusta a un tick
che suona a vuoto resta **niente**.

## 0. Cosa è misurato e cosa no

**Misurato:** quali chiamanti esistono nell'albero a `9840e91`, cosa esegue il
tick riga per riga, quale principale e quale taint riceve un job quando spara,
come è chiavata la tabella `todos`, e quale semantica di recupero implementa
`markRan`. Tutto su codice letto e su una corsa vera della suite dello
scheduler.

**Non misurato:** il database vivo dell'owner. Le tre cifre da cui parte questo
memo — 1 job del 25/08, 1 fire, `proactive_fires` a zero, 7 `todos` `pending`
dal 27/08 — mi sono state consegnate dal brief e non le ho ri-misurate: non ho
aperto `~/.muffin`. Dove una conclusione dipende da quelle cifre lo dico.

**Non misurato:** se il modello abbia mai *provato* a schedulare qualcosa. Non
esiste un rifiuto da contare, perché non esiste un tool da rifiutare.

Comandi eseguiti, con esito:

```text
npm ci                                   → 0
npx vitest run core/scheduler            → 0   (7 file, 77 test)
npx vitest run docs                      → 0   (3 file, 17 test)
node docs/derived/architecture-map/ancore.mjs && node …/build.mjs → 0
```

## 1. Le porte, e chi le apre davvero

La premessa del brief regge: il meccanismo c'è tutto. `core/scheduler/` ha
`jobs.ts`, `job-fires.ts`, `scheduler.ts`, `proactivity.ts`, `observe.ts`,
`firelog.ts`, `sendlock.ts`; il gateway ha un tick che è anche il battito
(`core/gateway/service.ts:246`); `agent/scheduler-run.ts` sa eseguire sia un
obiettivo sia uno script contenuto. 77 test verdi in 856 ms.

Quello che non c'è è **chi entra**.

`JobStore.add` ha, in tutto l'albero, **un solo chiamante fuori dai test e dagli
eval**: `cli/jobs.ts:107`. Verificato per costruzione, non a occhio:

```text
$ grep -rn "jobs\.add\|jobStore\.add\|store\.add(" --include='*.ts' .
… 27 righe, tutte in *.test.ts o evals/, tranne cli/jobs.ts:107
```

La tabella. Nessuna cella contiene barre verticali per costruzione, e la colonna
di destra dice *evidenza vista nel repo*, non congettura.

**`muffin jobs add` — crea un job cron.** Raggiungibile dall'owner, a mano, dal
terminale. È l'unica porta di produzione che scrive in `jobs`. Evidenza d'uso:
la riga del 25/08 nel database dell'owner, secondo il brief.

**Un tool `jobs` per il modello — non esiste.** E qui c'è il difetto di forma di
questo repo, scritto nero su bianco dentro il file che dovrebbe saperlo:
`cli/jobs.ts:13-15` afferma *«the natural-language path ("ogni mattina alle 8")
is a loop tool that turns the phrase into this cron after confirming it with the
owner, and lands on the same store»*. Quel tool non c'è. `agent/tools/` contiene
`send_file`, `todo`, `web_search`, `process_list`, `process_kill`,
`document_read`, `http_get`, `fs_read`, `fs_list`, `fs_search`, `fs_write`,
`sys_inspect`, `shell_run`, `wait`, `memory_search`, `skill_read` — e nient'altro.
Il commento descrive una porta al presente indicativo e la porta non è mai
esistita.

**`shell_run` verso `muffin jobs add` — teoricamente, praticamente no.** Il
comando aprirebbe `paths(home).db`, e ADR-0059 ha separato la casa dallo spazio
di lavoro proprio il 03/09: la home sta su `denyRead` e fuori dal `writeScope`
della sandbox (`agent/tools/shell.ts:148`). In più `sys.shell` è una domanda a
qualunque taint sotto 3 finché `rot harden` non è stato eseguito. Non ho trovato
nessuna traccia nel repo che qualcuno ci sia mai passato, e non ho potuto
guardare le tracce dell'owner: **questa porta esiste sulla carta e non ho potuto
stabilire se qualcosa la raggiunga.**

**`muffin observe --send` — crea un fire proattivo.** `cli/observe.ts:131` è
l'unico costruttore di `FireLog` in produzione; l'unico altro sta nei test.
Raggiungibile dall'owner, a mano. Nessun job, nessun tick, nessun connettore la
chiama.

**Config, `defaults/`, onboarding, `init` — nessuno crea job.** `grep -rn jobs
defaults/` non restituisce niente; `cli/init.ts` e `cli/onboarding.ts` non
nominano `JobStore`. Un'installazione nuova nasce con zero job e non ne guadagna
nessuno.

**I connettori — nessun percorso.** `new JobStore` esiste in produzione in un
solo punto, `agent/runtime.ts:338`, e da lì il runtime **legge** (`due`,
`markRan`, `list`) e non scrive mai.

**`wait` — non crea niente di durevole fuori dal turno.** Sospende *il turno
corrente*, fino a `MAX_WAIT_MS = 7 * 24 * 60 * 60 * 1000` (7 giorni,
`core/turns/wait.ts:52`), con un tetto di 8 turni sospesi per tenant
(`:63`). È il primitivo giusto per «ricontrolla fra un'ora» e strutturalmente il
primitivo sbagliato per «fra un mese»: la promessa dell'owner sta oltre
l'orizzonte massimo, e occuperebbe uno degli otto slot per tutto il tempo.

> **La risposta alla prima domanda del brief, in una riga: l'unica porta è un
> comando che l'owner deve battere a mano. Il modello non ha nessun modo di
> ricordarsi qualcosa per il mese prossimo, e il commento che dice il contrario
> è stato scritto per un tool che nessuno ha mai costruito.**

## 2. Cosa fa il tick quando suona a vuoto

Tre cose, ed è giusto che siano tre.

`Gateway.tick` (`core/gateway/service.ts:246`) rinfresca la rivendicazione con
`lock.beat`, pubblica la riga di stato, poi chiama `scheduler.tick(now)`
(`:255`) e `turnLane.tick(now)`. La cadenza è `TICK_MS = HEARTBEAT_MS`
(`core/gateway/service.ts:58`), 30 secondi, e il battito **è** il tick per
scelta: se smette di ticchettare la rivendicazione scade e un altro processo la
prende. Questa è la parte sana ed è il motivo per cui la frase «niente
heartbeat» del ROADMAP è falsa.

`Scheduler.tick` (`core/scheduler/scheduler.ts`) attraversa in ordine
`standDown`, `paused`, `modelLane.busy`, `gate.isActive`, poi:

```ts
const [job] = this.store.due(now);
if (!job) return;
```

(`core/scheduler/scheduler.ts:276-277`.) Su un'installazione con zero job dovuti
il tick **non emette nemmeno un evento**: non c'è `deferred`, non c'è
`not_recorded`, non c'è niente. Costa una query indicizzata su
`jobs(active, next_fire_at)` e torna. Su una tabella con un job non ancora
dovuto è esattamente lo stesso.

`TurnLane.tick` sulla stessa battuta risveglia i turni sospesi da `wait` che
hanno raggiunto la scadenza. Anche quello, a vuoto, è una query e un ritorno.

**Quindi:** il processo è vivo, batte, e non ha niente da fare. Questa non è la
distinzione fra «il processo è su» e «l'agente è vivo» — è la stessa distinzione,
ed è la diagnosi giusta. Il gateway non è wedged: è **inoccupato per
costruzione**, perché nessun produttore gli mette lavoro nella coda.

## 3. `proactivity.ts`: perché `proactive_fires` è zero

Non «non spara mai» e non «spara e nega sempre». **Non è cablata a niente che si
svegli da solo.**

La catena completa è: `detectAbsences` (memoria) → `observe`
(`core/scheduler/observe.ts`) → `decideProactive` (`core/scheduler/proactivity.ts:111`)
→ `FireLog.record`. Ogni anello esiste, è testato (12 + 9 + 3 test verdi), e la
catena intera ha **un solo punto di ingresso in produzione**: `cmdObserve`, cioè
il comando `muffin observe`. Il fire log si scrive solo in `sendAllowed`, cioè
solo con `--send`.

Perciò `proactive_fires: 0` significa una cosa sola e verificabile: **nessuno ha
mai eseguito `muffin observe --send`.** Non c'è nessun difetto da riparare in
`proactivity.ts`; c'è un comando che nessuno ha battuto.

Due cose lo confermano nel repo, entrambe scritte prima di me:

- ADR-0035 §*«Consolidamento e osservazione senza il tuo dito»* elenca fra le
  clausole **non soddisfatte** di M5, testualmente: *«`muffin memory extract` e
  `muffin observe` non devono diventare più comodi — devono smettere di essere
  tuoi.»* Il gateway è arrivato; questa clausola non è mai stata chiusa.
- `docs/evidence/triage-2026-08-17/a-b.md:473`, punto B9: *«non ho verificato se
  `muffin observe` sia mai invocato dallo scheduler/gateway stesso»*. **Ora è
  verificato: non lo è.**

E c'è un secondo zero, più interessante del primo. `ProactiveKind` ha quattro
valori e **uno solo ha un produttore**: `gone_quiet`, dal detector delle assenze.
`commitment_due` — *«un obbligo che l'owner ha registrato, il cui momento si
avvicina»* — `deadline_near` e `fact_actionable` sono dichiarati e non prodotti
da nessuno. `docs/work/day1/requirements-status.md:267` lo dice già. Il primo dei
tre è, parola per parola, la frase dell'owner sulla promessa fatta di sfuggita.

## 4. I sette `todos`: né bug né feature mancante, ma una chiave

La domanda del brief è se qualcosa dovesse mai farli riemergere. La risposta è
nello schema, non nell'intenzione.

`todos` è chiavata `PRIMARY KEY (tenant, session_id, key)`
(`core/turns/todo.ts:116`) e l'unica lettura che conta è

```sql
… FROM todos WHERE tenant = @tenant AND session_id = @sessionId AND state != 'done'
```

(`core/turns/todo.ts:177`), chiamata da `agent/loop.ts:1720` all'inizio di ogni
turno. **Un todo è per costruzione legato a una sessione, ed è letto solo quando
qualcuno parla in quella sessione.** Non esiste un lettore su base temporale;
non ne esiste uno cross-sessione; non ne esiste uno nel tick.

Il colpo di grazia è che il job — l'unica cosa che si sveglia da sola — apre
**una sessione nuova e usa e getta**:

```ts
const session = deps.sessions.open(`job-${job.id.slice(0, 8)}-${randomBytes(3).toString('hex')}`);
```

(`agent/scheduler-run.ts:134` e `:303`, con il commento che lo dichiara
deliberato: *«a daily brief is not one growing conversation»*.) Quindi anche
oggi, con un job attivo, il turno che si sveglia **non può vedere nessun todo**,
e nessun todo può essere visto da chi si sveglia. Le due metà di «esistenza fuori
dal turno» sono disconnesse per costruzione: chi si sveglia non ha il piano, e il
piano non ha un orologio.

C'è un terzo fatto che spiega perché quelle sette righe sono ferme dal 27/08 e
non riemergono nemmeno parlando. ADR-0056, accettato **oggi** 2026-09-03, ha
spostato la chiave di sessione dentro `identify`: l'owner ha ora una sessione
sola, `OWNER_SESSION_KEY = 'owner'` (`core/surface/types.ts:225,301`). Prima di
ADR-0056 il REPL ne apriva una **per lancio** (`YYYY-MM-DD-<8 hex>`) e la CLI
headless una per invocazione. Righe scritte il 27/08 portano quindi con ogni
probabilità una chiave che non verrà mai più aperta — e se furono scritte dal
REPL, non sarebbero riemerse nemmeno al lancio successivo, allora. Dico *con ogni
probabilità* perché **non ho letto il database dell'owner e non conosco il loro
`session_id`**: la verifica costa una `SELECT DISTINCT session_id FROM todos` e
non l'ho eseguita.

**La classificazione, quindi.** Non è un bug del tool `todo`: quel tool fa
esattamente ciò che dichiara, `effect: 'context'`, *«nothing here executes
anything: it records what you intend to do»*, e la sua descrizione dice
onestamente *«the persistent plan for this conversation»*. Non è nemmeno,
esattamente, una feature mancante del tool: è **la feature mancante del
sistema**, cioè una intenzione prospettica — un impegno con un momento — che oggi
non ha nessuna tabella che la sappia rappresentare. `jobs` sa rappresentare una
*ricorrenza*, `todos` sa rappresentare un *passo*, `wait` sa rappresentare
*un'attesa dentro un turno lungo al massimo sette giorni*. Nessuno dei tre è «una
cosa da fare il 3 ottobre».

E `jobs` non lo diventa cambiando porta. `markRan` (`core/scheduler/jobs.ts:245-252`)
ricalcola sempre `nextFire` e **non disattiva mai** la riga: un job non ha una
forma «una volta sola». Un impegno singolo scritto come cron `0 9 3 10 *`
tornerebbe ogni anno. Questo è un limite di *tipo*, non di accesso, e va detto
prima di qualunque discorso su chi possa creare job.

## 5. La risposta sul taint per un job creato dal modello

Il brief chiede la risposta nel vocabolario del kernel che esiste. Eccola, e la
parte che conta è che **la forma sicura esiste già e non è quella dei job**.

**Come sta oggi.** Un job spara con principale `{ kind: 'system', source:
'scheduler' }` e tenant `host` (`agent/scheduler-run.ts:136`, `:342`), e il turno
viene creato con `taint: 0` scritto letteralmente (`:351`, e `:368` alla
chiusura). Non è un difetto nel contesto per cui fu costruito — un job nasce oggi
solo da un comando battuto dall'owner in un terminale, quindi la sua origine *è*
pulita. Diventa un difetto nell'istante in cui un turno può crearne uno: un turno
a taint 3 che scrive un job produce, un mese dopo, un turno a taint 0 con
principale di sistema. È **laundering completo**, e per giunta con un'ampiezza di
azione maggiore di quella del turno che l'ha scritto, perché nessuno guarda.

La letteratura ha un nome per questo e non è ipotetico: *delayed trigger attack*,
un'istruzione iniettata in una sessione ed eseguita in una successiva dopo che il
contesto originale è stato scartato. È esattamente lo scenario `s7`
(`remember-then-act`) del corpus del 03/09, che **è riuscito** e non è fermato da
nessuna guardia — 4 attacchi su 7 riusciti senza nessun umano nel giro
(`docs/evidence/eval-taint-corpus-avversariale-2026-09-03.md` §1).

**La risposta, e non richiede kernel nuovo.** `decideProactive` risponde già
`{ effect: 'deny', reason: 'tainted_source' }` a qualunque trigger con
`tier > 1` (`core/scheduler/proactivity.ts:112-114`), ed è la **prima** riga
della funzione, prima delle ore di silenzio e prima del budget. La tabella
`todos` porta già il taint del turno che ha scritto la riga, in una colonna
dichiarata `NOT NULL` senza default e col commento che spiega perché: *«a row
that arrived without one would read as clean, which is the one direction this
column exists to forbid»* (`core/turns/todo.ts:110-113`). E `agent/loop.ts:1720`
alza già il **soffitto** del turno con `planTaint(open)` quando ricarica il
piano, per ADR-0044.

Quindi, concretamente, per un impegno differito:

1. **Il taint che il differimento porta è quello del turno che l'ha scritto**,
   registrato alla scrittura, mai ricalcolato al risveglio. La colonna esiste.
2. **Sopra tier 1 non parla.** Non «chiede»: nega, per la stessa ragione per cui
   `gone_quiet` nega — un impegno piantato da un messaggio di gruppo o da una
   pagina web è il memory-poisoning dormiente, e il rail è già scritto e già
   testato (`proactivity.test.ts`).
3. **Quando spara, il turno eredita quel tier come soffitto**, non `taint: 0`.
   È il contrario esatto di ciò che fa oggi un job, ed è la riga che va scritta
   se e solo se si sceglie di far scattare un turno e non solo un messaggio.
4. **Chi viene avvisato:** l'owner, sul canale, con l'ancora che dice *quando*
   l'impegno fu preso e *da quale evidenza*. `FireLog` conserva già `anchor`,
   `kind`, `decided_at` e `reason`, e la riga non si cancella mai (§I-8).

**La conseguenza sulla porta `jobs`.** Se l'owner vuole comunque un tool `jobs`
per il modello, la forma minima non è «aggiungere `maxTaint`»: è che
`agent/scheduler-run.ts` smetta di scrivere `taint: 0` a mano e legga invece un
taint conservato sulla riga del job, e che un job con taint > 1 non spari affatto.
Finché quel `0` è una costante letterale, ogni discussione su chi possa creare
job è una discussione su come laundering va fatto, non su se.

## 6. Recupero contro salto, per gli spari persi durante un riavvio

**Muffin ha già una semantica, è quella giusta, e non è mai stata dichiarata.**

`markRan` ricalcola il prossimo sparo **da adesso**, non dal vecchio
`next_fire_at` (`core/scheduler/jobs.ts:245-252`), e `due()` seleziona qualunque
riga con `next_fire_at <= now`. Composte, le due cose danno: un processo spento
tre giorni trova il job dovuto al riavvio, **spara una volta sola**, e riprende la
cadenza. Nessun arretrato, nessuna perdita. Nel vocabolario di APScheduler è
`coalesce=True` con `misfire_grace_time` **illimitato**; nel vocabolario di Quartz
è a metà fra le due famiglie di misfire instruction, più vicino a
`FIRE_NOW`-una-volta che a `IGNORE_MISFIRES`. Hermes converge sulla stessa
scelta e la dichiara: *«Missed ticks coalesce. If the session was busy (or the
process wasn't running) through several intervals, you get one heartbeat turn,
not a backlog.»*

C'è già un test che la prova, e il suo nome dice la proprietà:
`core/scheduler/jobs.test.ts:120`, *«markRan schedules the next fire from now,
not replaying missed slots»* — due giorni di processo morto, un solo sparo,
prossima occorrenza il giorno dopo.

**La raccomandazione è: non cambiare niente per i job cron, e dichiararlo.** Il
gateway riparte a ogni `muffin update`, quindi la finestra persa è tipicamente di
secondi e il coalescing è esattamente giusto.

**Ma per un impegno singolo la stessa regola è sbagliata**, e questo è il punto
che nessuno ha ancora deciso. Un cron perso è una ripetizione: spararlo ora va
bene, perché «il brief delle 8» resta utile alle 8:03. Una promessa persa non è
una ripetizione: se il gateway era giù martedì, sparare giovedì *come se fosse
adesso* produce «ricordati della cosa» due giorni dopo che non serve più. Le due
opzioni reali sono un **grace bound** (oltre N il differimento non spara e diventa
una riga da guardare) oppure una **consegna onesta ma tardiva** (spara, e il testo
dice *«era per martedì»*). Raccomando la seconda, con il momento previsto dentro
l'ancora: un silenzio prodotto da un riavvio è indistinguibile da un guasto, e
questo repository ha già pagato quella confusione altrove. Ma è una scelta di
prodotto e va fatta dall'owner, non dedotta.

## 7. Cosa dicono gli altri, e cosa dice il repo già

**Anthropic, *Effective harnesses for long-running agents*** —
`https://anthropic.com/engineering/effective-harnesses-for-long-running-agents`,
letto 2026-09-03. Il punto trasferibile non è l'orchestrazione: è che lo stato
che sopravvive a una sessione deve stare **fuori dal contesto**, in artefatti che
la sessione successiva rilegge — un file di progresso, la storia git, una lista
di feature strutturata — e che una sessione nuova comincia **verificando** che il
sistema funzioni prima di aggiungere lavoro. La distinzione che l'articolo insiste
a fare, *«avere l'infrastruttura accesa è diverso dal fare progresso»*, è
letteralmente la diagnosi del §2 qui sopra: il nostro tick è infrastruttura accesa
senza produttori. La conseguenza per noi è che la promessa deve diventare **una
riga durevole leggibile da chi si sveglia**, non un ricordo nella storia della
conversazione — che è ciò che è oggi.

**Anthropic, *Harness design for long-running application development*** —
`https://www.anthropic.com/engineering/harness-design-long-running-apps`,
letto 2026-09-03. Il primitivo che ricorre è il **log di sessione append-only**
da cui si risveglia un `sessionId`, con l'harness ridotto a control plane quasi
senza stato. Noi ce l'abbiamo — `turns`, `job_fires`, `TurnLane` che riprende un
turno sospeso — ed è il pezzo che *non* manca.

**Hermes Agent, `/heartbeat` e `/loop`** — già raccolto in
`docs/evidence/hermes-documentazione.md` §2.4-2.5 con le URL e la data di lettura
(2026-08-15), e riletto qui perché è il peer più vicino per problema. Due cose:
gli spari persi si fondono in uno (noi lo facciamo già, §6); e senza intervallo
esplicito il ritmo si autoregola su *quanto è cambiata la risposta*, con un
digest locale e nessuna chiamata al modello, dai 60 s ai 900 s. Loro stessi
scrivono che `/heartbeat` non sopravvive a tutto e che *«for schedules that must
survive anything, use cron»*. Per noi la lezione è sul costo: un produttore
proattivo che si auto-ritma costa quasi niente, e non c'è nessuna ragione di
guardare gli impegni ogni 30 secondi.

**Quartz e APScheduler, misfire policy** —
`https://nurkiewicz.com/2012/04/quartz-scheduler-misfire-instructions.html` e
`https://cronuru.com/guides/apscheduler`, letti 2026-09-03. Servono per nominare
ciò che facciamo: Quartz distingue le istruzioni che rieseguono *tutti* gli spari
persi da quelle che li scartano e aspettano il prossimo slot; APScheduler dà due
manopole separate, `misfire_grace_time` (quanto tardi è ancora accettabile) e
`coalesce` (se più spari persi diventano uno). Il nostro comportamento è
`coalesce=True` con grace illimitato, e la manopola che **non abbiamo** è proprio
`misfire_grace_time` — che è esattamente la manopola che un impegno singolo
richiede e una ricorrenza no. Il vocabolario esiste da anni; ci mancava il nome.

**Letteratura sull'iniezione differita.** *Hidden in Memory: Sleeper Memory
Poisoning in LLM Agents* (arXiv:2605.15338) definisce il *delayed trigger attack*
come un'istruzione iniettata nella memoria in una sessione ed eseguita in una
successiva, dopo che il contesto originale è stato scartato — quattro sessioni
per giro, una di iniezione, due benigne, una di innesco. **Non ho potuto
estrarre i numeri:** il PDF torna come struttura e la fetch non ha reso il testo;
cito la forma dell'attacco, che è quella che ci serve, e non un tasso di successo
che non ho letto. Chi vuole i numeri parta da
`https://arxiv.org/abs/2605.15338`, letto 2026-09-03. La difesa architetturale
citata più spesso resta CaMeL — pianificatore privilegiato che non vede mai i
byte non fidati — e `docs/RESEARCH.md` la elenca già fra i peer di sicurezza.

## 8. La decisione, con le alternative vere

```text
capacità desiderata   una promessa fatta di sfuggita torna da sola, al momento giusto
meccanismo attuale    nessuno: il tick c'è, i produttori no
invariante da tenere  un differimento non lava la provenienza (ADR-0044, ADR-0053)
```

**Candidata A — un tool `jobs` per il modello.** È la lettura letterale del
ROADMAP. Costi, tutti misurati sopra: `jobs` non sa rappresentare un evento
singolo (`markRan` riprogramma sempre); il turno di un job nasce a `taint: 0`
scritto a mano, quindi la porta è un laundering finché quella costante non si
muove; il turno gira in una sessione usa-e-getta, quindi la promessa arriva senza
il contesto in cui fu presa. Tre modifiche, ognuna in un file diverso, per una
capacità che non è quella chiesta.

**Candidata B — `todos` guadagna una scadenza, e `commitment_due` guadagna il suo
produttore.** La riga esiste già, è già scritta dal modello, è già durevole, e
porta già il taint di chi l'ha scritta. Manca una colonna `due_at` nullable, un
lettore che non sia chiavato sulla sessione, e la traduzione in un
`ProactiveTrigger` di tipo `commitment_due` — che è dichiarato dal giorno uno,
non ha mai avuto un produttore, e la cui definizione è testualmente *«un obbligo
che l'owner ha registrato, il cui momento si avvicina»*. Tutti i rail sono già
scritti e testati: tier ≤ 1, ore di silenzio, budget, dedup per ancora, tetto di
tre per giro. Il taint è risolto **per costruzione** e non per attenzione.

**Candidata C — non costruire niente, e chiudere invece la clausola di
ADR-0035.** Cioè: far chiamare `observe` da qualcosa che non sia il dito
dell'owner, e accettare che una promessa venga catturata dalla memoria e ripescata
dal recall quando l'argomento torna. Costo: il recall si apre per somiglianza, e
«come dicevo» non somiglia a niente — è l'argomento con cui ADR-0056 ha appena
motivato la sessione unica. Beneficio: zero schema nuovo, e chiude comunque
l'unico zero che l'owner può vedere subito. **Non è mutualmente esclusiva con B**:
è il primo passo di B.

**Scelta: C poi B, e A solo se l'owner la chiede esplicitamente.** In ordine:

1. `observe` smette di essere del dito dell'owner. La forma più piccola è che sia
   un job `script` — la macchina per farlo girare esiste già, non chiama il
   modello, e costa zero token — oppure una chiamata dal tick a bassa frequenza.
   È **un comando**, non codice nuovo, ed è misurabile domani.
2. `todos` guadagna `due_at`, e un lettore per scadenza che produce
   `commitment_due`. Qui c'è una cosa da dichiarare onestamente: il tool `todo`
   oggi è `effect: 'context'`, `risk: 'low'`, con la frase *«nothing downstream
   acts on a row: the list is shown, never executed»*. Dare a una riga il potere
   di far parlare Muffin **rende quella frase falsa**, e la dichiarazione della
   capability va cambiata nello stesso commit, non dopo. Non è un dettaglio
   burocratico: è la differenza fra un rail e una promessa.
3. `A` solo dopo, e mai prima che `agent/scheduler-run.ts` legga un taint invece
   di scrivere `0`.

**Cosa si sveglia, quanto spesso, e cosa può fare a vuoto.** Il tick resta a 30 s
e resta **muto**: la risposta giusta a un risveglio senza niente in coda è niente,
e la difendo con i numeri che il repo ha già — Pare-Bench misura al 17,8% la quota
di proposte proattive che arrivano nel momento sbagliato sul modello migliore
(ADR-0028), e un agente che parla senza causa è peggio di uno silenzioso. Il
passaggio sugli impegni non va sul tick: **una volta al giorno, alla fine della
finestra di silenzio**, che è già il momento a cui `decideProactive` rimanda
tutto ciò che difende. Non serve un ritmo adattivo per cominciare; se poi il
numero di impegni cresce, il digest auto-ritmato di Hermes è il seguito naturale
ed è a costo zero di modello.

## 9. Cosa va misurato, non argomentato

Cinque cose. Per ciascuna il controllo più piccolo che la può falsificare.

**1. Che le porte restino quelle dichiarate.** Oggi la frase «una sola porta di
produzione crea job» è vera e nessun test la protegge: la prossima porta si può
aprire in silenzio, ed è precisamente il difetto di famiglia al contrario. Check:
un test che risolve i chiamanti di `JobStore.add` nell'albero e fallisce se
compare un chiamante fuori da `cli/jobs.ts` e dai test. Costa una `readdir` più
una regex, gira in millisecondi, e obbliga chi apre una porta a dichiararla.

**2. Che il tick a vuoto resti muto.** Check: costruire uno `Scheduler` su uno
store vuoto, chiamare `tick`, asserire **zero** eventi. Oggi è vero per
`if (!job) return` e nessuno lo dice; un `onEvent` aggiunto per diagnostica lo
romperebbe senza che nessuno se ne accorga.

**3. Che un differimento sporco non parli.** Check: un impegno scritto a `tier: 2`
deve produrre `{ effect: 'deny', reason: 'tainted_source' }`. Il test esiste per
`gone_quiet` (`proactivity.test.ts`); va scritto per `commitment_due` **nello
stesso commit del produttore**, altrimenti la riga nasce non protetta.

**4. Il numero che decide se vale la pena costruirlo.** Quante promesse con un
momento l'owner fa davvero in una settimana. Si misura oggi, a costo zero e senza
modello: contare le righe di `todos` e i fatti in memoria che contengono
un'espressione temporale. **Se il numero è zero o uno, la raccomandazione giusta
è non costruire niente** — e questa è la sola misura che può ribaltare tutto il
memo. Non l'ho eseguita perché non apro il database dell'owner.

**5. Il segnale di reversibilità, che ADR-0028 ha già scelto per sé.** Il tasso
con cui l'owner scarta ciò che Muffin dice di sua iniziativa. Misurato, non
immaginato: se sale, il produttore si spegne. Richiede che un `deny`/`defer` e un
rifiuto diventino righe durevoli, che oggi non sono — il fire log registra solo
gli `allow`, per costruzione dichiarata.

## 10. Cosa non ho potuto stabilire

- **Se qualcosa raggiunga mai `muffin jobs add` attraverso `shell_run`.** La
  porta esiste sulla carta; la sandbox e l'ask di `sys.shell` la rendono
  improbabile; non ho letto le tracce dell'owner e non ho una prova né in un
  senso né nell'altro.
- **Il `session_id` dei sette `todos` fermi dal 27/08.** La mia spiegazione — una
  chiave di sessione che ADR-0056 ha appena sostituito — è coerente con lo schema
  e con la data, ma è un'inferenza. Una `SELECT DISTINCT session_id FROM todos`
  la conferma o la smentisce in un secondo.
- **Se `muffin observe` sia mai stato eseguito senza `--send`.** Niente lo
  registra in modo durevole: il fire log scrive solo gli `allow`, e una corsa in
  sola lettura vive su stdout e muore col processo. ADR-0028 lo nomina già come
  il punto su cui la critica *«un cancello che sopprime in silenzio non è
  argomentabile»* ha ancora ragione.
- **I numeri del delayed trigger attack.** Ho la forma dell'attacco dalla fonte,
  non i tassi: la fetch del PDF non ha reso il testo.
- **Il comportamento su Linux.** Tutto quanto sopra è lettura di codice più una
  corsa della suite su macOS. Le tre cifre del database dell'owner vengono dal
  brief e non le ho ri-misurate.

## Cosa ribalterebbe questo memo

Il numero 4 del §9. Se l'owner non fa promesse con un momento — o ne fa una al
mese e se la ricorda — allora la riga prima di tutte nel ROADMAP sta risolvendo un
problema che non ha, e la risposta corretta è chiudere la clausola di ADR-0035
(far girare `observe` senza il dito) e fermarsi lì. Se invece il numero è
sostanzioso, la candidata B resta la più piccola solo finché `todos` è davvero il
posto in cui quelle promesse finiscono: se finiscono in memoria come fatti e non
come passi, il produttore di `commitment_due` va costruito sopra la memoria e non
sopra `todos`, e questo memo ha guardato la tabella sbagliata.
