# Il modello di reversibilità — quattro classi sopra un kernel che ne legge una

```
scritto: 2026-08-15
verificato: 2026-08-15
verificato-contro: muffin-agent @ 947b076 (origin/dev) · M5-BIS.md @ origin/slice/m5bis-piano · PRACTICES.md §13 @ origin/slice/gateway ee186dd · node v22.22.2 · git 2.50.1
modello-strumenti: Opus 5 via Claude Code — repo letto in loco in un worktree su origin/dev, grep ed espansione riga-per-riga sui file citati. Il runtime NON è stato eseguito; nessun `~/.muffin` reale è stato aperto; nessun trace è stato letto.
invaliderebbe: una seconda `CapabilityDecl` di produzione con `reversible: 'undoable'`; un secondo consumatore di `Decision` oltre `runTool`; `deps.approve` cablato su una superficie diversa dal REPL; o `mcpCapabilityFor` che diventa per-tool invece che per-server
estende: research/confronto-gemini.md §19 · research/inventario-vecchio-nuovo.md · docs/blueprint/M5-BIS.md §1
```

**Domanda dell'owner**: *«non lo risolverei semplicemente facendo `fs.write → ASK`
senza prima ragionare sul modello di reversibilità. Perché Muffin deve poter fare
cose reali. Se ogni operazione potenzialmente distruttiva diventa "vuoi che
scriva questo file?" ogni cinque minuti, l'agente diventa inutilizzabile.»*
Quattro classi, non due, e coerenti col modello di policy — non una patch a
`fs.write`.

**Come leggere le etichette.** ⬤ **misurato** in questa passata, col comando o il
`file:riga` che lo produce. ◐ **letto sulla fonte primaria** (un documento
normativo di questo repo, un ADR). ○ **riportato**, non ri-verificato qui. La
sezione «Cosa non si è potuto stabilire» è parte del risultato.

---

## Bottom line

1. **Le quattro classi mappano sui quattro esiti esistenti, uno a uno. Non serve
   un quinto esito, e aggiungerlo sarebbe pericoloso** ⬤: `runTool` gestisce gli
   effetti con una catena di `if` che **cade sull'esecuzione del tool**
   (`agent/loop.ts:649,662,673`, poi `:699`). Un esito nuovo che nessuno
   intercetta *esegue*. Al contrario `switch (decl.risk)` (`decide.ts:201`) non
   ha `default` e ritorna in ogni ramo: arricchire l'**input** rompe la build,
   arricchire l'**output** rompe il silenzio. Si arricchisce l'input.

2. **Il buco non è `fs.write`, ed è più grande di `fs.write`** ⬤. Il kernel legge
   `decl.reversible` in **un solo punto**, `decide.ts:205`, e **solo dentro
   `case 'medium'`**. Quindi `reversible: 'no'` — letteralmente «irreversibile» —
   produce `allow`. `mcpCapabilityFor` dichiara `risk: 'medium'` +
   `reversible: 'no'` (`agent/tools/mcp.ts:32-34`) ed è cablata in produzione
   (`cli/repl.ts:48`, `cli/run.ts:47`). **Oggi una scrittura irreversibile su un
   server di terze parti passa in silenzio, mentre una scrittura su file
   annullabile è rifiutata.** La classe che il kernel tratta peggio è quella
   sbagliata.

3. **La classe è per-chiamata, non per-capability — e il kernel deve restare
   puro** ⬤. `core/policy/decide.ts` **non nomina mai `args`** (`grep -n "args"`
   → zero righe; la destrutturazione a `decide.ts:93` lo omette). «Il file
   esiste» è I/O, e `Decide` è dichiarata pura e sincrona (`types.ts:95-98`,
   `09-contratti §1`). La forma coerente: **il chiamante osserva, il kernel
   giudica, e l'assenza dell'osservazione vale la classe peggiore** — esattamente
   il rimedio già scritto per l'allowlist egress a `decide.ts:171-177`.

4. **La forma minima dell'undo è la copia-prima-di-scrivere, non un giornale.**
   Il kernel dichiara già `windowSeconds: 300` (`decide.ts:206`): per annullare
   dentro cinque minuti bastano i byte precedenti di **un** path. Contro il
   registro generico c'è il numero: `undo_log` **zero righe in quattro mesi**
   (`04-roadmap.md:250`) ◐. Contro git-sul-vault c'è la topologia: **lo scope di
   scrittura è `cwd`, non il vault** (`agent/runtime.ts:172`) ⬤.

5. **Fuori dal vault non cambia niente, ed è il pregio della forma scelta** ⬤.
   Un sidecar si aggancia a un path risolto; git ha bisogno di una radice di
   repo. Ma l'ordine dentro `runTool` va invertito: oggi si **decide** a
   `loop.ts:642` e si **risolve** dentro l'handler a `fs.ts:231`. Il kernel
   giudica una stringa che `resolveInScope` non ha ancora visto.

6. **Il vincolo «niente record, niente scrittura» va in `fsWrite`, non nel
   loop** ⬤. `agent/tools/fs.ts:233` è **l'unico `writeFileSync` raggiungibile da
   una capability**; tutti gli altri sono CLI, RoT o config. Il sink dell'undo
   diventa un parametro **obbligatorio** di `fsWrite`: un chiamante senza sink
   non compila.

---

# Parte concettuale

## Perché la scorciatoia è peggio di quanto sembri, e non per il motivo previsto

