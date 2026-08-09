# 05 — Testing ed evals

> La domanda del BRIEF: "come si testa un sistema che cambia se stesso?" Risposta corta: **il cricchetto ha bisogno di un metro che l'agente non può piegare** — la suite di riferimento è nel Root of Trust (modificabile solo via repo+owner), tutto il resto si misura contro di lei. Evidenza a monte: i benchmark pubblici di memoria sono inaffidabili (A4 §1.4) → si valuta su dati propri; il self-judging senza terra esterna degrada (A5 §8.5) → mai il modello giudice di se stesso nel proprio gate.

---

## 1. I quattro strati

| Strato | Cosa copre | Quando gira |
|---|---|---|
| **Test di codice** (unit/integration per feature-cartella) | logica deterministica: policy kernel, bi-temporalità, tenancy, renderer, scheduler | ogni commit (CI) |
| **CI di capability** (harness live, modelli veri) | il contratto multi-tier: gli stessi scenari su modello API di riferimento E modello consumer-locale di riferimento | **pre-merge solo sul consumer-locale** (il vincolo stringente); frontier su nightly + release-gate (C2-#8/#9) |
| **Suite memoria** (dati reali, golden set) | recall corretto, grafo che dice il vero, contraddizioni, poisoning | nightly + gate del cricchetto |
| **Replay harness** | regressioni end-to-end su trace storici reali (pattern già validato in casa) | pre-release, post-incidente |

Regola trasversale (lezione interna, feedback documentato): i test di tool-calling chiamano **il modello vero**, mai mock del modello — il mock valida l'idraulica, non l'organo.

## 2. CI di capability (il gate anti-"harness su Sonnet")

- **Floor contrattuale** (V2): N tool esposti simultaneamente, orizzonte di X tool-call, context utile Y, recovery da errore di tool. Scenari: fixtures NON personali in `evals/` (repo pubblico → niente dati veri qui dentro).
- Due modelli di riferimento pinnati per release (es. un frontier-API e un consumer-locale della classe 20-35B-A3B); il floor deve passare su **entrambi**; le capacità sopra-floor sono dichiarate per-profilo.
- Fallimenti tipici da coprire perché già visti in casa: announce-then-stop su framing casual, format contagion dalla history, false-completion (dichiara di aver fatto senza tool call) — ciascuno è uno scenario con assert, non una speranza.

## 3. Suite memoria (l'integrità del grafo nel tempo — domanda aperta №4)

1. **Golden set personale** (privato, in `~/.muffin/evals/`, MAI nel repo): domande con risposta nota costruite dalla storia reale dell'owner + aggiornate dal consolidamento (proposte automatiche, conferma owner). Metriche: recall@k, correttezza della fonte citata, staleness (risposta da fatto expired quando esiste il successore = fail).
2. **Invarianti property-based** (query SQL, girano nightly, zero LLM): nessun fatto attivo con `superseded_by` valorizzato; `trust_tier` fatto ≥ tier episodio di provenienza; nessuna riga senza `tenant_id`/`episode_id`; expired mai > recorded; identità `confirmed` con `link_evidence` presente; conteggio predicati distinti sotto soglia (o escalation aperta).
3. **Eval del giudice di contraddizione** (l'organo più a rischio del campo — A4): set di casi supersede/coexist/temporal/review con esito atteso (inclusi i 12 predicati set-valued di ADR-025 come regression storica e i casi-stress stile graphiti#1666); soglia di attivazione: sotto l'accuratezza minima il giudice non supersede, accumula e flagga.
4. **Red-team poisoning** (MINJA-style, A4 §6): fixtures di messaggi ostili in tenant gruppo → assert che: il fatto derivato resti tier-2 descrittivo; nessun trigger armato; il recall in contesto owner porti l'etichetta; l'azione gated venga negata. Gira in CI come test del kernel, non come esercizio una tantum.
5. **Eval migrazione/estrazione versionata**: replay del corpus su `extraction_v` nuova → diff dei grafi (fatti persi/nuovi/cambiati) sopra soglia = review umana prima del cutover.
6. **Eval embedding italiano** (gap dichiarato in A4 §8: nessun numero pubblico affidabile): retrieval set italiano dal golden set personale; qualunque cambio di modello embedding passa da qui (delta before/after, mai switch alla cieca).

## 4. Suite sicurezza (dal threat model)

- **Isolamento cross-tenant**: la batteria di attacchi di 03 §4 (a-g) come test automatici (fixtures di gruppo, membri ostili, MCP malevolo simulato). Il pattern è AgentDojo-in-piccolo: task utili + iniezioni, si misura utility E attack-success-rate; ASR atteso: 0 sui percorsi strutturali (non "basso": quelli non passano dal modello). **Aggiunti in Fase C**: (i) *stesso nome, due tenant* — due entità omonime in tenant diversi non devono mai fondersi (C1-11); (ii) *fuga fs tra tenant* — il workspace sandbox di un turno di gruppo non deve essere leggibile da un turno host successivo (C1-13); (iii) *tier che sopravvive alla sintesi* — il riassunto di un sub-agent che ha letto tier-3 deve arrivare al padre come tier-3 (C1-5); (iv) *render offline* — un contenuto con markup/URL ostile non deve produrre nessuna richiesta di rete durante il rendering (C1-1).
- **Egress**: tentativi di esfiltrazione con dati host in parametri verso destinazioni non allowlistate → DENY + span.
- **Kernel invariante**: fuzzing leggero sulle decision (principal×capability×taint) contro la matrice attesa; la matrice È il test (golden table).

## 5. Il cricchetto in dettaglio (self-modification testabile)

1. Proposta di modifica (voice/prompt/soglia/skill) = **artefatto versionato** con: diff, motivazione, segnale d'origine (quale correzione/fallimento l'ha generata).
2. Gate: gira il sottoinsieme di eval **pertinente alla dimensione toccata** (voice→voice-eval; recall→suite memoria; soglia proattività→scenari scheduler) + smoke della CI capability. Nessuna eval pertinente esistente → la modifica non è auto-applicabile (solo proposta all'owner). 
3. Canary: attiva con finestra di osservazione; metriche live sotto baseline → revert automatico + report.
4. Audit: ogni passaggio è span + voce nel log del cricchetto (`muffin ratchet log`).
5. **Chi custodisce il metro**: la suite di riferimento e le soglie del gate stanno nel RoT — l'agente non può modificare l'eval con cui viene giudicato (altrimenti il cricchetto è teatro). Le *proposte* di nuove eval sono benvenute e passano da PR.

## 6. Deriva lenta (ciò che le eval puntuali non vedono)

Trend nightly su finestre mobili: recall score, correzioni/100 interazioni, tasso interventi manuali, costo/giorno, distribuzione uscite del loop (taxonomy degli exit — pattern interno validato), rapporto interazioni/esiti (il monitor anti-dipendenza di V13). Ogni trend con soglia di alert → report introspezione (M6), non azione automatica.

## 7. Copertura per modulo (richiamo)

Ogni DoD di 04 §2 è uno scenario eseguibile che diventa test permanente alla chiusura del modulo: M0 boot+RoT tamper; M1 floor 2-modelli; M2 persistenza/bi-temporalità/fonte; M3 isolamento primitivi; M4 parità contenuto cross-canale; M5 job persistence + gate proattività; M6 ratchet end-to-end + report con dati veri; M7 batteria cross-tenant. "I test passano" non è mai la DoD: lo scenario che gira lo è, il test lo *conserva*.
