# 11 — Salvataggio documentale: cosa entra nell'albero nuovo

> Aperto il 2026-08-05 su richiesta owner: *"abbiamo davvero mesi di ricerca, non possiamo mica buttare tutto, però dobbiamo pensare al fatto che saremo opensource… ci sono delle gemme lì dentro"*.
>
> Questo documento fissa il **criterio** e il **metodo**. I verdetti per-file vivono nel registro (§5), che si compila in una passata meccanica.

---

## 1. La domanda giusta non è "cosa salviamo"

È già tutto salvo. Il vecchio repo resta su disco e in git history: nulla di ciò che non copiamo viene perso, resta indicizzato e recuperabile con un `git log`. La domanda vera è molto più stretta, e molto meno dolorosa:

> **cosa entra nell'albero nuovo?**

Un documento che non entra non è cestinato. È *dove sta adesso*, che per l'archeologia è il posto giusto. Questa distinzione è tutta la differenza tra un salvataggio e un trasloco: il trasloco porta tutto e riempie la casa nuova di scatole che nessuno riaprirà.

---

## 2. Tre destinazioni, non due

Il criterio è già nell'architettura (ADR-0011: i dati dell'utente vivono solo in `~/.muffin/`, un `git pull` non tocca l'identità di nessuno). Applicato ai documenti:

| Destinazione | Cosa ci va | Test |
|---|---|---|
| **`muffin-next/docs/`** — pubblico | Ciò che è vero per **qualunque** owner | Se lo legge uno sconosciuto, ha senso? |
| **`~/.muffin/`** — l'installazione di Giusto | Identità, voce, profilo owner, golden set personale | Ha senso solo perché parla di *questo* owner |
| **Il vecchio repo** — archivio | Tutto il resto | Parla di codice che sta per non esistere |

Il terzo non è un ripiego: è la destinazione **corretta** per la maggior parte del materiale, e dichiararla toglie la pressione di dover portare tutto.

---

## 3. Le gemme sono i risultati negativi

Guardando cosa ha davvero valore nei mesi di ricerca, quasi tutto ha la stessa forma — *abbiamo provato X, non ha funzionato, ecco come ce ne siamo accorti*:

- ADR-025 (triple rigide con vincoli di coerenza) aveva **corrotto 89 credenze in silenzio**;
- il supersede single-valued aveva fatto scadere per sbaglio **27 righe `interest` su 28** e **21 `preference` su 22**;
- **Thinking ON su Gemma-4 regredisce** il tool-calling invece di migliorarlo;
- **GLM-4.7-Flash**: forte su agentic-coding, **non transfer** al conversazionale;
- gli **intent classifier retrocessi a monitor-only**, due volte, per la stessa ragione;
- il **sandbox del VPS acceso da giugno che era un no-op** — il check cercava il binario invece di eseguire un contenimento;
- il **rowid `Number` invece di `BigInt`** che ha tenuto le tabelle vettoriali vuote per settimane senza un errore;
- l'**indice vettoriale che nessuno riempiva** e il **giudice di contraddizione che non vedeva mai le frasi** (trovati il 2026-08-05 costruendo M2: 0/4 verdetti utili → 4/4 con l'evidenza in pasto).

Queste sono **un paragrafo l'una**. Non sono documenti da migrare, sono frasi da raccogliere — il che rende il salvataggio economico proprio dove è più prezioso.

Ed è ciò che nessuno pubblica. Un progetto open-source pubblica l'architettura che ha funzionato, non l'elenco di cosa ha rotto e come se n'è accorto. Per un agente personale — dove la modalità di fallimento dominante è *il danno che riporta successo* — quell'elenco è la cosa più credibile che il repo possa portarsi dietro.

**Artefatto**: `muffin-next/docs/lessons.md`, ogni voce con data, evidenza e link all'ADR d'origine nel vecchio repo.

---

## 4. Categorie e verdetto atteso

