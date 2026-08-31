# ADR-0039 — Il confine è dove sta il file: il tetto entra nel sigillo, la chiave esce dalla working dir

**Stato:** accettato · 2026-08-13 · chiude la precondizione bloccante di ADR-0036
ed emenda ADR-0030

**Contesto.** Due difetti, e sono lo stesso difetto due volte: **una protezione
che nomina un file mentre la cosa che protegge vive in un altro**. Si chiudono
insieme perché la risposta è la stessa — *il confine va spostato dove sta il
dato, non aggiunta una seconda protezione accanto alla prima*.

1. **Il sigillo proteggeva una copia.** `rot/budgets.json` è dentro il manifest e
   il suo commento promette *«Dimensional, not sacred — ma l'agente non può
   alzarli da sé»*. `BudgetEngine` nasceva però da `config.budget`, cioè
   `~/.muffin/config.json`, che nel manifest **non c'è**. I due file portavano
   gli stessi numeri per duplicazione: ogni comportamento osservabile era
   corretto e la garanzia non esisteva. Trovato da ADR-0028 (2026-08-10),
   riscritto a grana di campo in `core/rot/readers.ts`, reso **precondizione
   bloccante** da ADR-0036 — *«nessuna superficie di scrittura conversazionale
   viene costruita prima che il tetto sia sigillato per davvero»*.
2. **L'agente poteva leggere la chiave dell'owner con un tool dichiarato.**
   `denyRead` nominava un solo percorso, `~/.muffin/secrets`. Ma `root` è
   `process.cwd()`, e ADR-0030 **richiede** che la cwd sia la directory del repo,
   perché è lì che vive la `.env` gitignorata con la chiave. `fs.read` è
   `risk: 'low'` e non dichiara `maxTaint`, quindi il suo tetto è
   `defaultMaxTaint.low`, che `rot/policy.json` mette a **3**. In un turno owner
   che avesse già ingerito un risultato tier-3 — il fetch-then-act che
   `03-threat-model.md §2` chiama *«il più comune, e va chiuso»* —
   `fs_read(".env")` restituiva la chiave in chiaro.

Il secondo non era sfruttabile sulla macchina dell'owner solo perché la `.env`
non esiste ancora. Diventava vivo nell'istante in cui la creava, che è
esattamente ciò che ADR-0030 gli dice di fare.

---

## Decisione 1 — il tetto vive nel file sigillato, e `config.budget` non esiste più

`core/rot/budgets.ts` è l'unico lettore di `rot/budgets.json`;
`agent/runtime.ts`, `cli/observe.ts` e `cli/jobs.ts` passano da lì. Il campo
`budget` esce da `ConfigSchema` e `CONFIG_SCHEMA_VERSION` passa a **2**.

**Perché questa forma e non «`config.budget` entra nel manifest».** Tre ragioni,
in ordine di peso:

- **Una sola fonte.** Due file che dichiarano entrambi il tetto è il modo in cui
  questo difetto è nato. Tenere `budget` deprecato-ma-parsato sarebbe lo stesso
  difetto con un'etichetta di avviso: un numero che si legge come il tetto e non
  lo è.
- **`config.json` è la cosa che ADR-0036 vuole scrivibile.** Ci vivono modelli,
  surface, e lo stato di pairing di Telegram — che il runtime **si scrive da
  solo** quando un pairing riesce. Sigillarlo farebbe di ogni cambio modello un
  `muffin rot reseal`, che è testualmente il segnale che ADR-0003 §5 dà per «il
  confine è nel posto sbagliato». E sigillare un *frammento* di file mutabile è
  una cosa che il manifest non sa esprimere: firma file interi.
- **Il costo della migrazione.** Cambiare *cosa* è sigillato invalida il manifest
  dell'installazione reale → `muffin rot verify` fallisce → safe mode nega tutto
  sopra il rischio basso. Questa forma **non tocca l'insieme sigillato**: restano
  i cinque file, con gli stessi hash. Verificato eseguendo: `rot verify` esce 0 e
  dice `5 files` prima e dopo.

**La migrazione, che è la parte difficile.** L'unica cosa che cambia sull'home
reale è `config.json`, e `loadConfig` rifiutava qualunque versione non fosse
l'attuale. Spedirlo così avrebbe murato l'installazione dell'owner dietro un
comando che non conosce — un rimedio peggiore del difetto.

