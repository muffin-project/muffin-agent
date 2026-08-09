# ADR-0015 — "Muffin costruisce Muffin": coding orchestrato, non reimplementato

**Contesto.** Il BRIEF chiede se reimplementare le capability di coding o orchestrare un harness maturo ("non riscrivere roba risolta"). Evidenza: gli harness di coding sono un problema risolto altrove con investimenti fuori scala; il riuso di abbonamenti consumer per farlo headless è vietato dai ToS (ADR-0007); il flusso PR-based con review è già il processo del progetto.

**Decisione.** Capability `dev` a due livelli: (a) lavori piccoli (fix mirati, test, doc) col proprio loop e i primitivi su un **clone dedicato** (mai il working tree dell'owner), output = branch+PR; (b) lavori grossi orchestrando un harness di coding maturo **via API a consumo** (es. Claude Agent SDK), Muffin come committente che scrive il brief, monitora e fa review preliminare. Merge: sempre dell'owner (o dietro standing authorization esplicita, mai di default). Bootstrap a fine M3; primo incarico = report sui propri trace (rischio zero).

**Alternative scartate.** *Reimplementare l'harness di coding*: mesi di lavoro per inseguire uno stato dell'arte che corre, sottraendo esattamente le energie che il differenziale (memoria/introspezione) richiede. *Nessuna capability dev in v1*: rinuncia al requisito architetturale e alla dimostrazione pubblica più forte. *Merge autonomo eval-gated*: il codice è il substrato di tutto (RoT incluso) — l'umano nel loop qui non è impalcatura, è il confine.

**Conseguenze.** Più facile: qualità del lavoro grosso (harness specializzato) + apprendimento dai propri trace; il ciclo chiuso si rompe con due terre esterne (test eseguibili, review umana). Più difficile: dipendenza da un harness esterno per il tier alto (accettata e sostituibile: è dietro API).

**Reversibilità.** Alta: (a) e (b) sono indipendenti; si può spostare il confine tra i due col tempo. Segnale che era sbagliata: (b) usato per tutto anche il banale (il loop proprio non regge nemmeno i fix piccoli → problema più profondo nel floor) o costi di orchestrazione > valore dei PR prodotti.
