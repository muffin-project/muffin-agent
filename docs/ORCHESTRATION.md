# Come si orchestra questo lavoro

> Direttiva owner, 2026-08-15. Nasce da due conversazioni esterne che l'owner ha
> portato come fonte (un'analisi del prompt d'orchestrazione, e una lettura della
> documentazione di Hermes Agent) più il modo in cui questo repo ha effettivamente
> lavorato negli ultimi giorni. Non è una lista di buone intenzioni: ogni regola
> qui sotto esiste perché la sua assenza è già costata qualcosa, e dove è costata
> è scritto.
>
> `PRACTICES.md` dice **come si scrive**. Questo file dice **come si decide e chi
> verifica**. `AGENTS.md` dice cosa non si tocca.

## 1. Il loop è un control loop, non un task loop

La forma sbagliata, e quella in cui si scivola da soli:

> leggo → credo di aver capito → faccio → i test passano → prossimo task

La forma giusta ha uno stadio che quella non ha: **ricostruire lo stato prima di
scegliere l'obiettivo**, e **aggiornarlo dopo**.

```
OSSERVA → RICOSTRUISCI LO STATO → SCEGLI L'OBIETTIVO → CERCA I BIVI
   → RICERCA → PIANIFICA → DELEGA → IMPLEMENTA → VERIFICA
   → INTEGRA → AGGIORNA LO STATO → OSSERVA
```

«Cerca i bivi» sta **prima** della ricerca di proposito: una decisione trovata a
implementazione fatta è una decisione già presa da sé.

## 2. Le classi di decisione, e dove ci si ferma

L'errore da evitare è duplice, e i due estremi sono ugualmente inutili: l'agente
paralizzato che chiede conferma per rinominare una variabile, e l'agente cowboy
che sceglie da solo la forma dei dati.

| Classe | Cosa fa l'orchestratore |
|---|---|
| Banale · implementazione locale | decide e procede |
| Architetturale **reversibile** | propone, e procede se il rischio è basso — dicendo che l'ha fatto |
| Architetturale **irreversibile** | **si ferma** |
| Prodotto (cosa deve fare, per chi) | **si ferma** |
| Sicurezza · privacy | **si ferma** |
| Modello dati (schema, formati, migrazioni) | **si ferma** |

**Fermarsi non è chiedere «cosa vuoi fare?».** È portare il bivio già istruito:
le opzioni, i pro e i contro di ciascuna, la raccomandazione con la sua ragione,
e la domanda esatta a cui serve risposta. Scaricare la scelta addosso all'owner
senza averla analizzata è lavoro non fatto, non collaborazione.

## 3. Un subagente che dice di aver fatto non è evidenza

Questa è la regola che questo repo paga più spesso. I subagenti sono **worker**:
l'orchestratore definisce il compito, loro producono, **l'orchestratore
verifica**. Non a campione — sulle affermazioni che reggono la conclusione.

Evidenza è: il codice che c'è · un test che passa **e che è stato visto fallire
prima del fix** · il comportamento eseguito · il diff letto · `tsc` e la suite
lanciati da chi riferisce · il numero prodotto nello stesso respiro in cui si
scrive.

Non è evidenza: un riassunto, una spunta, «tutti i test passano» senza il
comando, un `file:riga` ricordato invece che aperto.

E vale anche al contrario: quando un subagente riferisce un difetto, si verifica
prima di crederci. In questa slice un agente ha riportato due vincitori su un
lock — sembrava un bug di concorrenza gravissimo, era il suo harness di test.

## 4. Le PR sono checkpoint epistemici

Non «faccio tutto e poi te lo mostro», ma:

```
obiettivo → PR → verifica → merge → aggiorna lo stato → obiettivo successivo
```

Una PR per cosa, con una definizione di completamento **verificabile**. Non si
scrive «abbiamo implementato memoria, eventi e workspace»: si scrive quali PR,
e ognuna sopravvive da sola alla domanda «è vero?».

