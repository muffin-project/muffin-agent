# Audit dell'architettura informativa — 2026-08-19

**Ruolo: EVIDENCE SNAPSHOT.** Questo file registra la classificazione usata per
rifattorizzare l'architettura informativa non-code della repo. Non governa HEAD e
non va aggiornato per descrivere lo stato futuro. La mappa corrente delle
authority vive in `docs/README.md`; codice, schema e config shipped restano la
verità meccanica.

## Metodo

Obiettivo: **un fatto, una casa autoritativa; progressive disclosure; storia ed
evidenza preservate senza poter sembrare stato corrente**.

Il codice è stato letto solo per confutare affermazioni documentali load-bearing
(policy corrente, ruolo/speaker nella memoria, confine secret, child MCP, turn
state). Prima di scegliere la forma sono stati ricontrollati prior art 2026:

- OpenAI, *Harness engineering: leveraging Codex in an agent-first world* — root
  instructions come mappa, repo knowledge strutturata, generated separati,
  guardrail meccanici;
- OpenClaw — `AGENTS.md` come mappa/scoped guides, docs con `read_when`, manifest
  plugin prima del runtime;
- Hermes Agent — ruoli espliciti dei context file e discovery progressiva delle
  istruzioni di sottodirectory;
- Claude Code — `CLAUDE.md` conciso e focalizzato, istruzioni di progetto come
  guida invece di manuale universale.

Sono comparatori, non template da copiare.

## Legenda

- **KEEP** — ruolo già legittimo.
- **NARROW** — il file resta ma cede responsabilità ad altre authority.
- **REWRITE** — stesso ruolo utente, forma attuale sbagliata/stale.
- **MOVE HISTORY** — preservare come lineage, smettere di governare HEAD.
- **EVIDENCE/FREEZE** — snapshot datato: si cita, non si aggiorna in stato.
- **DERIVED** — vista ricostruibile/generata, mai verità indipendente.
- **RETIRE** — solo dopo aver provato assenza di consumer e conoscenza unica.
- **RECONCILE** — altra fonte/branch vivo sovrappone semantica; merge manuale.

Nessun move/delete avviene prima che ogni informazione unica ancora viva abbia
una destinazione esplicita.

---

## 1. Root, harness e meccanica di repo

- `.claude/deleghe/registro.jsonl` — **KEEP / OPERATIONAL**. Registro durevole
  delle deleghe; machine-managed, nessuna conoscenza di prodotto unica.
- `.claude/loop.md` — **KEEP + NARROW / WORKFLOW**. Algoritmo di continuazione
  zero-context; deve linkare ORCHESTRATION per i profili, non ridefinirli.
- `.claude/settings.json` — **KEEP / EXECUTABLE AUTHORITY**. Hook/settings Claude.
- `.env.example` — **KEEP / TEMPLATE**. Esempio onboarding, mai config authority.
- `.github/pull_request_template.md` — **REWRITE**. Template profile-aware:
  claim, profile, evidence budget, observed evidence, residual, docs rese stale.
- `.github/workflows/accettazione.yml` — **KEEP / EXECUTABLE AUTHORITY**.
- `.github/workflows/ci.yml` — **KEEP / EXECUTABLE AUTHORITY**.
- `.gitignore` — **KEEP / EXECUTABLE AUTHORITY**.
- `AGENTS.md` — **REWRITE → ROUTER CORTO**. Niente seconda copia di security,
  memory invariants, build doctrine o stato.
- `CLAUDE.md` — **REWRITE → ADAPTER CLAUDE**. Niente `STATE.md first`, niente
  vecchia blueprint map come current authority.
- `LICENSE` — **KEEP / LEGAL AUTHORITY**, ma decisione pre-public necessaria:
  MIT corrente vs vecchia intenzione non-commerciale. Se cambia, nuovo ADR.
- `README.md` — **REWRITE LATER / PUBLIC ENTRY**. What/why/maturity/install/demo
  e link; niente cronaca M0–M5/PR correnti.
