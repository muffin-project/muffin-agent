# Validazione dei contratti — registro delle affermazioni

```
scritto: 2026-08-15
verificato: 2026-08-15
verificato-contro: origin/dev @ 6316bd6 — clonato ed eseguito.
                   Base misurata su dev prima di toccare nulla:
                   `npx tsc --noEmit` → exit 0
                   `npx vitest run`  → exit 0, 84 file, 915 passati, 1 skipped
modello-strumenti: Claude Opus 5. macOS 25.0.0 (darwin/arm64), node v22.22.2,
                   npm ci nel worktree. Nessuna chiave, nessuna chiamata a
                   pagamento: gli eval che toccano un modello non sono stati
                   eseguiti e sono marcati NON VERIFICABILE con quella ragione.
invaliderebbe:     un merge che tocca `core/policy/`, `core/rot/`,
                   `agent/runtime.ts` o `agent/loop.ts`. Le righe VERIFICATA che
                   non hanno un controllo eseguibile nella colonna «esegue?»
                   tornano a essere opinioni al primo merge — è la §13.2 di
                   ORCHESTRATION applicata a questo file.
cadenza:           ogni gate (le righe senza controllo eseguibile), oppure alla
                   prima PR che tocca i file qui sopra.
estende:           docs/ORCHESTRATION.md §13

rivalidato:        2026-08-15 — `slice/taint-in-ingresso` (ADR-0042) tocca
                   `agent/loop.ts` e `agent/runtime.ts`, cioè la condizione che
                   questo file si dichiara da solo. Righe riscritte: §1.3 (le due
                   sul taint) e §5 (il tier di un file su disco). Base rimisurata
                   nel worktree, senza pipe:
                   `npx tsc --noEmit` → exit 0
                   `npx vitest run`  → exit 0, 88 file, 996 passati, 1 skipped
                   Le altre righe VERIFICATA di §1.3 sono state rilette contro il
                   codice nuovo, non ricopiate: `raiseTaint` alza soltanto e
                   svuota la cache (`agent/loop.ts:967-972`), la chiave di
                   memoizzazione include il taint (`:975`), il recall resta
                   piegato nel pre-loop (`:320-321`).
```

> **Cos'è.** `09-contratti-m0-m1.md` si dichiara **normativo**; `03-threat-model.md`
> dichiara **garanzie**. Ognuna delle loro righe è o vera o falsa del codice.
> Questo file le controlla una per una. Tre stati soltanto: **VERIFICATA** (con
> la prova), **DERIVATA** (il codice non fa quello che il documento dice —
> il documento resta il contratto, la distanza è lavoro aperto), **NON
> VERIFICABILE** (e dice perché).
>
> **Regola di lettura, dalla direttiva:** una DERIVATA non si chiude correggendo
> il documento. Si chiude scrivendo il codice, oppure emendando il contratto
> *deliberatamente* — che è un atto, non una toppa. Dove il codice è più
> **stretto** del documento la riga lo dice: è comunque distanza, e comunque
> qualcuno deve decidere quale delle due è la regola.

---

## Riepilogo

| | 09-contratti | 03-threat-model | AGENTS.md | totale |
|---|---|---|---|---|
| VERIFICATA | 37 | 21 | 4 | **62** |
| DERIVATA | 72 | 12 | 1 | **85** |
| NON VERIFICABILE | 2 | 6 | 0 | **8** |
| *troppo vaga per avere uno stato* | — | — | — | **13** |

*(Conteggio misurato sulle righe di questo file, non stimato. Una riga con `×N`
vale N affermazioni. Oltre alle tre categorie ci sono **2 RITROVAMENTI**: cose
vere del codice che nessun documento dice — il re-seal silenzioso di `init`, e
**ciò che entrava nel turno senza dichiarare un tier** (§1.3), che non era una
riga sbagliata ma una riga assente. Le vaghe scendono da 14 a 13 perché una di
esse — il tier di un file su disco — è stata decisa e scritta, non riformulata:
ADR-0042.)*

Le vaghe sono contate a parte perché **non sono un quarto stato**: sono un
ritrovamento. Un contratto che non si può violare non è un contratto, e sono
elencate in fondo con il perché.

**Il rapporto è il ritrovamento principale.** In un documento che si dichiara
normativo — *«dove contraddice gli altri, vince questo»* — le affermazioni false
del codice sono **il doppio** di quelle vere. Nessuna delle 85 è stata trovata da
un test: tutte da una lettura fatta apposta.

---

## 1. `03-threat-model.md` — le garanzie

Prima, perché una garanzia falsa qui vale più di dieci righe di deriva altrove.

### 1.1 La matrice normativa (§3)

| affermazione | dove | stato | prova |
|---|---|---|---|
| «Rendering rich-media (`render.rich_media`) — ALLOW **con render offline**» | `03:39`, `03:56` | **DERIVATA** | La capability **non esiste**: `grep -rn "render.rich_media" agent core cli connectors` → zero occorrenze fuori da `docs/`. Una riga della matrice, cinque regole normative in §3-ter e ADR-0016 intero descrivono un organo non costruito, al presente. Costo: le 5 regole di §3-ter vanno con il renderer quando arriva — oggi non c'è dove agganciarle. |
| «Lettura memoria del tenant corrente — ALLOW (solo proprio tenant)» | `03:40` | **VERIFICATA** | `agent/tools/memory.ts:21-29` (`memory.read`, low, `resourceKind:'tenant'`); il tenant viene dal turno, mai dalla registrazione — `agent/runtime.ts:281` `handler: (args, ctx) => searchMemory(deps, ctx.tenant, args)`, con il commento che spiega perché. `core/policy/decide.ts:120-122` nega `tenant_mismatch`. |
| «Egress rete — ALLOW su allowlist; ASK fuori» | `03:43` | **VERIFICATA** | `core/policy/decide.ts:155-193`. Fuori allowlist: `ask` solo se owner **e** taint ≤1 (`:184`), altrimenti `deny/resource_denied` (`:187`) — più stretto della riga, deliberatamente e con la ragione scritta. |
| «taint 2/3: solo read-only su allowlist pubblica» | `03:43` | **VERIFICATA** | `agent/tools/http.ts:30-37` dichiara `maxTaint: 3` e `hostOnly: false`; il metodo è GET, non parametrizzabile. `core/policy/decide.ts:171-177` rifiuta se il chiamante non consegna la url dichiarata (fail-closed). |
| «Shell / filesystem host / processi — taint 2: **DENY — nessun percorso**» | `03:44` | **VERIFICATA** | `sys.shell` è `high` senza `maxTaint` (`agent/tools/shell.ts:32-38`) → soffitto `defaultMaxTaint.high` = 1 (`core/policy/matrix.ts:95`) → `taint_exceeded` a 2 (`decide.ts:136-143`). `hostOnly:true` chiude comunque i membri (`decide.ts:128`). |
| «Outward — DRAFT di default; send solo con conferma» | `03:45` | **DERIVATA** | Nessuna capability `outward.*` è dichiarata: `outward.send` compare solo in `core/policy/matrix.ts:99` (deny list), in `defaults/rot/policy.json:6` e in fixture di test. La riga descrive il comportamento di una capability che non esiste. Il deny c'è; la cosa da negare no. |
| «Le capability `outward.*` … escluse del tutto da `system@scheduler`» | `03:51` | **DERIVATA → CHIUSA** | Era falsa: la lista teneva l'id esatto `outward.send` e il lookup era `Set.has` (`decide.ts:132`, pre-fix), quindi `outward.publish` per lo scheduler rispondeva **`ask`**, non `deny` — misurato, vedi §4. Chiusa in questa PR: `core/policy/matrix.ts:104-138` (`denyListCovers`), floor `:99`, test `core/policy/decide.test.ts:129-176`. |
| «Scrittura config/voice (cricchetto) — ALLOW solo via ratchet-API» | `03:46` | **DERIVATA** | `config.ratchet` non è dichiarata da nessuna parte se non nella deny list (`core/policy/matrix.ts:99`). Nessuna ratchet-API esiste (M6). Riga al presente per un organo futuro. |
| «Capability `dev` (repo, test, PR) — ALLOW (contesto non tainted)» | `03:47` | **DERIVATA** | `dev.repo` non esiste: `grep -rn "dev.repo" agent core cli` → zero. E, a differenza di `outward.send`/`config.ratchet`, **non è nemmeno nella deny list**: se arrivasse domani, arriverebbe senza il divieto che la riga accanto le promette. |
| «Root of Trust — DENY a runtime per chiunque» | `03:48` | **VERIFICATA** | `core/policy/decide.ts:111-117` → `rot_violation`, prima di ogni ramo che potrebbe permettere. Floor non svuotabile: `core/policy/matrix.ts:159` unione, mai assegnazione. Rafforzata in questa PR con `rot.*` (`matrix.ts:97`) perché `rot.write` da solo lasciava passare un ipotetico `rot.reseal`. |
| «un'azione proattiva può nascere solo da evidenza tier ≤1» | `03:50` | **VERIFICATA** | `core/scheduler/proactivity.ts:112` `if (trigger.tier > 1)` — funzione pura, con il tipo `ProactiveKind` che rende il firehose *incostruibile* (`:45-47`), non solo scoraggiato. |
| «`system@scheduler` … ASK-in-coda … mai auto-ALLOW» | `03:51` | **VERIFICATA** | `core/policy/decide.ts:197-199` (`ask` per high su principal autonomo); consegna in `agent/scheduler-run.ts:31-40` — `In coda per te: "<capability>"`. Il job gira come `{kind:'system',source:'scheduler'}` (`:46`). |

