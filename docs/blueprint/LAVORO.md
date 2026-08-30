# Lavoro corrente

**Regola di stop.** Il prossimo lavoro nasce da un failure osservato usando
Muffin, da una requirement owner, da una migrazione costosa o da un rischio su
authority/data/effect. Non da questa lista.

**Goal owner:** un agente *davvero usabile*, rivisto modulo per modulo, e tutto
ciò che manca prima della VPS.

**Come si trovano le cose.** Pilotando il REPL in **tmux**, o misurando su
tracce, log e il `muffin.db` vero — mai con `cp` dei suoi tre file, che dà una
vista vecchia senza errore: `sqlite3 <db> ".backup <dest>"`.

**Il gate.** `npm run gate:local`: clone di HEAD **fuori** dal repository, `npm
ci`, typecheck, build, suite, accettazione, e `gate-linux.sh` in Docker. Il
verde si scrive `LOCAL-GATE PASS @ <sha>`, **mai** «CI verde». La CI di GitHub
è rossa per **fatturazione**: i job muoiono in 2s senza eseguire niente, quindi
il gate locale è l'unica prova.

## Il telefono ora dice quando smette

`surfaces.enabled = ["cli","telegram","discord"]`, owner id su entrambe: 44
turni Telegram e 3 Discord nel db. Funziona, e da #260/#261 si sa **quando**
smette di funzionare.

Prima no: `gateway.err` registra solo i fallimenti e non li data, quindi dice
*quanti*, mai *per quanto*. **Non concluderne una durata:** il 30/08 l'ho fatto
e mi sono sbagliato, deducendo 19 ore di silenzio che non c'erano state.

Chiuso: il log dice la **causa** (`cause.code`, mai `.message` — l'URL porta il
token), per Telegram e per l'embedder; e `doctor` guarda la **superficie**, non
il processo, con i tre silenzi tutti limitati.

## Le decisioni dell'owner

**Instradamento: deciso** — `routing.only: ["alibaba"]`, `dataCollection:
"deny"`. Aperte: **`muffin rot harden`** (serve `sudo`; finché non è fatto
`sys.shell` chiede *sempre* conferma) e **C8, note vocali** (se la tua voce
esce di casa). Mancano **chiave Tavily** e **billing CI**.

`integrazione/tre-slice` (note vocali/whisper) è spinta su origin come
checkpoint: non è una PR, non è morta.

## Parcheggiato: come arriva una richiesta che non si fa adesso

`docs/blueprint/research/richieste-differite-2026-08-30.md` — misure, non una
forma, perché il tema tocca insieme work/todo, memoria, esposizione dei tool e
person model.

In breve: **`jobs` non ha un tool**, per nessuno e a nessun taint (solo `muffin
jobs add`), e il modello interrogato ha spiegato l'assenza come una policy di
taint che non esiste. `wait` è stato chiamato **1** volta, `todo` 2, i 7 todo
sono fermi dal 27/08 e invisibili fuori dalla loro sessione. **44 fatti attivi
su 83** sono `asked_to`/`asks_to`: «dimmi solo: tre» sta nello stesso mucchio
delle due richieste davvero pendenti. ANANAS non si recupera perché nessuna
somiglianza trova un'istruzione che il messaggio dopo non nomina — riparare
Ollama non c'entra.

Il tetto dei tool **non** è più il problema: `0d519cb` l'ha portato a 15 e
`doctor` non stampa più niente. Quel reperto è morto: non ripartire da lì.

## Aperto, non bloccante

**Prossimo grosso:** dichiarare i **permessi** nel prompt. Oggi il kernel
rifiuta alla chiamata e il modello impara per rifiuto — incluso il tetto di
taint. Codex rende `<permission_profile>`, OpenClaw `## Authorized Senders`.

**Altro:** community è solo una forma di stringa; `pricing.ts` sottostima 5
famiglie su 8; socket v2; il `try` di `recall.ts` avvolge anche la lettura della
provenienza, quindi un guasto dello store si traveste da causa di rete.

**Truth maintenance:** M5-BIS possiede status Gate, PERCORSO §0 l'ordine.
`STATE.md` è cronologia, non stato corrente.
