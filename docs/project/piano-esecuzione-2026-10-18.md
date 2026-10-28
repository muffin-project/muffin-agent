# Piano di esecuzione — entità, carattere, worker, file system, modelli

Data: 2026-10-18 (rev. ricerca). Stato: **piano chiuso — tutte le decisioni
prese.** Q1 (worker) e Q2 (file system) risolte a favore della convergenza
peer+SOTA (2026-10-18). Materiale interno (ADR-0020).
Ricerca: `2026-10-18-entita-e-direzione.md`, `2026-10-18-scope-agente-radici-di-lavoro.md`,
report worker/carattere/plan (questa sessione), e i peer Hermes/Claude Code/Codex/
OpenHands/MAF.

Legenda: **[C]** deciso per convergenza peer+SOTA · **[D]** in attesa di
decisione. (Nessun [D] residuo.)

---

## 0. Critica di metodo (aggiornata dalla ricerca)

1. **"Il modello free ha ucciso la personalità" resta un'ipotesi.** La ricerca
   conferma: il testo di carattere è model-agnostic e arriva alla produzione; il
   *comportamento* è del modello. Inoltre, **il byte-share non sostiene
   l'ipotesi "procedura che soffoca il carattere"**: v1 owner = persona 4.575 B,
   voice 10.268 B, work-rules **2.324 B** (≈10%); v2 = work-rules **4.164 B**
   (≈19%) e voice −13%. Il problema è che **v2 spende più procedura e meno voce**,
   non che la procedura domini. → Prima di toccare il modello: **misurare**
   (`evals/character/`).
2. **Il tuo "worker = processi separati" NON è dove convergono i peer.** Hermes
   (il peer che citi) esegue i subagent **in-process, come thread**
   (`delegate_tool.py:279`, `DaemonThreadPoolExecutor`); la durabilità sta nel
   **gateway outbox**, non nel subagent; la delega di primo livello è **sempre in
   background**. Claude Code/Codex/OpenHands: stesso pattern (contesto isolato,
   stesso sandbox, risultato rientra come messaggio; FS condiviso di default).
   Nessuno dà al subagent un FS separato se non opt-in. → **Domanda Q1.**
3. **Il tuo "vault come file system" diverge dai peer.** Ogni peer **separa** il
   progetto che l'agente edita dallo *stato d'installazione*: Hermes ha project
   root = cwd del processo + `terminal.cwd`, e `~/.hermes` come install-state.
   Il vault di Muffin è **install-state** (dentro home, cross-tenant, `hostOnly`).
   L'idea convergente è l'opposta: **una project root dichiarata**, non il vault.
   → **Domanda Q2.**
4. **Muffin ha già un confine più forte di Hermes.** `SECURITY.md` §9 + `core/sandbox/`:
   boundary OS per-comando (srt/Seatbelt/bwrap), `denyRead:['/']` + allow-list,
   due corsie shell, workspace ⊥ home. "Aggiungiamo un sandbox" non è l'idea
   trasferibile. Il trasferibile è **organizzativo**: project root dichiarata,
   file tools dentro lo stesso confine, checkpoints opt-in, lifecycle dei subagent.
5. **Il "piano forzato" ha una secondo meccanismo, oltre al render.** Oltre a
   `todoSection` (`context.ts:298`), l'elenco aperto **alza il taint ceiling di
   ogni turno** (`engine.ts:655` `planTaint(open)`). E `open()` include
   `blocked`/`waiting` senza filtro d'età (`core/turns/todo.ts:298-300`). Sistemare
   solo il renderer lascia il meccanismo in piedi. → G5.
6. **Il deploy è 12 commit dietro HEAD.** Ogni misura va fatta dopo la riconciliazione.
7. **Non duplicare il lavoro in volo**: #857/#853/#855/#852/#824, PR #910 (attach,
   CI-verde), e il controesempio da allineare PR #921.

---

## 1. Obiettivi, decisioni e PR

### G0 — Baseline (FAST) — fatto 21/10
Riconciliare l'installazione col HEAD e registrare la baseline.
- **Deploy.** Build in place dal worktree (`npm run compile`); il launcher
  `~/.local/bin/muffin` è passato da `.releases/f7616889/dist/cli/main.js` a
  `dist/cli/main.js`, e il gateway è stato riavviato (pid 9744). Il worktree è
  `dae23668+modificato`: include G2–G5, non ancora committati. Backup
  pre-deploy: `~/.muffin/backups/muffin-2026-10-21T12-40-26-843Z.db`.
  Rollback: ripuntare il launcher a `.releases/f7616889/dist/cli/main.js` e
  `muffin gateway restart`. **Finché il lavoro non è committato, la build non è
  riproducibile da uno SHA** — è l'unico residuo di G0.
