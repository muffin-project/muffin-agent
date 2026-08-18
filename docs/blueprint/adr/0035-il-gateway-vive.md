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

---

## Emendamento №3 — lease con generazione e fencing, dopo l'audit avversariale (2026-08-17, `slice/lease-fencing`)

**Il difetto.** L'audit del 2026-08-16 (P19/P20/P21, `docs/blueprint/research/audit-2026-08-16/`) ha trovato che `heldBy()` — la funzione che §"Come si tiene su" sopra intende quando parla di "un orizzonte di scadenza… generalizzato in `core/lock/durable.ts`" — chiedeva l'orologio **prima** di chiedere se il detentore fosse vivo: `if (nowMs - takenAt > staleAfterMs) return null` girava per primo, e solo se il claim non era ancora scaduto veniva mai consultato `alive(pid)`. Un processo genuinamente vivo ma silenzioso — uno sleep del laptop, un batch sincrono lungo, una singola tool call lenta — leggeva esattamente come un cadavere e la sua rivendicazione veniva rubata da un secondo processo. Per il gateway (P20) questo apriva una finestra di doppia consegna: `Gateway.tick()` controllava `beat()` una volta e poi eseguiva `scheduler.tick()`/`turnLane.tick()` senza mai riverificare. Per i turni (P19) una doppia esecuzione vera e propria — e le scritture di stato (`checkpoint`/`finish`/`suspend` su `turns`) non avevano alcuna guardia sul detentore, solo sullo stato, quindi il processo perdente sovrascriveva in silenzio il lavoro del vincitore.

**La correzione, nella stessa funzione.** `heldBy` ora chiede le due cose insieme, in un ordine specifico: morto è rubabile **subito**, senza aspettare alcun orizzonte; vivo è protetto fino a un orizzonte **duro** (`HARD_STALE_MULTIPLIER`, 6×) più largo dell'orizzonte che ciascun lock già dichiarava (`STALE_AFTER_MS`, `TURN_STALE_AFTER_MS`, eccetera). Non un quinto numero inventato per ciascun lock: un unico rapporto condiviso in `core/lock/durable.ts`, così l'orizzonte "ordinario" di ciascun lock resta esattamente quello che era sempre stato — la cadenza attesa di un detentore sano — e il margine che un detentore vivo-ma-silenzioso riceve prima dell'espulsione diventa una funzione di quello, non un'altra costante da giustificare a mano. Per il gateway: 5 minuti ordinari, 30 minuti dell'orizzonte duro.

**Fencing.** Ogni acquisizione — prima o rubata — conia un `holder_id` casuale, tenuto solo in memoria dall'istanza che ha vinto. Ogni scrittura successiva sulla stessa riga deve portarlo indietro: `changes === 0` significa che la rivendicazione non c'è più, e il chiamante deve fermarsi invece di continuare come se fosse ancora proprietario. `core/turns/store.ts` porta la stessa forma come `claim_token` (una tabella più in là, quindi non passa dalla classe `DurableLock`, ma dallo stesso principio) su `checkpoint`/`finish`/`suspend`; `agent/loop.ts` tratta un fencing fallito come «ho perso la rivendicazione», chiude il turno senza ulteriore chiamata al modello, tool o consegna, e non finge un esito che la riga non registra.

`DurableLock.refresh()` — il battito di un detentore di lunga vita — ora controlla lo stesso orizzonte che `heldBy` usa, prima di spingere avanti `taken_at`: è la correzione di P21. Prima, un gateway che si risvegliava oltre l'orizzonte poteva rifare il battito come se niente fosse, anche se ogni altro lettore (la REPL, tramite `readGateway`) lo aveva già giudicato assente — risorgendo una rivendicazione che il resto del sistema considerava già chiusa. Ora `refresh()` fallisce nello stesso istante in cui un lettore esterno avrebbe giudicato il claim scaduto: lettore e detentore condividono la stessa regola, non due regole che possono disaccordare esattamente attorno a un risveglio.

Sopra la primitiva, `Scheduler`/`TurnLane` prendono un nuovo `stillOwner` — una lettura fresca e non cache di "è ancora la mia rivendicazione, adesso" (`GatewayLock.isCurrentClaim`) — riverificato nello stesso punto in cui `ModelLane.take` già serializza: prima che un job/turno parta, e per lo scheduler di nuovo prima della consegna. `standDown` da solo non bastava: risponde "esiste un ALTRO gateway", ed è sempre `() => false` per lo scheduler del gateway stesso — nessuna protezione contro un furto della **propria** rivendicazione a metà di un giro lungo. `cli/gateway.ts` collega entrambe le corsie allo stesso `GatewayLock`.