- **Scala di migrazioni, in memoria, non su disco.** `MIGRATIONS[1]` toglie
  `budget` e porta la versione a 2. Un loader che riscrive il file che gli è
  stato chiesto di leggere è una sorpresa in ogni comando di sola lettura e una
  corsa fra il gateway e un REPL; `saveConfig` scrive comunque la versione
  corrente, quindi il file si aggiorna da sé alla prima modifica di una
  qualunque impostazione. Fino ad allora ogni load lo ripara di nuovo.
- **I numeri vecchi non vengono copiati nel file sigillato.** Lasciare che il
  valore di un file non sigillato entri nel sigillo da solo *è* il buco. La nota
  dice cosa c'era e lascia la decisione — e il reseal che la porta — all'owner.
- **Nulla è silenzioso.** La nota esce nei `bootLines` del runtime e come check
  `config migrata` in `muffin doctor`, con dentro i valori scartati e il comando.
- **La direzione opposta resta un rifiuto.** Un file scritto da una build più
  nuova non si migra: manca la conoscenza, non la volontà. Il rimedio dice
  *upgrade muffin*.

**Scartato: far distinguere a `rot verify` «file cambiato» da «insieme sigillato
cambiato».** Sarebbe servito solo alla forma che non abbiamo scelto. Costruirlo
adesso sarebbe un meccanismo senza grilletto, che è la firma di questo repo
(`AGENTS.md`: quattro difese con schema, test e nessun chiamante). Il difetto
adiacente **resta aperto e sta in roadmap**: oggi un file nuovo dentro `rot/`
arriva come `files_diverged … (untracked)`, indistinguibile fra «un upgrade ha
portato un file» e «qualcuno ne ha infilato uno». Il giorno che un upgrade
aggiunge davvero un file sigillato, quello va costruito prima.

## Decisione 2 — la chiave di sviluppo esce dalla working dir

Il segreto si risolve su una **catena ordinata** di due backend:

| ordine | backend | percorso |
|---|---|---|
| 1 | `home` | `$MUFFIN_HOME/secrets/<nome>` |
| 2 | `persistent` | `$XDG_CONFIG_HOME/muffin/secrets/<nome>` (dir `0700`, file `0600`) |

**Perché `home` vince.** Un segreto per-installazione deve poter oscurare quello
condiviso, altrimenti `muffin secret set` diventa un comando senza effetto su una
macchina che ha una chiave persistente. L'ordine inverso fallisce in silenzio, ed
è la direzione che non si nota mai.

**Perché una catena e non un solo posto.** `muffin uninstall` deve continuare a
cancellare ciò che dice di cancellare (ADR-0011: `~/.muffin` è il perimetro
GDPR), e il loop `uninstall && init` deve continuare a ritrovare la chiave
(ADR-0030). Le due cose sono compatibili solo se esiste un posto **fuori** dalla
home wipeata in cui l'owner sceglie esplicitamente di mettere la chiave:
`muffin secret set NAME --persist`. Il default resta `home`.

**La catena non è mai muta**, ed è una condizione, non un ornamento:
`muffin doctor` nomina il backend che ha risposto e il percorso, e **avvisa
quando esistono due copie** — perché l'installazione che crede di aver migrato la
chiave e continua a leggere quella vecchia presenta ogni sintomo di una
migrazione riuscita.

**`denyRead` copre ora ogni posto in cui una chiave può stare**: entrambe le
directory dei segreti e la `.env` della working dir. La `.env` è nominata
esplicitamente e non da un'euristica «sembra un segreto»: è l'unico file dentro
`root` che un registro di decisioni dice all'owner di riempire con una chiave;
un pattern su `*.pem`, `id_rsa`, `credentials` negherebbe un bersaglio mobile e
comprerebbe la fiducia di una lista completa senza esserlo. Ciò che rende la
chiave sicura è che non deve più stare lì; quella riga è la cintura per chi non
l'ha ancora spostata. La stessa lista va al sandbox: due deny-list che divergono
sono una deny-list più un buco.

## Decisione 3 — `fs.read` resta a `maxTaint` 3, e questo è un giudizio, non un'omissione

`web_search` porta 3 con una ragione registrata: il primo risultato sporca il
turno a 3, quindi un tetto più basso consentirebbe **una sola ricerca per turno**
e la ricerca profonda sarebbe impossibile. Leggere un file ha la stessa forma:
*«leggi questa pagina e confrontala con i miei appunti»* è un turno owner
normale, e a tetto 1 la seconda metà viene negata.

