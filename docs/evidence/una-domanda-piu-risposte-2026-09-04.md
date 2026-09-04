# Una domanda, più risposte — 2026-09-04

Caccia mirata a quattro domande (non un censimento): dove la stessa decisione
ha più di un punto che la calcola, e cosa succede il giorno in cui smettono di
essere d'accordo. Metodo: cercare il concetto e i suoi sinonimi, non il nome
della funzione; per ogni luogo trovato, eseguire — non sospettare — se
divergono già; dove non divergono ancora, dire cosa li farebbe divergere.

Sessione partita con un fan-out di quattro sotto-agenti in parallelo: fermato
dal coordinatore a metà, perché agenti concorrenti sullo stesso repository si
contendono la CPU e producono rossi da contesa spacciabili per difetti. Il
resto del lavoro è stato fatto a mano, una domanda alla volta, con la prova
eseguita per ciascuna.

Durante il lavoro `origin/dev` si è mosso (PR #349–#353): una delle due
duplicazioni trovate in `core/turns/store.ts` (la serializzazione di
`messages`) è stata unificata da un altro slice mentre questa sessione era in
corso. Verificato leggendo `origin/dev` direttamente, non a memoria, e il
lavoro ridondante è stato scartato prima del commit — resta descritto qui
sotto come "già chiuso", con la duplicazione gemella (`counters`) che è
rimasta aperta.

## Ordinate per quanto costa lasciarle

### 1. «Che ora è per l'owner?» — divergenza dimostrata e corretta

**La domanda**: quando Muffin scrive un'ora o un fuso destinato all'owner, da
dove lo legge?

**I posti che rispondono**, prima di questa slice:

- `core/scheduler/commitments.ts:324` — commento esplicito: *"The owner's
  timezone, from the sealed root of trust — never the host's."* Legge
  `budgets.quietHours.timezone`.
- `cli/jobs.ts:54` — stesso commento, stessa fonte: *"The owner's timezone
  lives in the root of trust, so '8am' means their 8am."*
- `agent/context/assemble.ts:303` (prima della correzione):
  `const zona = a.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;`
  — e **nessun chiamante di produzione passava `a.timeZone`**: l'unico punto
  di produzione che chiama `ambienteSection` è `agent/loop.ts` (dentro
  `buildContext`, riga 3759 di oggi), e prima di questa slice non passava mai
  `timeZone`. Ogni test di `agent/context/ambiente.test.ts`, invece, passa
  sempre un `timeZone` esplicito — motivo per cui il ramo di default non era
  mai stato eseguito da nessun test contro un fuso reale.

**Prova eseguita** (prima della correzione), con l'host forzato su UTC come
sarebbe una VPS:

```
$ TZ=UTC npx tsx scratch-tz-proof.ts
--- ambienteSection COME LA CHIAMA agent/loop.ts:3736 in produzione (nessun timeZone passato) ---
process TZ: UTC
## Questo turno

- Adesso: venerdì 4 settembre 2026 alle ore 01:59 — UTC, UTC+00:00.
...
--- la stessa funzione, se ricevesse il fuso dell'owner dal RoT sigillato ---
## Questo turno

- Adesso: venerdì 4 settembre 2026 alle ore 03:59 — Europe/Rome, UTC+02:00.
```

Due ore di differenza, stessa `Date`, stessa funzione: la sola differenza è
chi le passa il fuso. `defaults/rot/budgets.json` sigilla `Europe/Rome` per
ogni installazione fresca — lo stesso fuso che una VPS reale, che gira quasi
certamente in UTC o comunque non a Roma, non condivide con l'owner.

**Perché è la domanda più cara delle quattro**: ogni turno mostra "Adesso:
..." al modello nella coda volatile del contesto (`agent/loop.ts:3759`),
proprio per evitare che il modello chieda un permesso `sys.shell` solo per
sapere l'ora (misurato il 28/08/2026, citato in
`agent/todo-wiring.test.ts:301`). Con questa lacuna, il modello riceveva
l'ora della macchina anziché quella dell'owner **ad ogni singolo turno**, in
silenzio — e la stessa informazione, calcolata correttamente due file più in
là (`commitments.ts`, `jobs.ts`), non serviva a niente perché non arrivava
qui.

**Correzione fatta** (meccanica: il dato era già letto, solo non cablato fin
qui):

- `agent/loop.ts:525` — nuovo campo `LoopDeps.timeZone?: string | undefined`.
- `agent/loop.ts:1764` — `buildContext(...)` riceve `deps.timeZone`.
- `agent/loop.ts:3645`/`3759` — `buildContext` inoltra `timeZone` a
  `ambienteSection`.
- `agent/runtime.ts:1012` — `timeZone: budgets.quietHours.timezone` — la
  stessa lettura di `Runtime.quietHours`, nessuna seconda fonte.

**Test di regressione**: `agent/todo-wiring.test.ts:381`, *"il fuso mostrato
al modello è quello sigillato dell'owner, non quello del processo"* — forza
`process.env.TZ = 'Pacific/Kiritimati'` (mai uguale a `Europe/Rome`), fa
girare un turno vero attraverso `buildRuntime`/`runTurn`, e verifica che il
prompt contenga `Europe/Rome` e non `Pacific/Kiritimati`.

