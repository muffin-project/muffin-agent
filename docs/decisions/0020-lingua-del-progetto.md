# ADR-0020 — Lingua: inglese verso l'esterno, italiano dove si pensa e si parla

**Contesto.** Muffin è un agente **italiano** — parla italiano all'owner, e la sua persona è scritta in italiano. Il repo è open source e si rivolge a sviluppatori internazionali. Sono due pubblici con bisogni opposti, e la tentazione (tenere tutto bilingue) è la peggiore delle opzioni: doppia scrittura, deriva garantita tra le due versioni, nessuna delle due autorevole.

**Decisione.** Una lingua sola per ogni artefatto, scelta in base a **chi lo legge**:

| Artefatto | Lingua | Perché |
|---|---|---|
| Codice: identificatori, nomi file, tipi, commenti | **Inglese** | Un contributore deve poterci lavorare; il codice misto è illeggibile per tutti |
| Commit, PR, issue | **Inglese** | Storia pubblica del progetto |
| README, CONTRIBUTING, ARCHITECTURE, guida all'installazione | **Inglese** | È la vetrina: chi valuta il progetto legge questi |
| Help della CLI, messaggi di errore, log | **Inglese** | Sono interfaccia tecnica, e finiscono negli screenshot delle issue |
| `identity.md`, `voice.md`, `user.md`, prompt di sistema | **Italiano** | Sono la persona: Muffin pensa e parla in italiano all'owner |
| Descrizioni delle skill (`SKILL.md` frontmatter), descrizioni dei tool | **Inglese** | Le legge il modello per decidere, e il formato ha un ecosistema internazionale |
| ADR e documenti di design (questo blueprint) | **Italiano** | Sono il ragionamento dell'owner con se stesso: scriverli in una lingua non sua rallenta il pensiero e introduce imprecisione |
| Output all'utente | **Italiano** per l'owner; la lingua dell'interlocutore altrove | È un agente personale, non un prodotto localizzato |

Due regole di igiene: (1) **mai lo stesso contenuto in due lingue** — se serve la versione inglese di un ragionamento, va nell'`ARCHITECTURE.md` come *conclusione*, non come traduzione dell'ADR; (2) i file della persona sono **template in italiano nel repo** e diventano personali nell'installazione (ADR-0011) — chi installa da un'altra lingua sostituisce il template, non traduce il codice.

**Sulla lingua dei prompt — verificato (B2, mandato 6): non esiste evidenza controllata in nessuna direzione.** Le tre fonti più citate dai blog tecnici sono state aperte una per una e **nessuna contiene la misura**: sono opinion-piece che citano studi su altre variabili (MMLU tradotto, editing post-traduzione). L'unico filone con numeri propri è **XLT / Cross-Lingual Thought** (EMNLP 2023, +10 punti medi su 7 benchmark), ma misura una cosa diversa: l'istruzione esplicita "ragiona in inglese, poi rispondi nella lingua richiesta" — una tecnica attiva, non la scelta passiva della lingua del prompt. Sul tool-calling, lo studio più vicino ("Lost in Execution", 2026) misura l'effetto di tradurre la *query utente* tenendo schema e system prompt in inglese, su cinese/hindi/igbo — italiano assente. **Conclusione: è folklore, in entrambe le direzioni.** Chi dice "il prompt va in inglese" non ha più evidenza di chi dice il contrario.

**Sulla lingua dei prompt.** L'owner ha deciso: prompt in italiano. È coerente (la persona è italiana, e un prompt inglese che chiede output italiano introduce una traduzione implicita a ogni turno). Se la ricerca trovasse un costo misurabile — tool-calling o aderenza peggiori con system prompt italiano su qualche modello — **non si inverte la decisione: diventa un caso della suite di eval** (`05`), misurato per modello, e semmai un dettaglio del profilo per-modello. Un modello che regge male l'italiano nel prompt è un modello che non passa il floor, non un motivo per rendere Muffin inglese.

**Alternative scartate.** *Tutto inglese*: coerente per l'open source, ma la persona di Muffin in inglese è un'altra persona — e l'owner scriverebbe i propri ADR in una lingua che gli costa attrito, peggiorando la qualità del pensiero che quegli ADR servono a preservare. *Tutto italiano*: chiude il progetto a chiunque non sia italiano, sprecando la parte "artefatto pubblico". *Bilingue ovunque*: doppia manutenzione e deriva; il progetto ha già una regola contro il double-write.

**Conseguenze.** Più facile: il repo è valutabile e contribuibile da fuori senza tradurre nulla di essenziale; la persona resta autentica. Più difficile: un contributore che voglia capire *perché* una scelta è stata fatta trova l'ADR in italiano — mitigato dall'`ARCHITECTURE.md` inglese che porta le conclusioni, ma è un attrito reale e va accettato consapevolmente.

**Reversibilità.** Alta per la documentazione (tradurre gli ADR è lavoro meccanico, delegabile a Muffin stesso), media per il codice (rinominare identificatori è meccanico ma tocca tutto), bassa per la persona (tradurre `voice.md` significa cambiare il carattere, non la lingua). Segnale che era sbagliata: contributori esterni reali che aprono issue chiedendo il *perché* di scelte già documentate — vorrebbe dire che l'`ARCHITECTURE.md` inglese non sta portando abbastanza, e va ingrossato prima di tradurre gli ADR.
