# Stiamo sbagliando alla radice? Il confronto con i peer, misurato

**Data**: 2026-08-11 · **Domanda dell'owner**: *"vorrei una deep analisi della repo
Hermes per capire cosa stiamo facendo, cosa stanno facendo loro, e se stiamo
sbagliando fondamentalmente — moduli, scelte di harness, agent design, agentic
patterns."* · **Metodo**: quattro passate indipendenti (moduli/governance ·
traiettoria/proattività · assi di harness · verifica Letta), ogni claim marcato
verificato-su-fonte o non-trovato. Le fonti primarie sono nel testo; dove un
nostro documento è risultato sbagliato, sta scritto qui e corretto là.

**La risposta corta: no su cinque assi su sei, sì su uno (stretto), e tre
scommesse giuste erano non scritte.** Non ci mancano moduli: mancano un
parametro (il tenant nell'assemblaggio del prompt), un confine (vault
per-tenant), e quattro ADR.

---

## 1. Le correzioni ai nostri documenti (prima di tutto)

| dove | cosa diceva | cosa è vero |
|---|---|---|
| `03-threat-model.md:68` | "lezione Hermes #4146 → il sandbox non ha canali verso i tool" | Hermes NON l'ha chiusa così: ha tenuto il canale e propagato l'approvazione (PR #34497); la PR che toglieva la capability fu **rifiutata**; la classe si è riaperta due volte (#65592, #74078, aperte). Il nostro principio è giusto; la citazione dice il contrario del fatto — e corretta è più forte: *loro hanno scelto l'altro ramo e lo stanno pagando*. |
| giustificazione dei ~10 tool | implicita: "il prompt si gonfia" | Hermes espone **59 tool core, mai deferiti**, e funziona. La giustificazione che regge è superficie d'attacco e governabilità, non il conteggio dei token. |
| `a2-prior-art.md:258` | "Letta: granularità binaria" | `isolated_block_ids` per conversazione esiste (condividi `persona`, isoli `human`). |
| attribuzione critica LoCoMo | — | La critica "saturo/contaminato" NON è di Letta (loro dicono solo "misura retrieval"); il 6,4% di ground truth corrotta è un finding nostro e va citato come tale. |
| il mio stesso brief agli agenti | "Hermes ha checkpoint/resume del turno"; "non ci auto-verifichiamo" | Il loro `checkpoint_manager` è **undo per coding agent** (capability che ADR-0027 ha tagliato); e `agent/completion.ts` È un'auto-verifica pre-consegna, con ablation GAIA da 31 punti. |

## 2. Gli assi di harness — il verdetto per ciascuno

### 2.1 Loop singolo, cappato, niente planner — **regge**
Hermes: `while api_call_count < max_iterations` (nessun planner; `todo_tool` è
decomposizione *data al modello*, non un planner dell'harness). OpenHands SDK:
`while True → step()`, max 500, nessun graph. Letta v3: *"loops happen on tool
calls"* — ha **tolto** l'heartbeat dichiarato dal modello per una continuazione
strutturale, cioè si è mossa *verso* la nostra forma. Anthropic (*Building
Effective Agents*) approva esplicitamente: agenti con stopping conditions,
diffidenza per i framework che nascondono i prompt.
**Gap reale, non architetturale**: manca il tool `todo` (entrambi i peer ce
l'hanno). È un tool, non un planner.

### 2.2 Memoria curata dall'harness — **regge, ed è la meglio supportata**
Il fork che sembrava "noi contro Letta" è più stretto: **anche Letta dà timing
ed eviction all'harness** (la compattazione non ha un tool; gli agenti sleep-time
girano a schedulazione, `turns % frequency == 0`). Il fork vero è solo *chi
scrive il contenuto*. Evidenza sul nostro lato:
- **Letta stessa**: filesystem tools nudi → **74,0%** su LoCoMo (gpt-4o-mini),
  sopra Mem0-graph (68,5%). L'apparato di self-editing non è ciò che produce il punteggio.
- **Il loro leaderboard**: `core_read` saturo ~100, **`core_update` collassa**
  (claude-sonnet 83,7 · gpt-4.1 66 · o3-mini 16,7 · nano **0,0**). I loro dati
  dicono che l'update agentico è il punto di rottura.
- **Memory-R1** (ACL 2026): self-editing promptato = F1 41→34,5; failure mode
  nominati: *DELETE spurio su non-contraddizione*. ADR-0006 rende quel failure
  **non rappresentabile** (mai DELETE, solo supersede bitemporale).
- **Incidenti, verificati uno a uno**: #3388 (aperto) poisoning cross-sessione
  via self-write nella persona; #1616 replace-vuoto che esplode il blocco;
  #3241 blocchi che si gonfiano di notte, $30 bruciati, risposta "intended";
  #3291 il summarizer inventa contenuto e lo salva. E #3118: Letta sta
  **arretrando** le scritture di background a propose-only — verso di noi.
- Non trovato (detto onestamente): nessun head-to-head controllato
  agentico-vs-pipeline. → **ADR da scrivere** (0004 scarta Mem0/Graphiti, mai Letta).

### 2.3 Niente resume a grana di turno — **contraddetta** (l'unica)
OpenHands: snapshot + event-log append-only, autosave su ogni mutazione,
`get_unmatched_actions()` ripara i tool-call orfani dopo un crash. Anthropic
(sistema di ricerca in produzione): *"regular checkpoints… resume from where
the agent was"*. E il nostro M5 ha già concesso il principio (*"ogni job lungo
deve saper essere interrotto e ripreso"*) — a grana di job. Il buco: tool call
lungo + riavvio = tutto perso. **Reversal scopato**: estendere il `.jsonl` di
sessione a record ripristinabile per i turni lunghi/schedulati. NON l'event-log
di OpenHands (il loro resume ha richiesto un meccanismo di riparazione dedicato:
la resumabilità compra anche una superficie di correttezza nuova).

### 2.4 Niente critico LLM — regge ma **indifendibile senza ADR**
Abbiamo il gate deterministico (completion.ts); rifiutiamo il critico LLM.
OpenHands ne spedisce uno **spento di default** (threshold 0.6, ≤3 giri); Letta
non ne ha nessuno. L'ADR in tre frasi esiste (dal ricercatore) e va scritto:
un check a cui si può far cambiare verdetto con linguaggio assertivo
(+0,27–0,36 misurato) non è un check.

### 2.5 Delega disegnata e mai costruita — **indifendibile senza ADR**
Il numero più forte del campo punta contro di noi: **+90,2%** (orchestrator-
workers, Anthropic) — a **~15× token**, e "not a good fit" dove gli agenti
condividono contesto. I peer: OpenHands la spedisce **disabilitata di default**;
Hermes `MAX_DEPTH = 1` e spawn bloccato al figlio; **Letta è il contro-esempio**
(nessun contesto fresco, nessun guard di profondità, cicli A→B→A possibili).
→ ADR di rinvio con trigger scritto: deep-research che cappa le iterazioni, o
un tetto misurato del singolo agente sui task veri dell'owner.

### 2.6 Lane statiche · kernel puro · un processo — **reggono tutti e tre**
Nessun peer ha un router per-prompt (Hermes: `auxiliary_client` per-funzione =
le nostre lane). Il kernel è più forte del campo: OpenHands di default
`NeverConfirm`. ADR-0022 regge; la sua unica perdita è il 2.3.

## 3. Governance: il kernel puro, validato dai loro numeri

`approval.py`: 203KB, di cui 1.262 righe di parser/deobfuscatore shell; ~8 gate
indipendenti; UI ri-implementata 7 volte. **19× in 5,5 mesi mentre i tool
raddoppiavano** (`web_tools` +1%: la capability si finisce, il governo no; quota
governance 9,5%→15%). Esito: 3.009 issue di sicurezza, 65 bypass del gate in tre
classi (evasione regex · entry-point che dimentica il gate · race di stato), e
il verdetto è **loro** (`SECURITY.md`): *"a denylist over shell strings is
structurally incomplete"* — i bypass sono dichiarati fuori scope.
- La classe "entry-point che dimentica" è ciò che `decide()` obbligatoria elimina.
- Le altre due si evitano perché policiamo **capability tipate, non stringhe**.
- **Adopt-principle**: il floor hardline che scatta *prima* di ogni modalità
  (nessun setting di sessione lo alza); la separazione detect-ovunque /
  block-dove-c'è-un-umano (`threat_patterns.py`).
- **Adopt-mechanism**: lo staged-pending store (scritture in attesa persistite,
  sopravvivono al riavvio, rivedibili) → è il registro che manca al nostro DRAFT.

## 4. Self-improving skills: il rinvio di ADR-0014 è validato
L'agente Hermes scrive skill a runtime e **di default nulla sta fra scritta ed
eseguita** — la guardia è spenta, e il loro docstring spiega: *"l'agente può già
eseguire lo stesso codice via terminal senza gate"*. Hanno spedito il cricchetto
senza il RoT. Risultato: 751 skill malevole sul registry (1,3%), lo scan
auto-esentabile via `.skillignore`, provenance chiesta dalla community da 3 mesi
(#25512) — cioè la nostra colonna `origin` e i tier. L'ordine di ADR-0014 (prima
il RoT irraggiungibile, poi l'auto-modifica eval-gated) è confermato.

## 5. Proattività: siamo avanti, e la prova è doppia
In core Hermes **niente osserva la persona** (`silent_since`, absence: not
found). Il profilo utente è un blob di 1.375 char **interamente dedotto e
asserito come detto** — ciò che `origin` esiste per impedire. Le prove del
bisogno: l'issue più votata chiede *"You went quiet after that thread — want a
recap?"* (= `gone_quiet`, chiesto da un loro utente); **zero** issue "troppo
invadente"; e un utente ha costruito il layer **fuori** (hermes-active): LLM
*chiesto*, matrice deterministica *decide se esce*, 70% SKIP — con la riga
chiave *"non ho trovato un modo pulito di farlo col solo cron"*. E il loro unico
meccanismo interno (`cron/suggestions.py`, fonte `usage`) ha **zero chiamanti in
produzione** — il nostro difetto di casa, nel loro repo, non ancora trovato da loro.
**Contro-posizione seria da registrare in ADR-0028**: Hermes rifiuta le quiet
hours nel control-plane *come dottrina* (#17459). Risposta nostra, misurata:
Pare-Bench 17,8% di momento sbagliato sul modello migliore — uno su sei è troppo
per un rail che puoi rendere deterministico.
**Adopt**: un "no" sopravvive a un "sì" (i respinti tenuti per sempre, solo per
il dedup) · il cap che **scarta** invece di accodare · Stage-2 su modello
economico (razionale di cache scritto da loro).

## 6. Traiettoria: cosa dice il loro passato sul nostro futuro
3 tool (lug 2025) → 7 (piatto 4 mesi) → 45 (feb 2026, la productization) → 93
(+MCP). Le **rimozioni** sono le nostre regole raggiunte a posteriori:
`send_message` tolto come tool del modello (*"outbound messaging stays outside
the agent loop"* — PR #47856, 8 file toccati; noi non l'abbiamo mai spedito);
`mixture_of_agents` demoto da tool a modello; cron 3→1.
**L'avviso onesto**: convergere a ~100 non è indisciplina — è il prodotto
multi-superficie. Il tetto a 10 regge finché muffin resta single-owner; quando
arrivassero superfici classe Discord/HomeAssistant, arriva anche la pressione, e
ora sappiamo il prezzo: 19× di governance.

## 7. Tool search / selection
Il loro `tool_search` nasce a 48 tool core **e non per quelli**: per i cataloghi
MCP (il numero che l'ha forzato: Cloudflare, ~3.300 tool, 32K token di soli
nomi). BM25 inlined, ~250 righe, niente embedding. **Per noi**: a 10 no, a 59
no; il trigger è il primo server MCP >100 tool. Ma la primitiva nostra che manca
PRIMA è la **selezione**: `loop.ts` espone `slice(0, maxToolsExposed)` — ordine
di registrazione, e i tool MCP si attaccano ultimi, quindi su Qwen (tetto 10)
cadrebbero fuori per primi, in silenzio. Chi entra nella finestra, per turno e
per principal, è la scala: ordine arbitrario (oggi) → priorità → rilevanza →
search.

## 8. Prompt: file vs codice, e l'assemblatore
Prompt-as-code invecchia male (il loro `prompt_builder.py`: 116KB, 161+ commit,
issue aperta "fatemi spegnere i blocchi hardcoded"); prompt-as-files è amato **e
rotto proprio sul caricamento nel gateway** (#66396, SOUL.md non caricato su
Telegram — la stessa classe del nostro voice.md stantio, stesso punto). Tutti i
peer hanno un assemblatore nominato; `knowledge/README.md` lo elenca già fra le
primitive. **Nessuno ha la tenancy nel prompt** — parametri: cwd, modalità,
hint; mai un tenant. Lì siamo da soli, e il meccanismo è noto: prefisso condiviso
+ banda tenant = N cache calde, non N ricalcoli (l'esempio ufficiale di
`prompt_cache_key` di OpenAI è letteralmente `"tenant:acme"`).

## 9. La lista che ne esce (ordinata per costo dell'assenza)
1. **Assemblatore in `agent/context/` col tenant come parametro** — chiude il
   difetto comportamentale (persona che elicita dati personali in un gruppo) e
   un deliverable M1 dichiarato in tre documenti e mai costruito.
2. **Resumabilità a grana di turno** (reversal scopato, sul jsonl esistente).
3. **Quattro ADR**: memoria (conferma, armato di leaderboard e incidenti loro) ·
   delega (rinvio con trigger) · niente-critico-LLM (conferma) · emendamento
   0028 con la contro-posizione quiet-hours.
4. **Registro staged-pending** per DRAFT/undo (adopt-mechanism, il disegno è il loro).
5. **Tool `todo` + `clarify`** (gap veri contro i casi d'uso).
6. **Selezione dei tool per principal/turno** (prima di ogni search).
7. Fire-log: un "no" deve sopravvivere a un "sì" (per quando esisterà il dismiss).

*Fonti primarie citate nel testo; passate del 2026-08-11 sui repo
NousResearch/hermes-agent (@HEAD), OpenHands/software-agent-sdk (@281843c),
letta-ai/letta (@ff19ffe), più Anthropic "Building Effective Agents",
12-factor-agents, Letta blog/leaderboard, Memory-R1 (arXiv:2508.19828).*