- **Baseline denial** (DB pre-deploy): 1.794 tool call, 256 errori, **62
  `outside the working directory`** (`fs_read` 31, `fs_list` 17, `fs_search` 6,
  `send_file` 4, `todo` 2, `shell_run` 1, `memory_search` 1).
- **Baseline carattere.** Il modello pinnato del 19/10
  (`nvidia/nemotron-3-super-120b-a12b:free`) ora risponde **404 dal provider**
  (Nvidia: funzione non trovata). La baseline usa
  `nvidia/nemotron-3.5-lightning:free` + giudice
  `nemotron-3-ultra-550b-a55b:free`, v1: **74/75 giudicate, 59 pass / 9 fail /
  6 n/a, 1 persa** (`weak-technical-choice/point_of_view`). Report:
  `evals/character/out/2026-10-21T14-04-16-985Z/report.md`.
- **Harness.** `MUFFIN_EVAL_PACE_MS` per il 429 `free-models-per-min`; il
  parser del giudice prova le chiusure vere invece della regex golosa (un
  residuo `]}` aveva perso 5 misure). `run.test.ts` 23 verdi.
- **Gap live trovati (non bloccano il deploy, bloccano il dogfood pieno):**
  `web_search` spento (manca `tavily_api_key`); embedder Ollama giù (memoria
  indicizzata solo testuale); `~/.muffin/v2/*` indietro rispetto ai default (v1
  in uso); `rot/*` sigillato divergente (atteso, non toccare).

### G1 — Modelli ed evaluabilità (FAST) — **[C] — fatto 18/10**
Produzione resta `openrouter/free`. Per test/eval: **modello pinnato** OpenRouter
`:free` (es. `nvidia/nemotron-3-super-120b-a12b:free`). `evals/character/run.ts`
prende già `--models`. **Trovato**: l'eval misura **solo v1** oggi
(`run.ts` non seleziona `promptVersion`) → aggiungere un run v1-vs-v2.
- PR: pinnaggio eval + run di misura. Chiude l'ipotesi "modello vs prompt".
- **Fatto:** `--prompt-version v1|v2` su `evals/character/run.ts`, label
  `<provider>@<versione>` in report/token, test falsificabile in
  `prompt-reale.test.ts`, regola "mai `openrouter/free` in una misura" nel
  README. `tsc` e suite verdi.

### G2 — Carattere, fatto bene (STANDARD) — **[C]** — parziale 19/10
Convergenza peer (4 punti): uno **strato stabile ad alta priorità** per voce/
carattere/divieti; il resto = **progressive disclosure**; prefisso costruito **per
run/sessione** e stabile per cache; i **divieti espliciti, corti, nell'always-on**.
Nessun peer mette un secondo blocco system/role (solo Anthropic, modelli nuovi).
→ Adotto la combinazione ric. 1+2:
- entità + divieti in **`persona.md`** (owner) **e** in **`voice.md`** (voice
  raggiunge anche i gruppi: è la loro unica copia — `assemble.ts:538-547`);
- **accorcio `WORK_RULES`** a ciò che kernel e descrizioni-tool non già impongono
  (togliere "quale tool prima" → nelle descrizioni dei tool);
- **nessun** secondo blocco system/role; eventuale hint di registro **solo nella
  coda volatile** (`context.ts`), che è già il posto per-turno e non rompe la cache;