L'owner rifiuta `fs.write → ASK` perché produrrebbe una domanda ogni cinque
minuti. C'è una seconda ragione, misurata, che rafforza la sua: **`ask` non è
disponibile ovunque.** `deps.approve` è cablato in un solo posto, `cli/repl.ts:67`
⬤. Su ogni altra superficie — `muffin run` headless, Telegram — un `ask` solleva
`ApprovalRequired` (`loop.ts:683`) e **il turno si ferma** con `stopped: 'ask'`
(`loop.ts:519-528`).

Quindi `fs.write → ASK` non renderebbe l'agente fastidioso: lo renderebbe
**incapace di scrivere un file da Telegram e in headless**, cioè esattamente
nelle due superfici da cui l'owner userebbe Muffin mentre non è al terminale. La
scorciatoia non è un compromesso peggiore, è una regressione di capacità. Il
promemoria in memoria — *mai dietro al vecchio Muffin* — si applica qui alla
lettera.

## Il buco vero: il kernel tratta «irreversibile» meglio di «annullabile»

Questa è la scoperta che riordina tutto il resto, e sta in cinque righe di
codice. `decide.ts:201-214`:

- `risk: 'low'` → `allow`, e `reversible` non viene letto.
- `risk: 'medium'` → **l'unico punto in cui `reversible` conta**: `'undoable'`
  dà `draft`, `'yes'` e `'no'` danno entrambi `allow`.
- `risk: 'high'` → `ask` (o `allow` in hardened, owner, taint 0), e `reversible`
  non viene letto.

Il campo che porta il nome esatto del concetto che l'owner sta chiedendo è
**decorativo in tre rami su cinque**, e nel ramo dove conta distingue solo il
valore *migliore* dei tre. La conseguenza è che `mcp.*` — `medium` + `no`,
`agent/tools/mcp.ts:32-34`, in produzione da `cli/repl.ts:48` — **esegue in
silenzio** un'azione dichiarata irreversibile su un server di terze parti, mentre
`fs.write`, dichiarata annullabile, è l'unica cosa che il loop rifiuta.

Non è una svista da correggere di passaggio: è la prova che il modello a quattro
classi non è un raffinamento estetico. Il kernel oggi ne conosce **una** —
«annullabile a rischio medio» — e tratta tutto il resto come rischio.

E c'è la quarta classe, che non ha nemmeno un'istanza: **`outward.send` non è
dichiarata in nessun punto del codice di produzione** ⬤. Compare solo nelle
deny-list (`matrix.ts:63,99`) e in due commenti (`decide.ts:169`, `loop.ts:733`).
Una capability non dichiarata è `deny/no_capability` (`decide.ts:97`), quindi il
comportamento *oggi* è chiuso e corretto — ma la classe «irreversibile verso
l'esterno» è progettata contro una capability che non esiste ancora. Va tenuto a
mente quando si sceglie la forma: si sta scrivendo il contratto che quella
capability dovrà rispettare quando arriverà, non si sta riparando un difetto.

## 1. Le quattro classi mappano sui quattro esiti, o servono esiti nuovi?

**Mappano, uno a uno, senza residuo.**

| Classe dell'owner | Esito del kernel | Esiste già |
|---|---|---|
| reversibile → si esegue | `allow` | sì |
| reversibile ma potenzialmente distruttivo → policy/undo | `draft` (porta già `undo: {capability, windowSeconds}`) | sì, mai eseguito |
| irreversibile → ASK | `ask` | sì |
| irreversibile verso l'esterno → ASK o vietato | `ask` **o** `deny`, scelti dal contesto | sì, e con un precedente |

L'ultima riga merita la nota, perché è quella che sembrerebbe chiedere un esito
nuovo e non lo chiede. Il kernel fa **già** «ask oppure deny a seconda del
contesto» per l'egress, a `decide.ts:184-192`: fuori allowlist, se il principal è
l'owner e il taint è ≤1 si chiede; altrimenti si nega, con la ragione scritta
nel commento — un contesto avvelenato non deve poter *nominare* la destinazione.
La quarta classe ha già la sua forma implementata su un'altra capability.

**Pro di non aggiungere esiti.** Il costo di aggiungerne uno è misurabile e
brutto. `runTool` intercetta gli effetti con tre `if` in sequenza —
`deny` (`loop.ts:649`), `draft` (`:662`), `ask` (`:673`) — e poi **cade
sull'esecuzione del tool** a `loop.ts:698-699`. Non c'è `switch` esaustivo, non
c'è `default`, non c'è un `never`. Un quinto valore di `Decision['effect']`
aggiunto oggi verrebbe compilato senza un errore e **eseguirebbe il tool**. È la
famiglia «dichiarato e non connesso» nella sua forma più cara, perché il ramo
scoperto non è inerte: agisce.

Il verso opposto è protetto per costruzione: `switch (decl.risk)`
(`decide.ts:201`) copre i tre valori e **ritorna in ogni arm**, senza `default`.
Un quarto valore di `RiskClass` rompe la build. Stessa cosa per `Reversibility`,
se e quando il kernel farà uno `switch` su di essa invece del confronto singolo
di oggi.

**Contro.** Riusare `draft` per «reversibile ma potenzialmente distruttivo»
significa che una sola parola porta due carichi: *l'azione avviene, e ne esiste
il rovescio*. Chi legge `draft` in un trace legge una bozza, cioè qualcosa che
**non** è avvenuto — e in `09-contratti §8` è descritto come «tipizzato ma non
esercitato». La parola è già ambigua prima di caricarla. Il rischio è quello di
STE 1.11 nella sua forma nota a questo repo: `origin` non si chiama
`source_kind` perché quel nome era già preso due file più in là.

