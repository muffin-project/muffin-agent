# Il modello della persona — e come si chiede

**Stato: VIVO nei princìpi, con un difetto misurato al centro.** Il vecchio Muffin
aveva **due metà giuste di una risposta giusta, che non si sono mai parlate**: una
sapeva *cosa chiedere e in che ordine* al primo incontro, l'altra sapeva *come
dosare* le domande nel tempo. Quello che non è mai esistito — ed è il pezzo che
rende "progressivo" diverso da "metronomico" — è **leggere la risposta**.

Curato 2026-08-09 da un survey del vecchio repo. I numeri marcati **misurato-qui**
li ho ri-eseguiti io in sola lettura su `~/dev/Muffin/muffin.dev.db`; gli altri
vengono dal survey e sono etichettati.

## Il filtro primario, che si porta com'è

> **"Cosa è stabilmente vero di questa persona?"**
> `src/memory/memory_learning.ts:153`

Se una frase non risponde a quella domanda non è un fatto: è stato, episodio o
rumore. È il filtro più affilato e più economico di tutto il corpus.

Due regole della stessa fonte, altrettanto riusabili:

- **Niente etichette nude** (`memory_learning.ts:164-168`). "fuma", "python",
  "work_style" si rifiutano; *"Giusto fuma sigarette la sera"* si accetta. Ogni
  claim dev'essere una frase che si spiega da sola.
- **Il disambiguatore di "preferisco"** (`memory_learning.ts:111-114`). L'oggetto
  decide la destinazione: preferenza sul **comportamento di muffin** → direttiva
  di voce; preferenza sul **mondo della persona** → fatto. È l'unica ragione per
  cui il modello della persona non si è riempito di configurazione.

## Le due metà

### Metà A — il primo incontro (`src/cli/install.ts:429-576`)

La costituzione del primo turno, verbatim da `install.ts:457-468`:

> «Fai massimo 7 domande nel primo turno — poi la conversazione continua
> organicamente.» · «**Una domanda alla volta. MAI liste, MAI wizard, MAI form.**»
> · «Non chiedere mai la stessa cosa due volte. Non fare check-list. **Sii
> curioso, non metodico.**» · «Se l'utente dice "per ora basta" … chiudi con una
> frase breve e non insistere.»

**L'ordine progettato** (`docs/pitches/done/cycle_7.md:261-274`) — e nota che sono
**quattro**, non sette: il 7 è un tetto, non un obiettivo.

