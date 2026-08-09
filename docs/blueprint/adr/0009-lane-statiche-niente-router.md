# ADR-0009 — Collocazione: lane statiche (main/light/deep), nessun router dinamico

**Contesto.** Il BRIEF chiede se il routing è feature o impalcatura. Evidenza: post-mortem Manifest (router LLM rimosso dopo 4 mesi/7.000 utenti: complessità non deducibile dal prompt, caching > routing, incoerenza qualitativa dal model-switching); trend prezzi frontier >10×/12-18 mesi che erode il delta; lezione interna (intent-classifier retrocesso a monitor-only).

**Decisione.** Tre lane statiche in config: `main` (conversazione/azione), `light` (estrazione, consolidamento, classificazioni interne), `deep` (research/coding pesante, invocata **esplicitamente dal loop** con la scelta visibile nel trace). Nessun classifier pre-loop, nessun router.

**Alternative scartate.** *Router dinamico per-prompt*: tutte e tre le ragioni del post-mortem valgono identiche qui, aggravate dal fatto che un agente personale vive di coerenza comportamentale. *Lane sola*: paga il frontier per fare grep (il consolidamento notturno da solo varrebbe ~$7/mese su main vs ~$0.7 su light).

**Conseguenze.** Più facile: prevedibilità di costo e comportamento; debug ("quale modello ha fatto questo?" è in config, non in un log di routing). Più difficile: niente ottimizzazione automatica del costo per-prompt (rinuncia deliberata: il caching cattura il grosso).

**Reversibilità.** Massima — per design la struttura a lane è config: collassare a una lane o aggiungerne una è banale (07 la marca impalcatura con segnale: prezzo del modello "buono" sotto la soglia di indifferenza per il volume dell'owner → si collassa). Segnale che era sbagliata: escalation `main→deep` così frequenti da diventare il caso comune (le lane erano tagliate male).