## 5. Lo stato dell'orchestratore, non solo quello del progetto

`STATE.md` dice dov'è il *progetto*. Dopo trenta iterazioni serve anche dov'è
*chi lo sta guidando*: comprensione attuale · obiettivo attuale · decisioni
aperte · domande all'owner · PR attive · deleghe in volo · stato della verifica
· rischi noti · prossima azione consigliata.

Senza, il loop diventa un narratore con la memoria confusa: sa di aver fatto
molto e non sa più cosa regge.

## 6. Repo navigabile da umani **e** da agenti

Non sono lo stesso problema. Un umano naviga per concetti, gerarchie, nomi
familiari, intuizione. Un agente naviga per segnali strutturali: riferimenti
espliciti, indici, entry point, percorsi deterministici, metadati.

> **La repo non va progettata perché l'agente la legga tutta. Va progettata
> perché sappia cosa leggere, in che ordine, e perché.**

Due vincoli che si tengono a vicenda: *human-readable* non implica
*agent-navigable*, e *agent-navigable* non deve diventare *human-hostile*. Niente
cartella `AI_DOCS/` parallela — il livello di navigazione per agenti si ottiene
con manifest, indici, riferimenti bidirezionali e entry point **dentro** la
struttura vera (`CLAUDE.md`, `AGENTS.md`, `STATE.md`, gli ADR), non accanto.

Il criterio di qualità è misurabile: quanto ci mette un umano — e quanto ci mette
un agente — a ricostruire il contesto che serve per fare correttamente una data
operazione.

## 7. Sapere quando non fare niente

Vale per l'agente che stiamo costruendo e per l'orchestratore che lo costruisce.

> **Un agente continuo non è quello che fa sempre qualcosa. È quello che sa
> quando non fare nulla.**

Ogni evento passa da: serve un'azione? serve ricordare? serve toccare il
workspace? serve coinvolgere l'owner? **oppure si ignora** — e ignorare è un
esito legittimo, non un fallimento. In codice questa proprietà esiste già ed è
`decideProactive` (`core/scheduler/proactivity.ts`), col suo insieme **chiuso** di
trigger. Qualunque spina degli eventi nasca dopo, quel cancello resta.

## 8. Gli eval rispondono a una domanda sola

Non «quanti benchmark mettiamo nel README», ma **«sta migliorando?»**. Quindi
pochi, concreti, e soprattutto **di regressione**: la stessa suite prima e dopo,
e la capacità di dire *questa modifica ha peggiorato X*.

Le domande che meritano un eval, in ordine di quanto sono nostre: cosa va
ricordato di un dialogo · cosa va ripescato dato un contesto · dove va
un'informazione (memoria, workspace, contesto, tool) · quale tool serve · dato
un evento, agire/ricordare/ignorare · l'obiettivo è stato davvero completato.

## 9. Il modello si sceglie per la task, e la scelta si misura

Non si fissa oggi una matrice modello→task. La regola è: il modello di un
sotto-compito si sceglie per **natura, complessità, rischio e costo**, e quando
il dubbio sulla qualità relativa è reale si fa un **eval comparativo piccolo**
prima di standardizzare.

La separazione che resta ferma è un'altra, e non è sui nomi dei modelli:
**orchestratore ≠ worker ≠ verificatore**. L'orchestratore non è il modello che
sa fare tutto meglio; è quello che ha la responsabilità di decidere cosa va
fatto, come si verifica, e quando fermarsi a chiedere.

## 10. La ricerca cita, e la citazione impedisce di rifarla

Ogni affermazione che viene da fuori porta la fonte primaria e **perché ci
interessa**, non solo il titolo. Serve a una cosa concreta: che la ricerca
successiva possa dire *«quel paper lo stiamo già considerando, ecco dove»*
invece di ripartire. Il formato e le due zone stanno in `PRACTICES.md` §13; qui
si aggiunge solo l'obbligo della citazione puntuale e del *perché*.
## 11. Cosa significa «chiuso»

