# Muffin — public narrative e superfici esterne

> **Stato: DIREZIONE DI PRODOTTO · owner 2026-08-18.**
> Questo documento governa ciò che Muffin racconta pubblicamente di sé. Non è
> marketing copy definitivo. Esiste perché `muffin-public-docs`, `giusto.dev` e
> superfici machine-readable sono già fonti che persone e agenti usano per
> capire il progetto, mentre il runtime è stato ricostruito con una forma diversa.

## 1. Il problema

Le superfici pubbliche attuali raccontano soprattutto il Muffin H1 2026:

- moat = dataset accumulato;
- awareness loop Predictor/Scheduler/Decider;
- dream cycle notturno come struttura;
- living profile/counterpoint/self-narrative;
- sette layer di memoria;
- inferenza in transizione verso completamente locale;
- open source subordinato alla maturità narrativa di "specchio con carattere";
- focus sulla comprensione più che sulle capability.

Quella storia contiene idee ancora valide, ma non è una descrizione affidabile
del runtime che stiamo costruendo oggi.

Il rischio non è solo umano: `giusto.dev` pubblica anche superfici come
`llms.txt`, quindi una descrizione stale viene ingerita direttamente da motori e
agenti che poi la ripetono come current state.

## 2. Non cancellare il vecchio: versionarlo

I public docs hanno valore come storia di ricerca. Cancellarli o riscriverli
retroattivamente perderebbe proprio la qualità che Muffin dichiara di voler
avere: una storia che mostra correzioni e cambi di idea.

Preferenza:

```text
Muffin public docs
├─ Current / vNext
└─ Archive / H1 2026
```

oppure un banner inequivoco sui documenti esistenti:

> Historical architecture snapshot — H1 2026. Muffin is being rebuilt around
> durable turns, work/effects, authority, provenance and portable continuity.
> Some mechanisms below are historical experiments, not current runtime claims.

Il commit originale resta citabile.

## 3. Claims che devono migrare

### Da "dataset come unico moat"

A:

> **qualità, sovranità e portabilità della continuità.**

Il dataset grezzo può essere ricco anche presso grandi vendor. La differenza da
provare è che storia, provenance, correzioni, lavoro, effetti, costituzione e
authority restano dell'owner e sopravvivono a provider, modello, surface e
macchina.

### Da "Apple non potrà mai conoscermi così"

A:

> un vendor può conoscere moltissimo; Muffin deve garantire che la continuità
> non dipenda dal vendor.

La superiorità non va fondata su un limite competitivo che può scomparire.

### Da "non è un assistente di produttività"

A:

> **non è un productivity optimizer, ma può fare lavoro produttivo reale.**

Email, calendar, browser, file e processi sono capability coerenti con la
visione quando sostituiscono interfacce che l'owner dovrebbe altrimenti gestire
direttamente. Il carattere e il punto di vista non richiedono impotenza.

### Da "local inference come destinazione obbligata"

A:

> **data sovereignty + local-capable + provider egress esplicito.**

Un owner può scegliere un frontier model cloud. Deve sapere cosa gli viene
inviato, poter marcare contenuto local-only e poter aggiungere privacy transforms
locali quando utili.

### Da "dream cycle / awareness loop = l'architettura"

A:

> erano esperimenti e implementazioni del vecchio sistema. Le proprietà durevoli
> sono continuità, presenza, consolidamento quando serve, work persistente,
> provenance e capacità di parlare/tacere con criterio. Il meccanismo può cambiare.

### Da "il codice si apre quando la voce è abbastanza consolidata"

A:

> Gate 1 owner → 14 giorni reali → trusted alpha → public alpha quando install,
> update, security boundary e contributor path sono comprensibili a un estraneo.

La voce resta importante; non è più il release gate principale.

## 4. Le superfici vanno aggiornate insieme

Una modifica pubblica su Muffin è incompleta se aggiorna solo la pagina visuale.

Checklist minima:

- `muffin-public-docs` README + capitoli interessati;
- roadmap/FAQ pubbliche;
- `giusto.dev/lavori/muffin`;
- eventuale card progetto/Home/About che ripete claims;
- `llms.txt`;
- `llms-full.txt`;
- metadata/structured data/SEO;
- link alla source of truth corrente.

**Machine-readable docs sono parte della documentazione pubblica**, non materiale
secondario.

## 5. Public docs come asset di community

Il fatto che persone analizzino già i documenti prima che il codice sia pubblico
è un vantaggio distributivo raro.

Non trattarli soltanto come marketing. Possono diventare:

- research log pubblico;
- spiegazione delle scelte architetturali;
- fonte di contributor interessati al problema, non solo alla codebase;
- archivio delle decisioni superate;
- ponte verso trusted alpha;
- materiale per benchmark/eval riproducibili.

La community può arrivare prima del marketplace. Non deve però influenzare il
core attraverso popularity contest: le feature entrano per use case/evidenza e
le extension tengono la breadth fuori dal kernel.

## 6. Il momento giusto per la migrazione

Non aggiornare ogni pagina mentre Gate 1 cambia quotidianamente.

Sequenza consigliata:

1. la #73 raccoglie la direzione corrente;
2. Day1 chiude la forma minima del nuovo runtime;
3. durante i 14 giorni raccogliamo wording ed esempi realmente osservati;
4. prima della trusted alpha aggiorniamo `muffin-public-docs` e `giusto.dev` in
   un pass coerente;
5. prima del public alpha le public docs puntano alla codebase e distinguono
   chiaramente current, experimental e historical.

## 7. Regola di onestà

Una pagina pubblica può parlare di una **visione** o di una **capability corrente**,
ma deve distinguere le due.

Preferire etichette del tipo:

```text
CURRENT
DOGFOOD
EXPERIMENTAL
PLANNED
HISTORICAL
```

ad una prosa in cui un meccanismo prototipato una volta appare ancora come una
garanzia di produzione mesi dopo.

La narrativa pubblica deve rispettare la stessa regola del repo:

> una decisione documentata non prova che il runtime la implementi.