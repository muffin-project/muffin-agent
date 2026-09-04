# ADR-0070 — Le impostazioni si cambiano da un comando, mai dal modello

**Stato:** accettato · 2026-09-04 · direzione owner

## Contesto

ADR-0036 aveva reso `muffin config` di sola lettura *apposta*, e l'aveva detto
in modo da non lasciare dubbi: *«Nessuna superficie di scrittura conversazionale
viene costruita prima che il tetto sia sigillato per davvero»*. Quella
precondizione si è sciolta con l'emendamento ADR-0039 — `BudgetEngine` legge
`rot/budgets.json`, non più una copia in `config.json` — e l'owner ha chiesto
la superficie che ADR-0036 stessa anticipava: *«le impostazioni le possiamo
mettere solo tramite json, dovremo avere un /settings»*.

Con un vincolo esplicito, anche lui testuale: *«il modello non deve poter
cambiare le impostazioni»*. E una regola generale che precede entrambe le ADR:
*«non credo basti mai un solo modo di fare le cose, una funzione ma chiamata
da diversi posti no?»* — la stessa che ha prodotto `muffin surface default`
(porta unica: CLI) e `promptVersion`/`cmdPromptVersion` (porta doppia:
`muffin prompt version` più — non ancora — una conversazionale).

## La domanda che andava eseguita, non letta

*«Un comando di superficie arriva come messaggio dell'owner o come azione del
modello? Chi lo autentica?»* — verificato leggendo il percorso reale, non la
prosa:

- `connectors/telegram/connector.ts`'s `resolve()`: *"Un comando non crea mai
  un turno — non chiama il modello, non costa niente, e legarlo a un turno
  vorrebbe dire farlo passare da tutta la macchina di ripresa e consegna
  costruita per una risposta che non arriverà."* Un comando come `/model` o
  `/think` è intercettato **prima** che un turno esista — non c'è un punto in
  cui il modello decide di eseguirlo, perché il modello non viene nemmeno
  interrogato.