- `package.json` — **KEEP / EXECUTABLE AUTHORITY** per scripts, metadata,
  dependency ranges e license dichiarata.
- `package-lock.json` — **KEEP / GENERATED EXECUTABLE AUTHORITY**.
- `tsconfig.json` — **KEEP / EXECUTABLE CONFIG**.
- `tsconfig.build.json` — **KEEP / EXECUTABLE CONFIG**.
- `vitest.config.ts` — **KEEP / EXECUTABLE CONFIG**; fuori dalla prosa.
- `vitest.acceptance.config.ts` — **KEEP / EXECUTABLE CONFIG**; fuori dalla
  prosa.

`install.sh` e gli altri sorgenti eseguibili sono codice e restano fuori da
questo audit, salvo verifica di claim documentali.

## 2. Profili, persona e Root of Trust shipped

- `agent/profiles/consumer-local.json` — **KEEP / EXECUTABLE AUTHORITY**.
- `agent/profiles/frontier.json` — **KEEP / EXECUTABLE AUTHORITY**.
- `defaults/persona.md` — **KEEP / CONTENT AUTHORITY**. Persona Muffin shipped.
- `defaults/voice.md` — **KEEP / CONTENT AUTHORITY**. Voice/register shipped.
- `defaults/rot/identity.md` — **KEEP / CONSTITUTIONAL CONTENT AUTHORITY**.
- `defaults/rot/budgets.json` — **KEEP / EXECUTABLE AUTHORITY**. I numeri vivono
  qui, non in prose copie.
- `defaults/rot/egress.json` — **KEEP / EXECUTABLE AUTHORITY**.
- `defaults/rot/policy.json` — **KEEP / EXECUTABLE AUTHORITY**. Sole home dei
  literal policy correnti come `paramsMaxTaint`.
- `defaults/rot/evals/voice.json` — **REVIEW → RETIRE O DARE UN CONSUMER**. Ha
  zero casi; la suite character viva è `evals/character/`. Un placeholder vuoto
  nel RoT non deve sembrare una garanzia attiva.

## 3. Documenti top-level correnti

- `docs/README.md` — **KEEP / CURRENT AUTHORITY MAP**. Aggiunto da #81.
- `docs/THESIS.md` — **KEEP / CURRENT AUTHORITY**. Perché esiste Muffin.
- `docs/ARCHITECTURE.md` — **KEEP / CURRENT AUTHORITY**. Forma semantica corrente.
- `docs/SECURITY.md` — **KEEP / CURRENT AUTHORITY**. Security/trust boundaries.
- `docs/DESIGN-PRINCIPLES.md` — **KEEP + CALIBRATE LATER**. Casa del come
  decidiamo; P3/P4 hanno assunti da riallineare con identity/current phase.
- `docs/ORCHESTRATION.md` — **KEEP / WORKFLOW AUTHORITY**. Control loop,
  FAST/STANDARD/CRITICAL, evidence budget, delegation, escalation, doc budget.
- `docs/BRANCHING.md` — **NARROW** a branch/PR/merge/promotion/cleanup. Incidenti
  temporanei CI appartengono a LAVORO.
- `docs/JUDGE.md` — **NARROW** a review indipendente; profili linkati da
  ORCHESTRATION, non ricopiati.
- `docs/PRACTICES.md` — **NARROW** a pratiche+trigger; rimuovere STATE come
  authority e processo duplicato.
- `docs/lessons.md` — **KEEP / EVIDENCE-HISTORY**. Failure pattern
  generalizzabili; alimenta PRACTICES ma non descrive HEAD.

## 4. `docs/foundations/`: corpus sovrapposto

- `docs/foundations/VISION.md` — **RECONCILE CON #73**. Il branch prodotto ha una
  versione più nuova; decidere se resta una product-vision corrente o viene
  assorbita dalla strategia senza duplicare THESIS/ARCHITECTURE.
- `docs/foundations/COGNITIVE_BASES.md` — **MOVE HISTORY AFTER EXTRACTION**.
  Corpus cognitivo precedente, sovrapposto a `blueprint/knowledge/`.