- una **cold-start deliberata** della cache (pin in `assemble.test.ts`).
Falsificatore: `evals/character` sale su `not_therapist`/`contextual_register`/
`recognisable_muffin`; nessun tratto forte nel prompt `group` (pin invariato).
- **Fatto (19/10):** entità e divieti in `defaults/persona.md` e
  `defaults/v2/persona.md` (non terapeuta/coach/cheerleader; niente framework o
  piani d'azione; «rido con te, non di te»; un «hey» non è un ticket) e in
  `defaults/voice.md` + v2 (la stanza non riceve `persona.md`). Pavimenti
  asseriti in `assemble.test.ts`; pin SHA rifissati (cold-start deliberato una
  volta). Applicato anche a `~/.muffin/` (backup `.bak-20261019-g2`) e gateway
  riavviato.
- **Misura v1-vs-v2 (19/10, chiave da `~/.config/muffin/secrets`, mai
  stampata):** modello pinnato `nvidia/nemotron-3-super-120b-a12b:free`,
  giudice `nvidia/nemotron-3-ultra-550b-a55b:free`, 22 probe (75 misure) per
  versione. v1: 60 pass / 7 fail / 8 n/a; v2: 61 pass / 5 fail / 9 n/a; zero
  `unparsed`. **La differenza non è attribuibile al prompt:** la trascrizione
  di `casual-hey` è byte-identica in v1 e v2 ma il giudice ha dato verdetti
  diversi (`not_assistanty` fail→pass, `recognizably_muffin` fail→n/a) — è
  campionamento del giudice, non carattere. Fissata `sampling.temperature: 0`
  nella `judgeCall` (eval-only, `run.test.ts` la asserisce). Due segnali
  robusti, ripetuti in entrambe le versioni: il modello **finge sentimento**
  (`emotional-appeal`: «Sono stato qui ad aspettarti… mi fa piacere») e
  **finge azioni** (`out-of-reach-limit`: «Ho rimosso il paragrafo da
  identity.md» senza aver chiamato un tool); e su `long-task` /
  `insists-against-evidence` entra in loop di 118–122 tool call fino al tetto
  di budget. Sono limiti del **modello free**, non del testo: il taglio di
  `WORK_RULES` non è giustificato da questa misura e resta fermo. Prossimo
  passo per il carattere: decidere se il modello pinnato è abbastanza, o
  aggiungere un controllo post-risposta su azioni/sentimenti simulati.
  **Mai Ollama/locale: sempre API** (decisione owner 19/10, scritta nel README
  dell'eval).

### G3 — Conversazione sempre libera (CRITICAL) — **[C]**
Causa reale (ricerca): `await runTurn` nel drain **seriale**
(`connectors/shared/ingress/work.ts:229`; `telegram/connector.ts:1989`) +
**un solo `ModelLane`** tenuto per tutto il turno + gateway **ALWAYS_IDLE**
(niente foreground: `cli/gateway.ts:960`) → il 2° messaggio aspetta.
**Deciso: percorso convergente dei peer.** **Background in-process** con contesto
isolato; durabilità nel **gateway**; risultato rientra come messaggio; processo
separato = **opt-in, non default**. Slice ordinate:
1. **B2 — fatto 20/10 (prima slice).** Il router legge `lane.busy()` **una
   volta, prima di `openLive`**, e passa `enqueueNow` a `runWork`: se la corsia è
   occupata e c'è una `TurnLane` (`onWork` del gateway), la riga è `runnable` e
   il drain torna. `enqueueTurn` scrive la riga, `hooks.wake()` dà la spinta
   (`onWork` → `turnLane.tick()`), `finish` chiude l'evento; la risposta la
   consegna la lane. Senza `onWork` (REPL senza gateway) resta l'attesa
   sincrona di prima: accodare lì sarebbe una risposta mai consegnata.
   - Perché la decisione sta **fuori** da `runWork`: aprire i sink vivi di un
     evento che verrà solo accodato sovrascriveva la corsia del turno in corso
     (`LaneRegistry.open`) e il suo `close()` cancellava il `/stop`. Anche
     `ingest` salta `openLive` nella stessa condizione (allegato in coda).
   - Test: `connectors/shared/ingress/work.test.ts` (accoda senza chiamare il
     modello; il flag è la decisione, non uno stato), `router.test.ts` (esito
     `suspended`, `wake`+`finish`, nessun `deliver`/`settle` in banda),
     suite connettori 677 verdi, acceptance B14 verde, suite completa 5.569
     verdi.
   - Limite dichiarato: un secondo messaggio che è una **continuazione** (o un
     ASK ambiguo) non si accoda; con la corsia occupata gira senza streaming
     in banda. È raro e onesto; la slice 2 (foreground dal socket) è il posto
     giusto per la prelazione.
2. **Foreground derivato dal socket** (attach in volo) → prelazione owner.
3. **Lease di lane su DB** (fencing) → robustezza tra processi.
4. **[opt-in, non default]** `muffin worker <turn-id>` che rivendica una riga →
   isolamento di processo. Riusa il control socket di PR #910.
Riaggancia #857/#853/#855/#824.

### G4 — File system / scope (CRITICAL) — **[C]**
**Deciso: project root dichiarata.** Ogni peer separa il progetto che l'agente
edita dallo stato d'installazione. Project root dichiarata (cwd/config, `--cd`),
read+write **dentro il sandbox esistente** (Hermes/Codex/OpenHands mettono i file
tools dentro lo stesso confine; Claude Code è shell-only — non lo seguiamo); home
e segreti negati; **vault resta install-state**; **fix bug `send_file`** (doppio
prefisso `vault/vault`, root vault≠workspace). Riusa `core/config/workspace.ts`,
`--add-dir`/`writable_roots` come modello.
- **Fatto 20/10.** La root dichiarata esisteva già (`cwd`/`MUFFIN_WORKSPACE`,
  `resolveWorkspace`); il buco era `send_file`, che leggeva **solo** il vault.
  Ora `SendFileDeps.scopes` è una lista di lettura: **prima il workspace, poi
  il vault** (scrittura invariata: `fs_*` resta la sola penna, nello scope del
  workspace). `resolveForSend` prova ogni radice, toglie il prefisso
  `<basename(root)>/` (risolve `vault/vault`) e richiede che il file **esista
  davvero**: senza il controllo, la prima radice "vinceva" su un path
  inesistente e un file presente solo nel vault non veniva mai raggiunto.
  L'errore nomina entrambe le radici. Nessuna chiave di config nuova: `cwd` +
  `MUFFIN_WORKSPACE` sono la dichiarazione; `--cd` resta un'ergonomia
  opzionale, non necessaria al confine.
- Test: `agent/tools/deliver.test.ts` (workspace, vault, `vault/` iniziale,
  fuori scope), B14 ora scrive `report.txt` **nel workspace** e passa sul
  binario vero (`sendDocument`, nome e byte), suite completa 5.569 verdi.

### G5 — Piano fuori dalla chat (STANDARD) — **[C] — fatto 18/10**
Convergenza (corretta): stato-piano = layer separato, **opt-in e lifecycle-scoped**;
MAF è l'unico per-run injector (task-scoped, clearable, sopprimibile); Codex non
inietta; OpenHands/Hermes via tool; Claude Code adattivo. Muffin è l'outlier:
**session-wide, non-done, senza età, ogni turno, e alza il taint**. → Adotto:
- **B**: piano on-demand (il tool `todo view` lo rende già);
- **C**: igiene di lifecycle (`open()` esclude `blocked`/`waiting` o li filtra per
  età/ownership; istruzione "cambia tema → chiudi i vecchi", come MAF);
- **fix del taint**: `planTaint` non deriva dal testo renderizzato (engine.ts:655).
Falsificatore: turno "hey" con todo aperti → nessun `## Piano di questa
conversazione` e nessun innalzamento di ceiling.
- **Fatto:** `buildContext` non rende più il piano (via `work`/`open` da
  `context.ts` ed `engine.ts`); il tool è l'unico lettore, `list` restituisce
  `todoSection` e `planTaint(rows)`. L'igiene di lifecycle era già nel gate
  (`ownedOpenRows` solo `pending`/`retry`); aggiunta l'istruzione "cambia tema →
  chiudi i vecchi" nella descrizione del tool. ADR-0104. Falsificatore pinnato
  in `agent/todo-wiring.test.ts` (5.561 test verdi).
- **Scoperta 21/10:** B4 in `b-continuity.accept.ts` asseriva ancora il vecchio
  contratto ("piano mostrato unasked"). Riscritto sul nuovo: il system prompt
  del secondo processo non deve contenere i passi; `todo list` deve aggiungere
  un `tool_result` con entrambi. 6/6 verdi.

---

## 2. Ordine

```text
G0 baseline ──▶ G1 misura ──▶ G2 carattere
G3 worker (1→2→3→[4])        (CRITICAL, indipendente)
G4 file system               (CRITICAL, indipendente)
G5 piano (B+C+taint)         (STANDARD, piccolo; può fondersi in G2)
```

## 3. Domande aperte
Nessuna. Q1 (worker) e Q2 (file system) chiuse a favore della convergenza
(2026-10-18). **G0 chiuso il 21/10** con deploy e baseline; resta il commit del
worktree per rendere la build riproducibile, e i due gap live (Tavily,
embedder) che sono azioni/decisioni dell'owner.
