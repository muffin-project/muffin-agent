# ADR-0050 — Una continuità, una Home attiva, molti capability Node

**Stato:** accettato · 2026-08-20 · decisione owner durante la riconciliazione
della runtime topology

## Contesto

ADR-0045 ha già deciso l'identità corretta: Muffin è un agente personale
continuo, non un processo, un device, una surface o un modello. Quella decisione
resta valida.

La topologia di deployment era invece rimasta più stretta della tesi. ADR-0022
aveva scelto un solo processo OS per gateway, loop, memoria e scheduler; ADR-0035
aveva poi reso quel runtime long-lived e, per il deployment locale allora in
scope, aveva esplicitamente escluso listener di rete. Quelle scelte proteggevano
problemi reali — un solo owner del lavoro, niente scheduler concorrenti,
foreground responsiveness, stato durevole, una failure visibile — ma trattavano
come architettura alcune proprietà del primo deployment.

La riconciliazione del 2026-08-20 introduce un consumer concreto che rende quella
forma insufficiente senza renderla sbagliata in blocco:

- la Home di Muffin può ragionevolmente vivere su MacBook, Mac Mini, home server,
  NAS o VPS;
- un MacBook può dover restare parte di Muffin anche quando la Home vive altrove,
  esponendo filesystem, shell, screen, notifiche e compute locale;
- telefono, Watch, speaker e futuro pendente possono essere contemporaneamente
  porte di interazione e capability endpoint;
- modelli locali, Whisper, browser, OCR e altri worker possono avere lifecycle,
  risorse e failure domain indipendenti dal processo che custodisce la
  continuità;
- un input può arrivare da una surface mentre altro lavoro è in corso, senza che
  la surface diventi owner del work.

La ricerca comparativa su OpenClaw, Hermes, Letta e OpenHands mostra un pattern
convergente: identità/stato e execution placement non devono coincidere; device
identity e connessione corrente non sono la stessa cosa; gli executor non devono
possedere la transizione canonica che eseguono; process separation è utile quando
compra isolation, placement o lifecycle, non come estetica.

C'è inoltre un threat model nuovo e non opzionale. Se la Home vive su una VPS, o
anche soltanto se il processo Home viene compromesso, il pairing di un Mac non
può significare «questa Home ora possiede incondizionatamente tutta l'autorità
del Mac». Un Home malevolo o compromesso è un caso da contenere, non un mondo che
l'architettura può dichiarare impossibile.

## Decisione

### 1. Una continuità Muffin ha una sola Home autorevole attiva

La **Muffin Home** è il deployment authority boundary che custodisce, in un dato
momento, la continuità canonica di un Muffin.

Per la fase corrente e per l'MVP vale:

```text
1 authoritative Home
N Nodes
N Surfaces
N Workers / compute targets
```

La Home possiede logicamente almeno:

- durable identity;
- canonical Evidence/Beliefs commit;
- Work ledger e scheduler;
- Effect intent/outcome state;
- authority/delegation state;
- budget/spend ledger;
- Node registry e pairing state;
- routing della continuità fra surface e work.

La Home **non è Muffin**. Spostare la Home è una migrazione della stessa
continuità, non la nascita di un nuovo agente.

Non esiste active-active Home nell'MVP. Se la Home è offline, i Node non eleggono
automaticamente un leader e non promuovono da soli copie locali a stato
canonico. Offline degraded continuity, replica e authority handoff sono ricerca
post-MVP separata.

### 2. Un Node è un capability endpoint, non un secondo agente

Un **Node** è un host o device paired che può offrire capability, sensori,
attuatori, dati locali e/o compute alla stessa continuità Muffin.

Esempi: MacBook, telefono, Watch, futuro pendente, Mac Mini, NAS, workstation o
box Linux.

Il Node ha identità stabile separata dalla connessione corrente:

```text
NodeId        durable
ConnectionId  ephemeral
```

Un reconnect non crea un nuovo Node. Un Node offline non crea un nuovo Muffin e
non perde la propria identità.

Il pairing prova **chi è quel Node**. Non concede automaticamente ogni capability
del device.

### 3. Node e Surface sono assi diversi

Una **Surface** descrive come un principal comunica con Muffin: Telegram, CLI,
menubar, web UI, voice, Discord, pendant interaction.

Un **Node** descrive dove Muffin può percepire, agire o calcolare.

Lo stesso device può essere entrambe le cose:

```text
MacBook Node     → fs, shell, screen, notification, local model
MacBook Surface  → CLI, menubar, voice
```

Telegram può essere una Surface senza essere un Node. Un compute box può essere
un Node senza avere alcuna Surface umana.

Questa distinzione estende ADR-0021 e ADR-0045; non crea memoria, persona o policy
separate per device.

### 4. I cinque piani semantici restano invariati

Home, Node, Surface e Worker sono ruoli topologici, non nuovi piani.

Restano:

```text
Evidence · Beliefs · Work · Effects · Authority
```

La topologia risponde a «dove vive/esegue e sotto quale lifecycle/trust
boundary?». I cinque piani rispondono a «che significato canonico ha questo
stato?». Un refactor di processo o host non autorizza store duplicati per ciascun
Node.

### 5. Process topology è una scelta di deployment, non l'identità del runtime

Il vincolo generale «un solo processo OS per il runtime» di ADR-0022 è
**superseded** da questa ADR.

Restano invece i suoi obiettivi:

- un owner esplicito per ogni invariante;
- priorità interattiva rispetto al background quando competono per la stessa
  risorsa;
- nessuna duplicazione silenziosa del lavoro;
- coordinamento durevole per crash/retry;
- isolation solo quando compra una proprietà reale.

Un confine di processo è giustificato quando compra almeno una fra:

1. security isolation;
2. crash isolation;
3. resource/lifecycle independence;
4. placement su un altro host;
5. untrusted-code containment.

DAY-1 può quindi restare mostly single-daemon. Shell/code execution resta
naturalmente fuori processo/sandboxata; local model, Whisper, browser, OCR,
community code o future hardware bridges possono diventare worker separati
quando il consumer lo richiede.

Non si introducono microservizi, broker o IPC soltanto per anticipare quella
possibilità.

### 6. L'autorità effettiva su un Node è un'intersezione

ADR-0013 resta l'unico kernel che può concedere authority alla richiesta del
Muffin Home. Un Node aggiunge un **ceiling locale monotono**: può soltanto
restringere ciò che la Home ha già autorizzato.

La regola è:

```text
Home-authorized request
        ∩
Node local policy
        ∩
OS / device physical permission
        =
effective executable authority
```

Il Node può:

- negare una capability;
- richiedere approval locale;
- limitare path, app, sensore, attuatore o stato del device;
- essere più restrittivo della policy Home;
- fallire closed quando il meccanismo di approval locale richiesto non è
  disponibile.

La Home **non può allargare o bypassare remotamente** il ceiling locale del Node,
neppure inviando una dichiarazione «owner approved».

Una modifica del ceiling o un break-glass deve avvenire attraverso una presenza
locale autenticata o un meccanismo equivalente la cui authority nasce dal Node,
non da una semplice istruzione remota della Home.

Questa regola esiste esplicitamente per il caso di Home compromessa o malevola.
Pairing e mutual authentication riducono impersonation; non trasformano la Home
in una root remota assoluta dei device paired.

### 7. Una approval locale è legata al piano esatto eseguito

Il Node non approva prose generica. Prima dell'esecuzione deve poter verificare un
piano canonico equivalente almeno a:

```text
ExecutionPlan {
  requestId
  work/effect identity
  target NodeId
  capability
  canonical args/resource
  expiry
}
```

L'approval vale per quel piano. Cambiare command, path, target Node, resource o
altri argomenti authority-bearing invalida il consenso precedente.

Questo estende la semantica Effect intent → outcome e riduce il TOCTOU tra ciò
che l'owner ha visto e ciò che il Node esegue.

### 8. Il Node protocol ha proprietà di sicurezza, non un transport imposto

Questa ADR non decide WebSocket, QUIC, SSH, Tailscale o un protocollo concreto.
Decide le proprietà che qualunque implementazione deve preservare:

- autenticazione forte Home ↔ Node e pairing deliberato;
- stable Node identity separata dalla connection lease;
- replay protection / sequencing adeguati al transport;
- request id e idempotency per invocation;
- capability advertisement esplicita;
- nessuna authority implicita derivata dal solo pairing;
- approval legata all'ExecutionPlan canonico;
- deadline/cancel espliciti dove la capability li supporta;
- distinzione fra `request received/ACK`, `execution started`, `execution
  outcome` e `semantic commit at Home`;
- reconnect/sync che non assume che lo stato precedente esista ancora soltanto
  in RAM;
- data locality/egress osservabile quando payload o context cambiano host;
- nessuna ereditarietà implicita di secret o intero process environment.

Un ACK di rete non è prova che un effect sia avvenuto. Un outcome del worker non
è ancora una transizione canonica finché l'owner del relativo piano non l'ha
registrata.

### 9. Canonical state e computation restano separati

Un processo o Node può eseguire lavoro senza possedere la transizione canonica
che quel lavoro informa.

Esempio:

```text
Home → "trascrivi A" → Whisper worker sul Mac Node
                         ↓
                    transcript candidate
                         ↓
Home → commit evidence/provenance
```

Embedding, OCR, transcription, rerank, image understanding e altre computation
ricostruibili sono candidate naturali a worker. Work state, effect uncertainty,
authority, budget, schedule e canonical belief/evidence transition richiedono
invece un owner esplicito alla Home.

Questo non impone un database service. SQLite resta una scelta valida finché il
consumer non dimostra il contrario.

