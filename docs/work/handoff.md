# Handoff operativo

**Regola di stop.** Il prossimo lavoro nasce da un failure osservato usando
Muffin, da una requirement owner, da una migrazione costosa o da un rischio su
authority/data/effect — non da questa lista.

**Goal owner:** un agente *davvero usabile*, rivisto modulo per modulo, e tutto
ciò che manca prima della VPS.

**Come si trovano le cose.** Pilotando il REPL in **tmux**, o misurando su
tracce, log e il `muffin.db` vero — mai con `cp`, che dà una vista vecchia senza
errore: `sqlite3 <db> ".backup <dest>"`.

**Il gate sono i check di GitHub**, verdi dall'1/09/2026 (i 16 rossi riemersi
erano test mai eseguiti su Linux, #272). Si gatta sulla *condizione* dei check,
mai su una stampa. `gate:local` è lo strumento locale e il ripiego se i crediti
finiscono — non un sostituto: la sua gamba Linux esegue solo la config di
accettazione, non la suite.

## Le decisioni dell'owner

**Instradamento: deciso** — `routing.only: ["alibaba"]`, `dataCollection:
"deny"`. Aperte da prima: **`muffin rot harden`** (serve `sudo`; finché non è
fatto `sys.shell` chiede *sempre* conferma) e la **chiave Tavily**. **C8 note
vocali: il meccanismo è su `dev` e la macchina è pronta** (whisper.cpp, ffmpeg e
`ggml-base.bin` installati il 02/09; `doctor` ha la riga `note vocali`, verde
sull'installazione; una frase sintetizzata con `say` è tornata testo corretto).

## Decisione owner aperta: il soffitto di `fs.write` dopo una lettura

**Osservato (02/09, `muffin.db` dell'owner):** 165 turni, 110 a taint 2; `fs.write` mai
eseguita (0 chiamate). Dopo un `fs_read` (`DISK_TIER` = 2) il kernel dice ASK a
`sys.shell` (`high`, `maxTaint: 2`, revisione ADR-0044 del 16/08) e **DENY** a
`fs.write` (`medium` + `undoable`, soffitto di classe 1). Quindi l'unica porta per
scrivere un file dopo averne letto uno è la shell — senza checkpoint e senza `undo`
— mentre la porta col journal è chiusa. Il sink è lo stesso: il disco dentro lo scope.

**Bivio esatto:** che effetto deve dare il kernel a `fs.write` a taint 2?

| opzione | cosa cambia | costo |
|---|---|---|
| A. `maxTaint: 2` su `fs.write`, `draft` automatico anche a taint 2 | scrive senza chiedere, con checkpoint+undo | un file letto può far scrivere un altro file nello scope senza che l'owner lo veda (es. `.git/hooks/`), undoable ma già eseguito |
| B. `maxTaint: 2` su `fs.write`, `draft` solo a taint 0, ASK sopra | parità con la shell più il checkpoint: l'ASK mostra path+byte, poi scrive revocabile | un ASK in più per ogni write in un turno che ha letto; cambia la scala del kernel per `medium`+`undoable` |
| C. lasciare com'è | niente | il workflow read→write resta nella shell, senza undo; D11 resta irraggiungibile |

**Raccomandazione: B.** È il precedente che ADR-0044 ha già scelto per la shell,
applicato alla porta che ha il journal; l'egress non si tocca (`sys.http` fuori
allowlist resta DENY a taint ≥ 2), la monotonicità della provenienza resta. Entra come
emendamento di ADR-0044 + `agent/tools/fs.ts` + una riga in `decide.ts`, con il costo
dichiarato come test (come `shell.test.ts` §«il costo»), profilo CRITICAL (kernel).

**Cosa diventa irreversibile:** niente nel dato; cambia il threat model (`03` §3 riga
«filesystem host · taint 2 · DENY»): un emendamento è un atto, va scritto.

**La decisione minima:** A, B o C.

## Decisione owner aperta: un tool `jobs` per il modello

`jobs` si creano solo da CLI (`muffin jobs add`); «scrivimi tra 5 minuti» oggi passa da
`turn.wait` (min 60 s, max 7 giorni — e su Telegram funziona: l'unico wait reale del
29/08 è ripreso ed è stato consegnato). Un job creato dal modello è un goal eseguito
più tardi da un principal `system`: se il turno che lo crea è tainted, è un'iniezione
differita. Serve una forma (taint del goal ereditato? solo owner a taint 0? ASK?) prima
di costruirlo. Non è DAY-1 finché `wait` copre i promemoria brevi.

## Cosa è successo il 02/09 (sessione parent DAY-1)

Undici PR integrate su `dev` (`28a0d1b`): ledger di studio (#277), F5 in
PRACTICES (#278), riconciliazione righe/ordine (#279), `doctor` sulle note
vocali (#280), regola «un tool che non c'è non è una policy» (#281), F6 — la
mappa si controlla dove cambiano i docs (#282), quattro journey di accettazione
(#283 #284 #285 #286), tetto del job di accettazione a 10 minuti (#287).
Inventario: **36 READY · 14 BLOCKER · 6 OUT** (era 19/31/6). Il bivio che
domina DAY-1 è il primo del critical path e sta qui sopra.

**Cosa NON è ancora fatto per dichiarare READY:** la promozione `dev → main`
e `muffin update` sull'installazione reale (che legge `origin/main`, non
`dev`: il binario installato è ancora `e76d521` del 30/08), la revisione
indipendente del `dev` integrato, e la decisione owner su `fs.write`.

## Il ledger di studio è congelato

`docs/evidence/design-study-ledger-2026-09-02.md` è lo snapshot datato del
reasoning di design fatto fino al 2/09: challenge set, invarianti candidate,
alternative scartate, domande aperte. È evidence, non authority: si legge
quando il dominio entra nel lavoro, e una sua voce non si implementa perché è
lì.

## Parcheggiato: le richieste differite

`docs/evidence/richieste-differite-2026-08-30.md` — misure, non una forma:
**`jobs` non ha un tool**, i 7 todo fermi dal 27/08 e invisibili fuori dalla
sessione, 44 fatti attivi su 83 `asked_to`/`asks_to`. Il tetto dei tool **non** è
più il problema (`0d519cb`).

## Aperto, non bloccante

**Prossimo grosso:** dichiarare i **permessi** nel prompt. Oggi il kernel
rifiuta alla chiamata e il modello impara per rifiuto — incluso il tetto di
taint. Codex rende `<permission_profile>`, OpenClaw `## Authorized Senders`.

**Harness:** il finto Bot API (`evals/acceptance/telegram.ts`) non serve
`getFile`: B10 (immagini) e C8 (nota vocale) restano senza scenario per questo,
non per il prodotto. Le run di accettazione durano ora ~5 minuti: il tetto del
job è 10.

**Altro:** `gateway.err` registra solo i fallimenti e non li data: dice
*quanti*, mai *per quanto* — dedurne una durata mi è costato 19 ore di errore. Community è solo una forma di stringa; `pricing.ts` sottostima 5
famiglie su 8; socket v2; il `try` di `recall.ts` avvolge anche la lettura della
provenienza, quindi un guasto dello store si traveste da causa di rete.

**Truth maintenance:** `day1/requirements-status.md` possiede lo stato dei
requisiti DAY-1,
critical-path.md#ordine-corrente l'ordine.