Direttiva owner, 2026-08-15, e sostituisce ogni uso più permissivo della parola
in questo repo. **Un test verde non è «chiuso».**

Chiuso è, per ogni voce di lavoro:

| | |
|---|---|
| implementazione | il codice esiste |
| unit test | la logica è provata in isolamento |
| **integration test** | provata attraverso i confini, non nei mock |
| **cablaggio in produzione** | il percorso reale ci arriva — non solo i test |
| **percorso di fallimento** | cosa succede quando non funziona, e chi lo dice |
| **scenario di accettazione reale** | eseguito come lo eseguirebbe l'owner |
| documentazione · `STATE.md` | ciò che è cambiato è scritto dove si cerca |

Le due righe in mezzo sono quelle che questo repo salta, e sono la ragione per
cui esiste una famiglia di difetti chiamata *dichiarato e non collegato*: un
`decideProactive` con zero chiamanti aveva unit test verdi, e una allowlist
egress con i suoi test verdi non è mai entrata in funzione in produzione.

È la stessa disciplina che il giudice applica al codice: non che sembri
corretto, ma che **la garanzia sia raggiungibile dal percorso vero**.

## 12. Un inventario, non una lista di feature

Quando l'obiettivo è «siamo pronti?», la forma giusta non è l'elenco di ciò che
si vuole costruire — quello parte da come è fatto il codice. È un **inventario
di domande**, che parte da cosa serve a chi lo usa, e in cui **ogni voce ha una
di tre risposte**: `READY`, `FUORI DALLO SCOPO` con la ragione scritta, o
`BLOCKER`.

> **La quarta categoria — «non ci avevamo pensato» — è quella che produce le
> fasi di recupero.** Un inventario esiste per renderla impossibile: se emerge
> una lacuna nuova non si nasconde, si aggiunge.

L'inventario vivo è `docs/blueprint/M5-BIS.md`.
## 13. Un documento fondazionale è un insieme di affermazioni, e le affermazioni si controllano

Direttiva owner, 2026-08-15: *«dovremo controllare ogni singola cosetta messa in
questi file fondamentali e validarla… non possiamo continuare a trovare cose
nuove solo perché le noto io, che agentic codebase sarebbe altrimenti?»*

`09-contratti-m0-m1.md` è **normativo**. `03-threat-model.md` dichiara
**garanzie**. `STATE.md` dice cosa è **costruito**. Ognuna di quelle righe è o
vera o falsa del codice — e oggi la deriva si trova per caso.

**Non è un'idea nuova: qui esiste già in tre punti, e non è mai stata
generalizzata.** `core/rot/readers.ts` dimostra che ogni file sigillato ha un
lettore, e `doctor` lo esegue. `.claude/hooks/inject-state.test.ts` verifica che
il handoff **vero** entri nel budget vero. `core/memory/invariants.ts` controlla
proprietà del grafo. Tre invarianti che *girano*. Tutto il resto è sulla fiducia.

La regola, quindi:

1. **Ogni affermazione portante ha uno stato**: *verificata* (con la prova),
   *derivata* (drift trovato, lavoro aperto), *non verificabile* (e allora dice
   perché).
2. **Se un'affermazione può eseguire, deve eseguire.** Un test, un controllo di
   `doctor`, un invariante. Una regola che vive solo in prosa perde contro un
   merge — misurato: il budget del blocco iniettato era scritto in `PRACTICES`
   §7 ed è stato sforato il giorno dopo da un merge a tre vie.
3. **Ciò che non può eseguire ha una cadenza di ri-validazione**, non una data di
   scrittura.

E il limite da nominare, perché è quello che ha prodotto la direttiva: gli audit
interni confrontano il codice **con i nostri stessi documenti**. Trovano ciò che
abbiamo scritto e non fatto. Sono **strutturalmente ciechi** a ciò che non
abbiamo mai scritto — lo streaming non era «dichiarato e non collegato», era mai
pensato. Quella categoria si trova solo guardando fuori, e vuole una passata sua.

