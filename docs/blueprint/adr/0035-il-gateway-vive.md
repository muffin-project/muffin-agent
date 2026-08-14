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

**Reversibilità.** Alta. Il processo è additivo: la CLI continua a funzionare da sola (un client che non trova il socket fa quello che fa oggi), e `muffin run` headless resta il percorso scriptabile che ADR-0021 vuole. Se il processo si rivelasse più fragile del guadagno, si torna a invocare — perdendo esattamente le cose elencate sopra, che è il modo giusto di misurare cosa costava.

**Segnale che era sbagliata**, contato e non percepito: il processo muore più di una volta a settimana per cause non dovute a un crash del modello; oppure passa un mese di uso quotidiano e il numero di turni originati dal gateway (consolidamento, heartbeat, osservazione) resta sotto quello dei turni chiesti dall'owner — nel qual caso non serviva un processo che vive, serviva un cron.

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
