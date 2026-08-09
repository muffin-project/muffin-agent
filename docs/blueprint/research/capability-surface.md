# Superficie tool/capability & MCP — Hermes/OpenClaw/Goose

> Scout 2026-08-09 (muffin-scout). Clone read-only + lettura sorgente diretta.
> Hermes `11dc61b`, OpenClaw `135278c`, Goose `064244e`. Fonda la roadmap-capability.
> Estende `a2-prior-art.md` (traction/CVE) e `m3-connector-timing-*` con deep-dive
> a codice su tool registry + integrazione MCP.

## Tool bloat: 3 risposte divergenti, tutte verificate

- **Hermes**: lista statica per-piattaforma (~60 tool), **nessun retrieval**;
  presenza condizionale per-tool (`check_fn`: es. `ha_*` solo se `HASS_TOKEN`).
- **OpenClaw**: tool-profiles + **Tool Search BM25 lessicale, OPT-IN, non default**.
  Citazione: *"Direct tool exposure is still the right default for small catalogs.
  Tool Search is best when one run can see many tools, especially from MCP servers."*
  Consegnato via **code-execution** (il modello scrive JS in un subprocess Node
  isolato che chiama `tools.search/describe/call`). Schema dei tool MCP tenuto
  `"unknown"` nell'indice finché non chiami `describe()` — anti-injection.
- **Goose**: **nessun meccanismo**, disciplina dichiarata (*"fewer than 25 total
  tools"*), + un `Extension Manager` che l'**agente stesso** usa a runtime, +
  "Code Mode" (JS per tool discovery — stesso pattern di OpenClaw).
- **Convergenza**: 2/3 arrivano a "code-execution come consegna della
  tool-retrieval". **Nessuno usa embedding/vector per i tool** (solo BM25 lessicale).
  → Per cataloghi piccoli, esposizione diretta È il default giusto; la retrieval
  serve quando MCP aggiunge centinaia. (muffin-agent ha già `maxToolsExposed`.)

## Capability, come implementate

| | Hermes | OpenClaw | Goose |
|---|---|---|---|
| **fs read/write** | nativo core | nativo core | nativo (Developer, default) |
| **web search** | **nativo**, 8 provider pluggable | **nativo**, 13 provider | **assente** (MCP-only) |
| **deep research** | nessun tool — emergente da web+browse+`delegate_task`, orchestrato da **skill in prosa** | idem, senza catalogo skill | assente |
| **email** | **skill-mediato** via CLI `himalaya` (shell), zero gate dedicato | assente / MCP-only | assente / MCP-only |
| **browser** | **nativo core**, 12 tool (CDP+vision) | nativo dual-profile (Playwright + Chrome-DevTools-MCP) | Peekaboo (macOS, vision) |
| **calendar** | **assente** (grep esaustivo) | **assente** | **assente** |
| **github** | skill via `gh` CLI | MCP generico | MCP ufficiale remoto GitHub |

**Pattern trasversale**: fs read/write **sempre nativo**; web-search nativo in 2/3;
email/calendar/github **mai tool tipati first-class** — skill su CLI (Hermes) o
MCP bring-your-own. **Nessuno ha calendar.**

## MCP

- **Hermes**: catalogo curato **source-pinned** (SHA/versione, ≥2 settimane, mai
  auto-update) + bring-your-own (OAuth 2.1, glob include/exclude — es. Cloudflare
  ~3300 tool filtrati). Trust-tier a **call-time** (`readOnlyHint` + `trust:untrusted`,
  default OFF). Può anche **essere** server MCP (`hermes mcp serve`).
- **OpenClaw**: MCP nella **stessa policy** dei tool nativi; secondo registry
  (`mcporter.json`) per le skill; **miglior MCP Apps** (proxy iframe, view-lease,
  launch-ticket effimeri, rendering per-canale).
- **Goose**: MCP-nativo fin nei propri built-in; vetting = **malware-scan** del
  pacchetto, **nessun pin**.
- **NESSUNO implementa il rug-pull hash-pinning-dello-schema di muffin-agent** —
  siamo più severi di tutti e 3 su schema-drift. Ma siamo **più poveri** su:
  catalogo curato con source-pin, glob include/exclude per server enormi, OAuth 2.1.

## Outward / HITL

- Hermes: Tirith (classificatore LLM su shell) + trust-tier MCP. **Nessun gate email**.
- OpenClaw: policy stack "stricter wins" + **Lobster** (pipeline-come-dati,
  halt-su-side-effect, esempio canonico = **email triage**). Opt-in.
- Goose: **permissivo di default** (autonomous mode), classificazione write "fuzzy"
  delegata al modello.
- **Nessuno eguaglia un connettore tipato con draft-by-default** per email/calendar
  come il vecchio Muffin-bot (ADR-068, 8 tool outward tipati). **È un nostro
  differenziatore.**

## Research → artifact → action

Hermes: **interamente skill-driven** (`skills/research/competitor-news-monitor`:
setup → cron → tick → aggiorna file di stato → digest-o-silenzio). Nessun codice
dedicato: prosa sopra i primitivi (web_search, cronjob, file I/O). → Il pattern che
l'owner vuole ("dopo la ricerca scrivi file e gestisci") = una **SKILL sopra i
nostri primitivi**, non nuovo codice.

## Dove muffin-agent guida / insegue

- **Guida**: kernel di permessi unificato (ADR-0013) — nessuno dei 3 l'ha (hanno
  3-4 meccanismi paralleli non riconciliati); rug-pull hash-pinning più severo di tutti.
- **Insegue**: web-search nativo (2/3 ce l'hanno, noi no), calendar (differenziatore,
  nessuno ce l'ha), glob include/exclude MCP, OAuth 2.1, browser.

## Sintesi per la roadmap

fs-write + web-search sono i primitivi nativi mancanti a più alto sblocco
(deep-research = web+fetch+skill, non un tool). Email/calendar/github non sono mai
tool tipati nei peer: calendar via MCP è un differenziatore; email/gestione-cose col
nostro modulo outward tipato + draft-by-default batte tutti e 3. Il flusso
ricerca→artefatto→azione è una skill sui primitivi, alla Hermes. Il nostro kernel +
rug-pull sono già avanti; mancano le capability concrete sopra.

## Sources
- NousResearch/hermes-agent@11dc61b · openclaw/openclaw@135278c · aaif-goose/goose@064244e
