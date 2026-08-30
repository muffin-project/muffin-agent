# Lavoro corrente

**Regola di stop.** Il prossimo lavoro nasce da un failure osservato usando
Muffin, da una requirement owner, da una migrazione costosa o da un rischio su
authority/data/effect. Non da questa lista.

**Goal owner:** un agente *davvero usabile*, rivisto modulo per modulo, e tutto
ciò che manca prima della VPS.

**Come si trovano le cose.** Non leggendo il codice: pilotando il REPL in **tmux**
(`capture-pane` rende lo schermo; `script` registra i byte), o misurando su
tracce, WAL, `gateway.err` e il `muffin.db` vero — da lì sono nate tutte le
slice del 30/08.

**Il gate.** `npm run gate:local`: clone di HEAD **fuori** dal repository, `npm
ci`, typecheck, build, suite host, accettazione host, e `gate-linux.sh` in
Docker. Il verde si scrive `LOCAL-GATE PASS @ <sha>`, **mai** «CI verde». Il
clone serve perché a mano la suite raccoglieva 945 file su 201: `.releases/` e
`.codex/worktrees/` sono invisibili a `git status` e non a vitest.

## Il telefono è configurato, ed è muto

`surfaces.enabled = ["cli","telegram","discord"]`, owner id su entrambe: **44
turni Telegram** (28-29/08) e 3 Discord sono nel db. Poi, dalle 17:08 del 29/08,
zero turni su qualsiasi superficie e **3187 righe identiche** in `gateway.err`:
`telegram: polling fallito (Telegram 0: TypeError)`. Da questa macchina
`api.telegram.org` risponde in 300ms: non è la rete, è il poller morto.

Due difetti. Il log dice `error.name` e mai `.message` — scelta giusta, l'URL
porta il token (`connectors/telegram/api.ts:148`) — ma butta anche `cause.code`,
che è un simbolo (`UND_ERR_SOCKET`, `ECONNRESET`) e non può contenere un URL:
19 ore di guasto senza una causa. E `doctor` stampa `gateway attivo · socket
concorde` e `nessuna delivery mancante`: verde perché non arriva più niente.
Nessun check guarda se una superficie **abilitata** è connessa.

## Le decisioni dell'owner

**Instradamento: deciso** — `config.json` del 29/08 porta `routing.only:
["alibaba"]` con `dataCollection: "deny"`. Restano aperte: **`muffin rot
harden`** (serve `sudo`; finché non è fatto `sys.shell` chiede *sempre*
conferma) e **C8, note vocali** (whisper.cpp locale o API: se la tua voce esce
di casa). Mancano **chiave Tavily** (senza, `web_search` non si registra) e
**billing CI**.

## Cosa aspetta te, adesso

1. **Ollama è giù**: recall **solo testuale**, **120 sorgenti** senza vettore.
   `ollama serve`, poi `muffin memory extract`.
2. **Il binario installato è vecchio**: `muffin 0.0.0 (3ae9595, 28/08)`, cioè
   `main` prima di tutto il lavoro del 30/08.
3. **`dev` è 47 commit avanti a `main`**: la promozione è una PR che mergi tu —
   senza crediti CI l'unica prova è il gate locale, verde su ogni merge.

Zero PR aperte. #186 chiusa con l'evidenza (`fs.write` ha **0 chiamate** in
tutto il corpus, `~/.muffin/undo/` non esiste); i rami restano.

## Aperto, non bloccante

**Prossimo grosso:** dichiarare i **permessi** nel prompt. Oggi il kernel rifiuta
alla chiamata e il modello impara per rifiuto — incluso il tetto di taint, per
cui «leggi, calcola, scrivi» è rifiutato *sempre* senza che nessuno gli dica
perché. Codex rende `<permission_profile>`, OpenClaw `## Authorized Senders`. Va
nella coda volatile: il taint cambia dentro il turno.

**Memory health:** `doctor` nomina l'embedder giù e da #257 `memory stats` non
può dirsi in pari sopra un arretrato. Resta il **person model**: 3 entità, e 42
dei 79 fatti attivi sono eventi-richiesta (`asked_to`, `asks_to`).

**Altro:** community è solo una forma di stringa, promessa nel tipo e non
capability; `pricing.ts` sottostima 5 famiglie su 8; socket v2.

**Truth maintenance:** M5-BIS possiede status Gate, PERCORSO §0 l'ordine.
`STATE.md` è cronologia, non stato corrente.
