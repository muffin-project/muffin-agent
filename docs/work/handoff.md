# Handoff operativo

**Regola di stop.** Il prossimo lavoro nasce da un failure osservato usando
Muffin, da una requirement owner, da una migrazione costosa o da un rischio su
authority/data/effect — non da questa lista.

**Goal owner:** DAY-1 = *«io installo Muffin sulla VPS, quindi deve essere
praticamente pronto»*. Il 05/09 l'owner ha aggiunto due pilastri, subito:
ingresso unico (B18) e nucleo modulare (B19).

**Come si trovano le cose.** REPL in **tmux**, tracce, log e il `muffin.db`
vero — mai `cp`: `sqlite3 <db> ".backup <dest>"`. Fermare un processo di
prova si fa **per PID**: `pkill -f "gateway run"` prende anche quello vivo.

**Il gate è una porta sola:** `npm run merge -- <pr>` (`scripts/merge.ts`)
costruisce dev+PR in un worktree e ci fa girare `ci:local`; unisce solo su
PASS. `DISCARDED` = host conteso, si rifà **quando nessun worker gira**: con
load > 10 il rapporto e `strumenti` vanno in timeout. `gh pr merge` a mano è
bloccato dal hook. I minuti GitHub sono finiti (run morti in 4s): non aspettare
i check.

## Le decisioni dell'owner

`routing.only: ["alibaba"]`, `dataCollection: "deny"`; finché `rot harden`
non è fatto `sys.shell` chiede sempre. Kernel (ADR-0071/0072): un link
**citato** negli ingressi del turno non chiede; composto+owner chiede,
composto+non-owner nega; una ricerca non chiede mai. In un gruppo senza il
suo umano Muffin saluta, avvisa l'owner in privato ed esce (F4).

**Azioni owner senza codice:** `npm run e2e:telegram` con un bot di prova
(B11/B13/B2 restano BLOCKER finché quella corsa non è verde) · `muffin rot
harden` (senza, il sigillo dell'owner è riscrivibile: riserva su B15) ·
`muffin memory extract` (14 sorgenti senza vettori) · billing GitHub Actions.

## Il lavoro in corso (05/09)

**Disegno chiuso:** `docs/evidence/ingresso-unico-e-nucleo-2026-09-05.md` —
tre giudici hanno refutato il disegno originale e ogni emendamento è dentro.
Fase A (loop, nove fette, `agent/loop/*`) e Fase B (`connectors/shared/
ingress/*`, router a dieci stadi, test di parità a quattro `describe`: il
quarto prova che il connettore **entra davvero** dal router). Fase C (parità
Discord) non è DAY-1. Le fette girano come PR da worker, una per volta su
`agent/loop.ts`; il gate dopo ognuna.

**PR aperte da unire con la porta, in quest'ordine:** #430 (F1-F5 + stato
DAY-1 + questo handoff; ripara anche la riga E1 che spegneva il rapporto),
#431 (la porta), #432 (B15, giudicato: accetta con riserve, riserva scritta
nella riga), #433 (C8+B16), poi le fette.

## Aperto, non bloccante

Issue #378 tiene l'indice (#371-#377). A11 install pulita, D13 uso dei tool,
F7 capacità per stanza (ADR-0073 proposto) sono BLOCKER senza fetta aperta.
`evals/e2e/telegram.ts:66` legge ancora l'owner da `config.json`.

**Truth maintenance:** `day1/requirements-status.md` possiede lo stato,
critical-path.md#ordine-corrente l'ordine, le Issue il lavoro attribuibile.