Mutazione riportata e presa: rimuovendo `deps.timeZone` dalla chiamata a
`buildContext` (`agent/loop.ts:1764`), il test fallisce così:

```
AssertionError: expected '## Questo turno\n\n- Adesso: venerdì …' to contain 'Europe/Rome'
- Expected
+ Received
- Europe/Rome
+ ## Questo turno
+
+ - Adesso: venerdì 4 settembre 2026 alle ore 16:10 — Pacific/Kiritimati, UTC+14:00.
```

Verificato eseguendo la mutazione e ripristinando subito dopo — non solo
letto.

---

### 2. «Dove scrive un turno?» — un lato già chiuso da un altro slice, un lato ancora aperto

**La domanda**: quando un turno persiste `messages`/`counters` su
`core/turns/store.ts`, quante volte viene scritta la stessa decisione di
serializzazione?

**Stato di `messages` (già risolto, non da questa sessione)**:
`core/turns/store.ts:476` ha oggi `function serializzaMessaggi(messages:
readonly Message[]): string`, unico chiamante di
`insert`/`suspend`/`checkpoint`/`finish`. Questa sessione aveva scritto
autonomamente la stessa identica unificazione (due metodi privati
`serializeMessages`/`serializeCounters` sulla classe) prima di accorgersi,
confrontando `HEAD` con `origin/dev`, che `messages` era già stato risolto da
un altro slice mentre questa sessione era in corso. La parte ridondante è
stata scartata (`git checkout -- core/turns/store.ts`, poi rebase su
`origin/dev`); non è nel commit finale.

**Stato di `counters` (ancora aperto — reperto, non corretto qui)**: la
gemella di `messages` non ha ricevuto lo stesso trattamento. Quattro
scrittori, quattro `JSON.stringify(counters)` indipendenti, oggi:

- `core/turns/store.ts:768` — `insert` (create/enqueue)
- `core/turns/store.ts:840` — `suspend`
- `core/turns/store.ts:951` — `checkpoint`
- `core/turns/store.ts:984` — `finish`

Non divergono ancora — sono quattro `JSON.stringify` letterali sullo stesso
tipo `TurnCounters`. Quello che li farebbe divergere è esattamente la stessa
dinamica che ha giustificato `serializzaMessaggi`: un limite di dimensione,
un campo da ometterebbe per compatibilità con una riga vecchia, o una
migrazione di formato aggiunta a tre copie e dimenticata sulla quarta. Non
corretto qui su indicazione del coordinatore, per non rifare un lavoro già
fatto altrove e per tenere il tempo su domande diverse — ma la porta unica
proposta è meccanica e a basso rischio: una `serializzaContatori(counters:
TurnCounters): string`, stesso stile e stessa posizione di
`serializzaMessaggi` (riga 476), con i quattro call site sostituiti allo
stesso modo.

**Home e workspace (`muffinHome`/`paths`/`resolveWorkspace`/`FsScope`) — già
unificati, nessun reperto**: `core/config/config.ts:336`
(`muffinHome`) e `:340` (`paths`) sono l'unica fonte usata ovunque —
verificato che non esiste, fuori da `core/config/config.ts`, nessuna lettura
grezza di `MUFFIN_HOME` o del letterale `.muffin` in codice di produzione
(le uniche altre occorrenze del letterale sono in `core/config/home-guard.ts`
e `evals/acceptance/harness.ts`, guardie di test che devono *ignorare*
l'override e controllare la casa vera per costruzione, non una seconda
risposta alla stessa domanda). `core/config/workspace.ts:228`
(`resolveWorkspace`) ha un solo chiamante di produzione
(`agent/runtime.ts:320`); l'unico altro luogo che costruisce un `FsScope` con
un `root` diverso (`cli/surface.ts:1093`) risponde a una domanda diversa (la
radice del vault, non lo spazio di lavoro di un turno) — nome simile,
domanda diversa, da lasciare stare. Questa parte della domanda 3 è quindi un
reperto negativo onesto: l'ADR-0059 ha già fatto il lavoro che qui si stava
cercando.

---

### 3. «Chi è l'owner?» — già unificato, un reperto minore non corretto

**La domanda**: chi decide se chi parla è l'owner o un membro, e chi tiene
memoria di questa decisione più avanti nella pipeline?

