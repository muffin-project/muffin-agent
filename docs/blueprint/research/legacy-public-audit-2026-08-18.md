# Old Muffin + public surfaces audit — 2026-08-18

> Snapshot dated. Questo documento raccoglie ciò che vale recuperare dal vecchio
> `GiustoPiedimonte/Muffin.ai`, ciò che non va portato, e il drift fra il nuovo
> runtime e le superfici pubbliche `muffin-public-docs` / `giusto.dev`.
>
> Non è una roadmap. Le conclusioni durevoli sono ingerite in
> `docs/foundations/VISION.md`, `docs/THESIS.md`, `docs/EXTENSIONS.md`,
> `docs/OPEN-SOURCE-STRATEGY.md` e `docs/PUBLIC-NARRATIVE.md`.

## 1. Verdetto sul vecchio Muffin

Non esiste un grande sottosistema legacy da portare nel rebuild.

Il rebuild ha ragione a non importare dream-cycle, awareness stack, predictor,
self-narrative tables o vecchio executive come blocchi. Quello che il vecchio
repo conserva bene sono **proprietà di esperienza** e idee di use case che il
nuovo core rischia di dimenticare mentre perfeziona le primitive.

### KEEP come product property, non come port

#### Presenza proattiva con silenzio come default

`context/HEARTBEAT.md` aveva una definizione concreta e buona:

- thread irrisolti;
- intenzioni dichiarate ma ferme;
- cose che spariscono dalla conversazione;
- cambi di ritmo;
- pattern emergenti;
- niente check-in generici;
- il tempo passato da solo non è motivo per disturbare;
- se non c'è una osservazione specifica, silenzio.

Questa forma è migliore di "manda messaggi proattivi". Nel nuovo Muffin va
misurata dopo Day1 come qualità di Presence, senza ricreare per forza HEARTBEAT o
l'awareness loop.

#### Chiudere loop conversazionali

`docs/ideas.md` nomina esplicitamente il failure: Muffin lasciava una domanda o
un heartbeat aperto e non lo riprendeva più.

Il nuovo Work State rende il problema strutturalmente più risolvibile. Va però
provato come experience property:

> un thread che Muffin ha dichiarato importante non evapora solo perché una
> sessione finisce.

Non serve una nuova tabella se todo/work/continuation possono esprimerlo.

#### Skill-maker / apprendimento delle routine

Il vecchio executive immaginava:

> "ho notato che fai spesso questa cosa, vuoi che impari a farla?"

L'idea resta forte, ma la nuova forma è migliore:

- se le capability esistono già → skill locale;
- se manca authority/capability → suggerisci una extension community;
- mostra permission diff;
- l'apprendimento non inventa nuovi permessi.

Questa proprietà è ora in `docs/EXTENSIONS.md`.

#### Knowledge artifacts come file reali

La vecchia roadmap voleva liste, note, idee e progetti come file veri sul
filesystem dell'owner, leggibili anche senza Muffin.

Questa idea è molto coerente col moat aggiornato:

- portabilità;
- no vendor lock-in;
- dati curabili a mano;
- sopravvivenza al runtime.

Non è Gate1. Dopo dogfood va rivalutata contro i fallback reali e contro la
Muffin Capsule: alcune rappresentazioni utili all'owner possono essere file
canonici, mentre indici/summary restano derivati.

#### Pre-task epistemic check

Vecchia idea:

> cosa devo sapere per fare questa task? lo so? è fresco? se no, recuperalo.

Non va implementata come un nuovo planner rigido. È però una buona property di
reasoning da misurare:

- non agire da memoria stale quando il dato è time-sensitive;
- distinguere "so", "ricordo", "sto inferendo", "devo controllare";
- usare retrieval/web/tool quando la freshness lo richiede.

Può vivere come eval/prompt/capability composition prima che come modulo.

#### Multi-surface ambient presence

Il vecchio repo aveva già intuito che Telegram non sarebbe stata l'identità del
sistema: menubar, push, voce, device ambient.