Il costo si paga su ogni turno; il beneficio non è quello che sembra, perché la
lettura da sola non è la fuga: i byte devono comunque **uscire**, e la gamba
egress è gated a parte (fuori allowlist sopra taint 1 è DENY, mai ask, proprio
perché un contesto avvelenato non deve poter *nominare* la destinazione).
`hostOnly` tiene fuori i membri di gruppo del tutto. Restringere qui sarebbe uno
strumento cieco: romperebbe il flusso principale lasciando in piedi il residuo
vero, che è *qualunque* file privato, non solo il segreto.

**La precondizione che lo rende vero, scritta perché sia falsificabile:** il
tetto è difendibile *perché* dentro `root` non è raggiungibile nessun segreto. Se
un segreto torna leggibile lì, questo argomento smette di valere — quella, e non
il numero, è la cosa da sorvegliare. Sta come commento sulla dichiarazione, dove
vive la decisione.

**Non pinnato a 3 nella dichiarazione**, deliberatamente: pinnare scavalcherebbe
un owner che abbia abbassato `defaultMaxTaint.low` in `rot/policy.json`, e
l'unica direzione legittima di quel file è stringere (`core/policy/matrix.ts`).

## Emendamento a ADR-0030 (non riscrittura)

ADR-0030 §2 diceva *«la chiave dev vive nella `.env` del repo»*. Il **principio**
resta e non è mai stato in discussione: *la chiave vive fuori dalla home
wipeata*. Cambia il posto, e cambia perché ADR-0030 aveva già nominato il difetto
fra le sue conseguenze — *«la `.env` si carica dalla CWD, quindi il loop va fatto
dalla dir del repo»* — senza vedere che quella dipendenza dalla CWD **è** la
superficie: la cwd è `root`, e `root` è ciò che `fs_read` può leggere.

- **Sostituito**: `MUFFIN_API_KEY` in una `.env` → `muffin secret set --persist`.
- **Resta**: il caricamento della `.env` (`loadDotenvIfPresent`), per le variabili
  **non segrete** — `MUFFIN_HOME` sopra tutte, che è la primitiva dev/prod di
  ADR-0030 §3. Una chiave lasciata lì continua a funzionare e ora è nella
  deny-list, quindi l'agente non se la rilegge.
- **Chiusa la nota finale di ADR-0030** (*«se un domani servisse un `.env` a
  percorso fisso indipendente dalla CWD, questa decisione non lo preclude»*): è
  oggi, e il percorso è quello XDG — la stessa famiglia di directory che il
  credential store di systemd usa su Linux, così le due macchine potranno un
  giorno condividere un solo percorso di risoluzione.

## Conseguenze

**Più facile.** ADR-0036 è sbloccata: «Muffin regola i modelli sotto il tetto» ora
descrive qualcosa. Il tetto ha un posto solo. `doctor` risponde a due domande che
prima non aveva modo di distinguere — da quale file viene il tetto, e quale
backend ha risposto per la chiave.

**Più difficile.** Alzare il tetto adesso è `muffin rot reseal`, per costruzione:
è attrito deliberato ed è il prezzo del contrappeso (ADR-0003). E i segreti
vivono in due posti possibili invece che in uno: la catena è una superficie in
più da spiegare, ed è compensata solo finché `doctor` dice chi ha risposto.

**Segnale che era sbagliata.** Se l'owner si ritrova a fare `rot reseal` spesso
per il budget, allora il tetto non è «una cosa su cui l'agente non deve essere
indulgente con se stesso» ma una preferenza finita nel sigillo — ed è lo stesso
segnale che ADR-0036 si era dato. Se qualcuno scrive un terzo backend di segreti
senza aggiungerlo a `denyRead`, la catena è cresciuta oltre ciò che una
deny-list scritta a mano regge, e serve il contrario: un solo percorso, con il
keyring dell'OS dietro.

**Reversibilità.** Il tetto: bassa a costo (una migrazione di config in più) e
comunque indesiderabile — tornare indietro rimette il difetto. La catena dei
segreti: alta, è additiva; togliere il backend `persistent` rompe solo il loop di
sviluppo. Codice: `core/rot/budgets.ts`, `core/config/config.ts`,
`agent/runtime.ts`, `agent/tools/fs.ts`, `core/rot/readers.ts`.