### 1.2 Il sandbox (§3-bis)

| affermazione | dove | stato | prova |
|---|---|---|---|
| «**Mandatory deny paths**: `~/.muffin/rot/`, config, secrets, `.git/hooks`, dotfile di shell» | `03:67` | **DERIVATA → CHIUSA** | Cinque categorie dichiarate, **tre** implementate. `agent/runtime.ts:254` e `:297` (pre-fix) portavano entrambe `[p.rot, p.secrets, p.config]`, a mano, due volte. `.git/hooks` e i dotfile non erano in nessuna lista. Misurato rosso: scrittura di `.git/hooks/pre-commit` dentro il working dir → **riuscita**. Chiusa: `core/rot/guards.ts`, test `core/rot/guards.test.ts`, un solo call-site per superficie (`agent/runtime.ts`). |
| «negati in scrittura SEMPRE, **anche dentro un allow-write ampio**» | `03:67` | **VERIFICATA** | La metà portante, ora eseguita: `core/rot/guards.test.ts:66-88` scrive con `root = cwd` e `.git/hooks` *dentro* quello scope, e attende `PathDenied`. Lato sandbox `core/sandbox/executor.test.ts:139` dice la stessa cosa («denyWrite must beat allowWrite»). |
| «Esecuzione sandboxata di default per `shell`, **`process`** e ogni code-execution» | `03:66` | **DERIVATA** | `shell` sì (`agent/runtime.ts:300-302`: registrato solo se la probe ha retto). `process` **no**, e il codice lo dichiara: `agent/runtime.ts:304-308` «Process inspection/management is a host operation, not sandboxed execution». `sys.process.kill` agisce sulla process table dell'host senza contenimento; l'unico argine è il kernel. Costo: o si sandboxa, o la riga del threat model perde una parola. |
| «Sandbox non disponibile ≠ silenziosamente unsandboxed … si auto-degradano (ALLOW→ASK)» | `03:70` | **DERIVATA (il codice è più stretto)** | Non degradano: il tool **non viene registrato** (`agent/runtime.ts:300`), quindi al modello non è mai offerto e nessun `ask` è raggiungibile. Asserito da `agent/sandbox-gate.test.ts`. Ma `cli/doctor.ts:375` e `core/sandbox/probe.ts:40` stampano ancora «degrade to ask»: **due stringhe utente descrivono un comportamento che il codice non ha**. Costo: due stringhe. |
| «nessun dominio pre-concesso» | `03:66` | **VERIFICATA** | `core/sandbox/executor.ts:110` `allowedDomains: []` nel base config; per-call `:132` prende solo `req.allowHosts`, e `makeShellTool(executor, { root: cwd })` (`agent/runtime.ts:301`) non ne passa nessuno. |
| «namespace di rete rimosso su Linux, sola-porta-proxy su macOS» | `03:66` | **NON VERIFICABILE** | Richiede una macchina Linux: la metà Linux non è osservabile da qui. Su macOS la probe esegue un contenimento vero (`core/sandbox/probe.ts:61-127`, con controllo positivo allow-all perché un profilo non parsato non passi per contenimento) — misurato: `✓ sandbox seatbelt: a real containment ran and held`. |
| «Sub-agent, due assi di isolamento … blocked-tools per i delegati, niente spawn ricorsivo» | `03:71` | **DERIVATA** | I sub-agent **non esistono**: `grep -rn "subagent\|spawnAgent\|delegate" agent core cli` (esclusi i test) → zero. La garanzia non è falsa, è **senza referente**, e scritta al presente. Quando i sub-agent arriveranno non c'è nulla che imponga i due assi. |
| «Niente side-channel: il codice dentro il sandbox non ha alcun canale verso i tool del loop» | `03:68` | **VERIFICATA** | Non esiste RPC dal figlio: `core/sandbox/executor.ts:188-195` fa `spawn` con `stdio:['ignore','pipe','pipe']` e basta. L'ambiente è **ricostruito**, non ereditato (`:168-178`), perché un deny-read sul *file* del segreto non protegge nulla se la chiave viaggia in `environ`. |

### 1.3 Taint e provenienza (§2)

| affermazione | dove | stato | prova |
|---|---|---|---|
| «Il taint è ricalcolato a ogni `decide()`, mai congelato» | `03:21` | **VERIFICATA** | `agent/loop.ts:903-908`: `raiseTaint` alza e **svuota la cache** delle decisioni; la chiave di memoizzazione include il taint (`:911`). Firma in `core/policy/types.ts:104-117`. |
| «Un tool result tier-3 ricevuto a metà turno alza il taint … è il pattern fetch-then-act» | `03:21` | **VERIFICATA — e per mesi vera e fuorviante** | Oggi: `agent/loop.ts:850` `snapshot.raiseTaint(outcome.tier)`, incondizionato, con `tier` obbligatorio su `ToolOutcome` (`loop.ts:131-157`, il campo a `:156`). Chi dichiara il tier: **tutti**, perché il tipo non ammette altro. Fino a ADR-0042 la riga era `if (outcome.tier !== undefined)` e l'affermazione restava vera **della sola metà positiva**: era il controllo giusto sui cinque tool che un tier lo dichiaravano. Il registro l'ha marcata verificata e si è fermato lì — la lezione di metodo sta nella riga sotto, che nessuno aveva scritto. |
| *(la domanda negativa, che nessuno aveva fatto)* **«che cosa entra nel turno SENZA tier?»** | — | **RITROVAMENTO → CHIUSO** | Era: `fs_read`, `fs_list`, `shell_run`, `process_list`, `process_kill` — cioè ogni percorso che porta nel turno byte scritti da qualcun altro sul disco. Misurato su `dev` @ a3754c4: `fs_read` di un file con istruzioni iniettate → taint 0 → `http_get` fuori allowlist → `ask` → owner approva → **fetch eseguito**. Il docstring di `fs.read` argomentava il proprio soffitto 3 appoggiandosi a quel cancello, che non poteva scattare. Chiuso in questa PR: ADR-0042, `DISK_TIER` (`agent/tools/fs.ts`), `tier` obbligatorio, test `agent/read-then-egress.test.ts` (catena) e `agent/runtime-wiring.test.ts` §«the tier of a file read reaches the kernel» (stessa catena sul runtime vero). **Metodo:** una riga VERIFICATA controlla ciò che il documento dice; non controlla ciò di cui il documento tace. Il complemento di un'affermazione va cercato a mano, e questo registro ora ne ha uno. |
| «recall→azione: il kernel legge il taint prima di eseguire» | `03:20` | **VERIFICATA** | `agent/loop.ts:299-300` — il taint del recall è piegato nello snapshot **nel pre-loop**, prima che il modello veda qualcosa. È la chiusura del remember-then-act, e il commento a `:285-288` la nomina. |
| «Lo scope è **il turno** (non la sessione)» | `03:21` | **VERIFICATA** | `makeSnapshot` è chiamata una volta per turno (`agent/loop.ts:266`) e il taint riparte dal principal (`:897`). |
| «`fs.read` … il tier di un file su disco» | `03:20` | **VAGA → RISOLTA** | Era vaga perché il documento definiva la scala su *chi ha parlato* e non assegnava alcun tier al filesystem locale, e `fs.read` infatti non dichiarava `tier:`. Il registro la classificò «difendibile ma non derivata da una regola scritta» — e non chiese se l'assenza fosse **sfruttabile**, che era la domanda. Ora la regola è scritta (`03:20`, ultima frase) e eseguita: `DISK_TIER = 2` in `agent/tools/fs.ts`, asserito in `agent/tools/fs.test.ts` §«what a filesystem tool says about where its bytes came from». |
| «Qualunque testo derivato porta il tier massimo delle proprie fonti: … **summary di compattazione**» | `03:22` | **NON VERIFICABILE** | Il meccanismo nominato non esiste: `agent/context/compact.ts` **cancella payload**, non riassume (`compactToolResults`, e il file non nomina mai `tier`/`taint`). Non c'è testo derivato da etichettare. Corollario da tenere: quando la sommarizzazione arriverà, questa regola **non ha oggi un punto di applicazione**. |
| «valore di ritorno di un sub-agent (trattato … come un tool result, tier incluso)» | `03:22` | **NON VERIFICABILE** | Stessa ragione: nessun sub-agent esiste. |
| «Trust never rises» (invariante di grafo) | `03:20` + `AGENTS.md:74` | **VERIFICATA** | `core/memory/invariants.ts:72` `trust_tier_raised`, proprietà controllata sul grafo. Lato turno, `raiseTaint` alza soltanto (`agent/loop.ts:903-905`). |