**PID reuse.** Non si legge l'ora di avvio del processo: non esiste un modo portabile ed economico in Node senza un modulo nativo o un sottoprocesso ad ogni controllo di liveness (`ps -o lstart=` su macOS, `/proc/<pid>/stat` su Linux, niente su Windows) — esattamente la dipendenza che PRACTICES §2 dice di togliere invece di presumere quando la sonda non si può eseguire economicamente. Un `holder_id` locale al detentore risolve la stessa domanda — "è la stessa acquisizione, non solo lo stesso numero di pid" — senza dover sapere niente del sistema operativo, ed è altrettanto forte quanto un contatore di generazione monotono, senza una seconda colonna da incrementare nella stessa transazione della prima.

**Il costo, dichiarato.** Un `muffin gateway run` **senza supervisore** (lanciato a mano, non tramite `muffin gateway install`) che dorme più a lungo dell'orizzonte duro esce da solo al risveglio invece di riprendere silenziosamente, perché il proprio `refresh()` fallisce — esattamente come se qualcun altro avesse davvero rubato la rivendicazione — e senza supervisore non c'è nessuno a farlo ripartire. È la direzione sicura, scelta deliberatamente: "riprendere senza riverificare" è la forma esatta del bug P21. Col supervisore che questo ADR raccomanda (§"Come si tiene su"), il processo torna su da solo; è il prezzo di avere un orizzonte duro invece di uno infinito, e vale solo per chi ha scelto di non installare la unit.

**Cosa resta fuori, e perché.** La terza parte del reperto P21 (fire-claim idempotente sul percorso job, prima di chiamare il modello, e una riga durevole quando `turnId` è `null`) chiede o una tabella nuova (`job_fires`) o un meccanismo equivalente sulle colonne di `jobs` — in entrambi i casi una decisione di schema, non presa in questa slice: proposta e non fatta, riferita all'owner con le opzioni. `markRan` resta l'unico scrittore di `next_fire_at`, quindi un crash fra l'esecuzione del goal e `markRan` continua a rieseguirlo per intero — il limite che il commento in `core/scheduler/scheduler.ts` già nominava come "money and not correctness", ancora vero perché non ancora chiuso.

