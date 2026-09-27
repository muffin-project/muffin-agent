# ADR-0092: il detentore di un lock è vivo finché lo è la sua incarnazione

**Stato:** accettato · 2026-09-27 · `slice/lock-holder-liveness-by-incarnation` ·
evidenza: `docs/evidence/liveness-dei-lock-e-namespace-pid-2026-09-27.md` ·
supera il paragrafo «PID reuse» dell'emendamento №3 di ADR-0035

## Contesto

Ogni garanzia di unicità di Muffin passa da una sola regola, `heldBy`
(`core/lock/durable.ts`): un solo gateway (`gateway_lock`), un turno eseguito
una volta (`turns`), un invio proattivo alla volta (`send_lock`), una sola
estrazione della memoria (`ingest_lock`). La regola chiedeva al kernel
`kill(pid, 0)`: pid vivo, detentore vivo, protetto fino all'orizzonte duro
(6× la cadenza: 30 minuti per il gateway, 6 ore per turni e invii).

L'emendamento №3 di ADR-0035 aveva scartato l'ora di avvio del processo come
identità (non portabile in Node) sull'assunto che il riuso ordinario di un pid
richieda ore. I container lo falsificano, in due modi misurati:

- **Riavvio.** Un container riavviato dopo un kill duro (OOM, SIGKILL) apre un
  nuovo namespace pid, e il nuovo processo prende quasi sempre il pid del
  morto. Il gateway nuovo vede vivo il detentore (sé stesso), esce con 75 e la
  restart policy lo rilancia a vuoto. Misurati 24 rifiuti in circa 17 minuti,
  finiti solo perché un riavvio ha preso un altro pid; il limite è
  l'orizzonte duro di 30 minuti. I turni rimasti `running` non vengono marcati
  interrotti fino al loro orizzonte (6 ore, configurato, non misurato).
- **Vicino.** Un secondo container sulla stessa home ha un altro namespace: lì
  il pid della riga non indica nulla. Un detentore vivo può risultare morto e
  venire derubato, uno morto può risultare vivo.

Il fencing (`holder_id`, `claim_token`) protegge le scritture sul database a
ogni checkpoint, non ogni effetto esterno fra due checkpoint: l'emendamento №3
accetta come residuo «al più un giro di tool call» eseguito da un processo che
non è più proprietario. Un falso «morto» è quindi la direzione pericolosa; un
falso «vivo» costa disponibilità.

## Decisione

1. **Incarnazione.** Ogni processo che rivendica qualcosa a proprio nome crea,
   prima della prima rivendicazione, `incarnations/<uuid>.db` accanto al
   database e lo tiene bloccato in esclusiva per tutta la vita (SQLite
   `locking_mode = EXCLUSIVE` dopo una scrittura). I lock di record POSIX li
   rilascia il kernel alla morte del processo, SIGKILL e OOM compresi, e valgono
   per host, non per namespace. Chi solo legge (il `reclaim` di ogni avvio,
   `doctor`, `gateway status`) sonda senza creare nulla.
2. **L'incarnazione viaggia nel token che c'è già.** `holder_id` e
   `claim_token` diventano `<incarnazione>.<uuid>`. Nessuna colonna nuova e
   nessuna migrazione: i token si confrontano solo per uguaglianza, e un build
   precedente legge le stesse righe con la regola del pid.
3. **La regola.** Token con incarnazione e sonda che risponde: il lock del file
   prendibile, o il file assente, vuol dire morto; il lock occupato vuol dire
   vivo. Token senza incarnazione (righe scritte prima, database in memoria,
   processo che non ha potuto creare il file) o sonda che non sa rispondere: la
   regola del pid di prima. L'orizzonte duro resta com'è: il kernel dice se il
   processo esiste, non se sta lavorando, e un processo bloccato per sempre non
   deve tenere il lock per sempre.
4. **Una rivendicazione a nome di un altro pid non porta l'incarnazione.** La
   vita di chi scrive non dice niente di quel pid. In produzione si rivendica
   sempre per `process.pid`; il parametro esiste per test e fixture.
5. **Pulizia.** All'uscita pulita il processo rimuove il suo file. Dopo un
   kill lo rimuove il prossimo processo che crea un'incarnazione nella stessa
   directory, solo se più vecchio di 60 secondi e con il lock prendibile.
