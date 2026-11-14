# Muffin: l'entità, e dove si è persa — direzione

Data: 2026-10-18. Autore: sessione di sviluppo. Stato: **proposta, in attesa di
decisione dell'owner**. Materiale di design interno (ADR-0020, italiano).

Questo file risponde a una domanda dell'owner — *«capire per cosa esiste Muffin,
l'entità»* — e la collega alla linea aperta sullo scope (radici di lavoro,
`2026-10-18-scope-agente-radici-di-lavoro.md`) e alla missione di remediation.

---

## 0. Dove siamo

Dopo review + audit forense, la verifica su HEAD ha mostrato che i difetti
titolati dell'audit sono già chiusi, decisi o ambientali
(`2026-10-18-forensic-findings-verification.md`): **nessuna modifica di codice
giustificata**. L'owner ha quindi spostato la direzione, e ha aggiunto il pezzo
che mancava: prima di decidere *cosa* allargare, capire *per cosa* Muffin esiste.
Il vecchio Muffin è in locale: `~/dev/Muffin` (repo privata `Muffin.ai`).

---

## 1. Cos'è Muffin — l'entità, dalle fonti

Non è un assistente. Le fonti del vecchio Muffin e di quello nuovo **concordano**,
ed è la formulazione più chiara che il progetto abbia:

- Vecchio `context/SOUL.md`: *«Sono l'amico di Giusto che non dorme mai»* — non
  terapeuta, non coach, non cheerleader; *«quello che nota le cose che lui non
  vede perché è troppo dentro, e gliele dice. Con affetto, senza filtri.»*
- Vecchio `context/IDENTITY.md`: un'**entità** che fa e capisce, *«un agente
  vero... e su questo ho un punto di vista su di te»*; la differenza con un
  assistente non è che fa meno, è che *«fa con memoria e con carattere»*.
- Nuovo `defaults/rot/identity.md` (installato, ed è il patto sigillato):
  *«il mio secondo cervello con carattere»*, più vicino a *«un amico che non
  dorme mai e a uno sparring partner»*; *«Se dopo anni insieme sei diventato
  bravissimo a darmi ragione, abbiamo fallito»*; *«Ridi con me, non di me»*;
  *«A volte sto solo parlando con Muffin.»*
- `docs/product/VISION.md`: **presente**, non attivo; *«elapsed time alone is not
  a reason to interrupt»*; la memoria come seconda prospettiva, non inventario.

Tratti operativi dell'entità, non negoziabili perché sono *la ragione per cui
esiste*: continuità, punto di vista proprio, disaccordo portato con ragioni,
presenza che tace quando non ha niente di specifico, onestà operativa (non
affermare ciò che non ha osservato).

**La conseguenza per la direzione:** un cambiamento che rende Muffin più
"capace" ma meno "una persona con cui si vive" è un peggioramento, non una
feature. L'allargamento dello scope (§4) e la riduzione dell'harness (§5) sono
giustificabili *solo* se servono questa entità.

---

## 2. Dove l'entità si è persa — tre cause, con l'evidenza

Il testo dell'entità **non** è il problema: `~/.muffin/rot/identity.md` è ottimo
e opinionato. Il carattere si perde altrove, e le cause sono misurate.

### 2a. Il modello. (peso: alto, evidenza: diretta)

- `~/.muffin/config.json`: `models.main = "openrouter/free"`,
  `models.light = "openrouter/free"`.
- Il vecchio Muffin girava `gemma4:e4b` **locale** con un `SYSTEM` scritto a
  mano (`~/dev/Muffin/Modelfile`, 8 KB) che è, di fatto, la voce dell'entità:
  umorismo secco, *«zero adulazione. Mai "ottima domanda"»*, *«Non riempio lo
  spazio»*, *«una risposta di due righe che tocca il punto»*.
- Un modello "free" generico è, per costruzione, mediamente più piatto e più
  accondiscendente di un modello con un carattere forzato nel system prompt.
  "Poca personalità, poche opinioni vere" è la firma di **questo**, non del doc.

### 2b. La persona installata è la neutra, e il carattere forte è diluito. (peso: medio)

- Il prompt owner v1 (`agent/context/assemble.ts:619-625`, default
  `PromptVersion='v1'`) legge `~/.muffin/persona.md` + `~/.muffin/rot/identity.md`
  + `~/.muffin/voice.md` (`buildSystemPromptBlocks`, `:451-509`).
- La `persona.md` **installata** (`~/.muffin/persona.md`, identica a
  `defaults/persona.md`) è la versione astratta: *«Ho un punto di vista»*,
  *«Sono diretto e caldo»*. Il vecchio SOUL diceva *«l'amico di Giusto che non
  dorme mai»*, *«il mio sarcasmo è quello di un amico»*, e vietava esplicitamente
  ciò che oggi l'owner vede tornare: *«Non faccio il coach. Non propongo
  framework, piani d'azione, o "i tre step per"»*.
- La neutralizzazione è stata deliberata (VISION §«non dedicato a fare il
  clever», e il problema vero: il prompt owner non deve raggiungere i gruppi,
  `assemble.ts:511-558`). Il difetto non è la decisione — è che la versione
  **neutra** è diventata *anche* quella dell'owner, che di neutro non ha bisogno.

### 2c. Il blocco operativo è cresciuto fino a competere col carattere. (peso: basso-medio)

