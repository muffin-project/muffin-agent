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
verde si scrive `LOCAL-GATE PASS @ <sha>`, **mai** «CI verde». Il clone serve
perché a mano la suite raccoglieva 945 file su 201.

## Il telefono è configurato, e nessuno sa se sta bene

`surfaces.enabled = ["cli","telegram","discord"]`, owner id su entrambe: **44
turni Telegram** e 3 Discord nel db, più due Telegram il 30/08. Funziona.

Non si può sapere **quando** smette. In una sola vita del gateway `gateway.err`
ha raccolto **3187 righe identiche** — `telegram: polling fallito (Telegram 0:
TypeError)` — mentre `api.telegram.org` risponde in 326ms. Quel file registra
solo i fallimenti e non li data: dice *quanti*, mai *per quanto*.

**Non concluderne una durata.** Il 30/08 l'ho fatto e mi sono sbagliato: da
quelle righe più una copia incoerente del db avevo dedotto 19 ore di silenzio
che non c'erano state.

Due difetti veri, e sono quelli che #260 chiude: il log dice `error.name` e mai
la causa (`connectors/telegram/api.ts:148` — l'URL porta il token, quindi
`.message` è vietato, ma `cause.code` no); e `doctor` guardava il processo, non
la superficie — `gateway attivo` e `nessuna delivery mancante` restano verdi
**perché** non arriva niente.

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