`PORTA` = riscritto nell'albero nuovo · `CITA` = sopravvive come riga in `lessons.md` o in un ADR nuovo · `LASCIA` = resta nel vecchio repo.

| Materiale | Verdetto | Perché |
|---|---|---|
| `foundations/THESIS.md` | **PORTA** (chirurgia) | La tesi sul mondo e l'argomento sul moat reggono senza l'owner dentro. La parte personale è concentrata in poche righe in prima persona. Vedi §6. |
| `foundations/PRINCIPLES.md` | **PORTA** (chirurgia) | Metodologia quasi pura. P-C parla già esplicitamente "del framework": il documento aveva anticipato l'estrazione. Da rinominare i riferimenti a `SOUL.md` → `identity.md`/`voice.md`. |
| `foundations/{INVARIANTS,UNDERSTANDING,COGNITIVE_BASES,REFERENCES}.md` | **PORTA** parziale | INVARIANTS è schema-level sul DB vecchio → si riscrive sui tre piani nuovi. COGNITIVE_BASES e REFERENCES sono bibliografia: portabili quasi intatti. |
| `strategy/*` (audit vs SOTA) | **PORTA** come snapshot datati | Memory-architecture audit, agentic-OS research, foundations audit. Sono ricerca vera e citabile; vanno con la loro data perché sono fotografie. |
| `DECISIONS.md` (~156 ADR) | **CITA** in massa, `PORTA` pochi | La parte viva è già stata assorbita dal blueprint, che ha i suoi 23 ADR scritti *sul sistema nuovo*. Il resto nomina `gateway.ts`, `callChat`, flag: archeologia. Da questi si estraggono le gemme di §3. |
| `operations/INTERVENTIONS.md` | **LASCIA**, estrai le lezioni | Cronaca di un sistema che si spegne. Le lezioni sì, la cronaca no. |
| `reference/{ARCHITECTURE,DATABASE,MODULES,ENVIRONMENT,OPERATIONS,BACKUP}.md` | **LASCIA** | Descrivono il codice vecchio. I corrispettivi nuovi si scrivono dal codice nuovo, non si traducono. |
| `pitches/`, `ideas.md` | **LASCIA** | Per costruzione effimeri (ADR-003: se un'idea è importante riemerge). |
| `context/{IDENTITY,SOUL,VOICE,USER,HEARTBEAT}.md` | **→ `~/.muffin/`** | Già iniziato: `voice.md` è stato ereditato il 2026-08-05 con le sue regole rese misurabili. |
| `context/public/*` | **PORTA** valutando | Erano già scritti per essere pubblici: è il materiale con l'attrito più basso. |

---

## 5. Il registro

Una passata meccanica produce `docs/blueprint/11-registro.md`: una riga per documento con `PORTA|CITA|LASCIA` più una riga di motivo. Non richiede decisioni dell'owner e produce il numero che oggi manca — **quanto è davvero il lavoro**. Va fatto prima di cominciare a spostare qualunque cosa.

---

## 6. La decisione aperta (owner)

`THESIS.md` e `PRINCIPLES.md` descrivono un agente costruito **intorno a una persona specifica**. È la parte migliore del pensiero del progetto ed è anche la meno pubblicabile così com'è.

**(a) Spersonalizzare in una THESIS pubblica.** L'idea resta, il soggetto diventa chiunque. Costa una riscrittura vera; dà al progetto una tesi da mostrare.

**(b) Pubblicare solo la parte tecnica**, tesi vera in `~/.muffin`. Costo zero; il repo diventa un runtime senza motivo dichiarato.

**Raccomandazione: (a).** Le due gambe — agente che fa lavoro reale *e* specchio con punto di vista — non sono un'idiosincrasia dell'owner, sono una posizione di design che quasi nessun progetto nel panorama prende (vedi `research/a2` sul prior art). Vale la pena dirla in pubblico. Ma è una scelta di prodotto, non di ingegneria.
