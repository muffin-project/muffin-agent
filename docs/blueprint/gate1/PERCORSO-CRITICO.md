# Percorso critico minimo verso DAY 1

**Aggiornato**: 2026-08-17 (pomeriggio) · base `dev` @ `98e4787`.
Questo file è la sequenza operativa che il `/loop` segue: una slice alla volta,
piccola, verificata, giudicata e mergiata prima della successiva. Nasce dal
triage evidence-only del 17/08 (tre worker in sola lettura, tutti i BLOCKER,
tutti i `?`, i 19 MEDIUM dell'audit `research/audit-2026-08-16/`, le otto
proprietà trasversali del mandato) e dalle priorità dell'owner
(`MANDATO-DAY-1.md` + direttiva 17/08):

1. invarianti trasversali che possono invalidare più READY;
2. forma durevole prima che inizino i dati reali;
3. capability che costringerebbero l'owner a usare un altro agente;
4. UX/polish;
5. tutto il resto OUT/post-Gate 1.

`M5-BIS.md` è l'inventario (una delle quattro risposte per riga, con evidenza);
qui c'è solo **l'ordine** e il **perché**. Quando una slice chiude, si sposta la
riga in M5-BIS e si barra qui. Ogni slice ≤ ~500 righe nette, un judge (sonnet;
opus solo su concorrenza/kernel/segreti), tetto due giri, al massimo due slice
non sovrapposte in volo.

## 0 · In volo adesso

*(Questa sezione è verificata meccanicamente: `node .claude/riconcilia.mjs` esce
≠ 0 se qui compare una PR già mergiata o un branch già cancellato. Va aggiornata
**nello stesso passaggio del merge**, non dopo — `BRANCHING.md` checkpoint 4. Il
controllo non vede una voce *duplicata*: quella la vede solo chi legge.)*

- **`slice/egress-params`** (PC 1.6, **CRITICAL**) — implementazione, wiring e
  scenari già scritti prima del session limit; `origin/dev` mergiato e mappa
  rigenerata. Resta: rifinire, riverificare per mutazione il gate sui parametri,
  judge fresco, verdetto terminale.
- **`slice/session-taint`** (PC 1.2, **CRITICAL**) — WIP committato e pushato:
  tier per messaggio di sessione, la history reiniettata alza la taint prima del
  kernel. Da riprendere allo stesso modo.
- **`slice/identita-eval`** (A2/A3 parte 2, STANDARD) — WIP committato e
  pushato: character eval a proprietà, cross-model, confronto qualitativo col
  vecchio Muffin. La corsa reale sui modelli costa e va proposta all'owner prima
  di lanciarla.

**Integrate oggi** (non più in volo): #53 lease/fencing · #54 acceptance truth ·
#56 A1 continuità · #57 WAL dell'intento · #58 identità parte 1 · #59
`init --local` · #60 citazioni della mappa · #63 workflow (profili di verifica) · #61 cluster di MEDIUM dell'audit (P34-1, P35, P36, P25, P33, E2).

## 1 · Invarianti trasversali (priorità 1) — possono invalidare READY già dati

