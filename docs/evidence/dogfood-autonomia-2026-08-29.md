# Dogfood autonomia — 2026-08-29

**Tipo:** evidenza, non autorità architetturale.  
**Domanda:** perché l'istanza reale di Muffin, pur avendo memoria, turni durevoli e approvazioni Telegram, continua a perdere autonomia, ripetere lavoro e restare bloccata dal taint?  
**Repo osservata:** `main`/`dev` con albero identico dopo #238 (`main` `3ae9595acb437e2460f283dddcc50f318128fc8e`, `dev` `43d089e09c6a8d33745cc82e7f5c3a1d79245ccf`).  
**Dump osservato:** `muffin.db`, 7,331,840 byte, SHA-256 `dfe9e1c00fd8ec29048dc4c40a5a6e358b9837280631c3495333bead471095f7`.

Il criterio qui è quello di `ORCHESTRATION.md`: partire dal failure osservato, ricostruire il path produttivo, poi usare peer/paper per sfidare la forma della fix. Non è un audit generale della codebase.

## 1. La fix #237/#238 gira davvero, ma Telegram resta a taint 2

`sys_inspect` nel dump mostra tre epoche di build; dai turni delle 22:12 UTC in poi riporta **`3ae9595acb43`**, cioè il `main` che contiene #237/#238. Quegli stessi turni riportano ancora `taint corrente: 2`.

Quindi il residuo non è «gateway vecchio»: la separazione `raiseCeiling` / `intrinsicTaint` è in produzione e non basta da sola.

### Path letto

`agent/loop.ts` fa due cose diverse:

1. history e piano reiniettati -> `snapshot.raiseCeiling(...)`;
2. recall automatico -> `snapshot.raiseTaint(recallTaint(result))`.

La distinzione è corretta presa isolatamente: un ricordo richiamato **nuovo per questo turno** deve contaminare il turno, altrimenti `remember -> act` diventa una lavanderia.

Il problema misurato è nella composizione: il recall può ripescare **la stessa conversazione già presente nella history**. In quel caso un byte che #237 ha deliberatamente classificato come «ereditato da un turno passato» attraverso history rientra una seconda volta da recall e diventa di nuovo taint intrinseco.

Nel dump, dopo il primo messaggio Telegram quasi ogni blocco di memoria contiene risposte precedenti di Muffin. Un esempio reale richiamato automaticamente è l'episodio 130, ruolo `agent`, tier 2:

> `Ho guardato cosa ho in mano adesso: 14 tool, sandbox senza rete...`

Nei turni Telegram recenti il blocco automatico ha normalmente 11 item e spesso 4-8 sono risposte di Muffin tier 2. Questo spiega perché una risposta nuova può continuare a nascere tier 2 anche dopo #237.

**Ipotesi da provare, non ancora decisione:** history e recall devono avere dedup semantico/identitario di sorgente, oppure l'auto-recall deve distinguere evidenza primaria da output derivativo dell'agente. Abbassare semplicemente il tier delle risposte di Muffin è scartato: una risposta che riassume una pagina tier 3 deve restare tier 3.

## 2. Un hard `deny` insegna al modello che l'owner può sbloccarlo

`core/policy/decide.ts` distingue correttamente `ask` e `deny`. `taint_exceeded` è un `deny`: nessuna approvazione inline lo trasforma in allow nello stesso turno.

`agent/loop.ts`, però, rende **ogni** deny così:

> `Rifiutato dal kernel dei permessi (<code>). Non insistere: serve una decisione dell'owner.`

Nel dogfood questa frase è diventata comportamento. `fs_write` viene negato ripetutamente a taint 2; l'owner chiede «posso semplicemente dirti di sì?» e Muffin continua a ragionare come se mancasse un canale di approvazione. Il canale Telegram è stato poi costruito, ma non può risolvere un `deny`.

Questa è una fix separabile e STANDARD: **un deny deve spiegare che è un hard stop per quel turno e che un'approvazione non lo sovrascrive; solo `ask` deve parlare di approvazione**. Non cambia la policy, cambia la verità che il runtime dice al modello.

## 3. Il budget di resume conta le approvazioni come crash/retry

