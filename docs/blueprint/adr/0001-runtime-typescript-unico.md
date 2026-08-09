# ADR-0001 — Runtime unico TypeScript/Node

**Contesto.** Il BRIEF ipotizza un ibrido Python (core/AI) + TypeScript (gateway). Vincoli: manutentore singolo; "Muffin costruisce Muffin"; nessun training di modelli in-process (l'inferenza è sempre dietro HTTP).

**Decisione.** Un solo runtime: Node ≥22 + TypeScript strict, ESM. Sidecar in altri linguaggi ammessi solo come processi esterni opzionali dietro contratto CLI/HTTP, etichettati impalcatura.

**Alternative scartate.** *Ibrido Py+TS*: paga due toolchain e un boundary di serializzazione per librerie (Python AI) che non servono senza training; il costo è permanente, il beneficio ipotetico. *Python unico*: butta 193K LOC di prova d'esistenza TS e la padronanza del manutentore; l'ecosistema TS 2026 è Tier-1 su tutto lo stack richiesto (MCP SDK v2, SDK provider, better-sqlite3/sqlite-vec). *Rust (à la Goose)*: performance non è il collo; costo di sviluppo per un singolo molto più alto.

**Conseguenze.** Più facile: un deploy, un debugger, dogfooding del proprio codice. Più difficile: se emergesse una dipendenza dura Python-only (es. una libreria di estrazione unica), va incapsulata come sidecar invece che importata.

**Reversibilità.** Costosa (è LA scelta di fondazione): cambiarla tra sei mesi = riscrittura. Segnale che era sbagliata: passare >20% del tempo a reimplementare in TS cose mature altrove, o un sidecar Python che diventa permanente e cresce.
