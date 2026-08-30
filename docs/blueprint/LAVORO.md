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

Chiuso da #260/#261: il log dice la **causa** (`cause.code`, mai `.message` —
l'URL porta il token) e `doctor` guarda la **superficie**, non il processo.
Resta la regola: `gateway.err` registra solo i fallimenti e non li data, quindi
dice *quanti*, mai *per quanto*. **Non dedurne una durata** — il 30/08 l'ho
fatto e ho sbagliato di 19 ore.

## Le decisioni dell'owner

**Instradamento: deciso** — `routing.only: ["alibaba"]`, `dataCollection:
"deny"`. Aperte: **`muffin rot harden`** (serve `sudo`; finché non è fatto
`sys.shell` chiede *sempre* conferma) e **C8, note vocali** (se la tua voce
esce di casa). Manca la **chiave Tavily**.

`integrazione/tre-slice` (note vocali/whisper) è spinta su origin come
checkpoint: non è una PR, non è morta.

`slice/procedure-al-momento-giusto` (3e94e8a) è spinta su origin **senza PR**:
`@AGENTS.md` in `CLAUDE.md`, `.claude/loop.md` ridotto a manutenzione, le tre
skill `riprendi`/`giudice`/`sfida`, tre rules path-scoped e
`.claude/procedure.test.ts` che le copre (5 test) — è il test che autorizza
`strumenti.yml` a includere quei `paths`. Locale al 30/08: `tsc --noEmit`
pulito, `vitest run .claude` 7 file/68 test verdi. Aprire la PR è un lavoro,
non manutenzione: la sceglie `/riprendi`.

## Parcheggiato: come arriva una richiesta che non si fa adesso

`docs/blueprint/research/richieste-differite-2026-08-30.md` — misure, non una
forma, perché il tema tocca insieme work/todo, memoria, esposizione dei tool e
person model.

In breve: **`jobs` non ha un tool** (solo `muffin jobs add`); `wait` chiamato 1
volta, `todo` 2, i 7 todo fermi dal 27/08 e invisibili fuori dalla sessione; 44
fatti attivi su 83 sono `asked_to`/`asks_to`. Il tetto dei tool **non** è più il
problema (`0d519cb`): non ripartire da lì.

## STEP 0 — knowledge architecture

Piano owner del 30/08: `docs/blueprint/` si dissolve in path che dichiarano il
ruolo epistemico. Nove slice.

**Decisione owner da far entrare, non ancora entrata.** La direttiva del 15/08
«si ripara alla radice» è stata tolta da `ORCHESTRATION.md` il 19/08 senza
riospitarla. Casa decisa: `PRACTICES.md` — dopo la migrazione
`docs/engineering/PRACTICES.md` — e vi entra **quando una slice tocca quel
file**, non da sola. Semantica da preservare: *repair at the lowest semantic
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

**Altro:** community è solo una forma di stringa; `pricing.ts` sottostima 5
famiglie su 8; socket v2; il `try` di `recall.ts` avvolge anche la lettura della
provenienza, quindi un guasto dello store si traveste da causa di rete.

**Truth maintenance:** M5-BIS possiede status Gate, PERCORSO-CRITICO.md#ordine-corrente l'ordine.
`STATE.md` è cronologia, non stato corrente.
