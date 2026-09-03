# ADR-0055 — Le due porte passano dal kernel: la risposta e la memoria sono capability

**Stato:** accettato · 2026-09-03 · esegue la raccomandazione 4 della memo
`docs/evidence/decision-memo-taint-2026-09-02.md`

## Contesto

ADR-0053 ha reso eseguibile la matrice normativa di
`docs/history/rebuild-2026/03-threat-model.md` §3: il soffitto di una capability
viene dalla sua **riga di effetto**, non dalla sua classe di rischio. Quella ADR
ha dichiarato per iscritto ciò che le restava fuori:

> Due strade restano fuori dal kernel e la tabella lo rende visibile: il testo
> della risposta e la scrittura di un episodio di memoria non hanno una
> capability, quindi le righe `reply` e `memory` sono in parte vuote.

Le due righe erano scritte per loro. La matrice dice *«Reply sul canale di
origine: ALLOW · ALLOW · ALLOW»* e *«Scrittura memoria: ALLOW · ALLOW nel
tenant · ALLOW»*, e il kernel eseguiva quelle righe per ogni capability tranne
le due di cui le righe parlano. La risposta usciva da
`SurfaceRegistry.deliver(channel, text)` senza nessuna decisione presa;
l'episodio veniva scritto direttamente da `agent/loop.ts` e soltanto
*etichettato* con `intrinsicTaint()`.

Il costo è misurato, non congetturato (memo §1.3). A taint 2, prima di ADR-0053,
il modello **non poteva allegare** un file che aveva appena letto e **poteva
ricopiarne il contenuto nel testo** della risposta: `agent/tools/deliver.ts`
dichiara le due cose la stessa classe di fiducia — *"same trust class as
replying with more text on the same channel"* — e il sistema le trattava in modo
opposto. ADR-0053 ha riparato metà dell'asimmetria portando `surface.send_file`
sulla riga `reply`; l'altra metà è che la porta di testo non aveva niente da
attraversare.

Il seam di eval eredita esattamente lo stesso buco. La memo §7 elenca fra ciò
che manca: *«Le scene di sink mancano tutte. Nessuno scenario oppone `send_file`
alla risposta testuale, o mette la scrittura di memoria sotto attacco»*. Non era
una dimenticanza dell'eval: `evals/security/baseline.ts` presenta una
`DecisionRequest` al kernel vero, e per due delle tre porte non esisteva una
capability da nominare.

## Decisione

**Le due porte che il turno attraversa senza un tool sono capability dichiarate,
e il kernel le possiede.**

### 1. Due dichiarazioni, nel kernel e non in un runtime

`core/policy/doors.ts` dichiara `surface.reply` (riga `reply`) e `memory.write`
(riga `memory`), e `core/policy/decide.ts` le consulta **sotto** quelle che il
chiamante ha dichiarato: una dichiarazione del chiamante sullo stesso id vince,
così un harness può stringere una porta di proposito.

Stanno nel kernel e non in `agent/runtime.ts` perché non sono tool che una
feature registra: sono gli atti che il loop compie da solo. Un runtime che
dovesse *ricordarsi* di registrarle risponderebbe `no_capability` a ogni
risposta il giorno in cui se ne dimentica — e i runtime sono più d'uno: il
binario, gli harness di test, l'harness di accettazione. Un kernel che le
possiede non può dimenticarsene.

`ctx.capabilities` viene letta **viva**, a ogni richiesta, e non copiata alla
costruzione: `agent/runtime.ts` passa la stessa `Map` a `createDecide` e a
`Runtime.register`, che la muta. La prima stesura di questa slice ne prendeva
uno snapshot, e ogni tool MCP — più ogni tool registrato dopo il boot — è
diventato `no_capability`. Il difetto non stava sulla porta che la slice
aggiungeva: stava nel modo in cui la aggiungeva.

### 2. Rischio `low` su entrambe, deliberatamente

Lo switch sul rischio in `decide.ts` trasforma `medium` + `undoable` in un
`draft` e `high` in un `ask`, e nessuno dei due verdetti ha un significato per
«questo turno può rispondere»: la bozza di una risposta è una risposta, e una
richiesta di approvazione che è essa stessa una risposta non può presidiare le
risposte. L'unica manopola che significa qualcosa su queste righe è il
`denyAbove` della riga, e `low` è la classe che ci arriva senza inventare un
verdetto per strada.

