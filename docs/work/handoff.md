# Handoff operativo

**Regola di stop.** Il prossimo lavoro nasce da un failure osservato usando
Muffin, da una requirement owner, da una migrazione costosa o da un rischio su
authority/data/effect — non da questa lista.

**Goal owner:** un agente *davvero usabile*, rivisto modulo per modulo, e tutto
ciò che manca prima della VPS.

**Come si trovano le cose.** REPL in **tmux**, tracce, log e il `muffin.db`
vero — mai `cp`: `sqlite3 <db> ".backup <dest>"`. **Il gate sono i check di
GitHub**, sulla *condizione*, mai su una stampa; `gate:local` è il ripiego.

## Le decisioni dell'owner

**Instradamento: deciso** — `routing.only: ["alibaba"]`, `dataCollection:
"deny"`. Aperte da prima: **`muffin rot harden`** (serve `sudo`; finché non è
fatto `sys.shell` chiede *sempre* conferma) e la **chiave Tavily**. **C8 note
vocali: il meccanismo è su `dev` e la macchina è pronta** (whisper.cpp, ffmpeg e
`ggml-base.bin` installati il 02/09; `doctor` ha la riga `note vocali`, verde
sull'installazione; una frase sintetizzata con `say` è tornata testo corretto).

## Bivio owner n. 1: il soffitto delle capability `medium` a taint 2

Su Telegram il turno parte a taint 2 (history reiniettata) e `fs.write`,
`send_file`, `skill.read`, `process.list` sono DENY secchi; solo `/new` pulisce.
Opzioni A/B/C, misure e raccomandazione (**B, sull'intera classe**) in
critical-path.md#decidere-il-workflow-locale-read--write. Decisione minima: A, B o C.

## Bivio owner n. 2: un tool `jobs` per il modello

Oggi i job nascono solo da `muffin jobs add`; «scrivimi tra 5 minuti» passa da
`turn.wait` (funziona su Telegram, provato il 29/08). Un job creato da un turno
tainted è un'iniezione differita: serve una forma prima di costruirlo. Non DAY-1.

**Azioni owner senza codice:** chiave Tavily + `rot/egress.json` (oggi Muffin
non ha nessun accesso web: 0 `web_search`, 0 `http_get` in 165 turni) ·
`muffin rot harden` · togliere `discord` da `surfaces.enabled` finché flappa.

## Il 02/09

Dodici PR su `dev`: ledger (#277), F5 (#278), riconciliazione (#279), `doctor`
note vocali (#280), regola «un tool che non c'è non è una policy» (#281), F6
(#282), quattro journey (#283–#286), tetto accettazione (#287), stato (#288).
Inventario **36 READY · 14 BLOCKER · 6 OUT**. Revisione indipendente del `dev`
integrato: **NOT READY** per il bivio n. 1. Promozione `dev → main` fatta
(#289, `dd38d40`) e `muffin update` eseguito sull'installazione reale: build
`dd38d40`, gateway riavviato da launchd, `doctor` senza `fail`.

**Ledger di studio:** `docs/evidence/design-study-ledger-2026-09-02.md`,
evidence datata, non authority — si legge quando il dominio entra nel lavoro.

**Parcheggiato:** `docs/evidence/richieste-differite-2026-08-30.md` — misure
(7 todo fermi e invisibili fuori sessione, 44 fatti `asked_to` su 83), non una forma.

## Aperto, non bloccante

**Prossimo grosso:** dichiarare i **permessi** nel prompt. Oggi il kernel
rifiuta alla chiamata e il modello impara per rifiuto — incluso il tetto di
taint. Codex rende `<permission_profile>`, OpenClaw `## Authorized Senders`.

**Harness:** il finto Bot API (`evals/acceptance/telegram.ts`) non serve
`getFile`: B10 (immagini) e C8 (nota vocale) restano senza scenario per questo,
non per il prodotto. Le run di accettazione durano ora ~5 minuti: il tetto del
job è 10.

**Altro:** `gateway.err` non data le righe (19 ore di errore, una volta);
`pricing.ts` sottostima 5 famiglie su 8; il `try` di `recall.ts` avvolge anche
la provenienza, così un guasto dello store sembra rete.

**Truth maintenance:** `day1/requirements-status.md` possiede lo stato dei
requisiti DAY-1,
critical-path.md#ordine-corrente l'ordine.
