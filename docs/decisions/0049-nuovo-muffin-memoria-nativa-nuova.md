# ADR-0049 — Il nuovo Muffin nasce con memoria nativa nuova

**Stato:** accettato · 2026-08-19 · decisione owner durante il refactor della
gerarchia documentale

## Contesto

La roadmap del rebuild ha conservato una decisione storica: re-ingestire un
export del vecchio `muffin.db` come parte del passaggio al nuovo agente. Nel
frattempo la semantica della memoria è cambiata in modo sostanziale.

Il nuovo sistema distingue esplicitamente:

- evidence da beliefs;
- speaker/actor da trust tier;
- world time da system time;
- `said` da `inferred` e `imported`;
- dati canonici da profili, digest, embedding e altri derivati ricostruibili.

Una migrazione automatica del vecchio database non sarebbe quindi una semplice
copia. Dovrebbe decidere quali interpretazioni legacy sono evidence, quali sono
belief, quale provenienza assegnare a dati che non la registravano e quali
artefatti derivati meritano di diventare nativi nel nuovo sistema. Farlo per
inerzia renderebbe il nuovo schema più preciso solo in apparenza: l'incertezza
storica verrebbe nascosta dietro colonne nuove.

L'owner non vuole questo come requisito di cutover.

## Decisione

**Il nuovo Muffin parte con memoria nativa nuova.**

Il vecchio Muffin è il predecessore del progetto e resta un archivio/lineage
consultabile, non una sorgente che il DAY-1 deve importare automaticamente nel
nuovo evidence plane.

Quindi:

1. la memoria personale nativa della nuova generazione comincia dal primo
   evidence acquisito dal nuovo Muffin;
2. il Gate 1 non contiene un requisito "migra il vecchio `muffin.db`";
3. vecchi profile, counterpoint, observation, self-narrative, embedding, belief
   graph o confidence non vengono promossi a verità native del nuovo sistema;
4. repo, database ed export legacy possono essere conservati separatamente per
   storia, consultazione o ricerca;
5. un eventuale importer futuro deve essere **esplicito e opt-in** e trattare il
   materiale legacy come una fonte importata con provenance dichiarata, non come
   se fosse nato sotto le semantiche nuove;
6. un importer futuro è una capability di acquisizione dati, non parte
   dell'identità del core.

## Cosa significa per la continuità

Questa decisione non dice che la continuità personale è sacrificabile.
Definisce **il confine di nascita di questa generazione**.

Muffin come progetto, identità e voce ha una lineage; i dati personali nativi del
nuovo agente iniziano invece sotto il nuovo contratto di evidence/provenance.
Da quel momento in poi la promessa diventa severa: sostituire modello, provider,
harness, device o rappresentazione fisica non deve richiedere un reset della
continuità accumulata dal nuovo Muffin.

Questo rende anche falsificabile la futura portabilità: prima dobbiamo saper
preservare correttamente dati prodotti **da questa semantica**, invece di
nascondere nel primo dataset una migrazione ambigua da una semantica differente.

## Conseguenze documentali

- `docs/blueprint/04-roadmap.md` resta prova storica che il re-ingest legacy era
  stato considerato; durante il refactor documentale quella riga non deve più
  essere letta come requisito corrente.
- `docs/ARCHITECTURE.md` può dichiarare il fresh start come proprietà corrente.
- Una futura "Muffin Capsule" / export canonico riguarda la continuità **dopo**
  questo confine e deve preservare semantica, non necessariamente schema,
  embedding o indice fisico.

## Alternative scartate

### Importare tutto e riestrarre

Preserva più testo ma costringe comunque a inventare provenance/actor/semantica
per righe che non le avevano. Inoltre rende il DAY-1 dipendente da un importer
usato una sola volta dall'owner iniziale.

### Importare soltanto i messaggi legacy come evidence

È la forma meno pericolosa di migrazione e resta tecnicamente possibile come
capability futura. Non è però necessaria per il cutover desiderato dall'owner e
quindi non entra nel Gate per prudenza astratta.

### Migrare i belief/profile legacy

Scartato. Sono interpretazioni prodotte da un sistema con regole diverse. Se un
giorno servono come materiale storico, vanno presentate come output legacy, non
come belief native.

## Reversibilità

Alta. Nessun dato viene cancellato e nessun formato viene reso incompatibile.
La decisione rimuove un obbligo automatico; un importer esplicito può essere
aggiunto in seguito se un use case reale lo giustifica.

Il segnale per rivederla non è "abbiamo ancora il vecchio database". È un uso
reale in cui l'assenza di un import esplicito produce valore perso sufficiente da
giustificare il costo epistemico della migrazione.