> nome → **cosa fai nella vita** → una tacca più stretto ("backend, frontend,
> mobile?") → **da dove scrivi** → *e poi ti fermi*: «Per ora basta — il resto lo
> capirò parlando con te.»

Durante l'onboarding i tool sono ristretti a `save_fact / save_state /
set_preference / …`: **niente telegram, niente web_search** (`install.ts:493-500`).
E la regola dura: se l'utente dice solo "ciao", **non si incalza**.

### Metà B — chiedere nel tempo (`src/cognition/belief_gaps.ts`)

L'idea che vale: **non chiedere di ciò che ti manca, chiedi di ciò che credi e di
cui sei meno sicuro.** Il punteggio è `uncertainty × salience` sui fatti che già
possiedi. Con zero fatti non c'è nulla di cui essere incerti — motivo per cui
questa metà **non può** fare da cold start, e perché servono davvero due
meccanismi.

**Il moltiplicatore di mutabilità è la cosa migliore del file**
(`belief_gaps.ts:124-147`, formula `0.3 + 0.7 × changeability` → range `[0.3, 1.0]`,
**verificata a sorgente**):

| categoria | mutabilità | moltiplicatore |
|---|---|---|
| `identity` | 0 | **0.30** — biografico: chiederlo è *anti-empatico* |
| `interests` | 0.2 | 0.44 |
| `tech_stack` | 0.5 | 0.65 |
| `projects` · `priorities` · `preferences` | 1.0 | **1.00** — in movimento, chiedi |

Guidato dalla **colonna `category` strutturata, mai da regex** (`:122`). La prova
che funzionava: delle 19 domande fatte, **zero** hanno toccato `identity`.

**Le costanti di ritmo** (verificate a sorgente): `MIN_UNCERTAINTY_SCORE 0.4` ·
`MIN_SALIENCE_SCORE 0.1` · `COOLDOWN_DAYS 21` (stessa credenza) ·
`MAX_PER_DAY 1` · `MAX_IGNORED_STREAK 3` · `BACKOFF_DAYS 14`.

**La domanda non è mai un template.** Si passa alla voce un *seme*: il fatto, il
**motivo dell'incertezza**, e la postura — `dreamer.ts:298-313`:

> «Vuoi chiedergli di questo in modo naturale e curioso, **come chi nota un punto
> cieco** — non un interrogatorio, non una lista di domande. Una sola cosa,
> brevemente.»

## Il difetto, misurato

**misurato-qui** (`muffin.dev.db`, sola lettura):

| | |
|---|---|
| belief_asks totali | **19** |
| per stato | **`asked`: 19. Nient'altro.** |
| distribuzione | **esattamente 1 al giorno**, 19 giorni su un arco di 20 (manca il 2026-07-01) |

Due cose, e la seconda è quella che conta.

**1. Il tetto è diventato il ritmo.** `runBeliefGapAsk` è il *fallback del
silenzio*: parte quando il motore proattivo decide di tacere. Risultato: una
domanda al giorno, quasi ogni giorno, per venti giorni. Cooldown, back-off e
soglia di salienza non hanno mai vincolato — hanno vincolato solo il tetto. *"Chiedi
quando non hai niente di meglio da dire"* produce un metronomo.

**2. Nessuna delle 19 è mai passata da `asked`.** Niente scrive `answered` o
`ignored`: la slice era dichiarata differita. Quindi `isBeliefAskBackedOff`, che
richiede 3 `ignored` consecutivi, **non poteva scattare per costruzione**. L'unico
gate adattivo era morto alla nascita, e la nota operativa che diceva *"controlla
se ignored/asked > 50% e abbassa la soglia"* era una domanda senza risposta
possibile.

*(Il survey riporta anche 375 righe di skip tutte `daily_cap_reached`; quella
tabella non esiste in questo DB e **non ho potuto riprodurre il numero** — la
conclusione però non dipende da lui.)*

## La cosa da costruire che non è mai esistita

**Chiudere l'anello.** Leggere la risposta, aggiornare la confidenza della
credenza, e far dipendere il *tasso* di domande dall'ingaggio invece che da una
costante. È letteralmente la differenza fra "progressivo" e "una al giorno".

Corollario che il vecchio ha pagato: **serve uno stato terminale per ogni domanda
in sospeso.** `memory_notifications.ts:182-197` ha dovuto aggiungere un give-up a
14 giorni, con il commento che è la lezione: *"un give-up esplicito e misurato
batte il nagging infinito."* 125 pattern su 158 sono rimasti
`pending_confirmation` per sempre — il 79% del modello comportamentale era inerte.

## Altri VIVO da portare

- **Set-valued vs singleton** (`memory_entities.ts:61-66`): una persona ha molti
  *interessi* e un solo *focus* corrente. Sbagliarlo ha fatto scadere 79 credenze
  vere. → già incarnato nel nuovo (`functional_predicates`).
- **Il silenzio è un tipo di pattern di prima classe**, esente dalla regola delle
  3 settimane perché *l'assenza è l'evidenza*. 20 pattern su 158.
- **P-7 vieta le domande di configurazione, non la curiosità.** `THESIS.md:199`
  dice *"Muffin non chiede mai **come comportarsi**"* — che è molto più stretto di
  come viene citato. Esclude "vuoi risposte brevi?"; **non** esclude "cosa fai
  nella vita?". Il vecchio repo confondeva le due, e il nuovo deve dirlo esplicito.
- **La postura osservante** (`context/HEARTBEAT.md`): *"Apro con quello che ho
  notato, non con un saluto"* · *"Un saluto dice «sono qui». Un'osservazione dice
  «ti vedo»"* · **"Il default è il silenzio"** · *"il tempo passato da solo non è
  un motivo"*.
- **Gate meccanici, non epistemici** (`src/decider.ts:49-55`): cooldown 30min,
  salience floor 0.4, bypass a 0.85. Sistema nervoso autonomo, non un giudice.
- **La conoscenza ha un'emivita, e l'emivita è per-categoria.** Stessa intuizione
  della mutabilità, del TTL a 60 giorni e del `validity_horizon` sulle
  osservazioni. Nel nuovo va **una primitiva sola**, non tre.

## Graveyard — non ricostruire

| Cosa | Perché è morta |
|---|---|
| **Belief revision** (`bot_claims*`) | 1.370 chiamate LLM in 30gg, **0 revisioni**, 8 iniezioni di rumore. *"Failure di design, non di implementation."* |
| **`living_profile_claims` / `counterpoint_claims`** | Tombstoned a **0 righe**: schema disegnato e mai popolato. Se vuoi provenienza per-claim sul profilo, costruiscila **prima**, non come tabella che speri di riempire. |
| **4 tabelle-ponte di evidenza** | Droppate a 0 righe, sostituite da una FK diretta. Preferisci una colonna a un ponte finché il ponte non è provato necessario. |
| **`operational_mode`** (passive/task/deep_work/urgent/sleep) | Una colonna, un valore, **zero lettori**. Mai costruito. Costruisci il comportamento di *una* modalità end-to-end prima di aggiungere l'enum. |
| **`T1_PROACTIVE_SPINE_ENABLED`** | *"false da sempre"*, e il criterio per accenderlo dipendeva circolarmente dall'averlo acceso. **Mai spedire un flag il cui gate richiede il flag.** |
| **Blocco affect reattivo** | `<±2%` di effetto **e più sycophancy** (arXiv:2604.07369, verificato). |
| **Soppressione deittica euristica** | Bloccava ~11% di ricerche legittime. |
| **`unknown_terms`** | F1 0.61, ~50% falsi positivi, 300 termini ogni 30s su un upload: il firehose canonico. |
| **Predicati entità liberi** | La vocabolarietà libera ha prodotto `total_mentions`, `last_mentioned`, `description` archiviati **come fatti sulla persona**, più `lives_in` duplicato di `based_in`. |

E la lezione trasversale, dal loro stesso ADR: **"le escape hatch non scappano
mai"** — i flag `*_DISABLED` / `USE_*` / `LEGACY_*` storicamente non vengono mai
girati; sono carico cognitivo latente.

## ⚠️ Avvertenza sulla bibliografia

`docs/history/foundations/legacy/REFERENCES.md` **nel nostro repo è byte-identico a quello
vecchio** (verificato con `diff`): il consolidamento l'ha copiato verbatim. Il
survey ha ri-controllato gli identificativi arXiv e il verdetto è: **gli id sono
in gran parte reali, i metadati attorno spesso no** — titoli, autori, anni e nomi
di benchmark sbagliati in circa metà delle voci controllate, e **ogni cifra
quantitativa** (74,7% · 85,7% · 17,90/100 · 91,4%) **non verificata**. Il file
stesso lo ammette alla riga 7.

**Regola operativa**: nessun numero preso da lì entra in una decisione finché non
è riletto dal paper. Vale anche per noi adesso, perché quel file lo abbiamo
ereditato e lo stiamo per pubblicare open-source.

## Fonti

Vecchio repo (sola lettura, mai scritto): `src/memory/{memory_learning,
memory_semantic,memory_entities,memory_patterns,memory_dream,
memory_notifications}.ts` · `src/cognition/belief_gaps.ts` · `src/dreamer.ts` ·
`src/decider.ts` · `src/cli/install.ts` · `context/HEARTBEAT.md` ·
`docs/pitches/done/cycle_7.md` · `docs/DECISIONS.md` · `muffin.dev.db`.
Nel nuovo: `knowledge/{01-understanding,03-observing-spine,04-learn-from-absence}.md`.