6. **Solo SQLite apre quei file.** Un processo POSIX perde tutti i lock su un
   file quando chiude un qualunque descrittore di quel file; SQLite lo sa e
   tiene aperti i descrittori finché la sua ultima connessione al file resta.
   Una lettura con `fs` dal processo detentore rilascerebbe il suo lock senza
   che il detentore possa accorgersene. Il processo detentore esegue anche i
   tool fs del modello, e il workspace di default del `muffin` interattivo è la
   directory da cui parte, `$HOME` compresa: quindi `incarnations/` sta in
   `mandatoryGuards().denyRead` (copre `fs_read`, `fs_search`, `fs_list` e la
   sandbox, che la maschera). Il lettore interno che apre percorsi scelti dal
   contenuto, il controllo di scrittura git dei tool fs, legge ogni file (il
   puntatore `.git`, `commondir`, le config, gli `include`) attraverso un solo
   helper che risolve i link, compreso `/proc/self/fd/N`, e rifiuta un file di
   incarnazione: la scrittura viene negata senza aprirlo. Ogni nuovo lettore
   interno di un percorso che non ha scelto deve passare dallo stesso controllo.

## Alternative scartate

| Candidata | Perché no |
|---|---|
| Eccezione «stesso pid» alla PostgreSQL (la riga con il mio pid e un token che non ho coniato è di una vita precedente) | Nel riavvio funziona, ma `reclaim` percorre righe di altri: un secondo container con lo stesso pid piccolo segnerebbe interrotto un turno vivo, in modo deterministico. È la direzione pericolosa, e oggi il caso è casuale, non sistematico |
| Pid più ora di avvio del processo (`/proc/<pid>/stat`) | Solo Linux; da un altro namespace il `/proc` del detentore non si vede, quindi resta da scegliere fra furto e blocco; nuova colonna su quattro tabelle |
| Liveness per connettibilità del socket di controllo | Ascolta solo il gateway: turni, invii ed estrazioni li tengono anche processi CLI |
| Nuova colonna invece del token | Migrazione dello schema dei turni, e un build precedente rifiuterebbe una home con schema più avanti: il rollback si complica per nulla |
| Solo documentazione | Il blocco resta, e il caso del vicino resta casuale |

## Conseguenze

- Un file per processo che rivendica, di pochi KB, e un descrittore aperto.
  In regime normale uno: quello del gateway.
- Serve lo stesso filesystem che serve già a `muffin.db`: i lock di SQLite.
  Su un filesystem di rete non funzionano né l'uno né l'altro.
- Chi può scrivere nella home può cancellare il file di un detentore vivo e
  farlo risultare morto; chi può scrivere nella home ha già il database in mano.
- Residuo: `muffin gateway stop` lanciato da un altro container manda il
  segnale a un pid del proprio namespace. Prima la regola del pid lo faceva a
  caso; ora `readGateway` vede vivo un gateway di un altro container, quindi il
  segnale parte più spesso, verso il processo locale con quel pid (sempre e
  solo SIGTERM). Il percorso documentato è `exec` nello stesso container.
- Residuo non toccato qui: il fencing di ogni effetto esterno fra due
  checkpoint (vedi Contesto). È una claim a parte.
- macOS non è misurato: il meccanismo è lo stesso (lock POSIX di SQLite), la
  prova no.

## Cosa la ribalta

- `evals/system/lock-pid-namespaces.sh` rossa: il rimpiazzo di un container
  ucciso rifiutato, o il vicino che prende il lock di un detentore vivo.
- Il test «the holder checking its own claim does not release it» rosso su una
  piattaforma o una versione di SQLite: vorrebbe dire che una sonda dallo
  stesso processo libera il lock del detentore.
- Una sonda che legge vivo un processo morto, o morto uno vivo, su un
  filesystem che Muffin dichiara supportato.
- Un qualunque percorso del processo detentore che apre un file di
  incarnazione fuori da SQLite. Le due revisioni indipendenti ne hanno trovati
  in sequenza (i tool fs, poi le altre letture del controllo git): un terzo
  vorrebbe dire che la difesa per percorsi non basta e che il lock va tenuto
  fuori dal processo detentore.