`MAX_RESUMES = 3` è documentato in `agent/loop.ts` come bound contro riavvii/crash ripetuti: laptop chiuso, restart del servizio, un crash reale. Ma `resumeTurn()` incrementa lo stesso `counters.resumes` per qualunque turno che era già partito, inclusa una sospensione deliberata in attesa dell'owner.

### Caso reale A — turno `f23bd897...`

- build: `3ae9595...`;
- outcome: `error`;
- 8 iterazioni, 10 tool call;
- ~89,925 input token; ~$0.00968;
- quattro approval distinte per `sys.shell` mentre cerca la repo;
- le prime tre sono `allow` + `consumed`;
- la quarta è `allow` ma **mai consumed**;
- il record chiude con `resumes = 3` / `resumes_exhausted`.

Non è un loop di crash: l'owner ha risposto tre volte e il turno ha fatto progresso reale fra una risposta e l'altra.

### Caso reale B — turno `e7c6232e...`

- build: `3ae9595...`;
- outcome: `error`;
- 10 iterazioni, 12 tool call;
- ~156,078 input token; ~$0.01634;
- approvazioni successive mentre cerca il binario/configurazione MCP;
- anche qui l'ultima approval resta non consumata dopo il tetto di resume.

**Conclusione:** il counter sta misurando due fenomeni diversi. Una ripresa da crash/reclaim e una ripresa perché `approval:<id>` si è soddisfatta non devono spendere lo stesso budget.

Questa è CRITICAL: tocca crash recovery / durability. Prima della fix serve una classificazione persistibile o derivabile del motivo di resume e test che preservino il bound sui crash mentre consentono un numero ragionevole di wait/approval progressivi.

## 4. I turni incompleti restano nella history come richieste ancora vive

Due richieste Telegram identiche del tipo «guardando db/memoria cosa ne pensi?» sono terminate `ask` prima che la superficie avesse il consumer di approvazione. Nessuna risposta finale è stata consegnata, ma i messaggi user restano nel transcript append-only.

Il turno successivo riceve solo «Ciao!». La history contiene ancora le due richieste senza una controparte assistant terminale e il modello riparte ad analizzare memoria/DB invece di rispondere al saluto.

Il transcript come evidence non va riscritto. Il problema è il **rendering della history operativa**: un turno precedente `ask/error/aborted` dovrebbe essere rappresentato come lavoro incompleto/chiuso, non lasciato sembrare una richiesta ancora pendente per sempre.

## 5. Il recall automatico rinforza vecchie conclusioni di Muffin

La pipeline non estrae facts dagli output agent, correttamente, ma gli episodi agent restano ricercabili. Nel dump il recall ripropone spesso vecchie risposte su capability, rete, daemon, egress e stato del prodotto. Alcune sono state vere in una build precedente e poi superate.

Questo crea un circuito di self-reinforcement: una vecchia risposta plausibile di Muffin compete con evidence più fresca e con `sys_inspect`, pur essendo una conclusione derivata e non una fonte primaria.

Non è corretto cancellare la storia: serve ancora per «cosa mi avevi detto ieri?». Il problema è il **ranking/uso automatico**. L'auto-recall per rispondere sul mondo/persona dovrebbe privilegiare evidence owner/facts; l'output storico dell'agente dovrebbe restare raggiungibile esplicitamente o quando la domanda è davvero sulla conversazione passata.

## 6. `sys_inspect` è già una buona base; manca la causalità

Il dogfood smentisce un'altra ipotesi: Muffin non è cieco su sé stesso. `agent/tools/inspect.ts` è utile e ha permesso di provare la build corrente, il modello, il profilo, i tool esposti, il RoT e il **taint corrente** senza shell.

Quello che non sa dire è **da dove viene il taint**. Vedere `taint corrente: 2` non distingue:

- input del principal;
- recall;
- history;
- piano;
- tool result del turno.

Una vista causale (`ceiling=2: recall 2, history 2; intrinsic=2: recall 2`) renderebbe molte diagnosi possibili senza interrogare SQLite o greppare codice. Va prodotta dalle stesse alzate del `PermissionSnapshot`, non ricostruita dopo da testo.