### 1.4 I percorsi dell'input non fidato (§4) e il RoT (§5)

| affermazione | dove | stato | prova |
|---|---|---|---|
| «(a) … la tool call non esiste nel set esposto» | `03:76` | **VERIFICATA** | `agent/context/assemble.ts:114` filtra per `hostOnly === false` **dallo stesso campo che il kernel legge**, quindi le due viste non possono divergere; il kernel rinega comunque (`decide.ts:128`). |
| «(c-bis) all'allowlisting si **pinna l'hash** di `name`+`description`+`inputSchema`» | `03:82` | **VERIFICATA** | `core/mcp/registry.ts:85-103` — sha256 su serializzazione canonica (chiavi ordinate a ogni livello); confronto in `verifyTools` (`:125`). |
| «la lista dei tool esterni con hash è auditabile (`muffin mcp list --verify`)» | `03:82` | **VERIFICATA** | `cli/mcp.ts:89,110-116`; dispatch `cli/main.ts:558`. |
| «Nel RoT: … **(7) i profili sandbox** (mandatory deny paths, allowlist egress di esecuzione)» | `03:94` | **DERIVATA** | Il sigillo contiene 5 file — `policy.json`, `egress.json`, `budgets.json`, `identity.md`, `evals/` (`core/rot/readers.ts:91-163`, misurato: install reale sigilla 5 file). **Non c'è nessun profilo sandbox nel RoT**: i deny path sono costanti TypeScript. Quindi la voce 7 non è «hash verificato al boot, modifiche solo repo→riavvio» come dichiara §5 — è codice. `core/rot/verify.ts:12` ripete la stessa affermazione nella sua docstring: prosa che asserisce ciò che il codice non fa, dentro il file che tiene il sigillo. |
| «Nel RoT: **(8)** il meccanismo di update stesso» | `03:94` | **DERIVATA** | Non è un file del sigillo; non esiste un `muffin update` (`cli/main.ts:437`: `usage: muffin rot verify \| reseal`). |
| «hash verificato al boot, modifiche solo repo→install+riavvio» | `03:94` | **VERIFICATA** | `core/rot/verify.ts:156-212`, chiamata al boot in `agent/runtime.ts:114`; ancora fuori dal RoT (`:50`). |
| «Telemetria esterna: **nessuna, mai, di default**» | `03:116` | **VERIFICATA** | L'exporter dei trace è `appendFileSync` su file locale (`core/tracing/tracer.ts:34`); nessuna dipendenza OpenTelemetry in `package.json`; nessun import di rete nel layer di tracing. |
| «Secrets: … mai in chiaro nei trace (redaction nel layer di logging)» | `03:116` | **DERIVATA → CHIUSA** | Era **falsa** per i nomi camelCase. La denylist richiedeva un delimitatore `[_.-]` attorno alla parola, quindi `api_key` veniva redatto e **`apiKey` no** — insieme a `authToken`, `accessToken`, `clientSecret` e altri dieci. Misurato con la regex vera, e `core/tracing/redact.ts:8-9` affermava letteralmente il contrario («field names catch `apiKey`»). `core/tracing/` non aveva **nessun test**. Chiusa: `core/tracing/redact.ts:12-64` (segmentazione a parole), `core/tracing/redact.test.ts` (50 asserzioni). |
| «Log append-only locale» | `03:98` | **VERIFICATA** | `core/tracing/tracer.ts:34` `appendFileSync`, un file al giorno. |
| «Rischi residui» (§7, 8 righe) | `03:102-112` | **NON VERIFICABILE** ×3 | Tre righe descrivono ciò che il sistema *non* fa e nominano una mitigazione futura («evoluzione dichiarata»): proxy raggiungibile da altri processi, domain fronting, rubber-stamping. Sono dichiarazioni oneste di limite, non affermazioni sul codice — non hanno un valore di verità da controllare. Le conto come NON VERIFICABILE per costruzione, non come lacune. |

---

## 2. `09-contratti-m0-m1.md` — il documento normativo

> **Regola di lettura del documento stesso** (`09:5`): «TypeScript è pseudo-codice
> normativo (**nomi campo e semantica vincolanti**)». Quindi un campo rinominato
> è una violazione, non un dettaglio. Le righe qui sotto la applicano.

### 2.1 §1 — Tipi del kernel

| affermazione | dove | stato | prova |
|---|---|---|---|
| `Principal.owner = { kind, connector }` | `09:12` | **DERIVATA (il codice è più stretto)** | `core/policy/types.ts:21` aggiunge `externalId: string`, **non opzionale**, con il motivo in commento: senza, il connector Telegram confrontava l'id della *chat*, e chiunque parlasse in una stanza che portava l'id dell'owner arrivava come owner. Il contratto va emendato, non il codice. |
| `Decision.draft.undo.window_s` | `09:31` | **DERIVATA** | Il campo si chiama `windowSeconds` (`core/policy/types.ts:59`, valore in `core/policy/decide.ts:206`). Sotto la regola di lettura del documento questo è una violazione del contratto. Costo: una parola, da una parte o dall'altra. |
| `DenyCode` = 7 codici | `09:33-34` | **DERIVATA** | Il codice ne ha 8: `core/policy/types.ts:46-54` aggiunge `safe_mode`, emesso in `decide.ts:103-108`. Additivo, ma il documento elenca un insieme chiuso. |
| «`decide()` … **SINCRONA e pura**: nessun I/O, nessuna rete, nessun await» | `09:39` | **VERIFICATA** | `core/policy/decide.ts:92-215`: nessun `await`, nessun import di `fs`/`net`. La matrice è caricata una volta dove il contesto è costruito (`matrix.ts:106`, chiamata in `runtime.ts:152`) e il budget è iniettato come predicato (`decide.ts:55`) proprio per tenerlo così. |
| «`tenant` … restituisce `deny/tenant_mismatch` se divergono» | `09:43` | **VERIFICATA** | `core/policy/decide.ts:120-122`. |
| «Il kernel ispeziona solo i campi che la capability marca come `policyArgs`» | `09:44` | **VERIFICATA** | La risorsa è derivata da `resourceKind`+`policyArgs` della dichiarazione, non indovinata: `agent/loop.ts:811-827`. Il commento registra il difetto che l'ha prodotta — il loop indovinava da `path` prima di `url`, e `http_get({url, path:'x'})` faceva fetch fuori allowlist per un membro taint-2. |
| «In M1 il taint è determinato dal solo principal (owner→0, member→2, **system→eredita dal job**, agent→0)» | `09:45` | **DERIVATA** | `agent/loop.ts:897`: `principal.kind === 'member' ? 2 : 0`. Un principal `system` parte **sempre da 0**; nessuna eredità dal job esiste, e `makeSnapshot` non ha un parametro per riceverla. Controllo compensativo: `core/scheduler/proactivity.ts:112` nega l'armamento sopra tier 1 — ma sta in un altro modulo e riguarda l'*armare*, non l'*eseguire*. |
| `CapabilityDecl.maxTaint` obbligatorio | `09:56` | **DERIVATA** | `core/policy/types.ts:85` è `maxTaint?`, «omitted when it equals the default for the risk class». Semantica reale, documentata a `decide.ts:34-43`: una dichiarazione **allarga e restringe**, in entrambe le direzioni. Il documento non lo dice. |
| «PermissionSnapshot … cachea l'esito per la chiave `(capability, resource)`» | `09:65` | **DERIVATA (il codice è più stretto)** | La chiave include anche il **taint**: `agent/loop.ts:911`. E c'è `invalidate()` (`types.ts:115`) per il budget, che il contratto non prevede. |

### 2.2 §2 — ChatCall e profili

