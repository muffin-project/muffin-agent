# Ricerca — benchmark pubblici e qualità comparata vs altre harness

> Commissionata 2026-08-09 (domanda owner: *"possiamo fare eval e benchmark
> online e segnare la qualità comparata rispetto ad altre harness"*), con il
> vincolo esplicito **"sensati, senza esagerare"**. La domanda decisiva data allo
> scout: **quali benchmark misurano la harness e quali misurano solo il modello?**
> Un benchmark il cui punteggio si muove tutto col modello non dice niente su di
> noi e girarlo è spreco.

## Bottom line

**Uno solo: AgentDojo.** È l'unico candidato che (a) testa ciò che ci
differenzia davvero — kernel di policy, spotlighting, taint — invece della
competenza grezza del modello; (b) è **per costruzione** un confronto fra
pipeline (la sua reference implementation spedisce 5 difese intercambiabili, fra
cui `spotlighting_with_delimiting`, *la stessa tecnica* che il nostro threat
model cita); (c) non richiede niente che abbiamo tagliato — nessun browser,
nessun sandbox di codice, solo tool call simulate su banking/Slack/travel/
workspace; (d) costa poco (tabella costi degli autori: ~$4 per modello su tutte
e quattro le suite, prezzi GPT-4 2024); (e) è già la nostra metodologia —
`05-testing-evals.md` §4 chiama la suite cross-tenant *"AgentDojo-in-piccolo"*.

**Secondo slot: vuoto.** τ²-bench-Verified sopravvive al filtro capability ed è
mantenuto, ma la sua leaderboard pubblica è popolata da *stesso harness di
riferimento, modelli diversi* — quindi fallisce proprio il criterio dell'owner.
Se un giorno serve, si gira e si **riporta come ablation interna** (il nostro
loop vs il loop di riferimento, stessi modelli pinnati), mai come "Muffin fa X su
τ²-bench".

**Sulla memoria: non girare niente.** Il finding interno (`00-findings.md` #5)
regge, anzi peggiora sotto esame.

## La trappola: harness-sensitivity, misurata

È la parte decision-relevant, ed è diventata *il* dibattito metodologico 2026:

- **arXiv:2606.08529** (giu 2026), studio pre-registrato, 3 scaffold × 5 modelli
  su GAIA L1-2: *"Scaffold choice alone moves measured accuracy by as much as
  **28 percentage points** within a single model."* Stesso modello, sola harness.
- **arXiv:2605.23950** — *"Stop Comparing LLM Agents Without Disclosing the
  Harness"*: la varianza indotta dalla harness può **eccedere** quella indotta dal
  modello, **fino a invertire il ranking fra modelli**. (Lo scout non è riuscito a
  estrarre le tabelle: claim qualitativo confermato, magnitudo no.)
- **Le delta delle difese di AgentDojo sono harness-sensitivity in incognito**, e
  sono sull'asse che ci interessa: spotlighting porta l'ASR **50% → 2%**; CaMeL
  scambia utility 84% → 77% per sicurezza dimostrabile. Stessi modelli, pipeline
  diverse.
- **Ce l'abbiamo già in casa** ✔ (verificato in repo): `agent/completion.ts` cita
  un'ablation GAIA che perde **31 punti** senza il completion-gate, e
  false-success fra **13% e 79%** per famiglia di modello. La fonte è
  arXiv:2606.09863 (9.876 traiettorie τ²-bench + 1.879 AppWorld; i giudici LLM non
  superano mai AUROC 0.65). Un intervento a livello di harness, 31 punti, a
  modello invariato.

**Cosa NON è harness-sensitive**: BFCL (per costruzione l'harness di Gorilla è
fissa e varia solo il modello — ed è già segnata come incoerente fra fonti nel
nostro a5), AgentBench e ToolBench (fermi dal 2025).

## Tabella

| Benchmark | Cosa testa (claim nostro) | Locale? | Costo/run | Leaderboard con harness comparabili? | Harness-sensitive? |
|---|---|---|---|---|---|
| **AgentDojo** | kernel, taint, spotlighting vs injection | **sì**, MIT, pipeline pluggable | **~$2-5**/suite/modello | parziale (ricca in *difese*, incerta in *harness terze*) | **sì, diretto** |
| InjecAgent | idem, più stretto | sì | basso | no — assorbito in AgentDojo come `InjecAgentAttack` | superato |
| τ²-bench-Verified | floor tool-use, aderenza a policy | sì, MIT | centinaia di $ | **debole**: model-swap sotto harness di riferimento | indiretto |
| BFCL v4 | accuratezza tool-calling | harness di Gorilla | basso | **no**, è una leaderboard di modelli | **no** |
| GAIA | assistente long-horizon | serve web/browse | — | sottile (2 harness sul board HAL) | sì — ma è un argomento per *non fidarsi* del numero |
| AssistantBench / BrowseComp | ricerca web | **serve browser** (tagliato) | — | no / saturo | n/a |
| LoCoMo · LongMemEval · MemBench · BEAM | memoria | sì, economici | basso | **compromesse** (sotto) | n/a |

## Memoria: il finding interno regge, rafforzato

- **LoCoMo**: 99/1540 domande (**6.4%**) hanno ground truth corrotta → tetto
  teorico ~93.6%; il giudice LLM usato nelle pubblicazioni accetta **62.81%** di
  risposte adiacenti-ma-sbagliate.
- **La disputa Zep vs Mem0 è la migliore illustrazione esistente** di "stesso
  benchmark, harness diversa, numero completamente diverso": Zep dichiara 84% →
  Mem0 rigira la pipeline di Zep e ottiene 58.44% → Zep contesta la config e
  ripubblica 75.14% → Mem0 ribatte 65.99% → ad agosto 2026 entrambi dichiarano
  numeri nuovi (94.7% e 92.5%) **senza riconciliazione pubblica**.
- **Ognuno corregge i propri compiti**: Mem0 pubblica i propri LoCoMo/LongMemEval,
  Zep i propri DMR, Letta ha disegnato la leaderboard su cui è misurata.
- **BEAM** (ICLR 2026) è il più credibile dei nuovi, e il suo output più utile per
  noi **non è un punteggio**: la *risoluzione delle contraddizioni* è l'abilità
  più debole di ogni sistema testato, inclusi quelli memory-augmented. Da leggere
  progettando il giudice, non da girare per un numero.

**Verdetto**: resta il piano interno — golden set dalla storia vera dell'owner
(`05-testing-evals.md` §3), come già concluso in `a4-memoria.md` §1.4.

## Come riportano gli altri (convenzione onesta)

- **Vendor di memoria**: compiti auto-corretti, vedi sopra.
- **OpenHands / smolagents**: harness **fissa**, molti modelli, script pubblico e
  rigirabile (`run_gaia.py`). Posizione difendibile: isola la scelta del modello.
- **Goose**: si intitola *"Community-Inspired Benchmarking: the Goose Vibe
  Check"* — ammette esplicitamente di essere informale. Contrasto onesto.
- **HAL** (Princeton, ICLR 2026): il migliore tentativo terzo e cost-aware
  (riporta dollari e token accanto all'accuratezza) — ma submission in pausa e
  diversità di harness sottile.
- Convenzione emergente da tenere se pubblichiamo: **modello + seed + versione
  harness pinnati, 5-10 rollout, media ± deviazione standard**.

## Cosa servirebbe per girare AgentDojo su Muffin

1. **Un adapter, non una reimplementazione.** Il suo `AgentPipeline` è una lista
   di elementi intercambiabili: si scrive **un** elemento che chiama il nostro
   loop vero (`agent/loop.ts`) via shim CLI/RPC — così sotto test finisce il
   kernel TypeScript reale, non un clone Python che driva. `evals/floor/
   scenarios.ts` ha già la forma giusta (tool call catturate in ordine).
2. Mappare i tool delle 4 suite sul nostro registry — traduzione, non capability
   nuova.
3. Far girare il **nostro** kernel dietro l'adapter, e in più la spotlighting *di
   riferimento* di AgentDojo come secondo baseline: stessa tecnica,
   implementazione diversa.
4. Su **entrambi** i modelli di riferimento, come già impone `05` §2.
5. **Sanity-check prima di credere a qualunque numero**: girare il baseline non
   difeso e verificare che atterri vicino ai valori pubblicati (classe GPT-4o:
   ~69% utility benigna, ASR fino a 53.1% sull'attacco "Important message").

Sforzo: qualche giorno pieno per chi conosce il loop; il grosso è il ponte
Python↔TypeScript.

## Cosa NON si è potuto stabilire

- Costo di AgentDojo a prezzi 2026 (si estrapola dalla tabella 2024).
- **GAIA-2/ARE** (arXiv:2509.17158): se il suo ambiente "Mobile" sia simulato o
  richieda internet vivo, licenza, e se accetti harness arbitrarie. Se fosse
  simulato sarebbe tematicamente **più adatto** di GAIA originale a un agente
  personale — vale un check prima di scartarlo.
- Ampiezza reale della leaderboard τ²-bench (taubench.com risponde 403); la
  conclusione "model-swap" è **inferita** dalla convenzione di naming delle
  submission.
- Se la leaderboard ospitata di AgentDojo sia aggiornata nel 2026 (una fonte
  secondaria parla di uno snapshot fermo a feb 2025). Non cambia la
  raccomandazione — la si gira in casa — ma abbassa il peso del "confronto
  pubblico" per AgentDojo, ed è perché in tabella è segnata *parziale*.
- Nessuno di questi benchmark è stato **eseguito**: è una desk review.

## Fonti

arXiv:[2606.08529](https://arxiv.org/abs/2606.08529) ·
[2605.23950](https://arxiv.org/abs/2605.23950) ·
[2606.09863](https://arxiv.org/abs/2606.09863) ·
[2406.13352](https://arxiv.org/html/2406.13352v3) (AgentDojo) ·
[2507.15219](https://arxiv.org/abs/2507.15219) ·
[2509.17158](https://arxiv.org/abs/2509.17158) (GAIA-2/ARE) ·
[2510.27246](https://arxiv.org/pdf/2510.27246) (BEAM) ·
[AgentDojo GitHub](https://github.com/ethz-spylab/agentdojo) ·
[τ²-bench](https://github.com/sierra-research/tau2-bench) ·
[HAL](https://hal.cs.princeton.edu/) ·
[Zep, "Lies, Damn Lies, Statistics"](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/)