**Raccomandazione.** **Nessun esito nuovo.** Si arricchisce l'input in due mosse:

1. `reversible` diventa portante in **tutti e tre** i rami di rischio, non solo
   in `medium`. In particolare `'no'` smette di collassare su `'yes'`.
2. La quarta classe entra come **campo separato** sulla dichiarazione
   (`outward: boolean`), non come quarto valore di `Reversibility`.

Il perché della mossa 2, contro la lettura letterale delle «quattro classi». Le
classi dell'owner sono quattro *nell'elenco*, ma gli assi sono **due**:
reversibilità e direzione. Un messaggio che si può cancellare è reversibile *e*
verso l'esterno; una `DROP TABLE` locale è irreversibile *e* interna. Collassare
i due assi in un enum funziona finché nessuna capability occupa la casella
«reversibile e outward» — e la prima che ci arriva obbliga a ritagliare l'enum,
cioè a rinominare i valori di un campo che il kernel legge. Due campi costano una
riga in più e non hanno quel modo di fallire.

E una nota di sequenza, perché è la differenza fra una raccomandazione e una
trappola: **chiudere il buco `medium`+`no` e spezzare `mcp.*` per-tool sono una
sola slice, non due.** Chiudere il buco da solo manda a `ask` *ogni* chiamata
MCP, perché `mcpCapabilityFor` dichiara una classe per l'intero server
(`agent/tools/mcp.ts:30-39`) — e con `approve` sul solo REPL, su Telegram e in
headless significa fermare il turno. Spezzare da solo lascia il buco aperto. La
buona notizia pratica è che **`fs.write` non aspetta niente di tutto questo**:
è `undoable`, sta nell'unico ramo che il kernel già legge, e il lavoro sull'undo
è indipendente dal lavoro su `no`.

## 2. Chi decide la classe: la dichiarazione o l'argomento?

Prima il fatto, perché la domanda lo dava per verificare. **Il kernel non legge
`args`, e non in parte: proprio non li nomina.** `grep -n "args" core/policy/decide.ts`
non restituisce **nessuna riga** ⬤. La destrutturazione a `decide.ts:93` è
`const { principal, tenant, capability, resource, taint } = req;` — `args` è
nella `DecisionRequest` (`types.ts:68`) e resta lì.

`policyArgs` invece **è** letto, ma dal chiamante, non dal kernel: `resourceFor`
(`agent/loop.ts:742-756`) lo usa per sollevare la risorsa dagli argomenti. Il
campo esiste, ha un lettore, e il lettore è dalla parte sbagliata del confine.

**Opzione A — statica, come oggi, spezzando la capability.** `fs.write` diventa
due capability: una che crea, una che sovrascrive.

- *Pro*: il kernel non cambia di una riga. Resta puro, sincrono, totale. Nessun
  campo nuovo, nessuna chiave di memoizzazione da rivedere.
- *Contro, ed è dirimente*: **è il modello a scegliere quale tool chiamare**.
  Il gate verrebbe armato dalla parte che il gate deve contenere. Il repo ha già
  pagato questa forma una volta e la lezione è scritta a `decide.ts:158-177`: la
  branch egress firava su `resource.kind === 'url'`, e `http_get({url, path:'x'})`
  produceva una risorsa `path`, saltava l'allowlist e recuperava un host fuori
  lista per un membro a taint 2. Lì il chiamante era il loop. Qui sarebbe il
  modello, che è peggio di un grado.
- Secondo contro: due capability dove il threat model ne descrive una moltiplica
  la matrice, e ADR-0003 §5 chiede una riga di giustificazione per ogni aggiunta
  al RoT proprio per impedire questa deriva.

**Opzione B — il kernel legge `args` e stabilisce da sé se il file esiste.**

- *Pro*: un solo punto di decisione, il chiamante non partecipa.
- *Contro*: **non è implementabile senza rompere il contratto del kernel.**
  «Il file esiste» è uno `statSync`. `Decide` è dichiarata *"Synchronous and
  pure: no I/O, no network, no await"* (`types.ts:95-98`) e `09-contratti §1`
  ripete *"SINCRONA e pura (A7)"* con la ragione: una decisione dev'essere
  spiegabile da uno snapshot, mai da ciò che stava su disco nel microsecondo in
  cui è girata. Sacrificare quella proprietà per una classe di reversibilità è
  un cambio di natura del kernel, non un'estensione.

**Opzione C — il chiamante osserva, il kernel giudica, l'assenza vale la classe
peggiore.**

La `DecisionRequest` guadagna **un'osservazione, non un verdetto**: qualcosa come
`target: { state: 'absent' | 'present'; bytes: number }`, e `undefined` che
significa «non l'ho guardato» e vale come `present`.

- *Pro*: il kernel resta puro, sincrono e totale. Il fatto è calcolato una volta
  sola, dal codice che poi farà la scrittura, quindi non c'è una seconda copia
  che possa divergere — è la stessa ragione per cui `resourceFor` ha sostituito
  il chain hardcoded (`loop.ts:725-741`). Ed è **monotono** nel senso di
  ADR-0013: l'assenza dell'informazione stringe, non allarga, quindi un
  chiamante che dimentica ottiene il rifiuto, che è il modo di fallire che si
  nota.