- `docs/foundations/INVARIANTS.md` — **EXTRACT LIVE → MOVE HISTORY**. Un invariant
  ancora vivo deve avere casa in ARCHITECTURE/SECURITY/knowledge o executable
  contract.
- `docs/foundations/REFERENCES.md` — **EVIDENCE / RECONCILE WITH RESEARCH**.
- `docs/foundations/UNDERSTANDING.md` — **MOVE HISTORY AFTER EXTRACTION**;
  sovrapposto a `knowledge/01-understanding.md`.

## 5. Blueprint del rebuild

- `docs/blueprint/00-findings.md` — **MOVE HISTORY / REBUILD EVIDENCE**.
- `docs/blueprint/01-verdetti.md` — **MOVE HISTORY**. Verdict set storico.
- `docs/blueprint/02-ontologia.md` — **MOVE HISTORY AFTER EXTRACTION**; la forma
  corrente vive in ARCHITECTURE.
- `docs/blueprint/03-threat-model.md` — **MOVE HISTORY / THREAT LINEAGE**;
  SECURITY governa il presente.
- `docs/blueprint/04-roadmap.md` — **MOVE HISTORY / REBUILD PLAN**; Gate governa
  Day1 e ADR-0049 supera la vecchia richiesta di re-ingest legacy.
- `docs/blueprint/05-testing-evals.md` — **MOVE HISTORY AFTER EXTRACTION**;
  verification corrente in ORCHESTRATION/JUDGE/eval docs.
- `docs/blueprint/06-modelli.md` — **MOVE RESEARCH/HISTORY**; modelli invecchiano,
  profiles JSON governano la config corrente.
- `docs/blueprint/07-durevole-vs-impalcatura.md` — **MOVE HISTORY**; concetto
  corrente estratto in THESIS/ARCHITECTURE.
- `docs/blueprint/08-assunzioni.md` — **MOVE HISTORY**.
- `docs/blueprint/09-contratti-m0-m1.md` — **MOVE HISTORY**. Non può essere
  authority meccanica sopra codice/schema/config.
- `docs/blueprint/10-risoluzioni-fase-c.md` — **MOVE HISTORY**.
- `docs/blueprint/11-salvataggio-documentale.md` — **MOVE HISTORY**.
- `docs/blueprint/12-casi-uso-primitive.md` — **MOVE HISTORY / PRODUCT EVIDENCE**.
- `docs/blueprint/BRIEF.md` — **MOVE HISTORY**.
- `docs/blueprint/README.md` — **REWRITE COME HISTORY INDEX** dopo il move; deve
  smettere di dichiarare authority correnti.
- `docs/blueprint/STATE.md` — **MOVE HISTORY / RENAME CHRONICLE**. Conservare la
  cronaca, pensionare definitivamente il ruolo "current state".
- `docs/blueprint/LAVORO.md` — **KEEP + SHRINK / OPERATIONAL**. Solo goal, live
  work, blocker immediato, decisione owner, next action; Git osservato vince.
- `docs/blueprint/M5-BIS.md` — **KEEP + RECONCILE / GATE STATUS AUTHORITY**. Unica
  casa READY/BLOCKER/OUT/INVALIDATED; conteggi da derivare in seguito.
- `docs/blueprint/validazione-contratti.md` — **MOVE HISTORY/EVIDENCE**. È la
  prova storica che contract prose e realtà avevano già driftato.

## 6. DAY-1 Gate

- `docs/blueprint/gate1/MANDATO-DAY-1.md` — **NARROW / GATE CONTRACT**. Deve
  possedere soltanto cosa rende Day1 vero; startup algorithm, verification
  mechanics e findings vanno nelle loro case.
- `docs/blueprint/gate1/PERCORSO-CRITICO.md` — **RECONCILE + NARROW / ORDER**.
  Solo ordering/dipendenze; niente status duplicato, merge chronicle o conteggi.

## 7. Curatela cognitiva corrente

