# ADR-0035 — Muffin è un processo che vive, non un comando che invochi

**Contesto.** ADR-0022 aveva già deciso la forma: *"un processo OS per il runtime (**gateway**, loop, memoria, scheduler)"*, con systemd a riavviarlo. Quello che è stato costruito è `setInterval(() => scheduler.tick(), 30_000)` **dentro `cli/repl.ts`**: chiudi la finestra e non gira più niente. Nessun servizio, nessun launchd, nessun `daemon` — verificato. È l'undicesima istanza della famiglia "dichiarato e non connesso" e la più grossa, perché non è un file senza lettore: è la **forma del runtime**.

Le conseguenze non sono teoriche, sono misurate. `ingestPending` ha un solo chiamante manuale, quindi la memoria non si riempie: **414 fatti nel vecchio contro 0 nel nuovo** (`research/inventario-vecchio-nuovo.md`). Due clausole della DoD di M5 sono non soddisfatte — il trigger a soglia sul consolidamento, e `observe` che nessuno schedula. E la diagnosi generale sta nei verbi, non nelle intenzioni: **31 dei 95 comandi di Hermes presuppongono un processo che gira** (`heartbeat`, `queue`, `steer`, `pause`, `restart`, `undo`, `handoff`, `compress`); i nostri quattordici sono tutti "fai questo adesso ed esci". Un sistema è continuo se il suo vocabolario lo assume.

Direttiva owner (2026-08-11), che chiude la questione anche sul lato prompt: *"anche a noi serve un gateway sicuro, serve heartbeat… il concetto di occupato, continuo, sempre attivo, sempre vivo"*. E il corollario che ne discende: **"sei un agente continuo" non si scrive nel system prompt** finché non è vero — sarebbe una bugia che licenzia promesse che il runtime non mantiene, contro la riga di `identity.md` "non fingi di aver fatto". Si rende vero, e allora è ridondante scriverlo.

**Decisione.** Un **processo locale di lunga vita** che l'owner avvia una volta e che possiede scheduler, consolidamento e spina osservante. La CLI diventa un **client**; il REPL è un client fra gli altri, non il contenitore del runtime. Cinque vincoli, e sono la parte "sicuro" della direttiva — non contorno:

1. **Nessun listener di rete.** Socket unix nella home, permessi del filesystem, solo locale. Siamo single-owner su una macchina: una porta in ascolto è superficie d'attacco senza un utente che la giustifichi. (Il vecchio Muffin faceva già così: `muffind` non era un binario, era un socket dentro il processo del bot.)
2. **Il kernel resta l'unico punto di decisione.** Il gateway **non** diventa un secondo strato di approvazione. È la lezione più cara del confronto: `approval.py` di Hermes è 203 KB con ~8 gate indipendenti, 65 issue di bypass, e il loro stesso `SECURITY.md` lo declassa (*"a denylist over shell strings is structurally incomplete"*). Ogni turno che il gateway origina passa da `decide()` come tutti gli altri.
3. **Ogni turno autonomo porta il suo principal.** `{kind: 'system', source: 'scheduler'}` esiste già nel tipo ed è già usato da `scheduler-run.ts` e `observe-run.ts`. Il gateway non introduce un principal nuovo e non ne inventa uno privilegiato: se una capability è `hostOnly`, un turno del gateway non la ottiene per il fatto di girare in casa.
4. **Gira come l'owner, senza elevazione.** Nessun setuid, nessun servizio di sistema: un agente utente. Il RoT resta detection-non-prevention in single-user, e questo non lo cambia.
5. **Visibile e ammazzabile.** `doctor` lo vede (attivo? da quando? cosa sta facendo?), un comando lo ferma, e la sua morte non perde lavoro: i job restano dovuti, non consumati (M5 lo fa già per l'abort).

**Cosa diventa rappresentabile** — ed è la ragione per cui questo viene prima delle feature che abilita:

- **`heartbeat`**: un prompt ricorrente dichiarato dall'owner che rientra quando la sessione è inattiva. È lo Stadio-1 della spina osservante dal lato dell'owner invece che dal lato del segnale.
- **"occupato"**: oggi non esiste nemmeno come concetto visibile. Con un processo che vive, `queue` (accoda per il turno dopo) e `steer` (inietta dopo la prossima tool call, senza interrompere) diventano scrivibili — e il gate di priorità foreground di ADR-0022 §1 smette di essere un'astrazione, perché finalmente c'è un foreground *distinguibile* da un background.
- **Consolidamento e osservazione senza il tuo dito**: le due clausole non soddisfatte di M5. `muffin memory extract` e `muffin observe` non devono diventare più comodi — devono smettere di essere tuoi.
- **`undo`**: il registro che il kernel già emette come `DRAFT` e che il loop rifiuta perché non esiste. Nota dall'inventario, e vale come avvertimento: nel vecchio `undo_log` ha **zero righe** in quattro mesi — il tier act-notify-undo non ha mai prodotto un revert. Costruire il registro non basta; va costruito il caso d'uso che lo riempie, o è la dodicesima istanza.

**Alternative scartate.** *Lo status quo* (lo scheduler vive nel REPL): è ciò che tiene la memoria a zero, e non è una scelta — è ADR-0022 non implementato. *Un gateway di rete* come il loro (307 KB, enrollment, auth): risolve il multi-device, che non è un nostro problema in v1 (`04-roadmap.md` §3 taglia esplicitamente il sync multi-device), e paga una superficie d'attacco per un utente che non abbiamo. *Solo cron/launchd di sistema*, senza processo nostro: l'OS sa svegliare un comando, non sa tenere lo stato "sto lavorando" — niente `queue`, niente `steer`, niente cessione al foreground, e ogni fire paga un avvio a freddo che con la cache esplicita è anche una scrittura pagata e mai letta (~$0,0025 a fire, misurato in `research/confronto-harness.md`). *Un processo per surface*: moltiplica le connessioni al DB e le corse; il lock di invio che già esiste è la primitiva di coordinamento, non un secondo processo.

**Conseguenze.** Più facile: tutto ciò che oggi chiede il dito dell'owner; e il `SendLock` costruito per due invocazioni CLI in corsa diventa la primitiva normale di coordinamento invece che un caso limite. Più difficile: un ciclo di vita in più da sbagliare (avvio, riavvio dopo crash, aggiornamento del binario mentre gira), e il corollario di ADR-0022 sul bug Hermes #25517 diventa nostro — l'heartbeat di un job **non può** dipendere dal fatto che il loop torni al controllo, o un tool lento produce un secondo worker sullo stesso task. Va previsto adesso, non scoperto.

**Costo, misurato** (numeri del judge sulla review di `slice/gateway`,
2026-08-13, macchina di sviluppo; il conteggio delle scritture è aritmetica —
86 400 / 30). Le conseguenze qui sopra erano scritte in qualitativo; questi sono
i numeri, e uno dei tre non è quello che ci si aspettava. **~84 MB RSS** residenti (~190 MB all'avvio sotto
`tsx`, che è il percorso di sviluppo, non quello installato). **0,022 ms di CPU
per tick**, cioè ~65 ms al giorno: il tempo non è un costo. Il costo vero è il
terzo: **2 880 transazioni di scrittura al giorno su `gateway_lock`** — un
battito ogni 30 s, per sempre — dove con nessun REPL aperto erano **zero**. Il
database non è più mai quiescente, e questo tocca due cose che nessuno stava
guardando: qualunque snapshot del filesystem su `~/.muffin` vede un file sempre
in movimento, e il WAL cresce fra un checkpoint e l'altro anche in una giornata
in cui l'agente non ha fatto assolutamente niente. Il battito è la primitiva —
è ciò che rende l'orizzonte del claim un battito e non un'ora — quindi non è
eliminabile senza rinunciare alla proprietà; è il prezzo, ed era giusto contarlo.

**Reversibilità.** Alta. Il processo è additivo: la CLI continua a funzionare da sola (un client che non trova il socket fa quello che fa oggi), e `muffin run` headless resta il percorso scriptabile che ADR-0021 vuole. Se il processo si rivelasse più fragile del guadagno, si torna a invocare — perdendo esattamente le cose elencate sopra, che è il modo giusto di misurare cosa costava.

**Segnale che era sbagliata**, contato e non percepito: il processo muore più di una volta a settimana per cause non dovute a un crash del modello; oppure passa un mese di uso quotidiano e il numero di turni originati dal gateway (consolidamento, heartbeat, osservazione) resta sotto quello dei turni chiesti dall'owner — nel qual caso non serviva un processo che vive, serviva un cron.

---

## Come si tiene su — ricerca 2026-08-11, verificata sul sorgente di Hermes

**Il supervisore non è il problema interessante.** systemd/launchd rispondono a *"chi lo riavvia"*; non rispondono a *"è sano?"*, che è dove vivono i nostri fallimenti. Costruire prima il processo, poi la supervisione: sono separabili, e il secondo è il facile.

**Piattaforme, e una correzione**: ADR-0022 dice *"systemd a riavviare"*. Vero **sul VPS di produzione** (Linux, direttiva owner 2026-08-11), falso sulla macchina di sviluppo dell'owner, che è macOS → `launchd`, `~/Library/LaunchAgents/*.plist`. Servono entrambi alla fine (siamo MIT), non subito. Nota per il Linux: una user unit senza `loginctl enable-linger` muore al logout.

**Cosa fa Hermes, letto dal loro sorgente** (`gateway/systemd_notify.py`, `hermes_cli/gateway.py`):

- **`Type=notify` con `sd_notify`**, non `Restart=always` e basta. Il processo manda `READY=1` quando serve davvero — così systemd distingue *"il processo è partito"* da *"sta servendo"*, e un crash-loop smette di somigliare a un avvio riuscito. Manda `WATCHDOG=1` periodico (intervallo letto da `WATCHDOG_USEC`, dichiarato come `WatchdogSec` nell'unit): se smette, systemd ammazza e riavvia. **È l'unica cosa che cattura il processo *su ma piantato*** — il fallimento che `Restart=always` non vede, ed è la forma di fallimento silenzioso che questo repo paga da giorni. Più `STATUS=` leggibile in `systemctl status`, e un concetto esplicito di `unhealthy` con tolleranza al lag. Il modulo è no-op quando `NOTIFY_SOCKET` è assente: *"a missing socket must never prevent the gateway from starting"*.
- **Riavvio drenante via segnale**, non `systemctl restart`: `SIGUSR1` → rifiuta nuovi turni, aspetta quelli in volo entro un budget, poi `stop()` ed esce; sia systemd che launchd riavviano su qualunque uscita. `systemctl restart` manda SIGTERM e SIGKILLa i turni a metà.
- **Tre file che esistono solo perché un gateway ha figli**: `cgroup_cleanup` (i sandbox e i server MCP li ammazza il cgroup, non il parent), `shutdown_forensics` (perché è morto), `restart.py`.
- Unit: `Restart=always`, `RestartSec=5`, `KillMode=mixed`, `TimeoutStopSec` tarato sul drain.

**La cicatrice che prendiamo gratis.** Il loro commento racconta il bug: se l'unit punta `WorkingDirectory` a un checkout che poi si sposta, systemd fallisce allo `CHDIR` **prima che Python parta**, quindi l'auto-riparazione all'avvio non gira mai e *"`Restart=always` crash-loopa per sempre su una directory morta"*. La cura: **ancorare l'unit alla home dei dati** (`~/.muffin`), che non si muove, mai al checkout del codice.

**Quello che NON prendiamo: `StartLimitIntervalSec=0`.** Loro disabilitano il rate-limit di systemd — riavvia per sempre, senza mai arrendersi. Se Muffin muore per una chiave sbagliata deve **restare giù e dirlo**: un riavvio infinito brucia quota e riempie i log senza che nessuno se ne accorga, ed è già il falsificatore scritto sopra ("muore più di una volta a settimana per cause non dovute a un crash del modello"). Serve la distinzione che il processo deve saper fare da sé — *transitorio* contro *non si risolve riprovando* — e nel secondo caso l'uscita è definitiva e rumorosa.

---

## Emendamento №1 — quattro cose decise costruendolo (2026-08-11, `slice/gateway`)

Scritte qui e non in una risposta di chat perché tre su quattro **cambiano o restringono** qualcosa che l'ADR sopra afferma.

**1. `muffin init` propone di installare la unit.** L'ADR dice *"stampare la unit e cosa lanciare invece di abilitarla in silenzio"*. Giusto sul consenso, **sbagliato sull'ergonomia**, e la prova è la reazione dell'owner alla prima versione: *"non lancerò mai quei comandi a mano."* Una unit che nessuno installa lascia lo scheduler dov'era, cioè il difetto che questa ADR esiste per chiudere. Quindi la domanda si fa **dentro `init`**, una volta, mentre l'owner è già lì — resta un suo atto esplicito, solo nel momento in cui è presente. Fuori da un TTY non installa niente e stampa il comando: un installer che scrive una unit di servizio dentro una run scriptata farebbe esattamente ciò che l'ADR vieta. `muffin gateway install` resta, ed è ancora l'unico posto che scrive il file.

**2. `muffin gateway run` non è un verbo per un umano.** Sempre dall'owner, che ha letto la lista comandi e ha chiesto se deve digitarlo lui per tenere Muffin vivo: è la riga di `ExecStart`. Nella USAGE è marcato come tale. Il vocabolario di un sistema continuo (§"Cosa diventa rappresentabile") deve distinguere ciò che si invoca da ciò che gira.

**3. `NotifyAccess=all`, ed è una concessione, non un dettaglio.** Il protocollo `sd_notify` è un datagram su socket `AF_UNIX` **`SOCK_DGRAM`**. **Node non sa aprirlo**: `dgram.createSocket` accetta solo `udp4`/`udp6` (misurato su Node 22.22 — `ERR_SOCKET_BAD_TYPE`), e `node:net` è solo stream. Le opzioni erano una dipendenza nativa per una sola piattaforma o `systemd-notify(1)`, che systemd spedisce per questo. Preso il secondo, e il prezzo va detto: il messaggio arriva da un figlio, quindi serve `NotifyAccess=all`, e **con quello qualunque processo nel cgroup può alimentare il watchdog** — un gateway piantato con un figlio vivace è un buco che il watchdog non copre più. Accettato per ora (single-owner; i nostri figli sono server MCP e sandbox); la via d'uscita è un mittente che scriva il datagram dal pid principale, che è una decisione di dipendenza a sé.

**4. Il `ForegroundGate` del gateway è `ALWAYS_IDLE`, per ora.** Il gate di priorità di ADR-0022 §1 protegge la lane del modello quando l'owner scrive; un gateway senza terminale non ha un foreground da cui essere interrotto. **Non** è "risolto": quando un turno di surface saprà dire "l'owner sta parlando adesso" — cioè con `queue`/`steer`, che questa slice non costruisce — è lì che si innesta, e il gate smette di essere una costante. Dichiarato perché un `ALWAYS_IDLE` senza spiegazione si legge come una svista.

**E una scelta che non contraddice niente ma va nominata**: l'orizzonte di scadenza della rivendicazione del gateway è un **battito**, non una durata fissa. Il `SendLock` può dire "più vecchio di un'ora = morto" perché un invio è una chiamata al modello; un gateway tiene il lock per settimane e il silenzio non prova niente su di lui. Il meccanismo del claim è lo stesso — generalizzato in `core/lock/durable.ts`, non copiato — ma la costante non poteva esserlo.

---

## Emendamento №2 — due frasi false in questo documento, e i verbi che le contenevano (2026-08-13, `slice/gateway`)

Scritte qui, in coda e non riscrivendo il testo sopra, perché sono **correzioni a
questo ADR**: due delle sue frasi erano sbagliate, e ognuna aveva prodotto un
comando che non fa quello che dice.

**1. La riga 43 — *"sia systemd che launchd riavviano su qualunque uscita"* — è
falsa in tutte e due le direzioni, e ognuna era un verbo rotto.** Su systemd
`Restart=always` riavvia davvero qualunque uscita, quindi un `muffin gateway
stop` drenava, stampava "gateway fermato", e systemd lo riportava su dopo
`RestartSec=5`: **stop non fermava niente**, sulla VPS Linux che è la produzione.
Su launchd `KeepAlive: {SuccessfulExit: false}` riavvia solo su uscita ≠ 0,
quindi il riavvio drenante da `SIGUSR1` usciva 0 e l'agente **restava giù** —
il fallimento speculare, che spegne esattamente lo scopo del segnale.

La cura sta nei codici, non negli avvisi (direttiva owner: *"non lancerò mai quei
comandi a mano"*, quindi "fallo a mano con `systemctl --user stop`" non è una
risposta). `SIGUSR1` esce **0** = *riavviami*; `SIGTERM`/`SIGINT` escono **143**
= *mi hanno detto di smettere*, e la unit nomina 143 accanto a 78 in
`RestartPreventExitStatus` — che non tocca `systemctl stop|restart`, job
espliciti e quindi fuori da quella regola. Su launchd `KeepAlive` diventa
incondizionato, perché lì l'unica cosa che si può scegliere è **quale** dei due
difetti tenere, e restare giù dopo un riavvio richiesto è il peggiore. Il prezzo
— `gateway stop` su macOS ferma il processo e launchd ne avvia un altro — è
negli avvisi di `gateway install`, con il verbo di launchd che lo tiene giù. **La
proprietà che nessuna delle due metà può costare: un crash riavvia sempre.**

**2. La riga 49 — *"se Muffin muore per una chiave sbagliata deve restare giù e
dirlo"* — nomina un caso che non esiste**, e la stessa frase era nel commento
dentro la unit generata, cioè sotto gli occhi dell'owner. Tracciato e misurato:
un secret **mancante** dà `ConfigError` (`readSecret`, in
`core/config/config.ts`) → il ramo `ConfigError` di `cmdGatewayRun` → uscita 78
✅. Una chiave **presente ma sbagliata** viene passata al provider così com'è
(`buildRuntime`, `readSecret(config.provider.apiKeyRef)` dritto nel costruttore
del provider): il gateway parte, resta su, e il 401 arriva **dentro un turno**,
dove il `catch` di `Scheduler.run` lo trasforma in testo consegnato — la forma
`⏰ job fallito: …`, vista uscire su stdout in un probe di questo giro. Non esce mai, quindi l'esenzione non è mai
scattata per il caso che l'aveva motivata. Ciò che esce 78 è: config assente o
illeggibile, secret mancante, root of trust che rifiuta. **Un fallimento di
autenticazione a turno non è un fallimento di avvio** — e un contatore di 401
che spenga il processo è una decisione a sé, deliberatamente non presa qui.

**3. `Type=notify` presuppone un mittente, e senza quello non degrada.** Il
§"Come si tiene su" prescrive `Type=notify` senza dire cosa succede dove
`systemd-notify(1)` non c'è: `READY=1` non parte mai, la unit non raggiunge
"started", systemd la uccide a `TimeoutStartSec` (90 s di default) e
`Restart=always` ci riprova all'infinito **senza mai toccare il rate limit** —
cinque avvii in dieci secondi non succedono se ognuno dura novanta secondi.
`muffin gateway install` su linux ora guarda il PATH e, in assenza, emette
`Type=exec` senza `WatchdogSec` più l'avviso che la supervisione è "riavvia se
muore", non "riavvia se si pianta" — la stessa forma degli avvisi launchd.

**4. Il watchdog non può tacere durante il drenaggio, e non si poteva verificare
che potesse.** `drain` azzerava tutti i timer, ping compreso, e poi aspettava
fino a `DRAIN_BUDGET_MS` (60 s) contro un `WatchdogSec` di 60: un drenaggio non
iniziato da systemd (SIGUSR1, o il SIGTERM che `gateway stop` manda al pid) vale
fino a 90 s di silenzio contro una scadenza di 60. Si presumeva che
`notify.stopping()` mettesse al riparo. `sd_notify(3)` documenta `STOPPING=1`
come *"the service is beginning its shutdown"* e non dice **niente** sul
watchdog, e qui non c'è un systemd su cui eseguire la prova. Quindi la
dipendenza è stata **tolta** invece che scritta: timer del tick e timer del ping
sono separati, `drain` azzera solo il primo, e il ping vive quanto l'attesa.

**5. Il REPL rileggeva la rivendicazione una volta sola.** Vedi
`04-roadmap.md` §M5-bis punto 0, correzione del 2026-08-13, per l'ordine che
rompeva "due scheduler non girano mai" e per la finestra residua detta onesta.

---

## §revisione 2026-08-14 — il criterio d'uscita dal lato di chi lo usa, e il budget che ne consegue

Da `research/confronto-gemini.md` §2 e §18. Non sposta la decisione: aggiunge il criterio che le mancava e una cosa che va costruita **dentro** la stessa slice, non dopo.

**1. Il criterio d'uscita, detto dal lato dell'esperienza.** L'ADR sopra si giustifica dal lato del runtime — undicesima istanza di "dichiarato e non connesso", 31 verbi Hermes su 95 che presuppongono un processo. È corretto e non basta: un ADR che si argomenta con un conteggio di verbi non dice all'owner **cosa cambia mentre lo usa**, e "il processo gira" è verificabile con `ps`, il che lo rende un criterio troppo facile da soddisfare.

La formulazione che lo dice in una riga è la separazione **voce / mani** applicata alla chat: la *voce* accusa ricezione entro ~500 ms ("ricevuto, ci lavoro, ti aggiorno qui"), le *mani* lavorano in asincrono, l'aggiornamento arriva dopo sullo stesso filo. Quindi il criterio d'uscita di questa decisione, accanto ai cinque vincoli:

> **Un turno lungo restituisce entro ~500 ms e consegna dopo, senza che nessuno resti a guardare i puntini.**

Due precisazioni che il criterio porta con sé e che sono nostre:

- **Metà ce l'abbiamo già, ed è quella cosmetica.** `connectors/telegram/presence.ts` rinnova il draft ogni 22 s e `sendChatAction` ogni 4 s — nasce così perché il vecchio Muffin l'aveva tolto sull'assunzione che le risposte stessero dentro il TTL, e rimesso due settimane dopo. La metà **strutturale** (accetta, torna, consegna dopo) non esiste: `runTurn` è sincrono e il connettore lo attende. È una **conseguenza** di questa decisione, non un lavoro parallelo — un worker asincrono dentro `cli/repl.ts` muore col REPL, che è il difetto che questo ADR esiste per chiudere.
- **L'ACK ha un costo: raddoppia i messaggi.** La forma giusta è già scritta e già in codice per i gruppi — placeholder poi `editMessageText`, **un messaggio invece di due**, e nessun orfano se il turno muore. Vale come forma anche per l'ACK in privato; il draft effimero resta dov'è.

**2. Il budget per-job entra in questa slice, non dopo.** Oggi i cap sono **globali** (mese, e giorno-per-tenant, `core/budget/budget.ts`), e il solo limite per-turno è l'iteration cap del profilo, che conta i giri e non i token. Regge finché l'unico consumatore è l'owner davanti al terminale: se un turno impazzisce, lo vedi. **Un processo che vive rimuove esattamente quella condizione** — i turni autonomi girano di notte, e "il mese si è esaurito" è un controllo troppo grosso: è la differenza fra un job rotto che costa €0,50 e uno che si mangia il mese prima delle 7.

La forma non è un middleware sul client HTTP: il posto è **il job**. `core/scheduler/jobs.ts` ha già la riga; le servono un tetto (token, chiamate, timeout) e un contatore, e `markRan` sa già chiudere un giro. E il corollario di ADR-0022 sul bug Hermes #25517 vale identico qui: **il conto va tenuto fuori dal turno**, non dentro — un contatore che si aggiorna solo quando il loop torna al controllo è un contatore che non protegge dal caso in cui il loop non torna.

**Segnale che questa revisione era sbagliata**: l'ACK viene percepito come rumore (due messaggi dove ne bastava uno) invece che come reattività — nel qual caso la soglia non è il tempo di risposta ma la **durata attesa del turno**, e l'ACK va emesso solo oltre una soglia misurata, non sempre.