- `tryCommand`, la stessa classe: *"Solo l'owner. Questi comandi toccano la
  config e il conto… non si risponde nemmeno «non sei autorizzato»… il testo
  prosegue verso il modello come una frase qualunque."* — `if
  (principal.kind !== 'owner') return false;`, e `principal` viene da
  `identify()` (`core/surface/types.ts`), che confronta l'id reale della
  piattaforma con `ownerUserId` configurato, mai il contenuto del messaggio.
- Il REPL non passa da `identify()` affatto: gira sulla macchina dell'owner,
  ed è owner per costruzione (`cli/repl.ts` passa sempre `tenant: 'host'`,
  come `OWNER_SESSION_KEY` documenta).
- Discord (`connectors/discord/connector.ts`) **non ha nessun livello di
  comandi**: grep negativo su `sembraComando`/`eseguiComando`/`comandi` in
  tutto il file. È un relay di messaggi puro verso il loop.

Quindi: un comando `/qualcosa` a Telegram o al REPL non è mai un'azione del
modello. È un ramo deterministico, sincrono, verificato per identità reale
prima ancora che un turno possa esistere. `/model` e `/think` scrivono già
`config.json` da questo stesso percorso, oggi, senza alcuna `CapabilityDecl` —
non è una scappatoia trovata per questa slice, è il precedente su cui questa
slice si appoggia.

## Decisione

**Una funzione sola, tre porte, nessuna capability.**

### 1. La funzione: `core/config/settings.ts::setConfigKnob`

Valida la chiave contro un elenco piccolo e dichiarato, valida il valore,
scrive con `saveConfig`, e ritorna un verdetto — mai una stringa già
formattata per un terminale (stessa forma di `DeliveryOutcome`,
`core/surface/types.ts`). `formatSetOutcome` produce il testo, una volta sola:
ogni porta stampa esattamente quella riga.

Vive in `core/` — non in `cli/` né in `agent/` — per la stessa ragione che
tiene `listConfigKnobs` lì (ADR-0036, emendamento): `agent/comandi.ts` non
deve mai importare da `cli/` (lo dice il suo stesso commento su `muffin
model`, iniettato invece che importato), e `core/` è l'unico punto che sia
`cli/config.ts` sia `agent/comandi.ts` possono raggiungere senza quella
dipendenza sbagliata.

### 2. Le tre porte

- **CLI**: `muffin config set <chiave> <valore>` (`cli/config.ts::cmdConfigSet`).
- **REPL**: `/config set <chiave> <valore>`, nuovo `case` in
  `agent/comandi.ts::eseguiComando` — la stessa funzione che già possiede
  `/model` e `/think`.
- **Telegram**: la stessa `case` sopra, raggiunta attraverso il percorso che
  Telegram condivide da sempre con il REPL (`deps.comandi` →
  `eseguiComando`), owner-only per costruzione (§sopra).

**Discord resta fuori, dichiarato.** Non per una restrizione su `/config`:
per l'assenza totale del livello comandi su quel connector. Costruirlo per
questa sola manopola vorrebbe dire replicare da zero il gate `tryCommand`
possiede — l'owner-check via `identify()`, il "un comando non crea mai un
turno" — per un connector la cui stessa nota di scope dice *"a second real
surface, not a second chat platform's full feature set"*. Lavoro sproporzionato
per questa slice; se Discord acquisisce un livello comandi proprio, `/config`
lo eredita per costruzione, come `/model` lo erediterebbe.

### 3. Perché questo non passa dal kernel

ADR-0055 ha reso `reply` e `memory.write` capability del kernel *perché sono
atti che il turno compie da solo* — un turno già in corso, con un taint da
decidere prima che il testo esca. La riga di effetto `config`
(`core/policy/matrix.ts`, `askAbove: 0, denyAbove: 1`, *"ALLOW solo via
ratchet-API"*) esiste per la stessa classe di cosa: una futura capability che
il *modello* potrebbe invocare in conversazione, gated da taint, con
un'`ask` per l'owner sopra la soglia. Quella superficie — quella che ADR-0036
chiama *"Muffin lo può guidare e scrivere"* — non è quella che questa slice
costruisce, ed è deliberato: costruirla vorrebbe dire registrare un tool che
il modello può chiamare, che è esattamente il passo che l'owner ha chiesto di
non fare (*"il modello non deve poter cambiare le impostazioni"*).

Un comando `/config` non crea un turno, quindi il modello non ha mai
l'occasione di scegliere di chiamarlo: non c'è una `CapabilityDecl` da
dichiarare perché non c'è una decisione del modello da presidiare. Registrarne
una comunque sarebbe peggio, non meglio — significherebbe esporre `config.set`
come un tool reale, il rischio che questo intero design esiste per evitare.

La riga `config` della matrice resta esattamente come ADR-0053 l'ha lasciata:
riservata, non ancora posseduta da nessuna dichiarazione — vera oggi come lo
era ieri, e questa slice non la tocca.

### 4. Le chiavi: piccolo insieme, motivato una per una

Escluse per direttiva esplicita dell'owner: **`rot.mode`** (postura di
sicurezza, si legge `docs/SECURITY.md` prima di girarla, non un comando di
corsa), **i provider** (`provider.*`, incluso `provider.routing` —
instradamento e `dataCollection` sono scelte lette una volta, non un
termostato), **i segreti** (`*.apiKeyRef`: restano `muffin secret set`, da
stdin, mai da un argomento di comando).

Escluso anche tutto ciò che ha **già** una porta dedicata — includerlo qui
sarebbe la divergenza esatta che questa casa vieta: `models.*` (→ `muffin
model`/`/model`), `thinking` (→ `/think`), `surfaces.default` (→ `muffin
surface default`), `prompt.version` (→ `muffin prompt version`).

Quello che resta, e che oggi non ha **nessuna** porta:

- **`traces.retentionDays`** — quanti giorni tenere le tracce dei turni prima
  che `agent/runtime.ts`'s `pruneOlderThan` le ripulisca. Un numero di
  manutenzione, letto da `cli/doctor.ts` e mai scritto da nessun comando.
- **`search.maxResults`** — quanti risultati chiedere a ogni ricerca web
  (1–20, lo stesso vincolo dello schema). Tocca solo il numero: se
  `config.search` non esiste ancora, il comando rifiuta con la frase che
  spiega perché (provider e chiave restano fuori da qui), invece di costruire
  l'oggetto intero al posto dell'owner.

## Alternative scartate

**Un tool `config.set` gated da `ask` sopra taint 0.** È la forma che la riga
`config` della matrice descrive già e che ADR-0036 immagina per il futuro.
Scartata per questa slice perché è esattamente ciò che l'owner ha escluso: un
percorso, per quanto gated, in cui il modello *decide* di proporre una
scrittura. Il giorno in cui l'owner vorrà "Muffin regola le impostazioni
conversando", quella riga della matrice è già lì ad aspettare — e questa ADR
non la invalida, la lascia intonsa.

**Riusare `listConfigKnobs`/`ConfigKnob` per generare anche le chiavi
scrivibili.** Quell'elenco include file sigillati e segreti risolti — è
esplicitamente "ogni manopola", non "quelle scrivibili". Un secondo filtro
sopra quell'elenco sarebbe stato più fragile del piccolo elenco dichiarato a
mano in `settings.ts`, che è già l'unico posto che deve restare corto e
motivato.

**Costruire il livello comandi su Discord per questa slice.** Vedi §2 sopra:
lavoro sproporzionato per una manopola, quando la nota di scope del connector
dice già che non è quell'obiettivo.

## Conseguenze

- `muffin config` resta di sola lettura per la lista; `set` è l'unica
  eccezione, ed è un'eccezione piccola e nominata, non un varco.
- Una chiave nuova entra in un solo posto (`KNOBS` in `settings.ts`) e le tre
  porte la vedono lo stesso giorno — nessuna copia da tenere sincronizzata.
- Il modello non ha, e non guadagna da questa slice, nessun modo di invocare
  `setConfigKnob`: non è un tool, non è una capability, non è raggiungibile da
  un turno. `core/policy/effect-rows.test.ts`'s enumerazione `ALL` (ogni
  `CapabilityDecl` spedita) non contiene, e con questa slice continua a non
  contenere, nessuna dichiarazione sulla riga `config`.
- `muffin gateway restart` (stessa PR, deliberatamente non una ADR separata:
  è riuso puro di `cli/update.ts`'s `restartCommand`/`waitForGatewayPid`/
  `restartVerdict`, zero decisione nuova) chiude il "due comandi ogni volta"
  che l'owner ha nominato, verificando lo stato del supervisore dopo, mai
  l'exit code del comando che lo tocca — la stessa regola di casa che
  `restartVerdict` già impone a `muffin update`.

## Come si falsifica

- `core/config/settings.test.ts`: ogni chiave esclusa (`provider.*`,
  `rot.mode`, `*.apiKeyRef`, una chiave che non esiste) risponde `ok: false`
  con una ragione che nomina l'alternativa; ogni chiave inclusa fa un
  giro reale (scrivi, rileggi da un `loadConfig` fresco, verifica il valore).
- Una mutazione bersaglio: rompere UNA delle tre porte così che smetta di
  chiamare `setConfigKnob` (es. `cmdConfigSet` che scrive `saveConfig`
  direttamente) fa cadere un'asserzione di equivalenza fra porte dedicata,
  distinta da ciascun test per-porta — quella e non le altre, perché solo
  quella confronta il risultato letterale delle tre chiamate fra loro.
- Un test dedicato asserisce che nessuna `CapabilityDecl` fra quelle spedite
  in `agent/tools/*` dichiara `effect: 'config'` — l'affermazione "il modello
  non può" letta dall'enumerazione che il kernel stesso usa per decidere, non
  dalla prosa di questa ADR.
- `muffin gateway restart` sul binario compilato, in una home usa-e-getta
  senza supervisore installato: esce diverso da zero e nomina il rimedio
  (`muffin gateway install`), mai un tentativo silenzioso di riavviare niente.