- `docs/blueprint/knowledge/README.md` — **KEEP + NARROW / SCOPED ROUTER**.
- `docs/blueprint/knowledge/01-understanding.md` — **KEEP + REMOVE STATUS LEAK**.
- `docs/blueprint/knowledge/03-observing-spine.md` — **KEEP + REMOVE STATUS LEAK**.
- `docs/blueprint/knowledge/04-learn-from-absence.md` — **KEEP + REMOVE STATUS LEAK**.
- `docs/blueprint/knowledge/05-person-model.md` — **KEEP + REMOVE STATUS LEAK**.

Questi file possono possedere problema/evidenza/principi cognitivi, non `✅/⏳`
di implementazione o schema corrente.

## 8. Critique Fase C

- `docs/blueprint/critique/c1-threat-model.md` — **MOVE HISTORY/EVIDENCE**.
- `docs/blueprint/critique/c2-complessita.md` — **MOVE HISTORY/EVIDENCE**.
- `docs/blueprint/critique/c3-ingegnere-m0-m1.md` — **MOVE HISTORY/EVIDENCE**.

Sono challenge output; la decisione risultante appartiene ad ADR/current docs.

## 9. ADR — tutti restano decision history

Regola comune: un ADR spiega **perché** una decisione è stata presa. Non prova
che HEAD implementi ancora ogni riga. Una futura inversione materiale crea un
nuovo ADR invece di aggiungere revisioni indefinitamente.

- `docs/blueprint/adr/0001-runtime-typescript-unico.md` — **KEEP**.
- `docs/blueprint/adr/0002-organizzazione-per-feature.md` — **KEEP**.
- `docs/blueprint/adr/0003-root-of-trust.md` — **KEEP**.
- `docs/blueprint/adr/0004-memoria-tkg-schema-light.md` — **KEEP**.
- `docs/blueprint/adr/0005-provenienza-taint-primitive.md` — **KEEP**.
- `docs/blueprint/adr/0006-giudice-contraddizione-misurato.md` — **KEEP**.
- `docs/blueprint/adr/0007-approvvigionamento-modelli.md` — **KEEP**.
- `docs/blueprint/adr/0008-provider-adapter-unico.md` — **KEEP**.
- `docs/blueprint/adr/0009-lane-statiche-niente-router.md` — **KEEP**.
- `docs/blueprint/adr/0010-standard-esterni.md` — **KEEP**.
- `docs/blueprint/adr/0011-confine-repo-config-dati.md` — **KEEP**.
- `docs/blueprint/adr/0012-nome-muffin.md` — **KEEP**.
- `docs/blueprint/adr/0013-kernel-permessi-unificato.md` — **KEEP**.
- `docs/blueprint/adr/0014-cricchetto-eval-gated.md` — **KEEP**.
- `docs/blueprint/adr/0015-coding-orchestrato.md` — **KEEP**.
- `docs/blueprint/adr/0016-renderer-capability-aware.md` — **KEEP**.
- `docs/blueprint/adr/0017-community-differita.md` — **KEEP**.
- `docs/blueprint/adr/0018-brain-hands-sandbox.md` — **KEEP**.
- `docs/blueprint/adr/0019-licenza-mit.md` — **KEEP**, ma se la licenza cambia
  verrà superseded da una nuova decisione owner, non riscritto.
- `docs/blueprint/adr/0020-lingua-del-progetto.md` — **KEEP**.
- `docs/blueprint/adr/0021-surface-model.md` — **KEEP**.
- `docs/blueprint/adr/0022-un-processo-con-priorita-foreground.md` — **KEEP**.
- `docs/blueprint/adr/0023-media-e-rendering.md` — **KEEP**.
- `docs/blueprint/adr/0024-chunking-strutturale.md` — **KEEP**.
- `docs/blueprint/adr/0025-transport-telegram.md` — **KEEP**.
- `docs/blueprint/adr/0026-sandbox-runtime-dipendenza-sorvegliata.md` — **KEEP**.
- `docs/blueprint/adr/0027-muffin-non-e-coding-agent.md` — **KEEP**.
- `docs/blueprint/adr/0028-postura-di-proattivita.md` — **KEEP**.
- `docs/blueprint/adr/0029-onboarding-first-run.md` — **KEEP**.
- `docs/blueprint/adr/0030-setup-locale-dev.md` — **KEEP**.
- `docs/blueprint/adr/0031-muffin-agent-fonte-unica.md` — **KEEP**; la nuova
  authority-by-question ne precisa la semantica corrente senza cancellarlo.