**Trovato, e già a posto**: `core/surface/types.ts:287` (`identify`) e `:330`
(`tierOf`) sono l'unica fonte usata da `connectors/telegram/connector.ts`,
`connectors/discord/connector.ts` e `agent/loop.ts` — il docstring di
`identify` stesso documenta tre bug reali già chiusi da questa unificazione
("la stanza non è la persona", "spaiato vuol dire nessuno è owner", "un
mittente anonimo non è l'owner"). Non è un reperto: è l'esempio di come
questa classe di difetto va chiusa, già fatto.

`core/policy/decide.ts` ricalcola il tenant di un principal in una funzione
indipendente, `tenantOf` (riga 78), e la usa come **guardia**, non come
seconda fonte silenziosa: riga 140, `if (expected !== null && expected !==
tenant) return { effect: 'deny', code: 'tenant_mismatch', ... }`. Due
computazioni della stessa cosa esistono qui di proposito, e la seconda serve
a far esplodere rumorosamente un disaccordo invece di lasciarlo passare — il
contrario del difetto che questa caccia cerca, non un'istanza.

**Reperto minore, non corretto**: il principal `{ kind: 'owner', connector:
'cli', externalId: 'local' }` è scritto letteralmente in due punti di
produzione — `cli/repl.ts:961` e `cli/run.ts:85` — oltre a decine di file di
test/eval che lo replicano come fixture (normale in questo repository, non
un rischio di produzione). Non diverge oggi; divergerebbe se l'identità CLI
guadagnasse un campo o cambiasse forma domani, perché i due siti di
produzione andrebbero aggiornati a mano in sincronia. Costo di unificare:
basso (una costante esportata accanto a `identify`), valore: basso (due
righe, non quattro come il precedente storico in `core/turns/store.ts`) — non
implementato, segnalato e basta.

---

### 4. «Questo processo è vivo?» — già unificato, migrazione in corso deliberatamente inerte

**La domanda**: chi decide se il pid dietro un lock, una riga `turns`, o il
gateway stesso è ancora vivo?

**Trovato, e già a posto**: `core/lock/durable.ts:131` (`pidAlive`) è l'unica
funzione in tutto il repository che chiama `process.kill(pid, 0)` per un
controllo di liveness — verificato per grep su tutti i `.ts` di produzione,
le uniche altre due chiamate a `process.kill` nel repository sono segnali
reali (`SIGTERM`), non controlli. `heldBy` (riga 152) è la sola funzione che
decide "chi tiene questa riga adesso", ed è condivisa da
`core/gateway/lock.ts`, `core/scheduler/sendlock.ts`,
`core/memory/ingest-lock.ts`, `core/turns/store.ts` e `core/turns/lane.ts` —
tutti importano `pidAlive` da `core/lock/durable.ts`, nessuno lo reimplementa.
Il docstring del file (righe 1–79) documenta un bug reale già chiuso
(P19/P20/P21: la scadenza veniva chiesta prima della liveness, e un holder
vivo ma silenzioso veniva dichiarato morto).

Il socket di controllo (`core/gateway/control-socket.ts:25`) dichiara
esplicitamente **v1 è sola osservazione**: due verbi (`identify`, `status`)
che non cambiano niente, e `readGateway` (la vera fonte di liveness oggi) non
lo consulta ancora. Verificato che nessun consumatore di produzione legge dal
socket per decidere la liveness (`cli/gateway.ts` lo serve e basta, e legge
lo stato sempre da `readGateway(db)`). Non c'è quindi, oggi, una seconda
risposta alla domanda: la migrazione è deliberatamente a un solo verso, e
questo è precisamente ciò che la rende sicura. **Cosa la farebbe divergere**:
il giorno in cui un client comincia a trattare "il socket risponde" come
prova di vita indipendente da `readGateway`/`pidAlive` — un file di socket
rimasto da un processo morto, o un bind fallito su un percorso stantio,
darebbero una risposta diversa da quella del lock durevole esattamente
intorno a un crash, il momento in cui la risposta conta di più.

---

## Domande poste senza reperto sfruttabile

- **«Questo host/canale è permesso?»** — non approfondita oltre `allowHosts`
  (territorio già assegnato altrove).
- **«Il budget è esaurito?» / «Questa azione richiede approvazione?»** — non
  perseguite in questa sessione: il coordinatore ha ristretto il perimetro a
  quattro domande prima che venissero aperte, per tenere la caccia su prove
  complete invece che su copertura.
- **Costanti duplicate a mano in generale** (limiti di segmentazione
  Telegram/Discord, soglie magiche) — non cercate in questa sessione per lo
  stesso motivo.

## Verifica eseguibile

```
$ npx tsc --noEmit -p tsconfig.json
(exit 0)

$ npx vitest run
 Test Files  249 passed (249)
      Tests  3185 passed | 3 skipped (3188)
```

Un primo giro della suite completa ha riportato un timeout del worker su
`cli/gateway.test.ts` (`[vitest-worker]: Timeout calling "onTaskUpdate"`) —
rosso da contesa di macchina, non un'asserzione fallita. Rilanciato una
volta: verde, numeri sopra.

`npm run mappa:regen` eseguito dopo le modifiche a `agent/loop.ts` e
`agent/runtime.ts` (le ancore della mappa citavano righe che si sono
spostate); `docs/derived/architecture-map/mappa.test.ts` verde dopo la
rigenerazione.

Albero pulito a fine sessione: solo le modifiche descritte sopra, nessun
processo di test lasciato in esecuzione (nessun processo a lunga vita è
stato avviato da questa sessione — solo `vitest run`, che termina da solo).
