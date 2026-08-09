# ADR-0006 — Il giudice di contraddizione è un organo misurato

**Contesto.** La risoluzione delle contraddizioni è l'abilità più debole di tutti i sistemi di memoria misurati (BEAM, ICLR 2026); Graphiti ha un bug aperto esattamente lì (giudice che collassa 7/15→0/3 con modelli economici non-reasoning, #1666). "Sapere quando ciò che ricorda non vale più" è una capability richiesta dal BRIEF, non un dettaglio.

**Decisione.** Il giudice è un componente nominato con: schema reasoning-first (campo di ragionamento prima degli array — fix documentato del collasso), quattro esiti (`coexist`/`supersede`/`temporal_scope`/`review`), eval dedicata con casi-regression (inclusi i 12 predicati set-valued storici e i casi-stress multi-fatto) e **soglia di attivazione**: sotto l'accuratezza minima misurata, non supersede — accumula e flagga per review. Mai DELETE; supersede = chiusura bi-temporale con link.

**Alternative scartate.** *Fidarsi del default dell'estrazione* (pattern Graphiti stock): è il bug documentato. *Vincoli di schema come giudice* (le triple rigide): eseguono l'errore in silenzio (ADR-0004). *Review umana per ogni conflitto*: non scala oltre i primi giorni.

**Conseguenze.** Più facile: fidarsi dei supersede (sono gated da una misura); degradare con grazia su modelli piccoli (soglia → accumula invece di corrompere). Più difficile: mantenere l'eval del giudice viva (è nel RoT-adjacent set di 05).

**Reversibilità.** Alta: è un componente isolato della pipeline; quando il main-model farà contradiction-handling in-context in modo misurato-affidabile, il giudice separato collassa nel loop (segnale in 07). Segnale che era sbagliato: coda `review` che cresce senza limite (soglia troppo prudente) o supersede errati trovati dall'audit (eval insufficiente).