Entrambe dichiarano `reversible: 'no'` e `rerunnable: false`: i byte sulla rete
non si richiamano, e un episodio scritto due volte sono due righe che il recall
troverebbe entrambe. `memory.write` ha `resourceKind: 'tenant'` — il tenant del
turno, mai uno che il chiamante nomina.

### 3. La decisione è presa prima che il modello parli

La porta della risposta si interroga **all'inizio del giro**, prima della
chiamata al modello, perché il testo di un giro esce mentre viene generato
(`onDelta`): una decisione presa dopo la chiamata sarebbe presa su byte già
sullo schermo dell'owner. Tutto ciò da cui il testo del giro può derivare è già
in contesto a quel punto — i risultati dei tool alzano il taint *prima* del giro
successivo, mai durante lo streaming di questo — quindi il taint su cui si
decide è il taint che il testo porterà.

Un rifiuto chiude il turno con `stopped: 'answered'` e un testo che ha scritto
il kernel, non il modello (`replyRefusedText`): la riga presidia ciò che dice il
modello, e la frase del kernel non è quella. Il verdetto si legge con uno
`switch` esaustivo con `assertNever` nel `default`, la stessa forma di `runTool`
e per la stessa ragione: una disuguaglianza tratterebbe un quinto verdetto
inatteso come un rifiuto e proseguirebbe, che è lo stesso salto silenzioso — con
un segno invertito — che ha fatto girare `draft` come un allow implicito.

### 4. Nessun permesso cambia

Il pavimento spedito risponde `allow` su entrambe le righe a ogni taint. Ciò che
cambia è che ora la risposta **esiste**: un `rot/policy.json` sigillato che
stringe la riga viene obbedito (`matrix.ts`, `tighterRows`: stringere sì,
allargare mai), ogni risposta e ogni episodio lasciano uno span
`muffin.policy_decision` con capability, taint ed effetto, e un rifiuto lascia
sul turno `muffin.reply.refused` o `muffin.memory.write_refused`. La semantica
di ogni altra capability è invariata.

### 5. Cosa **non** è coperto: le consegne proattive

La Stage 2 dell'osservazione **è** un turno — `agent/observe-run.ts` chiama
`runTurn` — quindi la porta della risposta viene interrogata mentre il testo si
compone. Quello che resta fuori è ciò che viene dopo: la consegna vera e propria
la fa `cli/observe.ts` con `deliver(channel, text)` sul risultato, e l'episodio
lo scrive `agent/observe-run.ts` **fuori** dal loop (quel turno gira con
`memory: undefined`, quindi `memory.write` lì non viene mai chiesta). Da cui una
conseguenza che va detta e non deve sorprendere: con la riga `reply` stretta
dall'owner, il turno di composizione torna `answered` con il testo del kernel e
`observe-run` non lo distingue da una risposta vera, quindi il nudge proattivo
che arriva è la frase «La risposta è stata trattenuta dal kernel…», poi
registrata come episodio. Non è insicuro — è testo del kernel, e solo su una
riga che l'owner ha stretto — ma è la ragione per cui questa sezione esiste.
Non è una svista ed è presidiata altrove: `decideProactive`
(`core/scheduler/proactivity.ts`) rifiuta `tier > 1` alla fonte, quindi una
consegna proattiva nasce solo da un innesco pulito, e ha in più le sue quiet
hours e il suo budget. Portarla dentro la stessa porta è lavoro successivo, non
fatto qui, e va dichiarato invece che lasciato dedurre da una riga di matrice
che sembra coprire tutto.

## Alternative scartate

**Solo tracing, senza dichiarare.** Emettere uno span `muffin.reply` e
`muffin.memory.write` senza capability costava molto meno e dava l'osservabilità
che la memo chiede. Non dà le altre due cose: un `policy.json` sigillato non
avrebbe nulla da stringere, e il seam di eval non avrebbe un nome da mettere in
una scena — che è precisamente l'artefatto mancante fra noi e la risposta
(memo §7). Uno span non è una decisione: è il verbale di una decisione che
nessuno ha preso.