### 10. Home placement è configurazione, non identità

MacBook, Mac Mini, home server/NAS e VPS sono deployment possibili della stessa
Home semantics.

La distribuzione potrà avere un default ergonomico, ma nessuna capability o dato
canonico deve definire «Muffin = questa macchina per sempre».

Una futura Muffin Capsule / migrazione verificata deve poter spostare la Home
preservando il significato canonico e ricostruendo i derivati dove possibile.

### 11. Il pendente è un Node + Surface specializzato

Il futuro pendente Muffin non è un secondo agente e non richiede un protocollo
identitario separato.

Concettualmente può essere:

```text
Pendant Node
  capabilities: audio.capture, haptic.notify, status, optional speaker
  Surface: push-to-talk / wake / interrupt / voice
```

Le sue capability e il suo ceiling locale possono essere molto più stretti di
quelli del Mac. Lo stesso modello vale per speaker, Watch, telefono e hardware
futuro.

Costruire l'hardware non è un requisito DAY-1; progettare oggi una topologia che
lo renda una seconda entità da sincronizzare sarebbe però un errore costoso.

## Relazione con gli ADR precedenti

- **ADR-0045 resta valida integralmente.** Questa ADR rende implementabile «one
  continuous agent, many bodies»; non cambia l'unità identitaria.
- **ADR-0013 resta valida.** Il Node ceiling non è un secondo kernel che concede:
  è una restrizione ulteriore, monotona.
- **ADR-0018 resta valida.** Brain/hands e containment si estendono naturalmente
  ai confini Node/Worker; un processo remoto non diventa trusted solo perché è
  paired.
- **ADR-0021 resta valida.** Le Surface rimangono porte simultanee; ora sono
  distinte dagli host che possono anche offrire capability.
- **ADR-0022 è superseded solo nella frase «un processo OS per il runtime».**
  Restano foreground priority, durable coordination e isolation motivata.
- **ADR-0035 è amended nel deployment assumption.** Resta la necessità di un
  runtime long-lived, visibile, supervisionato e con un solo owner del work. Il
  divieto generale di network listener era corretto per il primo deployment
  locale ma non è un'invariante per un Home remoto con Nodes: un futuro Node
  transport di rete è consentito soltanto con il boundary autenticato deciso
  qui, non come porta pubblica implicita.

## Cosa questa ADR non autorizza a costruire ora

Non autorizza per inerzia:

- active-active Home;
- leader election o distributed consensus;
- replica completa della memoria sui Node;
- Redis, NATS, Kafka o un message broker;
- Postgres o un database daemon;
- un servizio per ogni modulo;
- un compute-placement optimizer;
- un protocollo Node generico prima del primo consumer reale;
- un sistema di plugin distribuiti;
- offline local leadership;
- un refactor DAY-1 soltanto per rendere più «microservice-like» il codice.

La logical topology viene fissata ora per evitare forme incompatibili; il numero
di processi e il transport concreto seguono i consumer e l'evidence.

## Conseguenze

Più facile:

- tenere Muffin always-on su un host e usare capability fisiche su un altro;
- far dormire/riconnettere un laptop senza cambiare identità;
- isolare modelli locali e worker resource-heavy;
- aggiungere pendant/speaker/phone senza inventare agenti secondari;
- rendere esplicito il blast radius di un Home compromesso;
- mantenere core e canonical state stretti mentre l'ecosistema cresce.

Più difficile:

- pairing e reconnect diventano security/durability problems, non networking
  ornamentale;
- ogni remote effect richiede identità, idempotency, outcome e failure semantics;
- bisogna distinguere egress verso un altro host owner-controlled da egress verso
  un provider terzo;
- il Node deve avere una propria UX/policy locale per capability che richiedono
  consenso fisico;
- la futura migrazione Home deve preservare semantica, non soltanto copiare una
  directory.

## Reversibilità e falsificazione

La scelta è altamente reversibile nella **deployment topology**: una singola Home
senza Node continua a essere un caso valido e semplice.

È deliberatamente poco reversibile nel security contract: una volta che un Node
promette un ceiling locale non bypassabile, future comodità remote non devono
trasformarlo silenziosamente in una root shell controllata dalla Home.

Rivedere la topologia se l'uso reale mostra che:

- nessuna capability ha mai bisogno di vivere su un host diverso dalla Home e i
  Node restano pura cerimonia;
- il costo del protocollo/ownership supera stabilmente il valore di locality,
  isolation e always-on deployment;
- una diversa divisione di canonical ownership dimostra una semantica più
  semplice senza introdurre multi-writer o false-success;
- il modello one-Home impedisce un caso d'uso reale sufficientemente importante
  da giustificare un progetto separato di replica/authority handoff.

Non rivedere il ceiling locale perché «l'override remoto sarebbe comodo»: il
criterio è un boundary di sicurezza falsificato da evidence, non la frizione di
un click locale.