**Alternative scartate.** *Un contatore di generazione intero* invece di `holder_id`: stessa proprietà, ma richiede un secondo scrittore (`generation = generation + 1`) nella stessa transazione della prima invece di un valore autosufficiente — nessun vantaggio misurabile, una colonna in più da tenere sincrona. *Un orizzonte duro per lock, scelto a mano* invece di un moltiplicatore condiviso: avrebbe richiesto giustificare quattro numeri invece di uno, e il rischio è esattamente quello che questo ADR nomina altrove — costanti inventate una alla volta invece di derivate da una regola sola. *Riverificare `stillOwner` dentro ogni tool call* (non solo al confine di `Scheduler`/`TurnLane`): avrebbe chiuso una finestra residua ancora più piccola (il tempo fra l'inizio di un batch di tool call e la sua fine) a un costo molto più alto — filo nuovo dentro `agent/loop.ts` per ogni chiamante — mentre il fencing sulle scritture di stato (`claim_token`) copre già la stessa finestra dal lato dei dati: se la rivendicazione è persa a metà batch, il prossimo `checkpoint` lo scopre e ferma il turno comunque, al costo di al più un giro di tool call in più eseguito da un processo che non è più proprietario — un residuo bounded, non un buco.

**Segnale che questa correzione era sbagliata**: `HARD_STALE_MULTIPLIER` (6×) si rivela troppo stretto (un gateway genuinamente vivo viene espulso durante l'uso normale — misurato, non presunto) o troppo largo (un detentore morto per pid-reuse viene creduto vivo abbastanza a lungo da causare un secondo problema osservato). Il numero è una scelta operativa, non un invariante architetturale: si cambia in un commit, in `core/lock/durable.ts`, senza toccare la forma.

## Emendamento №4 — §Continuità appartiene a Muffin, non al pid (2026-08-17, `slice/a1-continuita`)

Parole dell'owner, verbatim, mandato di questa slice: *"Muffin deve esistere come processo residente supervisionato, non come CLI che l'owner tiene aperta… la continuità appartiene a Muffin, non al PID del gateway."* Sette proprietà, ognuna con cosa la prova o perché non è provabile in questo ambiente — non un riassunto, l'elenco che il judge di A1 può controllare riga per riga.

1. **Il gateway vive indipendentemente da terminale/SSH.** Per costruzione: `cmdGatewayRun` (`cli/gateway.ts:299`) non ha un genitore interattivo, ed è la stessa ragione per cui esiste questo intero ADR. `a-lifecycle.accept.ts`'s A1 lo avvia come processo figlio staccato dal test che lo spawna (`inst.spawnRaw`/`inst.gateway()`, `evals/acceptance/harness.ts:148`) e lo uccide con `SIGKILL` senza che nessun `finally` del genitore lo salvi — ma **non** prova la sopravvivenza a una disconnessione SSH reale, perché il processo figlio del test non è scollegato dal gruppo di processi di vitest (nessun `detached: true`, `setsid` o supervisore reale nel mezzo). Quella prova resta la battery §10.
2. **Parte automaticamente al boot.** Non provabile qui: richiede un boot reale (`systemctl --user enable`, `launchctl bootstrap`, poi un riavvio della macchina). Ciò che è provato: la unit generata dichiara `WantedBy=default.target` / `RunAtLoad` (`core/gateway/unit.ts:184,231`, `unit.test.ts`), e `doctor` ora verifica che la unit **esista al suo posto giusto** (`core/gateway/supervisor.ts`) — non che il boot l'abbia davvero eseguita. Battery §10.
3. **Su Linux sopravvive al logout.** La unit generata nomina `loginctl enable-linger "$USER"` fra i comandi da eseguire (`unit.ts:199`), e `doctor` lo verifica (`checkSupervisor`'s `lingerEnabled`, `core/gateway/supervisor.ts`) — mai un blocco, sempre un `warn` col comando esatto se manca. La sopravvivenza *reale* a un logout richiede una sessione systemd vera; non provabile in questo harness. Battery §10.
4. **Crash/hang vengono recuperati dal supervisor.** Due metà diverse. *Crash seguito da un riavvio manuale* (ciò che farebbe un supervisore) è provato end-to-end da A1: `SIGKILL` → `muffin gateway status` exit 1 (claim libero, subito — `heldBy` giudica la vivezza prima della staleness) → un secondo `muffin gateway run` prende il claim e recupera. *Il riavvio innescato realmente dal supervisore* (systemd/launchd che notano l'uscita e rilanciano da soli) non è provabile senza quel supervisore; il protocollo che lo rende possibile (`RestartPreventExitStatus`, `KeepAlive`) è provato a livello di generazione in `unit.test.ts`. *L'hang* — processo vivo ma piantato — è la cosa che solo il watchdog vede, e su macOS **non esiste** (già documentato, Emendamento №2 punto 3-4: "launchd non ha watchdog"); su Linux il ping va a `WatchdogSec` (`notify.ts`), provato a livello di protocollo (`notify.test.ts`), non con un systemd reale.
5. **Il nuovo processo ricostruisce correttamente turni, wait, jobs, scheduler, inbox/delivery e altro stato durevole.** Turni, wait e jobs: provato da A1 (`a-lifecycle.accept.ts`) — un turno sospeso e un job dovuto, entrambi ripresi/eseguiti dal secondo processo. Inbox/delivery Telegram: provato separatamente e non riverificato da A1 (che non abilita Telegram, per PRACTICES §2 — nessun token reale in questo ambiente) da `connectors/telegram/updates.test.ts` (l'inbox durevole) e dal pattern di ripresa B5.
6. **Recovery non duplica lavoro o side effect.** Provato da A1 con mutazione, non solo con un'asserzione verde: disattivare a mano `Scheduler`'s `markRan` (`core/scheduler/scheduler.ts:342`) fa rifirare il job all'infinito e lo scenario va rosso (timeout sul secondo `waitFor`, la corsia dei turni resta affamata del model lane); rimuovere `status = 'done'` dalla scrittura di chiusura di un turno (`core/turns/store.ts`'s `finishStmt`) lascia la riga `running` per sempre e lo scenario lo nomina esplicitamente. Entrambe le mutazioni sono state eseguite, osservate rosse, e revertite — non lasciate nel codice.
7. **Telegram torna raggiungibile senza intervento owner.** Provato al livello del meccanismo, non dell'installazione reale: `TelegramConnector.run()` (`connectors/telegram/connector.ts`) ora riprova `getMe()` con backoff invece di morire una volta sola quando la rete non è pronta al boot — confermato rosso pre-fix, verde post-fix (`connectors/telegram/reconnect.test.ts`). Non riverificato con un token e una rete reali: quella prova, quando le credenziali sono disponibili, è la battery §10 di `gate1/MANDATO-DAY-1.md`.

**Il gap trovato e chiuso, nominato perché nessuno lo vedeva.** Prima di questa slice `connectSurfaces` (`cli/surface.ts:382`) avviava `TelegramConnector.run()` con `void connector.run().catch(...)`: un `getMe()` fallito al boot (rete non ancora pronta — `Wants=network-online.target` non lo garantisce, e su un laptop il Wi-Fi arriva dopo il boot) lanciava fuori da `run()` per intero, il `.catch` lo trasformava in una riga di log ("telegram: caduta"), e **la superficie restava morta per tutta la vita del processo** mentre il gateway restava su — lock tenuto, scheduler vivo, `doctor` che riportava un gateway sano con nessuno raggiungibile sopra. Vedi `docs/lessons.md` per la lezione in forma breve.

## Emendamento №5 — `job_fires`, il ponte di identità che chiude №3 (2026-08-18, `slice/job-fires`)

**Il punto lasciato aperto.** L'emendamento №3 elencava, fra "cosa resta fuori": *"il fire-claim idempotente sul percorso job, prima di chiamare il modello, e una riga durevole quando `turnId` è `null` — in entrambi i casi una decisione di schema, non presa in quella slice."* B7 (`M5-BIS.md`) nominava lo stesso buco dal lato dell'owner: *"un crash fra l'esecuzione del job e `markRan` rifà il fire per intero."* Decisione owner, verbatim: *"ogni occorrenza stabile `(job_id, scheduled_for)` deve mappare a UNA sola identità durevole di lavoro/turno; dopo crash Muffin continua o conclude quella stessa identità, non crea un secondo turn e non abbandona il primo."*

**La forma scelta, e perché non l'alternativa.** Una tabella nuova, additiva (`CREATE TABLE IF NOT EXISTS`, come ogni altro store di questo repo), non una colonna `origin_key` su `turns`. Le due alternative erano concrete — l'owner stesso le ha nominate entrambe — e la scelta si è decisa su una proprietà che una colonna su `turns` non può avere: **l'occorrenza deve poter esistere prima del turno.** `job_fires.claim(job_id, scheduled_for)` scrive una riga con `turn_id NULL` nell'istante in cui l'occorrenza diventa dovuta — prima che qualunque turno sia mai stato creato — così un crash in quella stessa finestra (fault point 2 sotto) trova comunque un'occorrenza registrata a cui completare il legame. Una colonna `origin_key` su `turns` non ha questo grado zero: non esiste alcuna riga finché il turno non esiste, quindi non c'è nulla su cui un secondo processo possa fare `INSERT OR IGNORE` per "prenotare" l'identità prima di crearla. La tabella separata è la forma minima che l'owner chiedeva esplicitamente di cercare ("se trovi una forma ancora più piccola... va bene"): tre colonne oltre alla chiave, tre metodi (`claim`, `bind`, `settle`), zero conoscenza di cosa sia un turno oltre al suo id.

**La forma, letterale.** `core/scheduler/job-fires.ts`:

```sql
CREATE TABLE IF NOT EXISTS job_fires (
  job_id        TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  turn_id       TEXT,
  settled_at    TEXT,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (job_id, scheduled_for)
);
```

`scheduled_for` è `job.nextFireAt` letto **una sola volta**, nell'istante in cui `due()` lo restituisce — mai l'orologio di quando un processo se ne accorge, per costruzione: il valore attraversa `agent/scheduler-run.ts`'s `makeJobRunner` come parametro, non viene mai ricalcolato durante la risoluzione di un'occorrenza.

**Il percorso.** `makeJobRunner` (`agent/scheduler-run.ts`), non `Scheduler.tick`: la decisione — quale identità usare, se richiamare il modello o no — resta nel file che il proprio docstring già rivendicava come *"the one piece with a decision in it, tested without a model"*. `Scheduler` (`core/scheduler/scheduler.ts`) resta la meccanica attorno: sa solo interpretare tre esiti possibili da `RunJob` — un `JobOutcome` normale (consegna+settle come sempre), `FireDeferred` (non fa nulla: né consegna né `markRan`, l'occorrenza resta dovuta per il prossimo giro), `FireSettleOnly` (salta la consegna — qualcun altro l'ha già fatta — e chiama solo `settleFire`+`markRan`). `settleFire`, nuovo parametro opzionale del costruttore (default no-op, quindi ogni sito di costruzione pre-esistente e ogni test pre-esistente restano invariati), viene chiamato **immediatamente prima** di ogni `markRan` in questo file — mai dopo, in nessuno dei tre punti che oggi chiamano `markRan` (`settle`, il ramo sospeso di `run`, e implicitamente `FireSettleOnly`).

**La matrice dei sette punti dell'owner, e dove ciascuno è provato.**

| # | Punto | Dove è provato |
|---|---|---|
| 1 | crash prima del fire → si crea | `core/scheduler/job-fires.test.ts` — `claim` idempotente, e il vincolo UNIQUE è dello schema, non della convenzione (un `INSERT` grezzo duplicato lancia) |
| 2 | dopo il fire prima del turno → completa il binding, non lo perde | **binario vero**: `evals/acceptance/scenarios/job-fires.accept.ts`, primo `SIGKILL`, nella finestra resa osservabile da `MUFFIN_JOB_FIRES_STALL_AFTER_BIND_MS` |
| 3 | dopo la creazione del turno → riprende lo stesso `turn_id` | store: `job-fires.test.ts` (`bind` first-writer-wins); runner: `agent/scheduler-run.test.ts` ("un occorrenza che arriva già legata... mai una id concorrente"); binario vero: lo stesso scenario, fra il primo e il secondo `SIGKILL` — il riavvio completa il legame con l'id **originale**, non uno nuovo (provato per mutazione: minare quella riga a mano fa scadere il secondo `waitForDb` in timeout, per la ragione esatta — l'id atteso non raggiunge mai `done`) |
| 4 | a metà turno → recovery normale del turno/effect WAL | invariato, meccanismo pre-esistente (B5); `agent/scheduler-run.test.ts` prova che il runner **non** lo tocca (`running`/`interrupted`/`waiting` → `FireDeferred`, zero chiamate al modello) |
| 5 | turno `done` prima di `markRan` → non richiama il modello, completa il settlement | store+runner: `agent/scheduler-run.test.ts`; **binario vero**: lo stesso scenario, secondo `SIGKILL`, nella finestra `MUFFIN_JOB_FIRES_STALL_AFTER_DONE_MS` — il terzo avvio recupera il testo dal file di sessione e consegna, il log delle request del provider finto conta **una** chiamata in tutto lo scenario |
| 6 | delivery incerta → non rifà la computazione | `agent/scheduler-run.test.ts` ("la STESSA occorrenza risolta due volte... non richiama mai il modello") e `core/scheduler/scheduler.test.ts` (`FireSettleOnly` non chiama mai `deliver`) |
| 7 | solo dopo il settlement avanza la schedule | `core/scheduler/scheduler.test.ts` — `settleFire` prima di `markRan`, provato per mutazione su **entrambi** i punti che chiamano `markRan` (`settle` e il ramo sospeso), osservato rosso, ripristinato. Trovato scrivendo questa prova: il test pre-esistente equivalente per `recordDelivery`/`markRan` inferiva l'ordine dall'evento `'ran'` invece che dalla chiamata reale a `store.markRan` — una mutazione non l'avrebbe mai fatto scattare, perché l'evento arriva comunque dopo entrambe le scritture indipendentemente dal loro ordine reciproco. Corretto nello stesso giro (`core/scheduler/scheduler.test.ts`), non lasciato silenzioso accanto alla prova nuova. |

**Cosa NON chiude.** Il ramo sospeso (`outcome.stopped === 'suspended'`) segna il fire "settled" nello stesso istante in cui chiama `markRan`, invariato da prima di questa slice: la *occorrenza* è gestita (turno creato, legato, ceduto alla corsia) anche se il *turno* non ha ancora risposto — le due cose restano domande diverse, e la consegna eventuale resta un fatto sulla riga del turno (`delivery`), non su `job_fires`. Non è un buco: è la stessa proprietà del §"suspended turn" pre-esistente, solo ora osservabile anche dal lato dell'occorrenza.

**Comporre con Telegram.** Non implementato qui — è `slice/inbound-unit` — ma la forma lo ospita direttamente: `update_id → turn_id` è la stessa domanda con una chiave diversa (un intero singolo invece della coppia `(job_id, scheduled_for)`), quindi la strada naturale è una tabella gemella, non una generalizzazione prematura:

```sql
CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id  INTEGER PRIMARY KEY,
  turn_id    TEXT,
  settled_at TEXT,
  created_at TEXT NOT NULL
);
```

con lo stesso `claim`/`bind`/`settle` di `JobFireStore`, alla lettera: `drain()` (`connectors/telegram/connector.ts`) chiamerebbe `claim(update.update_id)` prima di leggere l'update, `handle()` legherebbe il `turn_id` prima di chiamare `runTurn`/`enqueueTurn` esattamente come `runFresh` fa qui, e la finestra che l'owner ha nominato esplicitamente — *"crash fra `handle()` e `markProcessed` = secondo turno, secondo giro modello, seconda consegna"* — si chiude nello stesso modo: l'identità esiste prima dell'effetto. Una singola tabella condivisa con un discriminatore (`source: 'job' | 'telegram'`) o un helper generico sopra `claim`/`bind`/`settle` (sul modello di `core/lock/durable.ts`'s `DurableLock`, che generalizza *l'algoritmo* e non la tabella, per la stessa ragione documentata lì) restano scelte legittime **quando** esiste un terzo consumatore — due istanze non lo giustificano ancora, e inventare l'astrazione ora sarebbe esattamente il "trigger framework" che il mandato di questa slice chiedeva di non costruire.

**Alternative scartate.** *Colonna `origin_key` su `turns`* — vedi sopra: non può rappresentare un'occorrenza prima che il turno esista, che è la proprietà che rende il fault point 2 chiudibile. *Riverificare l'identità dentro ogni tool call della corsa* (come l'emendamento №3 aveva scartato per `stillOwner`) — stesso ragionamento, costo molto più alto per una finestra già chiusa dal binding-prima-del-modello. *Un contatore/generazione monotona invece del binding first-writer-wins* — stessa proprietà di `bind`'s `UPDATE … WHERE turn_id IS NULL`, nessun vantaggio misurabile, una scrittura in più da tenere sincrona nella stessa transazione.

**Segnale che questa forma era sbagliata**, contato e non percepito: un secondo consumatore di `claim`/`bind`/`settle` (Telegram, o altro) rende la duplicazione fra le due tabelle costosa da tenere in sincrono — nel qual caso l'estrazione dell'algoritmo condiviso, non della tabella, è il passo successivo, già indicato sopra.


### Limite noto: un fire legato a un turno sospeso resta deferred

Reperto del judge di questa slice, registrato invece che chiuso a caso.

Quando un crash lascia il turno di un job in `waiting` con un `wake_at` lontano,
il fire resta **deferred** (`core/scheduler/scheduler.ts`, ramo
`bound_turn_pending`) e `next_fire_at` non avanza finché la corsia dei turni non
lo chiude. Il ramo *sospeso vivo* invece fa settle e `markRan` subito: due
percorsi che divergono per la stessa parola, «sospeso».

**Perché non è un difetto della garanzia**: niente viene perso né duplicato —
l'occorrenza esiste, è legata a quel `turn_id`, e chi la conclude è la corsia,
che è il proprietario giusto di un turno sospeso. Il costo è che la *schedule*
di quel job non avanza nel frattempo: un brief delle 8 con un turno sospeso
appeso non spara alle 9.

**Perché non è silenzioso**: `cli/doctor.ts` ha già il controllo che serve —
`N in attesa e nessun gateway attivo: non li sveglia nessuno`, con il rimedio.
La configurazione in cui il deferred può durare è precisamente quella (REPL
senza gateway: `agent/runtime.ts` «reclaims, does not resume»), ed è quella che
`doctor` nomina.

**Cosa lo chiuderebbe**, se durante i quattordici giorni si vede davvero: un
test che porta un fire deferred fino al settlement passando per
`core/turns/lane.ts`, oppure un tetto d'età sul deferred che emetta un evento
diagnostico. Nessuno dei due prima di avere un caso reale: costruire il tetto
adesso sarebbe infrastruttura per una possibilità ipotetica.