- *Contro numero uno, misurato*: **la chiave di memoizzazione non basta più.**
  `makeSnapshot` cachea su `` `${capability}:${resource.kind}:${value}:${taint}` ``
  (`loop.ts:825`) ⬤. Per `fs.write` il path *è* il valore della risorsa, quindi
  la chiave discrimina per file — ma **non** per «il file esiste», e
  l'esistenza cambia *dentro il turno*: l'agente crea `note.md` alla chiamata 3
  e lo riscrive alla chiamata 7. Un `allow` memoizzato da «non esisteva»
  sopravviverebbe alla condizione che lo ha prodotto. È esattamente la classe di
  problema per cui `invalidate()` esiste già, e il commento a `types.ts:110-115`
  nomina il budget come l'altro input che cambia a metà turno. Il rimedio è
  scritto lì: o l'osservazione entra nella chiave, o `check` non memoizza le
  capability che la usano.
- *Contro numero due, e vale più del primo*: **obbliga a invertire l'ordine
  dentro `runTool`.** Oggi si decide a `loop.ts:642` e si risolve dentro
  l'handler, `fs.ts:231`. Per osservare lo stato del target bisogna prima sapere
  *quale* target, cioè far girare `resolveInScope` prima della decisione. È una
  riorganizzazione vera del percorso, non un campo in più.