| affermazione | dove | stato | prova |
|---|---|---|---|
| `messages: Message[] // role: 'user'\|'assistant'\|'tool'` | `09:74` | **DERIVATA** | `agent/providers/types.ts:13`: `Role = 'user' \| 'assistant'`. Non esiste un ruolo `'tool'`; i risultati sono blocchi `tool_result` (`types.ts:48`), che l'adapter openai-compat ri-espande in messaggi `role:'tool'` sul filo (`openai-compat.ts:253`). |
| `temperature: number` (obbligatorio) | `09:78` | **DERIVATA** | `types.ts:105` è `temperature?`, opzionale di proposito: assente è l'unica forma che Opus 4.7+/Sonnet 5 accettano (`anthropic.ts:48-51`). |
| `thinking?: { budgetTokens: number }` | `09:79` | **DERIVATA** | `types.ts:106` è `thinking?: ThinkingMode`, con `ThinkingMode = 'adaptive' \| 'off'` (`:88`). Il nome sopravvive, la semantica è stata sostituita: `budget_tokens` è un 400 sui modelli 4.7+ (`anthropic.ts:67-74`). Sotto la regola di lettura, violazione piena. |
| `structuredOutput?: { schema, name }` | `09:80` | **DERIVATA** | Il campo **non esiste**: `grep -rn structuredOutput --include="*.ts"` → zero fuori da `docs/`. |
| `stream: boolean` | `09:81` | **DERIVATA (dichiarato e non collegato)** | `types.ts:107` lo dichiara; **nessun adapter lo legge**, e l'unico produttore scrive `stream: false` fisso (`agent/loop.ts:402`). |
| `ChatResult.raw?: unknown // solo per il trace` | `09:89` | **DERIVATA** | Assente da `ChatResult` (`types.ts:120-140`). |
| `ChatResult` — campi extra non documentati | — | **DERIVATA** | `thinking?: ThinkingBlock[]` (`types.ts:136`, portante, ADR-0037) e `model: string` (`:139`) esistono e non sono nel tipo normativo. |
| «`cacheHint` … posizionale; anthropic su system **e** message; openai-compat **solo** system, e solo per `openrouter.ai` (`wantsExplicitCache`)» | `09:93` | **VERIFICATA** | Anthropic: `anthropic.ts:118` (system) e `:145` (message). openai-compat: `openai-compat.ts:206-208` unico sito; matcher `/(^|\.)openrouter\.ai$/` su hostname (`:81-89`), quindi `openrouter.ai.evil.tld` è falso. |
| «Selezione adapter: campo esplicito, **nessuna inferenza dall'URL**» | `09:95` | **VERIFICATA** | `core/config/config.ts:37-39`, con il commento «Explicit, never inferred from the URL». *(L'inferenza dal prefisso della chiave — `cli/onboarding.ts:23-27` — è un asse diverso e il documento lo scopa esplicitamente a §95.)* |
| «`muffin init` **lo chiede** quando l'endpoint non è riconosciuto» | `09:95` | **DERIVATA** | Non chiede mai: inferisce dal prefisso della chiave e su prefisso ignoto prende il default compilato `'anthropic'` stampando una riga `!` (`cli/onboarding.ts:58,84`). Deliberato (ADR-0036); la frase del contratto è la metà stantia. |
| profilo: campo `name` obbligatorio | — | **DERIVATA** | `agent/profiles/profile.ts:130` lo richiede e **l'esempio normativo del documento non carica**: eseguito contro il loader vero → `profilo doc-example.json scartato (campo "name")`. Un esempio in un documento normativo che il parser rifiuta. |
| «fallback = `profiles/conservative.json`» | `09:105` | **DERIVATA** | Il file non esiste (`find . -name "conservative*"` → vuoto). Il fallback è la costante `CONSERVATIVE` in `profile.ts:92-115`. Differenza reale: una costante non è modificabile dall'owner, un file sigillato sì. |
| «Strategie ammesse: `nudge`, `reinjectTools`, `retryOnce`, `strictJson`» | `09:105` | **VERIFICATA** | Esattamente quelle quattro, né più né meno: `profile.ts:30-38` (tipo) e `:146` (enum zod); switch in `recovery.ts:176`. |
| «**Nessun `providerSwitch` in v1**» | `09:105` | **VERIFICATA** | Unica occorrenza nel repo è il commento che lo dichiara fuori scope (`recovery.ts:26`). |
| «`structuredOutputMode` non esiste … (`agent/profiles/profile.ts:75`)» | `09:110` | **DERIVATA (l'ammissione è stantia)** | L'affermazione è giusta, la **citazione** no: `profile.ts:75` è `name: string` dentro il tipo `Profile`; lo schema zod comincia a `:128`. Un'ammissione di deriva il cui `file:riga` è a sua volta derivato. |
| «`structuredOutput` … **non ha consumatori**» | `09:111` | **DERIVATA (l'ammissione sottostima)** | Non ha *definizione*, non solo consumatori. «Ultima voce aperta di M1» descrive quindi lavoro mai iniziato, non lavoro semi-cablato. |

### 2.3 §3 — Il floor: i numeri

| affermazione | dove | stato | prova |
|---|---|---|---|
| **N = 10** tool esposti | `09:117` | **DERIVATA (vincola metà installazione)** | Applicato a `profile.maxToolsExposed` (`agent/loop.ts:321-323`). Ma i profili spediti misurati con il loader vero: `consumer-local 10/15`, **`frontier 24/30`**. L'install di default scrive `claude-sonnet-5`, che matcha `frontier`: gira **sopra il floor**. Il documento non dice mai quali profili debbano onorarlo. |
| **X = 15** tool-call per turno | `09:118` | **DERIVATA** | Stessa misura, stessa ragione. |
| **Y = 32K** context utile | `09:119` | **DERIVATA** | Lo scenario `context` costruisce ~100.641 caratteri / 1.202 righe ≈ **25–29K token** (`evals/floor/scenarios.ts:196-212`) — circa il 20% sotto il floor dichiarato. Il piazzamento dei due fatti (primi 2K / ultimi 2K) è corretto. |
| «Recovery: 1 tool-call **malformato** e 1 tool in errore per scenario» | `09:120` | **DERIVATA** | Solo il tool in errore è garantito (503 incondizionato, `scenarios.ts:154-160`). Il ramo malformato (`:161-163`) scatta **solo se il modello sbaglia il formato della data** — un modello corretto non lo esercita mai, che è esattamente il difetto che il commento a `:148-151` dice di aver chiuso per l'altra metà. |
| «**Cap duro 40 per turno**, indipendente da profilo e budget» | `09:121` | **VERIFICATA** | `agent/profiles/profile.ts:118` `MAX_ITERATIONS_HARD_CAP = 40`, applicato con `Math.min(profile.maxToolCallsPerTurn, 40)` (`:197-199`), consumato in `loop.ts:338`. Eseguito: un profilo che chiede 999 → `iterationCap` = 40. **Lacuna:** nessun test asserisce il 40 (`grep -rn MAX_ITERATIONS_HARD_CAP` → definizione + un uso). |
| «Il floor passa se … su **entrambi i modelli di riferimento** in 3 run» | `09:123` | **NON VERIFICABILE** | Metà eseguibile (`--reps`, `evals/floor/run.ts:193,223-229`: ogni scenario deve passare in ogni rep). L'altra metà no: nessuna coppia di modelli di riferimento è fissata da nessuna parte, `run.ts:183` prende un `--model` per invocazione. E eseguirlo costa denaro: **non eseguito**, per vincolo. |

### 2.4 §4-§6 — RoT, config, boot, doctor

| affermazione | dove | stato | prova |
|---|---|---|---|
| il RoT contiene `capabilities.json` | `09:131` | **DERIVATA** | Non esiste: `grep -rn "capabilities.json" .` → solo questa riga del documento. Install reale misurato: **5** file sigillati. |
| manifest `{…, installedBy}` | `09:129` | **DERIVATA** | `installedBy` assente da tipo e builder (`core/rot/verify.ts:29-34`, `:129-139`). |
| «`policy.json` — matrice (principal-kind × capability × maxTaint) → effect» | `09:130` | **DERIVATA** | Il file non ha né la dimensione principal-kind né regole per capability: lo schema è `defaultMaxTaint` + `neverAtRuntime` + `forbiddenForSystem` (`core/policy/matrix.ts:29-41`). La logica per principal è compilata in `decide.ts:128-134,197-199`. |
| «`egress.json` — allowlist domini **per capability**» | `09:132` | **DERIVATA** | L'allowlist è globale, un solo predicato per ogni capability con url (`core/net/egress.ts:21-25`; `runtime.ts` → `egressAllowed`). |
| «Ogni file ha `schemaVersion`; il loader **rifiuta** versioni sconosciute» | `09:138` | **DERIVATA** | Solo `config.json` rifiuta (`core/config/config.ts:196-201`). `policy.json` e `budgets.json` **degradano al floor** con una nota (`matrix.ts:119-122`, `budgets.ts:127-130`); `egress.json` lancia ma il boot inghiotte in allowlist vuota (`runtime.ts:319-324`). Entrambi i loader argomentano a lungo perché murare un'installazione vecchia sia peggio — è una decisione, e il contratto non la registra. |
| «Mismatch = **boot rifiutato**» | `09:140` | **DERIVATA** | Solo in hardened (`verify.ts:167`, `runtime.ts:137-142`). In single-user — **il default** (`config.ts:100`) — il boot prosegue in safe mode. Misurato su un `identity.md` manomesso: `single-user → "safe-mode"`, `hardened → "refuse"`. |
| «…con l'istruzione `muffin rot reinstall`» | `09:140`, `09:224` | **DERIVATA** | Il sottocomando **non esiste** (`cli/main.ts:437`: `usage: muffin rot verify \| reseal`). Peggio: `core/net/egress.ts:46,54` lo stampa come rimedio all'utente. Un messaggio d'errore che nomina un comando inesistente; chi lo esegue prende exit 78. |
| «`--hardened` (richiede sudo) crea l'utente di servizio `muffin`; RoT `0444`» | `09:143` | **DERIVATA** | `--hardened` scrive **una stringa e nient'altro** (`cli/init.ts:104`). Nessun sudo, nessun utente, nessun chown/chmod. Misurato: file RoT `mode=644 uid=501` con `"mode": "hardened"` in config. *Controllo compensativo, e onesto:* `hardeningHolds()` prova `W_OK` (`verify.ts:99-127`), il kernel riceve la verità (`runtime.ts:123-134`) e doctor dice `hardened dichiarato, non vero`. |
| «single-user: RoT `0444`» | `09:144` | **DERIVATA** | Nessun chmod mai: `cli/init.ts:52-54` è `mkdirSync`, `:149-166` è `copyFileSync`. Misurato 0644/0755. |
| «single-user: `sys.shell` è **sempre ASK**» | `09:144` | **VERIFICATA** | `decide.ts:208-213` (allow solo se `hardened && owner && taint===0`); test `core/policy/decide.test.ts:138`. |
| «…e il boot **lo stampa a ogni avvio**» | `09:144` | **DERIVATA** | Nessuna riga di boot dichiara la modalità: `runtime.ts:453-461` la porta solo nel caso hardened-ma-falso. L'avviso single-user esiste **solo in doctor** (`cli/doctor.ts:177-182`). |
| «Verifica a runtime (C4): **watcher** sui file del RoT» | `09:145` | **DERIVATA (assente)** | `grep -rniE "fs\.watch\|watchFile\|chokidar\|FSWatcher" cli agent core` → nessun match; nessun `chokidar` in `package.json`. `verify()` ha tre call-site, tutti one-shot: boot (`runtime.ts:114`), doctor (`doctor.ts:126`), `muffin rot verify` (`main.ts:418`). **Una manomissione mentre il processo gira non è mai rilevata** — che è precisamente il percorso §4(g) del threat model. Safe mode esiste ed è applicata (`decide.ts:103-109`), ma è raggiungibile **solo al boot**. |
| «Boot: (1) tracing (2) config (3) RoT» | `09:176` | **VERIFICATA** | `agent/runtime.ts:105-106`, `:109`, `:114`. Il prefisso critico è esatto. |
| «(4) capability registry (5) budget (6) DB (7) policy pronta (8) adapter+loop (9) connector» | `09:176` | **DERIVATA** | Ordine misurato: matrice `:152` → budget sigillati `:164` → **DB `:167`** → **budget engine `:170`** → **adapter `:174-185`** → memoria/tool → **capability registry `:370`** → **policy `:385`**. 6 precede 5 (inevitabile: `BudgetEngine(db,…)`); **8 precede 4 e 7**. Costo: spostare la Map e `createDecide` sopra il provider — meccanico, `decide` non chiude su nulla che il provider crei. |
| «RoT fallito → **exit 78**» | `09:176` | **DERIVATA** | 78 solo sul percorso gateway (`cli/gateway.ts:308`). REPL e headless tornano **1** (`repl.ts:77-80`, `run.ts:31-34`); in single-user non c'è affatto un'uscita fallita. |
| doctor: `--online` = ping da 1 token | `09:178` | **DERIVATA** | Il flag è parsato e non fa nulla: `cli/doctor.ts:247-249` → `warn('api reachability','online check not implemented in M0')`. |
| doctor: «spazio disco per i trace» | `09:178` | **DERIVATA (assente)** | `cli/doctor.ts:383-387` controlla solo che `traces/` esista; il commento sopra ammette che il check non è mai stato scritto. |
| doctor: `schemaVersion` di **ogni** file | `09:178` | **DERIVATA** | `egress.json` non è **mai caricato da doctor** (nessun `loadEgress` in `cli/doctor.ts`), quindi uno `schemaVersion` sbagliato lì è invisibile a doctor e svuota in silenzio l'allowlist al boot. |
| «Il check del sandbox **esegue, non cerca**» | `09:180` | **VERIFICATA** | `core/sandbox/probe.ts:61-127`, con controllo positivo allow-all a `:109-124` — perché un profilo che l'OS rifiuta di parsare non si legga come contenimento che ha retto. Eseguito su questa macchina: `✓ sandbox seatbelt: a real containment ran and held`. |
| «`bwrap --ro-bind / / --unshare-all --die-with-parent true` … come l'utente del runtime, **mai come root**» | `09:180` | **NON VERIFICABILE (Linux)** | L'argv coincide alla lettera in sorgente (`probe.ts:142`) e il rifiuto da root c'è (`:130-140`), ma eseguirlo richiede un host Linux con user namespace. Questa macchina è macOS: non indovinato. |
| «Secrets: default **file cifrato age** `secrets.age`» | `09:150` | **DERIVATA (già ammessa a `09:168-170`)** | Nessun `age`, nessuna passphrase, nessun `key.txt`. File in chiaro `0600` (`config.ts:311-324`, misurato `mode 600`). L'ammissione del documento a `:168-170` **coincide con il disco** — quella riga è VERIFICATA. |
| catena ADR-0039 (ordine, `--persist`, `uninstall` nomina, `doctor` nomina l'anello) | `09:154-166` | **VERIFICATA** ×4 | `config.ts:247-249` (ordine), `cli/main.ts:599-621` (`--persist`), `cli/main.ts:378,386-391` (`La chiave persistente resta: <path>`), `cli/doctor.ts:228-242` (nomina backend e path). Quattro affermazioni, quattro prove. |
| «`muffin init` idempotente e resumibile» | `09:174` | **VERIFICATA** | Misurato su un home di scratch: run 1 senza chiave → tutto tranne la chiave; run 2 con chiave → `root of trust :: already present` e un `identity.md` modificato a mano **sopravvive**; `--force` reinstalla (`cli/init.ts:57,158`). |
| i 6 passi di `init`, **in quest'ordine** | `09:174` | **DERIVATA** | Sequenza misurata: `directories → root of trust → voice → persona → api key → config → database → sealed`. Manifest+anchor scritti **per ultimi** (`init.ts:116-119`), non dentro il passo 2; il passo 4 (utente di servizio) non esiste; il passo 6 (`esegue doctor`) non avviene — `cmdInit` stampa `Ora: muffin doctor` (`main.ts:296-298`); due passi non documentati (voice, persona) stanno in mezzo. |
| — *(non nel documento, trovato eseguendo)* | — | **RITROVAMENTO** | `runInit` **ri-sigilla a ogni esecuzione** (`cli/init.ts:118`): un `identity.md` modificato a mano viene assorbito in silenzio nel manifest da un secondo `muffin init`. Misurato: dopo la modifica e il re-init, `verify` → `ok`. È l'opposto della cerimonia `muffin rot reseal` su cui il RoT si appoggia, e non è descritto in §4 né in §6. |

### 2.5 §7-§11 — errori, loop, tracing, CLI, test

| affermazione | dove | stato | prova |
|---|---|---|---|
| «Timeout tool: default globale **60s**» | `09:190` | **DERIVATA (assente)** | **Nessun timeout globale esiste.** `agent/loop.ts:785` fa `await tool.handler(...)` senza timer e senza signal; il `try/catch` converte un errore *lanciato*, mai un blocco. Il `60_000` nel loop è `TOOL_RESULT_BUDGET_CHARS` (`:56`), un budget in caratteri. Un tool senza timer proprio appende il turno per sempre. |
| «sovrascrivibile per capability nella dichiarazione» | `09:190` | **DERIVATA (dichiarato e non collegato)** | `core/policy/types.ts:91` `timeoutMs?` è l'**unica** occorrenza: nessun lettore. Manopola morta — la firma del difetto che `AGENTS.md:16-22` elenca. |
| «`ASK` senza risposta: timeout configurabile **default 10 min**» | `09:193` | **DERIVATA (assente)** | `cli/repl.ts:125` attende `rl.question` senza timer: un prompt senza risposta blocca per sempre. Nessuna chiave di config esiste. |
| «`ASK` headless = **deny automatico**» | `09:193` | **DERIVATA** | È un abort di turno, non un deny: `agent/loop.ts:765-769` lancia `ApprovalRequired` **prima** che una decisione sia presa, e `:578-587` chiude il turno. Osservabilmente sicuro (nulla esegue) ma un «deny» lascerebbe proseguire il turno; questo lo ferma. |
| «max **3 tentativi** totali» (risposta malformata) | `09:187` | **DERIVATA** | Il tetto è `profile.recovery.length` (`loop.ts:645-646`). I profili spediti danno **4** (`consumer-local`) e **2** (`frontier`). Nessuno dei due è 3. |
| stringa «il modello non ha prodotto una risposta valida dopo 3 tentativi» | `09:187` | **DERIVATA** | Assente dal repo. Il testo reale è `'Il modello non ha prodotto una risposta utilizzabile.'` (`loop.ts:485`), senza conteggio; il percorso malformato non raggiunge affatto una stringa utente — `loop.ts:442` rilancia il `ProviderError` grezzo. |
| «+ span con l'ultima risposta **raw**» | `09:187` | **DERIVATA** | Nessuna risposta grezza è conservata: `tracer.ts:97-98` salva solo `error.message`; `ProviderError` non porta il body. |
| «Budget: messaggio di sistema distinto dalla voce dell'agente (**prefisso riservato in CLI**)» | `09:192` | **DERIVATA** | Nessun prefisso riservato esiste. Il messaggio è il terzo argomento di `finish` (`loop.ts:353`), diventa `result.text` e viene stampato su stdout **come la risposta dell'agente** (`run.ts:84`, `repl.ts:272`). |
| «D9: tutti i messaggi di sistema … mai mescolati nel testo della risposta» | `09:196` | **DERIVATA** | Ogni stop non-risposta è consegnato *come* testo della risposta: budget `:353`, interruzione `:356`, fallimento modello `:485`, approvazione `:583`, cap `:598`. È un confine di fiducia, non un dettaglio estetico. |
| «Notifica al primo superamento del periodo» | `09:192` | **DERIVATA (dichiarato e non collegato)** | `core/budget/budget.ts:139-141` calcola `justCrossed`; `grep -rn justCrossed` trova solo la definizione e il suo test. Nessun chiamante di produzione. |
| «DB lockato: `busy_timeout = 5000`, mai retry silenzioso infinito» | `09:189` | **VERIFICATA** | Pragma in `runtime.ts:169`, `init.ts:111`, `jobs.ts:27`, `memory.ts:38`, `observe.ts:116`. Nessun wrapper di retry esiste: l'assenza *è* la garanzia. |
| «Chiave mancante: il runtime **parte**, il loop rifiuta nominando il campo» | `09:186` | **VERIFICATA** | Eseguito su un home senza chiave: `doctor` gira e esce 2, `trace tail` esce 1; `muffin run "ciao"` → `missing secret "provider_api_key" — cercato in …`. |
| «…**e il comando per impostarlo**» | `09:186` | **DERIVATA** | Il comando viaggia su `ConfigError.remedy` (`config.ts:305`) ma i due ingressi del loop stampano solo `error.message` (`run.ts:32`, `repl.ts:78`). Misurato: nessuna riga di rimedio. Il fix più economico di tutto il registro: due righe, e il pattern esiste già in quattro altri file CLI. |
| «Streaming: **sì in CLI (REPL)**, no in headless» | `09:200` | **DERIVATA** | **Nessuna superficie streamma.** `loop.ts:402` fissa `stream:false`; l'interfaccia `Provider` ha un solo metodo `chat(call): Promise<ChatResult>` (`types.ts:142-145`) — non esiste un ingresso di streaming; il REPL stampa il turno finito in una sola write (`repl.ts:272`). La metà headless è vera per caso. |
| «transcript su `~/.muffin/sessions/<id>.jsonl`, in append a ogni messaggio completo» | `09:201` | **VERIFICATA** | `core/session/store.ts:39,45,49` (`appendFileSync`); tre siti di append, uno per tipo di messaggio completo — `loop.ts:328` (user), `:521` (assistant), `:787` (tool). `read()` tollera una coda troncata (`store.ts:56-68`). |
| «`DRAFT`: tipizzato ma **non esercitato** in M0/M1» | `09:202` | **DERIVATA (l'affermazione è diventata stantia)** | `fs.write` — uno dei tre primitivi di M1 — è `medium` + `undoable` (`agent/tools/fs.ts:78-85`), e `decide.ts:204-206` mappa esattamente quella coppia su `draft`. Il loop raggiunge il ramo e **rifiuta la chiamata** (`loop.ts:748-758`, «il registro di undo non esiste ancora»): ogni `fs.write` a taint 0 è oggi un tool_result di errore. |
| «lo slot recall è un **no-op** che ritorna `[]` finché M2» | `09:203` | **DERIVATA (stantia)** | Recall è costruito e cablato: `core/memory/recall.ts:160`, chiamato nel pre-loop (`loop.ts:289-313`) con il taint piegato nello snapshot. La previsione «nessun cambio di firma dopo» ha retto. |
| «M3 aggiunge `sys.shell`, `sys.process`, **`net.egress`**, MCP» | `09:204`, `09:21` | **DERIVATA** | `net.egress` **non esiste come capability**: la rete è `sys.http` (`agent/tools/http.ts:31`) e l'egress è un predicato di allowlist. `sys.process` è spedito **spaccato** in `sys.process.list` / `sys.process.kill` (`process.ts:24,33`). |
| «K2: la tool call di prova di M0 è un test diretto su `decide()`» | `09:205` | **VERIFICATA** | `core/policy/decide.test.ts:6-23` — dichiarazioni fabbricate nel test, nessun import di provider o loop. Eseguito: 19 test passati, nessuna rete. |
| span `muffin.tool_call` **figlia di** `muffin.chat_call` | `09:209` | **DERIVATA** | Il genitore è il **turno**, non la chat_call: `loop.ts:576` passa `turn` a `runTool`, che lo usa a `:686`. È una sorella di chat_call. E `loop.ts:291` emette un `muffin.tool_call` per `memory.recall` fuori da qualunque chat_call. |
| `muffin.policy_decision` figlia di tool_call, **sempre emessa anche su allow** | `09:209` | **VERIFICATA** | `loop.ts:723-727` (genitore = lo span del tool), `:733` `decisionSpan.end()` incondizionato, prima dei rami deny/draft/ask. |
| i sei attributi `muffin.*` | `09:210` | **VERIFICATA** | Tutti e sei alla lettera in `core/tracing/types.ts:58,59,61,62,63,64`, tutti e sei emessi (`loop.ts:255,256,725,730,731`). |
| «`gen_ai.*` pinnati per modello/token/**costo**» | `09:210` | **DERIVATA** | Il costo è nostro, non `gen_ai.*`: `types.ts:67` `costUsd: 'muffin.cost.usd'`. La semconv GenAI non definisce un attributo di costo, quindi la frase è inapplicabile come scritta. |
| «semconv v1.42.0 pinnata in **`core/tracing/SEMCONV_VERSION`**» | `09:211` | **DERIVATA (valore giusto, percorso sbagliato)** | Il valore è giusto — `core/tracing/types.ts:16` `SEMCONV_VERSION = '1.42.0'`. Il **file** `core/tracing/SEMCONV_VERSION` non esiste. |
| «Retention: applicata al boot **e a ogni rotazione giornaliera**» | `09:212` | **DERIVATA** | `grep -rn pruneOlderThan` → due hit: la definizione (`tracer.ts:46`) e l'unico chiamante al boot (`runtime.ts:110`). Un processo di lunga vita (REPL, gateway) **non pota mai più**. `tracer.ts:42` afferma il contrario in un commento. |
| «`muffin trace tail`/`grep`» | `09:212` | **VERIFICATA** | `cli/main.ts:626-666`; eseguito su un home vuoto → `no spans matched`, exit 1. |
| exit code di `muffin run` (0/3/4/5/1) | `09:222` | **VERIFICATA** ×5 | `cli/run.ts:97-98` (0), `:103-113` (3), `:99-100` (4), `:101-102` (5), `:33,75,116` (1). Eseguito `muffin run "ciao"` senza config → 1. |
| exit code di `muffin doctor` (0/1/2) | `09:220` | **VERIFICATA** | `cli/doctor.ts:398`; eseguito su un home senza chiave → 2. |
| exit code di `muffin init` = {0, 78} | `09:219` | **DERIVATA** | Terzo codice non documentato: `cli/main.ts:290-294` torna **1** quando un passo resta incompleto. Eseguito: `INIT_EXIT=1`. |
| exit code di `muffin rot verify` = {0, 2} | `09:224` | **DERIVATA** | Quattro codici, e 2 è il più raro: `main.ts:428` torna 2 solo se `action === 'refuse'`, che `verify.ts:167` produce **solo in hardened**; il default single-user dà **1**. Più 78 se la config non carica. |
| «stdout = solo la risposta finale» | `09:226` | **DERIVATA (per il REPL)** | Vale per `run` (`run.ts:81-94`). Non per il REPL: readline è costruita con `output: process.stdout` (`repl.ts:116`), quindi il prompt `'› '` e la domanda di approvazione (`:125`) finiscono su stdout. |
| Ctrl+C: primo annulla, secondo entro **2s** esce | `09:226` | **VERIFICATA** | `cli/repl.ts:136-141` (abort, REPL resta) e `:144` `if (now - lastInterrupt < 2000) rl.close()`. |
| librerie: `commander` | `09:226` | **DERIVATA** | Non è una dipendenza. Il parsing è `parseArgs` di `node:util` (`cli/main.ts:3`). |
| librerie: `@inquirer/prompts` | `09:226` | **DERIVATA** | Non è una dipendenza; il prompting è scritto a mano in `cli/prompt.ts`. |
| librerie: `@opentelemetry/api` + `sdk-trace-node` | `09:226` | **DERIVATA** | Nessuna delle due è dipendenza e nulla importa OpenTelemetry; il tracer è scritto a mano (`core/tracing/tracer.ts`). |
| librerie: `age` via libreria JS | `09:226` | **DERIVATA** | Nessuna libreria age. Coerente con la §5 già ammessa. |
| librerie: `readline` nativo, `zod`, `better-sqlite3` in M0, `@anthropic-ai/sdk`+`openai` | `09:226` | **VERIFICATA** ×4 | `repl.ts:1`; `package.json:45`; `package.json:36` + `cli/init.ts:110-111`; `package.json:34,42`. |
| «Vietati: framework LLM/agentici, graph-engine, ORM» | `09:226` | **VERIFICATA** | Le 13 dipendenze runtime di `package.json:32-46` esaminate una per una: nessun framework di classe LangChain, nessun graph engine, nessun ORM (SQL scritto a mano, es. `core/budget/budget.ts:76-85`). |
| «CI di capability con modello vero: solo su push e in **nightly**» | `09:231` | **DERIVATA (assente)** | `.github/workflows/ci.yml:34-37` ha due trigger, `pull_request` e `push` su [dev, main]; **nessun `schedule:`**. Nessun job chiama un modello, nessun secret di chiave è referenziato. |
| «budget CI separato ($20/mese), cap hard nel workflow» | `09:231` | **DERIVATA (assente)** | Nessun budget in dollari esiste in CI; l'unico cap è `timeout-minutes: 10` (`ci.yml:49`), wall-clock su un job che non spende. |
| «il modello consumer-locale gira su un **self-hosted runner**» | `09:231` | **DERIVATA** | `ci.yml:48` `runs-on: ubuntu-latest`, unico job; nessun `self-hosted`. |
| «`temperature: 0`» | `09:232` | **DERIVATA** | Condizionale: `loop.ts:390` lo invia solo se `profile.sampling === 'deterministic'`. `frontier.json` è `model-default` — la lane di default degli eval non invia temperatura affatto, per una ragione documentata (400 su Opus 4.7+). |
| «3 run, 3/3 per passare» | `09:232` | **VERIFICATA (la parte 3/3)** | `evals/floor/run.ts:223-229`: un fallimento in *qualunque* rep esce non-zero. Il **default è però 1 rep** (`:193`), e le 3 run sono un flag manuale. |
| «si segnala 2/3 come **flaky**» | `09:232` | **DERIVATA (assente)** | `grep -rni flaky` su `evals/` e `.github/` → zero. Un 2/3 stampa esattamente come uno 0/3. |
| fixture `evals/fixtures/<scenario>.json` con `{id, prompt, tools, expect:{…}}` | `09:233` | **DERIVATA** | La directory non esiste. Gli scenari sono TypeScript: `evals/floor/scenarios.ts:30-39` = `{id, dimension, seed(dir), prompt, extraTools?, check(ctx)}`. Sopravvivono `id` e `prompt`; l'intero blocco `expect` è sostituito da un predicato imperativo. Divergenza di disegno, non un rename: una fixture JSON non può esprimere `seed(dir)`. |
| «dati sintetici, zero informazione personale» | `09:233` | **VERIFICATA** | `evals/floor/scenarios.ts:66-79`: contenuti inventati, nessun cognome né identificatore; ogni scenario scrive in un `mkdtempSync` fresco (`run.ts:60-63`). |

---

## 3. `AGENTS.md` — le convenzioni dichiarate non negoziabili

| affermazione | dove | stato | prova |
|---|---|---|---|
| «Secrets are read from stdin, **never from argv**, and never printed» | `AGENTS.md:77` | **DERIVATA** | `--api-key CHIAVE` esiste, è **pubblicizzato nella riga di usage** (`cli/main.ts:62`), parsato (`:224`) e usato (`:245`). Una chiave su argv finisce nella history della shell e nella process table (`ps aux`), leggibile da ogni altro utente della macchina. Il percorso stdin esiste (`promptSecret`, `:250-252`) ma solo come fallback quando argv **e** env sono assenti. |
| «Never delete rows» | `AGENTS.md:72` | **VERIFICATA** | Due sole `DELETE FROM` in produzione, entrambe in `core/memory/vectors.ts:196-197`, ed entrambe legali con la ragione scritta al sito (`:186-190`): tabella **derivata**, l'episodio non è mai cancellato, l'indice si ricostruisce. |
| «Trust never rises» | `AGENTS.md:74` | **VERIFICATA** | `core/memory/invariants.ts:72` come proprietà di grafo; `agent/loop.ts:903-905` alza soltanto. |
| «`core/policy/decide.ts` è il kernel: puro, sincrono, totale» | `AGENTS.md:57` | **VERIFICATA** | Nessun `await`, nessun I/O (`decide.ts:92-215`); lo `switch` finale copre le tre classi di rischio e TypeScript lo verifica esaustivo (`npx tsc --noEmit` exit 0). |
| «Data lives only in `~/.muffin/`» | `AGENTS.md:61` | **VERIFICATA (con l'eccezione dichiarata)** | `core/config/config.ts:105-126`. L'unica uscita è `$XDG_CONFIG_HOME/muffin/secrets/` (ADR-0039), che `09:153-166` dichiara come eccezione motivata: ciò che finisce lì è una **credenziale**, non dati dell'owner. |

---

## 4. I controlli costruiti, e perché questi e non gli altri

Criterio, dalla direttiva: **costo basso, conseguenza alta, soprattutto nel
threat model**. Tre. Ognuno visto **rosso** prima, con la misura riportata.

### 4.1 `core/tracing/redact.test.ts` — la redazione dei segreti nei trace

- **L'affermazione**: `03:116` «Secrets: … mai in chiaro nei trace».
- **Perché questo**: `core/tracing/` non aveva **nessun** file di test. Ogni
  garanzia di §9 riposava sulla lettura del codice — ed è esattamente lì che il
  codice affermava in un commento (`redact.ts:8-9`, «field names catch
  `apiKey`») il contrario di ciò che faceva.
- **Rosso, misurato**: 13 fallimenti su 50. `apiKey`, `authToken`,
  `accessToken`, `clientSecret`, `apiKeyRef`, `sessionCookie`, `muffin.apiKey`
  e altri sei uscivano **in chiaro**. La regex chiedeva un delimitatore
  `[_.-]` attorno alla parola, quindi `api_key` sì e `apiKey` no.
- **Verde**: 50/50. Il fix sostituisce la caccia ai delimitatori con una
  segmentazione a parole (camel, snake, kebab, punti), che è la domanda vera —
  *una di queste parole è una parola-segreto?* — e tiene fuori `monkey`,
  `tokenizer`, `authority`, che una regex più larga avrebbe perso.
- **Cosa impedisce ora**: la lista dei nomi è una tabella di casi; togliere una
  parola-segreto o allargarla fino a redigere `muffin.capability` diventa rosso.

### 4.2 `core/rot/guards.ts` + `guards.test.ts` — i cinque mandatory deny path

- **L'affermazione**: `03:67`, cinque categorie negate in scrittura «SEMPRE,
  anche dentro un allow-write ampio».
- **Perché questo**: era **tre su cinque**, scritte a mano **due volte**
  (`agent/runtime.ts:254` e `:297`), con un commento a `:293-295` che diceva
  «two deny-lists that drift are one deny-list plus a hole» — vero, e la
  risposta a quel commento è una funzione, non due letterali che oggi
  combaciano. E le due categorie mancanti sono le due che convertono una
  scrittura *contenuta* in un'esecuzione *non contenuta*: `.git/hooks/pre-commit`
  gira al prossimo commit dell'owner, `~/.zshrc` alla prossima shell, entrambi
  fuori dal sandbox, come l'owner, senza passare da nessuna capability.
- **Rosso, misurato**: `.git/hooks` e `shell dotfiles` non coperti; la scrittura
  di `.git/hooks/pre-commit` dentro il working directory **riusciva**.
- **Verde**: 10/10. Un solo call-site per superficie (`agent/runtime.ts`), quindi
  le due liste non possono più divergere.
- **Cosa impedisce ora**: `MANDATORY` nel test **è la lista del documento**. Una
  categoria che smette di essere coperta si nomina da sola nel fallimento, e
  `it('names all five')` impedisce di cancellarne una insieme al suo test.

### 4.3 `denyListCovers` — `outward.*` è un namespace, non un id

- **L'affermazione**: `03:51` «le capability **`outward.*`** … escluse del tutto
  da `system@scheduler` a qualunque taint».
- **Perché questo**: costo bassissimo (una funzione di 8 righe), conseguenza
  alta, e **rischio latente puro**: `outward.send` non esiste ancora, quindi
  oggi non rompe nulla — ma la prima capability a spedire sotto quel prefisso
  sarebbe arrivata senza il divieto che la riga accanto le promette, in silenzio,
  perché il deny era scritto con il nome di sua sorella.
- **Rosso, misurato**: `outward.publish` per lo scheduler → **`ask`**, non
  `deny`. Un ASK non è un DENY: è una richiesta che l'owner può approvare alle
  2 di notte per un'azione che il threat model dice non debba essergli mai
  proposta.
- **Verde**: 29/29 in `core/policy/`. Stesso trattamento a `neverAtRuntime`
  (`rot.*`), un rigo sopra nella stessa tabella, dove `rot.write` da solo
  lasciava passare un ipotetico `rot.reseal`.
- **Nota di metodo**: `core/policy/matrix.test.ts:80-83` è diventato rosso
  perché asserisce i contenuti del floor **alla lettera** — «so that widening
  the floor turns these red instead of dragging them along». Ha fatto
  esattamente il suo lavoro; il letterale è aggiornato con il motivo accanto.

### 4.4 Quelli che **non** ho costruito, e perché

- **Il watcher del RoT** (`09:145`): conseguenza altissima, ma non è un
  controllo — è la **feature mancante**. Costruire un test che lo asserisce
  significherebbe lasciare un rosso in albero, o costruire il watcher, che è una
  slice sua.
- **Il timeout globale dei tool** (`09:190`): stessa forma. Un `Promise.race` a
  `loop.ts:785` è piccolo, ma decide il comportamento di ogni tool del sistema e
  merita la sua PR, non una riga di contorno a una validazione.
- **Il cap duro a 40** (`09:121`): VERIFICATA e **senza test**. Il controllo è
  banale e l'ho lasciato fuori solo per non allargare oltre i tre: è il
  candidato numero uno per il prossimo giro.
- **Un invariante «ogni capability nominata da un documento normativo esiste o è
  dichiarata futura»**, sulla forma di `core/rot/readers.ts`: prenderebbe in un
  colpo `render.rich_media`, `dev.repo`, `config.ratchet`, `outward.send`,
  `net.egress`, `sys.process`. È il controllo di maggior valore che questo
  registro suggerisce, ed è anche il più grosso — vuole una decisione su come si
  dichiara «futuro» in modo che non diventi una discarica.

---

## 5. Affermazioni troppo vaghe per avere uno stato

Non sono un quarto stato. **Sono un ritrovamento**: un contratto che non si può
violare non è un contratto.

| affermazione | dove | perché non ha valore di verità |
|---|---|---|
| «presenza/**permessi** di `~/.muffin`» | `09:178` | Nessun modo né proprietario richiesto è nominato. Nessuna implementazione può essere mostrata sbagliata. Se voleva dire `0700`, deve dire `0700`. |
| «**spazio disco** per i trace» | `09:178` | Nessuna soglia, nessuna unità, nessuna azione. Invalidabile anche prima di notare che il check non esiste. |
| «fino a **riavvio verificato**» | `09:145` | «Verificato» non è definito: dopo un `verify` che passa? dopo `rot reseal`? dopo un'azione dell'operatore? Nessun codice può essere giudicato. |
| «`capabilities.json` — snapshot … **congelato all'install**» | `09:131` | Nessuno schema, nessun consumatore, nessuna affermazione su cosa «congelato» imponga. Anche se il file esistesse non ci sarebbe modo di dirlo sbagliato. |
| «**seed** dove supportato» | `09:232` | Non nomina né un modello né un adapter né un fallback. Nessuna osservazione singola la falsifica. |
| «budget CI **separato** ($20/mese)» | `09:231` | Separato da cosa, imposto da chi, non è detto. Una cifra senza meccanismo non è presente-o-assente. |
| «Il tool-call in corso **termina**» | `09:192` | Intransitivo («finisce») o transitivo («viene interrotto»): le due letture chiedono codice opposto. Il codice lo lascia finire. Questa parola decide se una scrittura lunga viene tagliata a metà quando il cap scatta. |
| «5 floor/**loop cap** raggiunto» | `09:222` | Due nomi in un'alternanza senza distinzione dichiarata. Esiste un solo meccanismo; nulla è rotto, ma chi legge non può sapere se ne erano previsti due. |
| «`0/1`» e «`0/2`» come insiemi di exit code | `09:223-224` | Insiemi nudi senza condizione attaccata a nessun membro. È la notazione lasca che ha lasciato sopravvivere il mismatch di `rot verify`. |
| «sovrascrivibile per capability **nella dichiarazione**» | `09:190` | Si legge come soddisfatta dalla mera esistenza di `CapabilityDecl.timeoutMs`. Un campo con zero lettori soddisfa la frase come è scritta e non consegna nulla: l'affermazione deve nominare il punto di applicazione. |
| «Stato del turno: **in RAM** in M1» | `09:201` | Nessuna osservazione la renderebbe falsa — qualunque locale non persistito la soddisfa. Verifica banalmente e non vincola niente. |
| «**entrambi i modelli di riferimento**» | `09:123` | I modelli di riferimento non sono fissati in codice, config o CI. Finché una coppia non è appuntata da qualche parte di eseguibile, «il floor passa» non ha valore di verità. |
| **N=10 / X=15** a livello di installazione | `09:117-118` | Il documento non dice **quali profili** debbano onorarli. `frontier.json` li supera, legalmente, e nessuna regola scritta è violata. |
| ~~il **tier di un file su disco**~~ — **uscita da questa lista** | `03:20` | Era qui perché la scala era definita su chi ha parlato e il filesystem non aveva un tier assegnato. Ed era la voce più cara dell'elenco: non era solo invalidabile, era **sfruttabile**, e questo registro l'ha catalogata come imprecisione di prosa. `03:20` ora assegna il tier (2, ADR-0042) e il codice lo produce. Resta come promemoria di metodo: «vaga» e «innocua» non sono sinonimi. |

---

## 6. Nota di metodo — il limite di questo registro

È lo stesso che `ORCHESTRATION.md` §13 nomina, e vale ripeterlo qui perché
questo file lo eredita per intero: **ho confrontato il codice con i nostri
documenti**. Trovo ciò che abbiamo scritto e non fatto. Sono
**strutturalmente cieco** a ciò che non abbiamo mai scritto.

Delle 85 DERIVATE qui sopra, **una** sola non viene dal confronto con un
documento — il re-seal silenzioso di `muffin init` (§2.4), trovato eseguendo il
comando e non leggendolo. Le altre 84 sono cose che avevamo scritto e non fatto.
La categoria «non ci avevamo pensato» si trova solo guardando fuori, e vuole una
passata sua.

**Addendum 2026-08-15 — la previsione si è avverata, e con la faccia peggiore.**
Il secondo ritrovamento (§1.3, «che cosa entra nel turno SENZA tier?») non è stato
trovato guardando fuori: è stato trovato **girando un'affermazione già
verificata**. La riga diceva *«un tool result tier-3 alza il taint»*, era vera, ed
è stata controllata esattamente come è scritta — sui cinque tool che un tier lo
dichiaravano. I quattro che non lo dichiaravano non comparivano in nessuna riga,
quindi non comparivano in nessun controllo, quindi il registro li ha attraversati
senza vederli. **Un'affermazione vera acceca sul proprio complemento.** La regola
che questo aggiunge a `ORCHESTRATION.md` §13, e che costa poco: per ogni
affermazione portante della forma *«X fa Y»*, scrivere anche *«che cosa NON è X e
finisce nello stesso posto?»* — e se la risposta è un elenco, l'elenco è il
controllo.