- `docs/blueprint/adr/0032-chi-scrive-la-memoria.md` — **KEEP**; niente nuove
  inversioni lunghe inline.
- `docs/blueprint/adr/0033-delega-rinviata-con-il-grilletto-scritto.md` — **KEEP**.
- `docs/blueprint/adr/0034-verifica-prima-di-consegnare-deterministica.md` — **KEEP**.
- `docs/blueprint/adr/0035-il-gateway-vive.md` — **KEEP**; è diventato un dossier
  longitudinale, ma la storia non va riscritta.
- `docs/blueprint/adr/0036-il-setup-minimo-sta-nel-terminale.md` — **KEEP**.
- `docs/blueprint/adr/0037-il-ragionamento-torna-indietro.md` — **KEEP**.
- `docs/blueprint/adr/0038-il-consolidamento-parte-da-solo.md` — **KEEP**.
- `docs/blueprint/adr/0039-il-confine-e-dove-sta-il-file.md` — **KEEP**.
- `docs/blueprint/adr/0040-la-manutenzione-e-guidata-dai-dati.md` — **KEEP**.
- `docs/blueprint/adr/0041-pulire-non-e-fidarsi-estrazione-in-libreria.md` — **KEEP**.
- `docs/blueprint/adr/0042-un-turno-e-un-record.md` — **KEEP**.
- `docs/blueprint/adr/0043-un-documento-entra-intero.md` — **KEEP**.
- `docs/blueprint/adr/0044-il-disco-non-ha-provenienza.md` — **KEEP**; i literal
  correnti restano config/capability authority.
- `docs/blueprint/adr/0045-l-unita-e-l-agente-continuo.md` — **KEEP**; cinque
  piani estratti in ARCHITECTURE.
- `docs/blueprint/adr/0046-identita-e-contenuto-sono-due-piani.md` — **KEEP**.
- `docs/blueprint/adr/0047-il-turno-si-sospende.md` — **KEEP**.
- `docs/blueprint/adr/0048-segreti-mai-mostrabili.md` — **KEEP**; security
  promise corrente estratta in SECURITY.
- `docs/blueprint/adr/0049-nuovo-muffin-memoria-nativa-nuova.md` — **KEEP**;
  decisione fresh-native-memory owner.

`docs/blueprint/adr/adr.test.ts` è codice di verifica e resta fuori dall'audit
prosa. Un eventuale manifest/status ADR verrà introdotto solo insieme al checker
che lo consuma.

## 10. Research e audit — ogni file è EVIDENCE/FREEZE

Regola comune: snapshot datato. Può giustificare una decisione; non viene
aggiornato per descrivere HEAD.