**Raccomandazione.** **Opzione C**, con l'inversione dichiarata come parte del
lavoro e non come effetto collaterale. E vale la pena notare che l'inversione
è la forma che l'owner ha chiesto: `READ → IL MODELLO DECIDE → WRITE → UNDO
RECORD → EXECUTE → TRACE`. La `READ` iniziale non è quella del modello: è quella
del runtime, che guarda il target prima di lasciar giudicare il kernel.

C'è un difetto latente che questa opzione **sveglia**, e va nominato adesso
perché è il costo nascosto più grosso dell'intero disegno. `types.ts:41` dichiara
che una risorsa `path` è *"absolute, normalized, symlinks resolved"*, e
`09-contratti §1` ripete *"assoluto, già normalizzato (no '..', symlink risolti)"*.
`resourceFor` (`loop.ts:749-752`) passa al kernel **la stringa grezza degli
argomenti**, e lo schema del tool la documenta come *"Path relative to the
working directory"* (`fs.ts:88`) ⬤. Oggi non costa nulla, perché il kernel usa
`resource.value` di tipo `path` **solo** per comporre il testo dell'`ask`
(`decide.ts:213`, `describe`). Nel momento in cui la classe dipende dal path, il
kernel giudicherebbe una stringa che `resolveInScope` non ha ancora visto: `..`,
symlink e hard link entrerebbero nella decisione prima di essere risolti. L'ordine
`resolve → observe → decide → write` **chiude anche questo**, ed è la ragione
migliore per pagarlo.

## 3. La forma minima dell'undo che sblocca `fs.write` questa settimana

Il vincolo che governa la scelta è già nel kernel e non va inventato:
`windowSeconds: 300` (`decide.ts:206`). Per annullare dentro cinque minuti serve
**una** cosa: i byte precedenti di **un** path. Tutto ciò che è più generale di
questo sta rispondendo a una domanda che nessuno ha ancora fatto.

**Candidata 1 — registro staged-pending / giornale generico di undo.**
È il disegno di Hermes, ripreso da `confronto-harness.md §9` punto 4 e citato da
ADR-0035.

- *Pro*: copre in anticipo tutte le capability future, non solo `fs.write`.
  Sopravvive al riavvio. È il posto naturale anche per la scrittura di memoria
  «propose-only» che ADR-0032 lascia aperta.
- *Contro*: è il numero che l'owner ha messo nel mandato. `undo_log` **zero
  righe in quattro mesi** col tier act-notify-undo **acceso di default**
  (`04-roadmap.md:250`, `inventario-vecchio-nuovo.md:212-213`) ◐ — verdetto
  dell'inventario: *«ERA SLOP»*. E il secondo contro è di tempistica: un registro
  staged-pending risponde a *«questa scrittura aspetta una revisione»*, che non è
  la domanda di questa settimana. La domanda di questa settimana è *«rimetti i
  byte di prima»*.
- *Contro terzo*: costruirlo per primo è, alla lettera, il rischio che ADR-0035
  nomina — *«costruire il registro non basta; va costruito il caso d'uso che lo
  riempie»*.

**Candidata 2 — git sul vault.** È la proposta di Gemini, riportata a
`confronto-gemini.md §19`: *"ogni modifica nel Vault passa per un Internal
Versioning System"*, così che «annulla l'ultima azione» sia un `git revert`.

- *Pro reali, e sono due.* Primo: **il vault è già compatibile.** `SKIP_DIRS`
  (`core/vault/vault.ts:36`) contiene `.git` e `.trash` e viene applicato al
  walk (`vault.ts:129`) ⬤ — un repo dentro il vault non finirebbe nell'indice.
  Secondo: il verdetto di §19 nota che darebbe a `muffin vault check` la capacità
  di dire non solo *«disco e indice divergono»* ma *«ecco cosa è cambiato»*.
- *Contro, ed è topologico e decisivo*: **il vault non è dove si scrive.**
  `agent/runtime.ts:172` fissa `root: cwd`; il vault è `~/.muffin/vault`
  (`config.ts:112`). Sono due sottoalberi diversi, e durante i quattordici giorni
  l'owner lavora in `$CWD`. Git-sul-vault proteggerebbe una cartella in cui
  l'agente per lo più non scrive, lasciando scoperta quella in cui scrive.
- *Contro secondo*: dove l'agente **scrive** davvero — una directory di progetto —
  un repo esiste già ed è dell'owner. Commit dell'agente dentro quel repo
  mescolano il suo lavoro col nostro nello strumento che l'owner usa proprio per
  distinguerli. Un secondo repo annidato è peggio.
- *Contro terzo*: git è una dipendenza esterna al processo. `doctor` dovrebbe
  provarlo eseguendolo, con la stessa disciplina del probe del sandbox
  (`09-contratti §6`: *«il check del sandbox esegue, non cerca»*), e un
  meccanismo di reversibilità che non parte su una macchina è un meccanismo che
  degrada in silenzio.

**Candidata 3 — `.trash` e rename invece di sovrascrittura.**

- *Pro*: costo O(1), nessuna copia dei byte.
- *Contro*: il rename cambia l'inode. Editor aperti, watcher, `tail -f` e ogni
  hard link al file vedono qualcosa che non è più lo stesso file — e
  `resolveInScope` rifiuta già i file multi-link proprio perché quella identità
  conta (`fs.ts:182-187`). E non copre il caso più comune: una riscrittura che
  cambia una parte del file, dove il «cestino» conterrebbe il documento buono e
  il posto giusto quello nuovo.

**Candidata 4 — copia-prima-di-scrivere in `~/.muffin/undo/`.** Prima della
scrittura si copiano i byte esistenti in un sidecar, si scrive una riga di record
(path risolto, sha del prima, byte, capability, trace id, istante), poi si scrive.

- *Pro*: è esattamente ciò che la finestra dichiarata di 300 secondi può
  ripristinare, niente di più. Non introduce un sottosistema: la cartella sta
  accanto a `traces/` e `sessions/` (`config.ts:113-114`) e può avere la stessa
  retention già applicata al boot e alla rotazione (`09-contratti §9`, B7).
  Funziona identica dentro e fuori dal vault perché si aggancia a un path, non a
  una radice di repo. E il caso «creazione» ha un record naturale: *questo file
  non esisteva*, il cui rovescio è una cancellazione di ciò che l'agente stesso
  ha creato — che non è una riga di dati dell'owner, quindi non collide con
  «mai cancellare righe».
- *Contro onesto*: **è un giornale**, e in questa casa i giornali non si leggono.
  La differenza che lo salva è di ampiezza, e va difesa esplicitamente: tiene
  **una** cosa (i byte precedenti di un path), ha **un** lettore (`muffin undo`),
  e non è un tier di autonomia. Il fallimento di `undo_log` non è stato «un
  registro»: è stato un registro che nove tipi d'azione potevano riempire e che
  nessun comando interrogava.
- *Contro secondo*: **costa i byte del file sovrascritto**, e `fsWrite` non ha
  oggi alcun cap sulla dimensione del file preesistente (`fs.ts:230-235`) —
  `MAX_READ_BYTES` (2 MB, `fs.ts:206`) vincola solo `fs_read`. Serve un tetto, e
  serve che il superamento **salga a `ask`** invece di degradare ad `allow`.
  Quello è l'uso giusto di `ask`: raro, e la rarità è il punto.

**Raccomandazione.** **Candidata 4**, con il tetto e con l'escalation a `ask`
sopra il tetto. Le altre tre restano annotate: la 1 quando arriverà il caso d'uso
*proponi e fai ratificare* — ADR-0032 lo lascia aperto per la scrittura di
memoria, ed è lì che il registro trova il suo riempitore; la 2 come forma
candidata per `muffin vault check`, che è l'uso che §19 le riconosce e che non
è questo.

## 4. Le scritture fuori dal vault

I fatti, prima delle opinioni ⬤:

- `agent/runtime.ts:172` — `{ root: cwd, denyWrite: [p.rot, p.secrets, p.config],
  denyRead: [p.secrets] }`. Lo scope è la **working directory del processo**.
- `agent/tools/fs.ts:28-29` dice che *"the default working directory is `$HOME`,
  which contains `~/.muffin`"*.
- `core/config/config.ts:112` — il vault è `~/.muffin/vault`.

Messi insieme: con `cwd = $HOME` **il vault è dentro lo scope di scrittura**, e
lo scope di scrittura è la home dell'owner meno tre percorsi. Il vault non è una
zona speciale per `fs.write`; è una sottocartella come le altre. Qualunque
modello di reversibilità costruito attorno al vault coprirebbe una frazione
arbitraria delle scritture reali.

Questo è l'argomento più forte a favore del sidecar e contro git, e si concilia
con `resolveInScope` senza attrito: il record di undo si scrive **sul path
risolto**, cioè dopo che `resolveInScope` (`fs.ts:149-190`) ha già applicato la
containment nel `cwd`, il rifiuto dei symlink in scrittura, il confronto
case-blind con le deny-list e il rifiuto degli hard link. Un path che
`resolveInScope` rifiuta non arriva mai a produrre un record — ed è giusto: non
c'è niente da annullare, perché non succede niente.

**Una cosa trovata di passaggio e che non va lasciata cadere**, perché la domanda
nomina le deny-list. `03-threat-model.md:67` elenca cinque **mandatory deny
paths**: *«`~/.muffin/rot/`, config, secrets, `.git/hooks`, dotfile di shell»*.
Il codice ne implementa **tre** — `runtime.ts:172` per i tool e `runtime.ts:210`
per il sandbox portano entrambi la stessa terna `[p.rot, p.secrets, p.config]` ⬤.
`.git/hooks` e i dotfile di shell non sono negati da nessuna parte. Con
`cwd = $HOME` e un `~/.zshrc` scrivibile, la reversibilità di una singola
scrittura è la difesa sbagliata contro il problema giusto: un hook o un dotfile
riscritto è **tecnicamente** annullabile e **praticamente** già eseguito al
prossimo shell o al prossimo commit. Non è materia di questa ricerca risolverlo,
ma è materia di questa ricerca dire che **la classe «reversibile» non è la stessa
cosa della classe «innocua»**, e che i due path che il threat model nomina e il
codice non nega sono precisamente dove la differenza morde.

**Raccomandazione.** Nessuna zona privilegiata per il vault; il modello è
per-path e vale ovunque `resolveInScope` dica di sì. E la terna delle deny-list
va riportata alle cinque voci del threat model **prima** o **insieme** allo
sblocco di `fs.write`, non dopo — perché sbloccare la scrittura amplia la
superficie di due percorsi che sono dichiarati chiusi e non lo sono.

## 5. Il percorso di fallimento: dove va il vincolo perché non sia aggirabile

Il vincolo è: **se il record di undo non si scrive, la scrittura non avviene.**
Le tre collocazioni possibili, e perché due non tengono.

**In `runTool` (il loop).** È dove vive il rifiuto di oggi (`loop.ts:662-672`).
- *Pro*: sta accanto alla decisione, ha il trace a portata, non tocca i tool.
- *Contro*: ripete lo stesso errore in un posto nuovo. Il loop è **un** chiamante
  di `fsWrite`; la funzione resta esportata e chiamabile senza passare di lì.
  Ed è la forma che il repo ha già dichiarato insufficiente a `decide.ts:171-177`:
  *«a gate whose precondition is supplied by its caller is not a gate»*.

**Nella registrazione dell'handler** (`runtime.ts:184-191`).
- *Pro*: un solo punto, e il posto dove lo scope è già chiuso.
- *Contro*: è una closure. Chi aggiunge un secondo tool di scrittura domani non
  incontra nessun ostacolo che lo obblighi a ripeterla — non c'è niente da
  soddisfare, solo un esempio da imitare.

**Dentro `fsWrite`.**
- *Pro, e sono misurati.* `agent/tools/fs.ts:233` è **l'unico `writeFileSync`
  raggiungibile da una capability** ⬤: gli altri sono `core/tracing/tracer.ts:34`,
  `core/rot/verify.ts:151-152`, `core/config/config.ts:157,182`,
  `core/mcp/registry.ts:82`, `core/session/store.ts:49` — CLI, RoT, config,
  sessioni, nessuno dietro un tool. Mettere il vincolo lì rende il record e la
  scrittura **la stessa operazione**, senza un ordine che qualcuno possa
  sbagliare.
- *Pro secondo, ed è quello che lo rende un meccanismo e non una convenzione*:
  il sink diventa un **parametro obbligatorio** della firma. Un chiamante senza
  sink **non compila**. È «parse at the boundary» (PRACTICES §4) applicato a un
  effetto invece che a un dato: il caso illegale smette di essere rappresentabile
  invece di essere controllato.
- *Contro*: non impedisce a qualcuno di chiamare `writeFileSync` direttamente in
  un tool futuro. Nulla in TypeScript lo impedisce. La contromisura è un test di
  cablaggio, non un tipo — nella famiglia di `runtime-wiring.test.ts`.

**Raccomandazione.** In `fsWrite`, con il sink obbligatorio nella firma. E il
test che deve esistere non è quello che prova la forma del record: è quello che
**fallisce senza il cablaggio** — *una scrittura il cui record di undo non
riesce a persistere lascia il file invariato sul disco*. È la regola che AGENTS.md
mette in cima come la più costosa da imparare, e questa è precisamente la
situazione che l'ha prodotta quattro volte.

Due dettagli sul verso del fallimento, perché la direzione conta:

- **La copia precede la scrittura.** Se la copia riesce e la scrittura fallisce
  resta un sidecar per un file che non è cambiato: inutile, innocuo, e va
  lasciato lì. Cancellarlo silenziosamente sarebbe la stessa forma di «non
  cancellare righe» sbagliata dall'altro lato.
- **Il record va sul trace, non solo su disco.** `muffin.policy_decision` esiste
  già (`core/tracing/types.ts:22`, `loop.ts:637-647`) e porta
  `muffin.policy.effect`. La `TRACE` finale della forma dell'owner è già lì: le
  manca solo l'attributo che dice *quale* record è stato scritto, così che
  «perché hai fatto così» risponda anche a «e come lo disfo».

---

# Technical part

Terminology, fixed for this part: **policy kernel** = `core/policy/decide.ts`.
**capability declaration** = a `CapabilityDecl` value. **write scope** = the
`FsScope.root` in `agent/runtime.ts:172`. **undo record** = the persisted
description of one write. **sidecar** = the copy of the bytes that a file holds
before a write.

## What the policy kernel reads ⬤

| Field of `DecisionRequest` | Read by `decide.ts` | Line |
|---|---|---|
| `principal` | yes | `:93`, `:120`, `:128`, `:132`, `:184`, `:197`, `:211` |
| `tenant` | yes | `:93`, `:121`, `:145` |
| `capability` | yes | `:93`, `:95`, `:111` |
| `resource` | yes, and only `kind === 'url'` uses `value` for logic | `:155-193`; `:213` builds the ask text |
| `args` | **no** | `grep -n "args" core/policy/decide.ts` returns zero lines |
| `taint` | yes | `:93`, `:137`, `:184` |

`CapabilityDecl.policyArgs` (`core/policy/types.ts:88`) has one reader, and the
reader is outside the kernel: `resourceFor` at `agent/loop.ts:742-756`.

## Capability declarations in production ⬤

| Capability | File:line | risk | reversible | Kernel result at taint 0, owner |
|---|---|---|---|---|
| `fs.read` | `agent/tools/fs.ts:36-42` | low | yes | allow |
| `fs.list` | `agent/tools/fs.ts:44-50` | low | yes | allow |
| `fs.write` | `agent/tools/fs.ts:52-58` | medium | **undoable** | **draft** |
| `memory.read` | `agent/tools/memory.ts:22-24` | low | yes | allow |
| `skill.read` | `agent/tools/skill.ts:23-25` | low | yes | allow |
| `sys.process.list` | `agent/tools/process.ts:24-26` | low | yes | allow |
| `sys.http` | `agent/tools/http.ts:30-32` | medium | yes | allow, after the egress branch |
| `sys.search` | `agent/tools/search.ts:49-51` | medium | yes | allow, after the egress branch |
| `mcp.<server>` | `agent/tools/mcp.ts:30-39` | medium | **no** | **allow** |
| `sys.shell` | `agent/tools/shell.ts:33-35` | high | no | ask in single-user |
| `sys.process.kill` | `agent/tools/process.ts:33-35` | high | no | ask in single-user |
| `outward.send` | **no declaration exists** | — | — | `deny/no_capability` |

`fs.write` is the only production declaration with `reversible: 'undoable'`. The
other two occurrences of that value are test fixtures: `core/policy/decide.test.ts:8`
and `agent/loop.test.ts:510`.

`outward.send` appears in `core/policy/matrix.ts:63,99` and in comments at
`core/policy/decide.ts:169` and `agent/loop.ts:733`. No file declares it.

## The reversibility field, by risk branch ⬤

`decide.ts:201-214`:

| `risk` | `reversible` | Result | Reads `reversible` |
|---|---|---|---|
| low | any | `allow` | no |
| medium | `undoable` | `draft`, `windowSeconds: 300` | yes, `:205` |
| medium | `yes` | `allow` | yes, `:205` |
| medium | `no` | `allow` | yes, `:205` |
| high | any | `ask`, or `allow` at hardened + owner + taint 0 | no |

`POLICY_FLOOR.defaultMaxTaint` is `{ low: 3, medium: 1, high: 1 }`
(`core/policy/matrix.ts:95`). `fs.write` declares no `maxTaint`, so its ceiling
is 1. A turn at taint 2 or 3 reaches `deny/taint_exceeded` at `decide.ts:137-143`
before the risk switch. The reversibility model therefore governs turns at taint
0 and 1 only.

## Consumers of `Decision` ⬤

`runTool` (`agent/loop.ts:591-723`) is the only consumer of a kernel `Decision`
in production. The chain is:

```
:649  if (decision.effect === 'deny')  → return tool_result, isError
:662  if (decision.effect === 'draft') → return tool_result, isError
:673  if (decision.effect === 'ask')   → deps.approve, or throw ApprovalRequired
:698  try { await tool.handler(...) }
```

The chain has no `switch`, no `default`, and no exhaustiveness check. An `effect`
value outside these three reaches `:698` and runs the tool.

`cli/observe.ts:122-127` matches on `effect` values `skip`, `deny` and `defer`.
Those belong to `core/scheduler/observe.ts`, a separate type.

## The decision memo key ⬤

`makeSnapshot` (`agent/loop.ts:808-833`) caches on:

```
`${capability}:${resource.kind}:${'value' in resource ? resource.value : ''}:${taint}`
```

The key holds no argument and no file state. `raiseTaint` clears the cache
(`:817-822`). `invalidate()` clears it on demand (`core/policy/types.ts:110-115`),
and its comment names the budget as the second input that changes inside a turn.

## The path resource contract ⬤

| Statement | Source |
|---|---|
| A `path` resource is absolute, normalized, symlinks resolved | `core/policy/types.ts:41` |
| Same, in the normative document | `docs/blueprint/09-contratti-m0-m1.md:23` |
| The loop passes the argument string unchanged | `agent/loop.ts:749-752` |
| The tool schema documents the argument as relative | `agent/tools/fs.ts:88` |
| The kernel resolves the path | nowhere |
| `resolveInScope` runs inside the handler, after the decision | `agent/loop.ts:699` → `agent/tools/fs.ts:231` |

The kernel uses a `path` resource value at `decide.ts:213` only, through
`describe`, to compose the ask text.

## Where the owner is asked ⬤

`deps.approve` has one production assignment: `cli/repl.ts:67`. `cli/run.ts` and
the Telegram connector leave it unset. With `approve` unset, `runTool` throws
`ApprovalRequired` (`agent/loop.ts:679-683`), and the turn ends with
`stopped: 'ask'` and a `pending` request (`agent/loop.ts:519-528`).

`docs/blueprint/09-contratti-m0-m1.md:174` states the headless rule: in
`muffin run`, `ASK` is an automatic deny with a dedicated exit code.

## Where bytes reach the disk ⬤

`writeFileSync` and `appendFileSync` call sites outside tests:

| File:line | Behind a capability |
|---|---|
| `agent/tools/fs.ts:233` | **yes — `fs.write`** |
| `core/tracing/tracer.ts:34` | no |
| `core/rot/verify.ts:151,152` | no |
| `core/config/config.ts:157,182` | no |
| `core/mcp/registry.ts:82` | no |
| `core/session/store.ts:49` | no |

`fsWrite` (`agent/tools/fs.ts:230-235`) resolves, creates parent directories, and
writes. It does not distinguish a create from an overwrite. It applies no size
limit to the file it replaces. `MAX_READ_BYTES` (`agent/tools/fs.ts:206`, 2 MB)
applies to `fsRead` only.

## Write scope and deny paths ⬤

| Value | Source |
|---|---|
| write scope root | `cwd` — `agent/runtime.ts:172` |
| default `cwd` | `process.cwd()` — `agent/runtime.ts:77` |
| documented default working directory | `$HOME` — `agent/tools/fs.ts:28-29` |
| vault directory | `~/.muffin/vault` — `core/config/config.ts:112` |
| tool deny-write list | `[rot, secrets, config]` — `agent/runtime.ts:172` |
| sandbox deny-write list | `[rot, secrets, config]` — `agent/runtime.ts:210` |
| mandatory deny paths in the threat model | `rot/`, config, secrets, `.git/hooks`, shell dotfiles — `docs/blueprint/03-threat-model.md:67` |

Two of the five named paths have no implementation: `.git/hooks` and shell
dotfiles.

`core/vault/vault.ts:36` skips `.git`, `node_modules`, `.obsidian`, `.trash` and
`__pycache__` during the walk (`vault.ts:129`). A git repository inside the vault
produces no index rows.

## Undo record — the minimal shape

This is a proposal. No code implements it.

```
~/.muffin/undo/YYYY-MM-DD/<epochMs>-<sha8>.bak     the previous bytes
~/.muffin/undo/YYYY-MM-DD.jsonl                    one line per write
```

One line holds: the resolved absolute path, the state before the write
(`absent` or `present`), the sha256 and the byte count of the previous content,
the capability id, the trace id, and the timestamp. A write to an absent path
carries no sidecar; its reverse is the removal of the file the agent created.

Placement, and the order that the constraint requires:

```
resolveInScope(scope, path, true)     → the resolved path, or PathDenied
stat the resolved path                → { state, bytes }
decide(..., target: { state, bytes }) → allow | draft | ask | deny
write the sidecar and the record      → failure stops here
writeFileSync                         → the bytes land
span attribute                        → the record id joins muffin.policy_decision
```

`~/.muffin/traces` and `~/.muffin/sessions` are siblings of this directory
(`core/config/config.ts:113-114`). Trace retention runs at boot and at the daily
rotation (`docs/blueprint/09-contratti-m0-m1.md:193`).

---

## Cosa non si è potuto stabilire

1. **Quante scritture al giorno produce l'uso reale.** Il numero decide se 300
   secondi sono la finestra giusta e quanto disco costa la retention dei
   sidecar. Non è misurabile finché `fs.write` è rifiutata: il loop non l'ha mai
   eseguita, quindi non esiste un solo trace con `muffin.capability = fs.write`
   seguito da un'esecuzione. **Il `~/.muffin` dell'owner non è stato aperto in
   questa passata** — né i trace né il db — quindi anche il conteggio dei
   tentativi rifiutati resta ignoto.

2. **La distribuzione delle dimensioni dei file sovrascritti.** È il numero che
   fissa il tetto sopra il quale il sidecar diventa `ask`. Ho proposto 2 MB per
   analogia con `MAX_READ_BYTES` (`agent/tools/fs.ts:206`), ma è un'analogia, non
   una misura: quel limite è stato scelto per non far esplodere il **context**,
   che è un vincolo diverso dal disco.

3. **Se `undo_log` fosse vuoto perché il meccanismo non serviva o perché non era
   raggiungibile.** Zero righe in quattro mesi è misurato ◐
   (`04-roadmap.md:250`), e l'inventario lo legge come *«ERA SLOP»*. Ma le due
   spiegazioni — nessuno ha mai voluto annullare, oppure nessun comando
   permetteva di annullare — hanno conseguenze opposte per questo disegno, e le
   righe assenti non distinguono fra loro. Il vecchio repo non è stato aperto in
   questa passata per cercare il comando che avrebbe letto quella tabella.

4. **Se `git` sia presente sulle macchine di produzione.** Verificato solo su
   questa (`git version 2.50.1`, macOS). La produzione è Linux
   (`docs/blueprint/LAVORO.md:20`) e non è stata interrogata. La raccomandazione
   contro git-sul-vault non dipende da questo — dipende dalla topologia dello
   scope — ma il costo del probe in `doctor` sì.

5. **Il comportamento di `resolveInScope` quando `cwd` non esiste più.**
   `fs.ts:150` chiama `realpathSync(resolve(scope.root))` a ogni chiamata. Con
   un processo che sopravvive al terminale (ADR-0035) la working directory può
   essere cancellata sotto di lui. Non è stato provato, e tocca il modello di
   reversibilità solo indirettamente — ma tocca il punto 5 della domanda, perché
   un `resolveInScope` che lancia prima della decisione sposta dove il
   fallimento si manifesta.

6. **Se un secondo asse oltre `reversible` e `outward` serva davvero.**
   L'argomento a favore di due campi separati (§1) è di forma, non di evidenza:
   nessuna capability oggi occupa la casella «reversibile e verso l'esterno»,
   perché `outward.send` non esiste. La prima che ci arriverà falsificherà o
   confermerà la scelta, e nessun peer letto in questa passata separa i due assi
   in modo citabile.