## 7. Mancanza di un guardrail di no-progress

Il dump contiene turni con 10-12 tool call e molte approvazioni per scoprire una cosa locale semplice (repo/binario/config). Gli args non sono sempre identici, quindi un semplice «non ripetere la stessa call» non basta.

### Hermes, letto a sorgente

Peer: `NousResearch/hermes-agent`, `main` osservato il 2026-08-29 a `ac6c8028e00d01ee2f299ba7fd03329c7f10382d` (la logica letta è nel parent `2a36a715...`, non modificata dal commit di formatting successivo).

`agent/tool_guardrails.py` mantiene per turno:

- repeated exact failures;
- same-tool failures;
- idempotent calls che restituiscono lo stesso risultato / no progress;
- warning prima del blocco;
- hard stop configurabile;
- cap separati per classi runaway-prone.

La parte da portare non è il numero delle soglie. È il concetto: **osservare outcome/progresso, non solo l'identità della call**. Le issue recenti di Hermes mostrano anche il limite del signature-only: argomenti diversi possono produrre lo stesso risultato e continuare a girare.

Per Muffin la forma minima dovrebbe usare primitive che già possiede (`args_digest`, outcome durevole, tool name/capability, turn counters) e iniziare come nudge osservabile, non come altro framework.

## 8. Peer/paper che cambiano davvero la decisione

- Hermes `agent/tool_guardrails.py`: guardrail per repeated failure/no-progress; utile per il loop.
- Hermes memoria: separa memoria curata della persona / note persistenti da session history/search; utile contro il self-recall indiscriminato, ma non va copiato come flat-file perché Muffin possiede già provenance e graph/facts.
- Anthropic, *Effective harnesses for long-running agents* (2025-11-26): compaction da sola non basta; il progresso tra finestre va reso esplicito in artefatti/stato, non affidato alla capacità del modello di ricostruirlo.
- Anthropic, *Scaling Managed Agents: Decoupling the brain from the hands* (2026-04-08): sessione e context window non sono la stessa cosa; context trimming/compaction sono decisioni lossy e lo stato utile va conservato fuori dalla finestra.
- Mem0, arXiv:2504.19413: estrazione/consolidamento/retrieval selettivo battono il full-context sui loro eval; rilevante qui non per i numeri ma perché il failure misurato di Muffin è precisamente «history ampia + recall che la duplica».

## 9. Ordine di lavoro aggiornato dal dogfood

Questo dump cambia l'ordine rispetto a una roadmap centrata solo sul person-model:

1. **STANDARD — deny dice il vero.** Nessun hard deny viene descritto come sbloccabile da approval.
2. **CRITICAL — resume reason/budget.** Le approvazioni non consumano il budget che protegge dai crash loop; il crash loop resta bounded.
3. **CRITICAL — history/recall provenance composition.** Provare e rimuovere il doppio conteggio della stessa evidence senza aprire remember-then-act laundering.
4. **STANDARD — self-inspection causale.** `sys_inspect` mostra i contributori del taint e il motivo del blocco.
5. **STANDARD — no-progress guardrail.** Warning/nudge su failure/result ripetuti anche con args diversi; hard stop solo dopo misura.
6. **STANDARD — history degli outcome incompleti.** Un ask/error passato non resta semanticamente una richiesta viva per sempre.
7. Poi i P0 già misurati nel DB: embedder reale/fallback configurato e contradiction judge che non scarta un verdetto per la sola lunghezza del reasoning.
8. Solo dopo: entity/predicate canonicalization, identity resolution, profilo/digest consumato, proattività automatica.

## 10. Stop boundary

Non cambio qui `defaultMaxTaint`, `DISK_TIER`, i ceiling di `fs.write`, l'egress gate o la semantica «owner può approvare sopra taint N». Sono boundary di sicurezza/prodotto e il dump non dimostra ancora che vadano allargati: dimostra prima di tutto che il turno arriva a tier 2 per composizione sporca e che il runtime spiega male cosa quel tier comporta.

Dopo aver eliminato il taint spurio, se un workflow owner legittimo resta sistematicamente bloccato, allora il ceiling della capability è la decisione da portare all'owner, come ADR-0044 già prescrive.