## 14. La mappa è una vista derivata, e le viste derivate marciscono

Direttiva owner, 2026-08-15: *«ricordiamoci di aggiornare anche questo artefatto
quando serve che modifichiamo qualcosa»*.

Un diagramma dell'architettura è la forma di documentazione che **invecchia
peggio**: descrive la parte del sistema che cambia di più, non ha compilatore, e
sbaglia con autorevolezza — sembra vero proprio mentre smette di esserlo. Un
promemoria («ricordati di aggiornarlo») è una regola che vive solo in prosa, e
§13.2 dice già come finisce.

Quindi la mappa **non si disegna a mano**:

1. **I dati stanno nel repo**, non nell'artefatto: `docs/blueprint/mappa/*.json`.
   Ogni voce porta un'ancora `file:riga` verso il codice che la giustifica.
2. **L'artefatto è un renderer** su quei dati. Ridisegnarlo non è un lavoro di
   memoria: si rigenera.
3. **Le ancore sono testate.** `docs/blueprint/mappa/mappa.test.ts` verifica che
   ogni ancora esista ancora e punti allo stesso testo. Quando il codice si
   sposta, **fallisce la suite**, non l'artefatto in silenzio.

Il costo di questa forma è che la mappa può coprire solo ciò che è ancorabile a
codice vero, ed è precisamente il vincolo che si vuole: una casella senza ancora
è una casella che non abbiamo il diritto di disegnare.

## 14. Si ripara alla radice, e la radice è quasi sempre una forma

Direttiva owner, 2026-08-15: *«quando ci sono cose da fixxare, proviamo sempre a
fixxare alla radice, magari sono scelte sbagliate, o cose del genere, cerchiamo
di andare più alla radice possibile e sempre primitivo, architetturale»*.

Un difetto trovato **due volte** non è due difetti: è una forma che li produce.
Ripararne le istanze una per una è lavoro che si ripete, e che finisce quando
qualcuno smette di guardare — non quando la causa smette di esistere.

**Il livello a cui fermarsi.** Salendo dall'istanza: la riga · la funzione · il
contratto fra due moduli · **il tipo che permette lo stato sbagliato** · la
decisione architetturale. Ci si ferma al primo livello in cui il difetto diventa
**non rappresentabile**, non al primo in cui sparisce.

L'esempio da cui viene la regola, e vale come metro perché è tutto misurato in
un giorno solo. Tre istanze della stessa famiglia — «riporta successo mentre
fallisce» — in `cli/repl.ts`, `cli/gateway.ts`, `cli/doctor.ts`. Tre riparazioni
puntuali sarebbero state tre riparazioni corrette e la quarta istanza sarebbe
arrivata comunque, perché:

- `Deliver` ritorna `Promise<void>`. **Una firma che ritorna `void` non può dire
  «non ho consegnato»**: ogni implementazione deve *ricordarsi* di lanciare, e
  delle tre una sola se n'è ricordata. Il tipo permette il difetto.
- `doctor` distingue i casi di un'unione chiusa con una catena di `if`, e il
  ramo non gestito **cade su quello verde**. Questo repo ha già la prova che la
  forma alternativa funziona: `switch (decl.risk)` in `core/policy/decide.ts` non
  ha `default` e **rompe la build** se manca un caso, mentre la catena di `if` in
  `runTool` *esegue il tool* su un effetto sconosciuto. Stessa domanda, due forme,
  due esiti opposti — e uno dei due si accorge da solo.

**La regola operativa**: quando la stessa forma compare due volte, si smette di
ripararla e si chiede *quale primitiva la renderebbe impossibile*. Se la risposta
è cara, si porta all'owner con pro e contro — ma si **chiede**, prima di riparare
la terza.

E il corollario che questo repo paga più spesso: preferire la forma che
**fallisce da sola** — un `switch` esaustivo, un tipo che obbliga il chiamante a
gestire l'esito, un sink obbligatorio nella firma — a quella che dipende dal
fatto che qualcuno si ricordi.