- `docs/blueprint/research/a1-inventario-codebase.md`
- `docs/blueprint/research/a2-prior-art.md`
- `docs/blueprint/research/a3-standard.md`
- `docs/blueprint/research/a4-memoria.md`
- `docs/blueprint/research/a5-modelli-economia.md`
- `docs/blueprint/research/a6-brain-hands-sandbox.md`
- `docs/blueprint/research/audit-2026-08-16/README.md`
- `docs/blueprint/research/audit-2026-08-16/findings-digest.txt`
- `docs/blueprint/research/b1-runtime-processo.md`
- `docs/blueprint/research/b2-modelli-openrouter-multimodale.md`
- `docs/blueprint/research/b3-media-rendering.md`
- `docs/blueprint/research/benchmark-comparabilita-harness.md`
- `docs/blueprint/research/capability-surface.md`
- `docs/blueprint/research/confronto-gemini.md`
- `docs/blueprint/research/confronto-harness.md`
- `docs/blueprint/research/consolidamento-due-meccanismi.md`
- `docs/blueprint/research/eu-ai-act-gdpr.md`
- `docs/blueprint/research/graph-memory-starter.md`
- `docs/blueprint/research/harness-agentico-2026-08-17.md`
- `docs/blueprint/research/hermes-documentazione.md`
- `docs/blueprint/research/inventario-vecchio-nuovo.md`
- `docs/blueprint/research/local-dev-setup.md`
- `docs/blueprint/research/m3-a-sandbox-runtime-lib.md`
- `docs/blueprint/research/m3-b-skillmd-shell.md`
- `docs/blueprint/research/m3-caching-and-per-connector-timing.md`
- `docs/blueprint/research/m3-connector-capabilities-telegram-discord.md`
- `docs/blueprint/research/m3-connector-timing-hermes-openclaw-goose.md`
- `docs/blueprint/research/memory-salience-and-fusion.md`
- `docs/blueprint/research/modelli-agosto-2026.md`
- `docs/blueprint/research/modello-reversibilita.md`
- `docs/blueprint/research/muffin-vecchio-vs-nuovo-identita.md`
- `docs/blueprint/research/onboarding-first-run.md`
- `docs/blueprint/research/piano-eventi-workspace.md`
- `docs/blueprint/research/proattivita-quando-parlare.md`
- `docs/blueprint/research/prompt-assembly-2026-08-17.md`
- `docs/blueprint/research/recupero-dal-web.md`
- `docs/blueprint/research/system-prompt-architecture.md`
- `docs/blueprint/research/tipi-contro-successo-falso.md`
- `docs/blueprint/research/triage-2026-08-17/a-b.md`
- `docs/blueprint/research/triage-2026-08-17/brief.md`
- `docs/blueprint/research/triage-2026-08-17/c-d.md`
- `docs/blueprint/research/triage-2026-08-17/e-audit-trasversali.md`
- `docs/blueprint/research/turno-sospendibile.md`

## 11. Mappa e generated views

- `docs/mappa/ancore.json` — **DERIVED / KEEP GENERATED**.
- `docs/mappa/data-loop.json` — **DERIVED / REGENERATE OR OMIT MANUAL FACTS**.
- `docs/mappa/data-memory.json` — **DERIVED / REGENERATE OR OMIT MANUAL FACTS**.
- `docs/mappa/data-policy.json` — **DERIVED / REGENERATE OR OMIT MANUAL FACTS**.
- `docs/mappa/data-surfaces.json` — **DERIVED / REGENERATE**.
- `docs/mappa/data-tools.json` — **DERIVED / REGENERATE OR OMIT MANUAL FACTS**;
  ha già dimostrato drift su policy corrente.
- `docs/mappa/mappa.html` — **DERIVED / KEEP GENERATED**.
- `docs/mappa/template.html` — **KEEP / GENERATOR INPUT**, non authority prodotto.

## 12. Proposal, eval docs e fixture

- `docs/proposals/README.md` — **KEEP + NARROW / PROCESS**. Una proposal non ha
  authority finché non produce una decisione.
- `evals/character/README.md` — **KEEP / SCOPED EVAL DOC**. Spiega come gira
  l'eval; A2/A3 status resta solo M5-BIS.
- `core/documents/fixtures/relazione.docx` — **KEEP / TEST FIXTURE**. Nessuna
  authority prodotto.

## 13. Overlay pendente: draft PR #73

#73 non è su `dev`, ma contiene decisioni prodotto/open-source importanti e va
classificata prima di chiudere #81. Non va mergiata wholesale sopra la nuova
hierarchy.

- `docs/EXTENSIONS.md` — **RECONCILE / CANDIDATE SCOPED CURRENT DESIGN**.
  Package vs capability vs grant; evitare duplicazione con ARCHITECTURE.
- `docs/OPEN-SOURCE-STRATEGY.md` — **RECONCILE / PRODUCT-DISTRIBUTION STRATEGY**.
- `docs/PUBLIC-NARRATIVE.md` — **RECONCILE / PUBLISHING STRATEGY**; non runtime
  truth.
