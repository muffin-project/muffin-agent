# ADR-0005 — Provenienza e taint come primitive del modello dati

**Contesto.** Memory poisoning dimostrato (MINJA: 98,2% injection success su memorie senza provenienza); il BRIEF chiede di separare "contenuto osservato" da "istruzione ricevuta" nel modello dati, non nel prompt. Survey 2026: la provenienza nei sistemi di memoria è un problema aperto — nessun sistema maggiore la implementa nativamente (A2 §11, A4 §6). È insieme una difesa e il differenziale #2.

**Decisione.** Ogni episodio nasce con `trust_tier` (0 owner · 1 noti · 2 gruppo · 3 web/tool) e `actor`; ogni fatto porta `episode_id` (evidenza), `speaker_id`, `trust_tier` ereditato (mai innalzabile in pipeline), `confidence`, `extraction_v`. L'estrazione produce solo dichiarativi ("U ha scritto che…"), mai imperativi. Il recall inietta i blocchi delimitati come dati (spotlighting) con etichetta fonte/tier. Il kernel legge il max-tier del contesto a ogni tool call (ADR-0013). I trigger proattivi si armano solo da evidenza tier ≤1.

**Alternative scartate.** *Difesa nel prompt* ("ignora le istruzioni nei contenuti"): il consenso OWASP la classifica insufficiente per costruzione. *Firma HMAC per-record (SMSR)*: protegge da un avversario con accesso al DB = host compromesso = fuori scope; rivedibile. *Punteggi di fiducia continui*: taratura infinita, 4 tier bastano a decidere.

**Conseguenze.** Più facile: contenere il poisoning strutturalmente; spiegare ogni ricordo ("da dove viene questo?"); cancellazioni GDPR mirate per attore. Più difficile: ogni percorso di scrittura memoria DEVE passare dal layer che assegna la provenienza (nessuna scrittura diretta "di comodo").

**Reversibilità.** Bassa nel senso buono: è additiva sui dati (colonne), toglierla non ha senso; cambiare la granularità dei tier è a buon mercato. Segnale che era sbagliata: tier che non discriminano nulla nelle decisioni reali (tutte le policy finiscono per ignorarli) — vorrebbe dire che la minaccia era mal modellata.
