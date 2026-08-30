# Lavoro corrente

**Regola di stop.** Il prossimo lavoro nasce da un failure osservato usando
Muffin, da una requirement owner, da una migrazione costosa o da un rischio su
authority/data/effect. Non da questa lista.

**Goal owner:** un agente *davvero usabile*, rivisto modulo per modulo. E tutto
ciò che manca prima della VPS.

**Come si trovano le cose.** Le ultime otto slice sono nate tutte allo stesso
modo: pilotando il REPL vero dentro **tmux** (`capture-pane` rende lo schermo;
`script` registra i byte e fa concludere il falso), o misurando su tracce e WAL
invece che sullo schermo. Nessuna è nata leggendo il codice.

**28/08 (#219 → #224).** `npm run build` era `tsc --noEmit` e mi ha fatto
misurare due volte il binario di ieri. Ctrl+J spediva invece di andare a capo
(Node consegna `\n` come `enter`). Il prompt si ripeteva: `persona.md` 7.528 →
4.629 byte, e `prompt show --eco` misura l'eco. Le righe di lavoro dicono su
cosa (sette ricerche diverse erano sette righe identiche). Muffin non sapeva
che giorno fosse: `## Questo turno` porta ora momento, fuso+offset, superficie,
con chi parli, modello e profilo. `gateway status` e `rot harden` davano rimedi
diventati falsi dopo #217.

**30/08 (#251, #240, #253).** Il gate locale certificava **945** file di test
dove il repository ne ha 201: gli altri 744 venivano da `.releases/` (402, le
release affiancate di `muffin update`) e `.codex/worktrees/` (342), invisibili a
`git status` — il primo per `.gitignore`, il secondo per `.git/info/exclude` — e
letti da vitest. I 97 rossi dell'owner erano `.codex/worktrees/pr186-*`, cioè il
ramo di una PR aperta, **non** regressioni di HEAD. Ora vitest non legge ciò che
Git ignora (`vitest.ignored.ts`) e il gate clona HEAD **fuori** dal repository e
asserisce che il clone non abbia un solo file non tracciato né ignorato. Poi:
una spiegazione >600 caratteri non invalida più un verdetto del giudice della
memoria. Poi gli episodi hanno guadagnato `episodes.turn_id` e il recall
automatico ha smesso di ripescare lo scambio che la history già riporta.

**Il gate, e come si scrive.** `npm run gate:local` — clone di HEAD in una
directory temporanea, `npm ci`, typecheck, build fresh, suite host, accettazione
host, e `evals/acceptance/gate-linux.sh` in Docker. Il verde si scrive
`LOCAL-GATE PASS @ <sha>` e **mai** «CI verde»: GitHub Actions è senza crediti,
e questo gira sulla macchina dell'owner.

**Peer da guardare sempre**, e soprattutto gli agenti personali continui:
openclaw, hermes, pi, odysseus, opencode, codex, claude, gemini. Letti finora:
Hermes (`stable`/`context`/`volatile`, offset UTC argomentato), OpenClaw
(`## Temporal Context`, `## Authorized Senders`, owner id hashato), Codex
(`<permission_profile>`, world state).

## Le tre decisioni aperte, tutte dell'owner

1. **Instradamento** (`config.provider.routing`, da #221). Oggi 0% di cache:
   OpenRouter manda al più economico dei 12 provider a monte, che non onora i
   breakpoint. Con `only: ["alibaba"]` la cache prende il 95% dal secondo turno
   e costa **meno** (~$0.0009 contro ~$0.0031 a turno). Ma è cinese, e
   `dataCollection: "deny"` non l'ha mai deciso nessuno: oggi `identity.md` e i
   ricordi vanno a chi costa meno senza vincoli su chi può tenerseli.
2. **`muffin rot harden`** — serve `sudo`, e da lì i reseal servono `sudo`.
   Finché non è fatto, `sys.shell` chiede **sempre** conferma.
3. **C8, note vocali**: whisper.cpp locale o un'API. Decide se la voce
   dell'owner esce di casa.

## Cosa manca per usarlo davvero

Muffin oggi è **solo terminale**: `surfaces.enabled = ["cli"]`, un solo segreto
(`provider_api_key`). Servono, dall'owner: **token bot Telegram** (senza,
niente telefono), **chiave Tavily** (senza, `web_search` non si registra),
**billing CI**.

## Aperto, non bloccante

**Prossimo grosso, con evidenza dai peer:** dichiarare i **permessi** nel
prompt. Oggi il kernel rifiuta al momento della chiamata e il modello impara
per rifiuto — incluso il tetto di taint (`defaultMaxTaint` medium/high = 1),
per cui «leggi, calcola, scrivi» è rifiutato *sempre* e nessuno gli dice
perché. Codex rende `<permission_profile>`, OpenClaw `## Authorized Senders`.
Va nella coda volatile, perché il taint cambia dentro il turno. Lì nasce anche
l'hashing degli identificatori: oggi nessun `externalId` arriva al prompt.

**PR aperte, classificate il 30/08** (triage indipendente su `dev`, commento su
ognuna):

| PR | Difetto reale a HEAD? | Esito |
|---|---|---|
| #241 resume budget | sì: ogni `wait`/approvazione addebita il contatore di crash | REIMPLEMENT — un rigo, `resumed: !firstAttempt && !wasWaiting`. Il reset in `TurnStore.suspend` che la PR propone toglie `MAX_RESUMES` come bound sul loop di recovery. CRITICAL, serve il giudice. |
| #244 no-progress | sì: il meccanismo non esiste | REBASE + 2 correzioni. Non fa typecheck (`ToolContext.intrinsicTaint`), e `wrap-tool.ts:46` rilancia un `Error` nuovo che rompe lo smistamento di `ApprovalRequired` (`agent/loop.ts:1981`, `:2226`). |
| #246 security A/B | in parte | REIMPLEMENT-SMALL: `evals/security/scenarios.ts:38-88` ridichiara le capability invece di importarle, quindi la baseline resta verde quando la produzione deriva. |
| #186 undo | — | SALVAGE, non merge: 141 commit indietro, 5 conflitti. Il lineage che portava è rientrato con #253; la parte undo/redo va valutata a parte. |

Il lavoro non committato trovato in `.codex/worktrees/pr186-orchestrator` è
salvato in `codex/pr186-safe-legacy` (bae1a40): la sua tesi — un backfill di
`turn_id` per `(tenant, connector, thread_key, created_at)` non è una giunzione
causale — è la stessa a cui è arrivata #253.

**Community:** esiste solo come forma di stringa (`community:${slug}` in
`TenantId`). Nessuna macchina: né appartenenza, né raggruppamento fra
superfici, né memoria condivisa. Promessa nel tipo, non capability.

**Altro:** la cache non prende fra un turno e l'altro (vedi decisione 1);
`pricing.ts` sottostima 5 famiglie su 8; ADR su «il REPL è un client del
gateway?»; socket v2; `possibly_sent` non distingue crash da in-volo.

**Prossimo, nell'ordine deciso:** #241 (un rigo, CRITICAL, giudice), poi #244
reimplementata su `dev` corrente, poi memory health osservabile (embedder
disponibile o no, modalità lexical/hybrid/vector, arretrato dei vettori,
fallimenti del giudice) — il fallback non va nascosto.

**Truth maintenance:** M5-BIS possiede status Gate, PERCORSO §0 l'ordine.