- `docs/THESIS.md` — **DO NOT MERGE BLINDLY**; #81 ora contiene la versione
  autoritativa più nuova e le idee vanno fuse manualmente.
- `docs/foundations/VISION.md` — **MANUAL RECONCILE**; decidere se merita ancora
  una current home separata.
- `research/core-architecture-audit-2026-08-18.md` — **EVIDENCE → research home**.
- `research/legacy-public-audit-2026-08-18.md` — **EVIDENCE → research home**.
- `research/product-landscape-2026-08-18.md` — **EVIDENCE → research home**.

---

## 14. Grafo di authority target

```text
                         DOMANDA
                            │
       ┌────────────────────┼────────────────────┐
       │                    │                    │
       ▼                    ▼                    ▼
 meccanica letterale   semantica corrente    perché/history
 code/schema/config    THESIS/ARCH/SECURITY       ADR
       │                    │                    │
       └────────────┬───────┴────────────┬───────┘
                    │                    │
                    ▼                    ▼
               Gate status            evidence
                  M5-BIS          research/audit/lessons

 current work ──► Git osservato + LAVORO piccolo
 ordering     ──► PERCORSO-CRITICO
 workflow     ──► ORCHESTRATION + docs scoped
 maps         ──► proiezioni generated
 rebuild old  ──► HISTORY
```

## 15. Ordine di migrazione sicuro

### Pass A — control plane

Già iniziato in #81: `docs/README`, THESIS, ARCHITECTURE, SECURITY, ADR-0049.
Nessun history move.

### Pass B — router e context tax

Riscrivere `AGENTS.md` e `CLAUDE.md`; riallineare `.claude/loop.md` solo dove
punta a fonti demote; rendere il PR template profile-aware.

Acceptance: un agente fresco trova la fonte corrente giusta senza caricare la
storia del rebuild per default.

### Pass C — Gate truth maintenance

Narrow MANDATO, riconciliare M5, ridurre PERCORSO, ridurre LAVORO, pensionare
STATE come current state.

Acceptance: una sola casa per status, una per ordine, una per WIP.

### Pass D — history/evidence move

Spostare blueprint rebuild, critique e legacy foundations soltanto dopo reverse
reference scan ed estrazione delle semantiche ancora vive.

Acceptance: togliere `history/` dal startup context non cambia nessuna decisione
corrente.

### Pass E — generated map

La mappa consuma fonti correnti o omette ciò che non sa derivare.

Acceptance: una vista generated può driftare senza diventare source of truth.

### Pass F — reconcile #73

Rebase della direzione prodotto/open-source sulla nuova hierarchy; placement
esplicito di extensions/product/public narrative e research datata.

## 16. Cosa vale la pena meccanizzare dopo la migrazione

Niente metadata framework senza consumer. Quando la struttura esiste, un checker
piccolo è giustificato se cattura drift già misurato:

- root router non possono dire `STATE.md first`;
- history/evidence non possono dichiararsi normative per HEAD;
- generated map non possiede literal policy copiati;
- Gate status/count non vengono ricopiati in handoff/path;
- un blocco non può dichiararsi chiuso se le righe nominate sono ancora aperte;
- link dai router risolvono;
- nessun conflict marker nei documenti;
- se in futuro esiste metadata ADR, `superseded_by/amends` deve risolvere.

Il checker resta stretto: rende falsificabile la gerarchia, non crea un secondo
framework documentale.

## 17. Non-obiettivi

Questo refactor non:

- ridisegna il runtime;
- migra la memoria personale del vecchio Muffin;
- riscrive ADR storici per farli sembrare puliti;
- forza una sottocartella docs per ogni dominio senza consumer;
- aggiunge manifest/frontmatter senza checker;
- trasforma research in current state;
- riporta la verifica a ceremony universale;
- trasforma l'igiene documentale in una feature factory Gate1.

Il risultato finale deve essere più piccolo **nel contesto iniziale**, non per
forza più piccolo su disco: storia e research possono restare ricche mentre
l'authority corrente resta compatta.