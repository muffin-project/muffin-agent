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
"deny"`. Aperte: **`muffin rot harden`** (serve `sudo`; finché non è fatto
`sys.shell` chiede *sempre* conferma) e **C8, note vocali**. Manca la **chiave
Tavily**.

`integrazione/tre-slice` (note vocali/whisper) è un checkpoint su origin: non è
una PR, non è morta.

**STEP 0 chiuso.** `docs/{decisions,knowledge,work,evidence,derived,history}/`,
nomi semantici (regola in `docs/README.md`); `blueprint/` e `foundations/` non
esistono più. Una proposta non è evidence: sta in `history/design-notes/`.
`lessons.md` è evidence *rolling* — ruolo e lifecycle sono assi diversi.

**Primo hardening della mappa, F17:** 135 citazioni `file:riga` nella prosa dei
`data-*.json`, 94 a una riga vecchia. Il renderer ha già `ancore()` ma solo sul
campo `rif` (`template.html:338`): usare ciò che c'è, non costruire altro.

Trappole dove sta il meccanismo: `riprendi/SKILL.md`, `architecture-map/ancore.mjs`,
`rules/decisioni.md` (**F7**). `riprendi` ora esce ≠0 se l'inventario DAY-1 non
si legge: «0 su 0» era il path morto, non i bloccanti (lesson del 2/09).

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

**Altro:** `gateway.err` registra solo i fallimenti e non li data: dice
*quanti*, mai *per quanto* — dedurne una durata mi è costato 19 ore di errore. Community è solo una forma di stringa; `pricing.ts` sottostima 5
famiglie su 8; socket v2; il `try` di `recall.ts` avvolge anche la lettura della
provenienza, quindi un guasto dello store si traveste da causa di rete.

**Truth maintenance:** `day1/requirements-status.md` possiede lo stato dei
requisiti DAY-1,
critical-path.md#ordine-corrente l'ordine.