| # | Slice | Cosa chiude | Evidenza del difetto oggi | Costo |
|---|---|---|---|---|
| 1.1 | ~~`slice/wal-intent`~~ **fatto (#57)** | Mandato inv. 1 e prima verifica pre-D2/D3/D11: **fallita persistenza di `startToolCall` ⇒ l'handler NON esegue**. Oggi `recordIntent` inghiotte l'errore e `tool.handler` parte comunque. Insieme: `tier` obbligatorio nella firma di `endToolCall` (audit P05: `NULL` silenzioso salta il bump di taint). | `agent/loop.ts` `recordIntent` (try/catch senza throw) → `await tool.handler(args, ctx)` incondizionato; `core/turns/store.ts` `endToolCall(tier?)` | S |
| 1.2 | `slice/session-taint` **(in volo, WIP)** | Mandato inv. 2: la history di sessione reiniettata alza la taint del turno al tier massimo del contenuto che riporta (probe eseguito: turno 2 pulito nella stessa sessione di un turno tier 3 → taint 0, testo tier 3 presente nella richiesta al modello — **LAUNDERED**). Serve il tier per messaggio di sessione (colonna additiva su `SessionMessage`, o derivazione da `TurnStore` per `sessionId` — scelta tecnica del worker, dichiarata nella PR). | `agent/loop.ts` `taint: principal.kind==='member' ? 2 : 0`; `buildContext` inietta `sessions.read()` come testo; `core/session/store.ts` senza tier | M |
| 1.3 | `slice/recall-speaker` | Mandato inv. 3: un episodio `role='agent'` richiamato non è mai «tu» (probe eseguito: `source: "tu via cli"` per una frase mai detta dall'owner — **CONFLATED**). `describeTier` riceve il ruolo; `searchEpisodes` seleziona `role`; rendering `[muffin, …]`. Stesso file: audit P23 (ricerca a parola chiave e vicinato non marcano RITIRATO i fatti superseduti). | `core/memory/recall.ts` `describeTier(tier→'tu')`; `core/memory/store.ts` `searchEpisodes` senza `role`; `schema.ts` trigger FTS senza filtro | M |
| 1.4 | `slice/ingress-forward` (B16 minimo, non l'envelope universale) | Mandato inv. 3 lato ingresso: un messaggio **inoltrato** dall'owner da un estraneo entra oggi a tier 0, byte-identico alle parole dell'owner (audit P14); caption/filename entrano fusi nel testo. Minimo: `forward_origin` → contenuto a tier 2 recintato; caption e filename come campi tipizzati con provenienza. L'envelope completo (nomi, bio, entities, poll, contact) resta post-Gate 1 con ragione scritta in M5-BIS. | `connectors/telegram/connector.ts` `parseUpdate` (`text ?? caption`, nessun `forward_origin`) | M |
| 1.5 | `slice/job-fires` + `slice/inbound-unit` — **decisione owner presa (17/08): A, `job_fires` come ponte di identità** | Mandato inv. 4 e 5 (proprietà 3 e 4). Proprietà voluta dall'owner: «ogni occorrenza stabile `(job_id, scheduled_for)` mappa a UNA sola identità durevole di lavoro/turno; dopo un crash Muffin continua o conclude quella stessa identità, non crea un secondo turno e non abbandona il primo». `job_fires` è un **ponte di identità/idempotenza verso `turns`** (`(job_id, scheduled_for) → turn_id`), non un secondo TurnStore; `scheduled_for` è l'occorrenza dovuta, mai l'ora in cui il processo l'ha presa. Matrice di fault minima: crash prima del fire → si crea; dopo il fire prima del turno → completa il binding, non perde il fire; dopo la creazione del turno → riprende lo stesso `turn_id`; a metà turno → recovery normale del turno/effect WAL; turno `done` prima di `markRan` → non richiama il modello, completa il settlement; delivery incerta → non rifà la computazione; **solo dopo il settlement** avanza la schedule. Niente trigger framework; deve **comporre** con la stessa proprietà Telegram `update_id → exactly one durable turn` (oggi `drain()` → `handle()` → `runTurn` con id fresco: crash fra `handle()` e `markProcessed` = secondo turno, secondo giro modello, seconda consegna). Una forma più piccola che garantisca esattamente queste proprietà è ammessa. Prova: fault-chain con Bot API finto e SIGKILL reale in quattro punti (dopo accept / dopo runTurn / dopo sendMessage / dopo recordDelivery) e per i job nei sette punti della matrice. Chiude B7, B1 (metà Telegram), la parte Telegram di B8, e apre B2 alla prova di prod. | `core/scheduler/scheduler.ts` `markRan`; `connectors/telegram/connector.ts` `drain()`/`handle()`; `core/turns/store.ts` (nessuna chiave d'origine) | L (una slice per il ponte job, una per Telegram, una per la journey) |
| 1.6 | `slice/egress-params` **(in volo, WIP)** | Mandato inv. 7 (proprietà 6): il kernel guarda solo l'host; byte a tier ≥ 2 nel path/query di `http_get` verso host allowlisted passano (P04-1); `sys.search` dichiara `resourceKind:'none'` e non entra mai nel ramo egress (P04-2, D7). Chiude D7 e la journey egress (D6/D7/D10 nello stesso file di scenario). | `core/policy/decide.ts` ramo `resourceKind==='url'`; `agent/tools/http.ts`; `agent/tools/search.ts:57` | M |

## 2 · Forma durevole prima dei dati reali (priorità 2)

| # | Slice | Cosa chiude | Costo |
|---|---|---|---|
| 2.1 | `slice/schema-evolution` (A7 + P27, proprietà 7) | `ensureColumn` generalizzato (già metà fatto da #53 in `core/lock/durable.ts`) e applicato a `turns`/`jobs`/`todos`; **un test che parte da un `muffin.db` allo schema di `b9ab672` popolato** (turni, job, episodi, fatti) e applica HEAD: boot, `doctor`, un turno, `memory search`, tick dello scheduler — zero `no such column`, zero righe perse. `episodes.kind` CHECK: la strada dichiarata (rebuild guidato o CHECK allargato prima del giorno 1) scritta in ADR. | M |
| 2.2 | `slice/update-backup` (A6 + A8) | `muffin update` (A6: nuovo artifact, stesso home, `doctor` dopo; naming `build` vs `compile` che non lascia credere di aver costruito `dist`); `muffin backup` con `wal_checkpoint(TRUNCATE)` o stop-copia-riavvio dichiarato, `restore` documentato; scenario J2 backup **a caldo** con gateway vivo → distruzione → restore → `doctor` + `memory search`. | M |
| 2.3 | `slice/undo-journal` (D2/D3/D11, forma decisa dall'owner 16/08: quattro classi + journal per turno in `~/.muffin/undo/<turno>/`) — dopo 1.1 | Effect lifecycle riusabile (mandato §6): policy → intent durevole → snapshot pre-effect (mai sovrascritto da un retry: guardia idempotente per `call_id`) → effetto → outcome durevole → `muffin undo` che riallinea filesystem **e** riga turno. `draft` diventa eseguibile; `fs_write` smette di rifiutare il 100%. Journey J4. Probabile split in due PR (journal+snapshot; `undo` CLI + reconcile). | L |
| 2.4 | ~~`slice/audit-mediums`~~ **fatto (#61)** (cluster di S indipendenti, un solo PR) | P34-1 `span.error` non redatto; P35 cache-write fatturato 0.25× invece di 1.25×; P36 «hardened» = probe W_OK, aggiungere `uid` check; P25 filtro lessicale sui fatti estratti; P33 fencing a nonce delle skill nel prompt (D9); E6 tetto sulle tool call per turno indipendente da `iterations`; E2 spesa **di oggi** in `/spend` (`tenantTodayUsd` esiste). Ogni voce con test rosso-prima. | S×7 |
| 2.5 | **Decisione owner**: P34-2 segreti a riposo in `turns.messages`/`turn_tool_calls.content` (mai pruned, righe mai cancellate). Redazione in scrittura? prune con età? Finché non decide: nessuna slice; nota in E3. | — |

## 3 · Capability che costringerebbero a un altro agente (priorità 3)

| # | Slice | Cosa chiude | Costo |
|---|---|---|---|
| 3.1 | `slice/ask-dice-cosa` (D12) | L'ASK porta l'azione specifica (comando+cwd, URL, pid+nome) e la ragione del taint; le richieste `turn_outcome='ask'` non risolte restano visibili (`doctor`/comando) finché l'owner non decide. Meglio dopo 2.3 (stessa famiglia decisione+registro). | M |
| 3.2 | ~~`slice/init-local` (A9)~~ **fatto (#59)** | `muffin init --local` riusa il segreto persistito senza `--api-key`. | S |
| 3.3 | `slice/prompts-md` — **parte 1 fatta (#58)**: `prompt show`, home canonica, wiring; resta l'onboarding a stato e i prompt puro-Muffin in `defaults/prompts/` | Prompt puro-Muffin in `defaults/prompts/*.md` importati (identity/voice a casa, identity nel RoT), onboarding come nudge a stato, tracciabilità sezione→doc. **`muffin prompt show` e il contenuto di A2/A3 sono già chiusi** (`slice/identita` parte 1, 2026-08-17: `research/prompt-assembly-2026-08-17.md` — la plumbing era già canonica, nessuna duplicazione trovata). Resta solo lo spostamento delle tre stringhe hardcoded in `agent/context/assemble.ts` (`GROUP_PERSONA`, `WORK_RULES`, `SAFE_MODE_NOTE`, catalogate nella ricerca) e l'onboarding. A2/A3 restano BLOCKER per il character eval, non per il contenuto — `slice/identita` parte 2. | S |
| 3.4 | `slice/provider-retry` (B6) | 429/5xx/rete a metà turno: retry con backoff nell'adapter, fallimento esplicito oltre il tetto (mai silenzioso). | S |
| 3.5 | `slice/pairing-sigilla` (B15) | Il pairing sigilla da solo il binding; manomissione di `config.json` non sigillato rilevata. | S/M |
| 3.6 | `slice/telegram-media` (B10) | Foto → modello con visione se la capability c'è, altrimenti rifiuto esplicito; errori Telegram visibili. | S/M |
| 3.7 | `slice/budget-per-job` (E1) | Cap per singola esecuzione di job, controllato prima del goal, dinamico da CLI. | M |
| 3.8 | `slice/audio` (C8) — **ultima**, e solo se l'owner conferma che le note vocali servono nei 14 giorni | Capability nativa del modello se c'è, altrimenti whisper/faster-whisper locale, fornitore da CLI. Nessuna chiamata reale nella suite. | L |
| 3.9 | B2 turno lungo Telegram | Provato al test di prod (decisione owner); resta BLOCKER nell'inventario finché non è provato lì. | battery |
| 3.10 | `slice/sys-inspect` (E7, lacuna aggiunta dall'owner il 17/08) — dopo `slice/identita` parte 1 (`prompt show`) | Propriocezione tecnica: Muffin «non deve ricordare come funziona quando può interrogarsi». Una primitiva **read-only first-class `sys.inspect`** che legge dalle **stesse fonti autorevoli** già usate da runtime/`doctor`/`prompt show`/`gateway status` (una sola source of truth: runtime facts → doctor / prompt show / gateway status / sys.inspect; nessuna implementazione divergente; niente altra documentazione nel system prompt). Scope minimo Gate 1: overview runtime; provider + modello main/light correnti; surface/tenant corrente; RoT/safe mode; sandbox/search/MCP disponibili; capability effettivamente esposte; blocchi del prompt e provenienza; modalità reale della memoria (indice vettoriale disponibile o degradato); work state essenziale (turni aperti/waiting/interrupted); scheduler/job essenziali. Distinguere sempre **architettura/progetto** da **stato live dell'istanza**. Acceptance: «spiegami tecnicamente come funzioni e cosa stai usando adesso» → cambia una condizione reale (search off, modello diverso, MCP assente) → ripeti: se recita lo stato vecchio è BROKEN; se distingue design e live state è verde. Piccolo: non deve documentare la codebase, deve spiegare il proprio funzionamento operativo reale, nella propria voce. | M |

## 4 · Scenari per le righe la cui implementazione è già solida (S ciascuno, per journey)

Il rapporto `evals/acceptance/report.ts` nomina le READY senza scenario. Una
riga READY senza scenario sul percorso vero non è chiusa (M5-BIS «Cosa
significa chiuso»). Journey, non righe:

- **J1 memoria-turno-reale**: C2, C3, C4 (fixture reale, non `addFact` a
  mano), C6 (`asOf` intermedio), rafforza C1.
- **J2 documento-e-provenienza**: C7 (PDF nel vault dal binario), C5
  (`memory why` risale all'episodio).
- **J5 egress**: D6 (host allowlisted passa), D7, D10 — con 1.6.
- **J6 sandbox-e-processi**: D4 (la prova oggi vive in CI su bubblewrap: portarla
  nell'harness o dichiarare in M5-BIS che la CI è la prova, con il run), D5
  (list/kill; avviare processi propri in background = OUT con ragione).
- **A4** config a mano + `rot reseal` end-to-end; **B14** allegato reale;
  **E3** `trace` senza segreti (dopo 2.4).

## 5 · OUT / post-Gate 1 (con la ragione)

B17 (Discord fuori finestra) · C10 (schema prima del consumer) · B9 oltre
`gone_quiet` (nessun produttore per 3 kind su 4; nessuna capability §5 dipende
dai trigger proattivi nei 14 giorni) · B12 overflow-a-file e B13 progress
strutturale (UX; B11 copre la presenza) · C9 pressione nel prompt (forma da
decidere senza rompere il prefisso cacheabile) · D8 revoca calda MCP (il comando
dice già «spariscono al prossimo avvio»; il riavvio è un verbo del supervisore)
· audit P30 (`allowHosts` inerte, nessun chiamante), P37 (cache delle tool
definitions: costo, non correttezza), P10 (nessun produttore deserializza un
kind) · envelope universale B16 oltre il minimo di 1.4 · subagent, world-state,
multi-hop, computer-use (mandato §7).

## 6 · Solo l'owner

- ~~A2/A3 identity/persona (contenuto)~~ dato il 17/08: `persona.md`/`voice.md`/`identity.md`
  reali, commit c090dce. Quello che resta su A2/A3 (character eval, punti 6-8 del mandato) è
  lavoro di verifica, non più una decisione che aspetta solo l'owner — `slice/identita` parte 2.
- ~~Schema di 1.5~~ decisa il 17/08: A, `job_fires` come ponte di identità (vedi 1.5).
- P34-2 segreti a riposo (2.5).
- Audio nei 14 giorni sì/no (3.8).
- Ancora aperte dal 16/08: scope lettura sandbox · `mcp.*` per-tool ·
  `ricorda` scrive o propone · lingua dei doc pubblici.

## 7 · Chiusura

Quando l'inventario ha zero BLOCKER: battery §10 del mandato (incluso il reboot
completo con gateway installato: nessun comando manuale, Telegram operativo,
stato preservato, `status`/`doctor` sani, kill + restart del supervisore) ·
install/upgrade/migration/backup/restore sulla forma reale · `doctor` · Telegram
reale se le credenziali ci sono · ultimo judge indipendente sull'intero `dev`
(«se l'owner da oggi vive dentro Muffin per 14 giorni, quale problema concreto
già conoscibile lo farà uscire?») · promozione `dev`→`main` secondo
`BRANCHING.md` · build candidata installata · report conciso · chiedere
esplicitamente all'owner di iniziare il giorno 1.
