# Handoff operativo

**Regola di stop.** Il prossimo lavoro nasce da un failure osservato usando
Muffin, da una requirement owner, da una migrazione costosa o da un rischio su
authority/data/effect. Non da questa lista.

**Goal owner:** un agente *davvero usabile*, rivisto modulo per modulo, e tutto
ciò che manca prima della VPS.

**Come si trovano le cose.** Pilotando il REPL in **tmux**, o misurando su
tracce, log e il `muffin.db` vero — mai con `cp` dei suoi tre file, che dà una
vista vecchia senza errore: `sqlite3 <db> ".backup <dest>"`.

**Il gate.** `npm run gate:local`: clone di HEAD **fuori** dal repository, `npm
ci`, typecheck, build, suite, accettazione, `gate-linux.sh` in Docker. Il verde
si scrive `LOCAL-GATE PASS @ <sha>`, **mai** «CI verde». Dall'1/09 la CI di
GitHub **esegue di nuovo** (prima moriva in 2s per fatturazione) ed è rossa su
16 test in `cli/update.test.ts`, `cli/main.test.ts`, `core/net/causa.test.ts`,
identici su `dev` nudo: firme Linux che `gate-linux.sh` non vede. **F11**.

## Le decisioni dell'owner

**Instradamento: deciso** — `routing.only: ["alibaba"]`, `dataCollection:
"deny"`. Aperte: **`muffin rot harden`** (serve `sudo`; finché non è fatto
`sys.shell` chiede *sempre* conferma) e **C8, note vocali** (se la tua voce
esce di casa). Manca la **chiave Tavily**.

`integrazione/tre-slice` (note vocali/whisper) è un checkpoint su origin: non è
una PR, non è morta.

Slice 3-6 integrate: `docs/{history,decisions,knowledge,work}/`, nomi semantici
(regola in `docs/README.md`), niente più `M5-BIS`/`Gate 1` nel vivo.
`blueprint/STATE.md` e `foundations/VISION.md` sono **lapidi**. Prossima: slice
7, `research/`→`evidence/`, `mappa/`→`generated/map/`.

Tre trappole scritte dove sta il meccanismo: `riprendi/SKILL.md`,
`mappa/ancore.mjs`, `rules/decisioni.md`. **F7**: la logica in prosa dentro una
rule si rompe senza che nessun test se ne accorga.

## Parcheggiato: le richieste differite

`docs/blueprint/research/richieste-differite-2026-08-30.md` — misure, non una
forma: **`jobs` non ha un tool**, i 7 todo fermi dal 27/08 e invisibili fuori
dalla sessione, 44 fatti attivi su 83 `asked_to`/`asks_to`. Il tetto dei tool
**non** è più il problema (`0d519cb`).

## F5 — decisione owner non ancora entrata

La direttiva del 15/08 «si ripara alla radice» è stata tolta da
`ORCHESTRATION.md` il 19/08 senza riospitarla. Casa decisa: `PRACTICES.md`.
**Entra con una micro-slice semantica sua**: non entra automaticamente in una
futura migrazione di `PRACTICES.md`, e una slice che sposta quel file non la
porta con sé. Semantica da preservare: *repair at the lowest semantic
layer that eliminates the class of failure, not at the widest layer you can
plausibly redesign*. Scala `riga → funzione → contratto di modulo → tipo/schema
→ confine architetturale`; si sale **solo** se una riparazione più locale
lascerebbe la stessa classe di stato invalido rappresentabile o destinata a
ripetersi. Non giustifica refactor laterali. Originale:
`git show 451cd916:docs/ORCHESTRATION.md`.

## Aperto, non bloccante

**Prossimo grosso:** dichiarare i **permessi** nel prompt. Oggi il kernel
rifiuta alla chiamata e il modello impara per rifiuto — incluso il tetto di
taint. Codex rende `<permission_profile>`, OpenClaw `## Authorized Senders`.

**Altro:** `gateway.err` registra solo i fallimenti e non li data: dice
*quanti*, mai *per quanto* — dedurne una durata mi è costato 19 ore di errore. Community è solo una forma di stringa; `pricing.ts` sottostima 5
famiglie su 8; socket v2; il `try` di `recall.ts` avvolge anche la lettura della
provenienza, quindi un guasto dello store si traveste da causa di rete.

**Truth maintenance:** `day1/requirements-status.md` possiede lo stato dei
requisiti DAY-1,
critical-path.md#ordine-corrente l'ordine.