**Lasciarle fuori finché l'eval non decide.** È l'argomento che la memo stessa
smonta al punto 4 della raccomandazione: questa riparazione *«cambia cosa è
osservabile, non cosa è permesso»*, e l'eval decide se il taint ambientale sia
il segnale giusto — cioè le **colonne**. Senza le due dichiarazioni l'eval non
può nemmeno formulare la domanda sui sink, perché due delle tre porte non hanno
un nome che il kernel riconosca. Aspettare un esperimento che non si può
allestire non è prudenza.

**Registrarle da `agent/runtime.ts` come ogni altra capability.** Sarebbe la
forma consueta, e sarebbe fail-open: ogni harness che costruisce un `decide` per
conto suo — ce ne sono diversi, in `agent/` e in `evals/` — risponderebbe
`no_capability` a ogni risposta, cioè un rifiuto su una riga che dice ALLOW a
ogni colonna. Una porta che il kernel possiede non ha quel modo di fallire.

**Dare a `memory.write` `reversible: 'undoable'`.** Una riga di episodio si può
cancellare, ma nulla oggi la registra su un journal né offre `undo`: dichiararlo
sarebbe il kernel che promette un checkpoint che il loop non prende — l'esatta
forma che il percorso `draft` di ADR-0022 rifiuta.

## Conseguenze

- Il costo per giro è una `Map.get` e uno span: `snapshot.check` è memoizzata, e
  la domanda per giro è di fatto gratuita.
- La riga `memory` e la riga `reply` della tabella di ADR-0053 non sono più «in
  parte vuote». `core/policy/effect-rows.test.ts` asserisce le due porte cella
  per cella insieme a tutte le altre dichiarazioni spedite.
- `evals/security/scenarios.ts` ha una famiglia `sink` con tre scene sulle tre
  porte che finiscono nella stessa chat: allegare il file letto, rispondere col
  suo testo, ricordarsene. Sono dichiarazioni di produzione verificate per
  identità (`evals/security/baseline.test.ts`), non copie.
- Un owner che stringesse la riga `reply` in un `policy.json` risigillato
  otterrebbe un'installazione che a volte non risponde. È il suo diritto ed è
  ciò che ha chiesto; il testo che legge è del kernel e nomina il codice del
  rifiuto, non un errore del modello.
- **Restano scoperte** la consegna proattiva di `cli/observe.ts` e il suo
  episodio scritto da `agent/observe-run.ts` (§5 qui sopra), l'episodio di
  ingest del vault (`core/vault/vault.ts`, `kind: 'document'`), e il verso
  opposto della memoria: la *lettura* di recall passa già da `memory.read`, la
  consolidazione che riscrive ciò che deriva no. «L'episodio passa dal kernel»
  è vero del **turno**, non di ogni riga che finisce nella memoria.
- La domanda aperta di `docs/SECURITY.md` §13 non è toccata: se l'eval mostra
  che il taint ambientale non paga la sua complessità, cambiano le colonne e
  queste due righe restano dove sono.

## Come si falsifica

`agent/doors.test.ts` gira turni veri contro il kernel vero, senza `decide`
finto e senza store finto. Il primo test è la metà che prova che **nulla è
proibito di nuovo**: un turno che ha letto un file risponde, scrive entrambi gli
episodi, e lascia un `muffin.policy_decision` per ognuna delle due porte nel
file di trace che l'exporter ha davvero scritto. Gli altri due provano che la
decisione **pesa**: con `rows.reply = {askAbove: 3, denyAbove: 1}` il primo giro
legge e il secondo viene trattenuto prima che il modello venga interrogato — le
sue parole non compaiono né nello stream né nel risultato — e con
`rows.memory = {denyAbove: -1}` il turno risponde lo stesso e nello store non
c'è nessuna riga.

Mutazione eseguita a mano il 03/09: tolto il blocco della porta della risposta
da `agent/loop.ts`, il secondo test diventa rosso su `expected 2 to be 1` (il
modello viene interrogato due volte invece di una) e il primo perde lo span di
`surface.reply`. La prova fallisce quando il cablaggio sparisce.

Il segnale che questa decisione è sbagliata sarebbe una riga stretta che produce
un'installazione muta senza che l'owner capisca perché: se il testo del rifiuto
non basta a farglielo capire, la riparazione è quel testo, non tornare a una
porta senza decisione.