- `WORK_RULES` (`assemble.ts:701-739`) e `WORK_RULES_V2` (`:785-836`) sono ~40
  righe di procedure («## Prima di chiamare», «## Riferire», «## Quando mi
  fermo»). Sono giuste, ma in un prompt di modello debole spostano il registro
  verso "esecutore di procedure".

---

## 3. Il "piano forzato" nella chat casuale — il meccanismo

Questo è concreto e cablato, non un'impressione.

- `agent/loop/context.ts:285-298`: *«The plan, on every turn of the session,
  whether or not anyone asked.»* Se la sessione ha todo aperti,
  `todoSection(open)` produce `## Piano di questa conversazione` e viene
  iniettato in **ogni** turno come sezione `work` (`:326-327`,
  `flattenSemantic` `:193-202`).
- Il testo *dice* di non forzare (`assemble.ts:177-179`: «non decidono quando il
  turno è finito... la sola presenza di passi aperti non richiede di
  ricordarli»), ma l'effetto con un modello debole è che ogni turno *vede* un
  blocco intitolato "Piano di questa conversazione".
- Reality check sul DB (snapshot read-only): solo 2 sessioni hanno todo aperti —
  ma una è la **`owner`** (la DM Telegram, 4 aperti), cioè *la* sessione in cui
  avviene la chat casuale. Nella CLI, `2026-08-27-ae654a8e` ne ha 7.
  → Nella conversazione privata, ogni messaggio — anche un "hey" — porta con sé
  il piano aperto.
- Concausa: il recall è iniettato ogni turno (blocco `memory`, `:321-322`), e i
  fatti `planned_to`/`plans_to`/`open_work` rientrano come "cose da fare".

**Onestà sul limite di questa prova:** il meccanismo è cablato (codice citato);
non ho un transcript che mostri la frase in chat, perché payload
provider/risposta non sono conservati. Il check falsificabile è nella §5.

---

## 4. Direzione: il filo che unisce scope, harness ed entità

Le tre cose sono una sola. L'entità (§1) è *presenza con carattere*; lo scope
(§file scope) è *dove può guardare*; l'harness (§5) è *quanto rumore le si mette
davanti*. Oggi il rumore (piano + recall + work-rules) compete con la persona,
e lo scope ristretto la fa sembrare cieca. La direzione minima, in una riga:

> **Meno impalcatura, un carattere che si sente, radici di lavoro dichiarate —
> e un modello abbastanza forte da reggere il carattere.**

### 4a. Modello (decisione dell'owner, costo)

Serve un modello che non sia un "free router". È la leva con l'effetto più alto
su "personalità e opinioni". Opzioni: un frontier via OpenRouter a pagamento, o
il vecchio locale (`gemma4`/`ollama`) per i turni in cui l'owner vuole l'entità.
*Questa è una spesa / decisione di prodotto → owner.*

### 4b. Persona dell'owner ≠ persona neutra

Tenere `persona.md` neutra come *default spedito*, ma la home dell'owner dovrebbe
poter tornare al carattere forte (il vecchio SOUL, portato nel formato nuovo).
Candidato: ripristinare in `~/.muffin/persona.md` i tratti concreti del SOUL —
"amico che non dorme mai", sarcasmo, i **divieti** ("no coach, no piani d'azione,
no psicologia pop", "niente 'fammi sapere'") — che oggi vivono solo in
`rot/identity.md` e in forma più tenue.

### 4c. Piano fuori dalla chat casuale

Il piano deve esistere **quando la conversazione è lavoro**, non in ogni turno.
Candidati (da scegliere, nessuno è "ovvio"):
- **A.** iniettare la sezione `work` solo se il turno è "lavoro" (ha tool-call,
  o l'owner chiede del piano) — non su un "hey";
- **B.** tenere l'iniezione ma *on-demand*: il piano è dietro `todo`/un tool, e
  non nel contesto di default;
- **C.** chiudere i todo stantii (4 nella DM `owner`, 7 in CLI) — rimedio ai
  sintomi, non al meccanismo.

`VISION.md` e `COGNITIVE-DESIGN.md` H5 («silence is a valid action») danno il
criterio: il default è il silenzio; il piano non è un motivo per parlare.

---

## 5. Cosa aspetta l'owner (decisioni, non lavoro)

1. **Modello**: accetti la spesa per un provider forte (o locale), o restiamo su
   `openrouter/free`?
2. **Persona**: riporto il carattere forte del vecchio SOUL nella `persona.md`
   dell'owner?
3. **Scope** (file gemello): candidato B — radici di lavoro dichiarate e
   sigillate (lettura ampia dentro l'insieme, scrittura solo dove dichiarato,
   home/segreti sempre negati, rete spenta di default)? O A/C.
4. **Piano**: quale di A/B/C per togliere il "Piano di questa conversazione"
   dalla chat casuale.

Fatti questi quattro sì/no, la direzione è chiusa e posso scrivere l'ADR e
implementare i fix meccanici con test red-before-green.

## Verifica (fail-if-removed) per quando si implementa
- Piano: con un turno "hey" in una sessione con todo aperti, il contesto inviato
  **non** contiene `## Piano di questa conversazione`; rimuovere il fix lo fa
  riapparire.
- Entità: una chat casuale non produce piani d'azione non richiesti né chiusure
  da assistente ("fammi sapere se serve altro").