Il nuovo principio surface-agnostic è una generalizzazione migliore. La lezione
legacy utile è UX: una nuova surface deve rendere più naturale **raggiungere lo
stesso Muffin**, non creare una seconda esperienza da sincronizzare.

#### Cold-start honesty

Il vecchio framework documentava correttamente che living profile, counterpoint,
pattern e comprensione non esistono magicamente il primo giorno.

Il nuovo import-first riduce il cold start, non elimina il warm-up. Un archivio
Gmail o ChatGPT porta evidence storica; non equivale ad aver osservato davvero
l'owner durante l'uso del nuovo agente.

### MAYBE, solo se l'uso lo richiede

#### Self-narrative

L'idea "Muffin sa come è cambiato Muffin" è interessante. La vecchia
implementazione dedicava schema, dream phase, tool e cockpit.

Non portare quella struttura.

Il nuovo runtime possiede fonti più forti:

- risposte/turni;
- effect journal;
- correzioni;
- work completato/fallito;
- owner feedback;
- identity/voice versionate.

Se dopo tenure reale emerge valore nel chiedere "come sei cambiato?", costruire
una vista derivata da queste fonti. La storia di sé non deve diventare un blob
che Muffin crede perché l'ha scritto Muffin.

#### Background thinking / continuous-light loop

Interessante per Presence e anticipazione, ma rischia costo, rumore e una seconda
macchina cognitiva parallela.

Prima servono use case reali in cui:

- lavoro in background riduce latenza o fallback;
- un evento esterno richiede rivalutazione;
- un job già durevole non basta.

Non accendere un loop continuo per dimostrare che Muffin "vive".

### DROP come architettura da copiare

#### Day/night come divisione strutturale

Sleep-time compute resta un pattern utile per batch costoso. Non è una ontologia
del sistema. Consolidamento può girare quando conviene; il cervello non deve
imitare il sonno.

#### Predictor → Scheduler → Decider come forma obbligatoria

Era una soluzione a proattività/presenza. Il rebuild possiede scheduler, work,
world state e policy più generali. Se un predictor futuro serve a un consumer
reale, entra come capability/derived state, non perché il vecchio diagramma lo
aveva.

#### Living profile/counterpoint come fonte autorevole

Come viste derivate possono essere utili. Non devono diventare un secondo
substrato o una narrativa che sovrascrive l'evidenza.

#### "Raw immutable forever"

Corretto solo come default di audit. L'owner deve poter dimenticare contenuto.
Tombstone/metadata possono prevenire resurrezione senza conservare per sempre il
payload cancellato.

## 2. Una vecchia idea che oggi è più forte: rebuild derivatives

`docs/strategy/FRAMEWORK.md` aveva già il concetto di "wipe derivati, rigenera
dal raw".

Con la nuova distinzione canonical/derived questa idea diventa più generale:

```text
Muffin Capsule / canonical evidence
        ↓
rebuild
        ↓
FTS + vectors + summaries + beliefs/materialized views
```

Pre-public-release va considerato un vero comando/test di recovery, non un
meccanismo memory-specific.

## 3. Un vecchio avvertimento che resta attuale

`docs/ideas.md` scriveva esplicitamente:

> bias verso pensiero/architettura > esecuzione

ed anche:

> quando senti che serve struttura nuova, chiediti se la vuoi mantenere viva o
> la stai creando perché ti serve pensare.

Il nuovo workflow FAST/STANDARD/CRITICAL e il dogfood-first sono una risposta
migliore. Il rischio però non è sparito: memory architecture e documentazione
restano superfici dove il progetto può produrre architettura più velocemente di
quanto produca esperienza utente.

## 4. Public docs: cosa raccontano oggi

`muffin-public-docs` è un documento molto ben scritto, ma descrive il Muffin H1
2026 come current state.

Claims oggi stale o troppo assolute:

- "l'unico moat possibile" = dataset;
- "Apple non saprà mai" quanto un agente personale;
- schema + embedding nel substrato immortale;
- dataset non si resetta mai;
- focus comprensione, non capability;
- inferenza/configurazione come opposizione forte;
- awareness loop come architettura corrente;
- dream cycle/living profile/counterpoint come strutture correnti;
- open source solo dopo consolidamento narrativo;
- impossibilità attuale di contribuire come scelta di metodo.

Claims che restano preziose:

- modelli/harness/protocolli convergono;
- continuità temporale conta;
- provenance e temporalità;
- "specchio con carattere" come tono/relazione, non come intera product thesis;
- default silenzio nella proattività;
- audit dichiarato-vs-reale;
- una voce riconoscibile;
- single-owner data sovereignty;
- external irreversible effects meritano un confine forte.

## 5. giusto.dev amplifica lo stesso snapshot

La pagina Muffin e le superfici machine-readable del portfolio ripetono:

- awareness loop;
- sette layer;
- moat del dataset;
- inference interamente locale come direzione;
- dream cycle;
- raw che non si cancella;
- vecchio doppio contesto private/group.

Questa è una superficie reputazionale: chi legge il sito può ragionevolmente
assumere che quelle siano le scelte del progetto corrente.

Inoltre `public/llms.txt` presenta Muffin con la stessa architettura, quindi il
claim stale può essere ingerito direttamente da sistemi AI anche se una persona
non apre mai la pagina visuale.

Conseguenza: quando migriamo la narrativa bisogna aggiornare pagina + llms + docs
insieme. Decisione persistita in `docs/PUBLIC-NARRATIVE.md`.

## 6. Non riscrivere il passato

I docs pubblici hanno già valore proprio perché mostrano un percorso di design.
La scelta preferita è una di queste:

- archiviarli come `H1-2026` e creare una current edition; oppure
- banner storico + nuovo capitolo "current rebuild".

Non editare vecchi testi facendo sembrare che nel marzo 2026 pensassimo già le
cose corrette ad agosto.

La correzione è parte della storia di Muffin.

## 7. License conflict da risolvere pre-public

Il vecchio `docs/ideas.md` registra come decisione:

- PolyForm Noncommercial 1.0.0;
- DCO;
- trademark policy;
- rifiuto MIT/AGPL/SSPL/BSL.

Il nuovo `package.json` dichiara MIT.

Queste due cose non possono restare entrambe implicite.

Se il progetto vuole chiamarsi realmente **open source**, una restrizione
non-commerciale non è coerente con l'Open Source Definition. Se invece vuole
bloccare l'uso commerciale senza accordo, va chiamato source-available e va
accettato il tradeoff di community/ecosystem.

Non decidere in questa research note. Aprire decisione esplicita prima della
public alpha, considerando almeno:

- MIT/Apache-style permissive;
- AGPL/copyleft se l'obiettivo è reciprocità del codice;
- source-available/noncommercial se la protezione commerciale pesa più della
  definizione e dell'ecosistema open-source;
- trademark policy separata dal copyright license;
- contributor agreement/DCO secondo il modello di governance scelto.

## 8. Nuova opportunità: la documentazione pubblica è già distribution

Il progetto non parte da zero quando il codice si apre. Esiste già un pubblico
che legge e analizza il design.

Questo suggerisce una trusted alpha più intelligente:

- scegliere almeno alcuni tester fra persone che hanno già capito la tesi;
- separare chi testa install/UX da chi vuole discutere architettura;
- usare i docs come filtro di self-selection;
- pubblicare errori/correzioni come parte del valore del progetto;
- trasformare gradualmente lettori in contributor, non cercare co-maintainer a
  freddo.

La forza qui non è un funnel. È avere una community che arriva dal problema e
dalle idee prima che dal catalogo di feature.

## 9. Decisione di sintesi

Il vecchio Muffin non va portato.

Va **interrogato**.

Ogni elemento legacy deve ricevere una delle quattro risposte:

```text
property da preservare
use case da riprovare
view derivata da ricostruire se utile
meccanismo storico da lasciare morto
```

Questo evita sia nostalgia architetturale sia amnesia di prodotto.