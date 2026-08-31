# ADR-0010 — Adozione standard esterni (MCP, Apps, Tasks, SKILL.md, AGENTS.md, OTel GenAI)

**Contesto.** "Non reinventare formati che hanno già un ecosistema" (BRIEF). Tutte le verifiche sono su fonte primaria (A3): i 6 breaking change della revision MCP 2026-07-28 sono confermati; Apps è Stable con 11 host; Tasks è SEP-Final ma repo "experimental" e 0 client tracciati; SKILL.md ha ~45 adopter e nessuna foundation; AGENTS.md e MCP sono entrambi sotto AAIF/Linux Foundation; OTel GenAI è interamente Development.

**Decisione (per standard).**

| Standard | Verdetto | Dettaglio |
|---|---|---|
| MCP core | **ADOTTA `2026-07-28`** | Client in M3 via SDK TS v2 (che serve anche i server legacy di default). Nascere sulla revision nuova evita di nascere legacy. |
| MCP Apps | **ADOTTA, post-v1** | Strada per la UI generativa (dashboard, esplorazione grafo, approvazioni HITL) — 11 host reali. In v1 entra solo il renderer capability-aware che la predispone (ADR-0016). Muffin-come-server-MCP: post-v1, stessa onda. |
| MCP Tasks | **RINVIA** | Immaturo (0 client, repo experimental). Il lavoro asincrono interno usa il nostro job model (scheduler): l'astrazione MCP è per il confine client/server, usarla *dentro* sarebbe forzarla — e oggi non c'è nemmeno l'ecosistema che ripagherebbe la forzatura. |
| Agent Skills / SKILL.md | **ADOTTA** | Formato skill = SKILL.md (progressive disclosure). Divergere con 2 skill in casa sarebbe ingiustificabile. La governance debole (nessuna foundation) è un rischio accettato: il formato è banale da forkare se deriva. |
| AGENTS.md | **ADOTTA** | Nel repo dal giorno 1 (è anche il contesto che Muffin stesso legge quando lavora sul proprio codice). |
| OTel GenAI | **ADOTTA PINNATA** | Tutto Development: versione pinnata, isolata in `core/tracing/` (un solo punto di rincorsa ai breaking change). L'alternativa (formato log proprio) costa l'ecosistema di tooling per zero guadagno. |

**Alternative scartate.** *Targettare la revision MCP precedente (2025-11-25)*: nascere legacy con deprecation window che corre. *Adottare Tasks subito*: agganciarsi a una spec senza implementazioni reali. *Formato skill proprio*: già pagato una volta (v0.3 interno), zero ecosistema in cambio.

**Conseguenze.** Più facile: interop immediata (ogni server MCP è un'estensione; ogni skill pubblica è installabile); l'API di estensione per terzi È MCP+SKILL.md — nessuna API proprietaria da progettare e mantenere. Più difficile: dipendiamo dalla velocità degli SDK ufficiali sulle spec nuove.

**Reversibilità.** Alta su Tasks/Apps (rinvii, non impegni); media su MCP core (migrazioni di revision hanno guide ufficiali); alta su OTel (il pin isola). Segnali: per Tasks → comparsa nella client-matrix ufficiale con host reali; per Apps → gli host coprono i canali che l'owner usa davvero; per OTel → prima release Stable di `gen_ai.*`.
