# Handoff operativo

**Regola di stop.** Il prossimo lavoro nasce da un failure osservato usando
Muffin, da una requirement owner, da una migrazione costosa o da un rischio su
authority/data/effect — non da questa lista.

**Goal owner:** DAY-1 = *«io installo Muffin sulla VPS, quindi deve essere
praticamente pronto»*. Al 06/09: 58 righe READY su 60 in scope; aperte D13
(uso dei tool) e F7 (capacità per stanza, ADR-0073 riscritta, aspetta il sì).

**Come si trovano le cose.** REPL in **tmux**, tracce, log e il `muffin.db`
vero — mai `cp`: `sqlite3 <db> ".backup <dest>"`. Fermare un processo di
prova si fa **per PID**: `pkill -f "gateway run"` prende anche quello vivo.

**Il gate è una porta sola:** `npm run merge -- <pr>` costruisce dev+PR in un
worktree e ci fa girare `ci:local` (cinque job nei container: verifica,
accettazione, collegamenti, strumenti, **install**); unisce solo su PASS.
Una PR alla volta, ~12-15 minuti, **con nessun worker che gira**: un vitest
estraneo o load > 10 all'inizio danno `DISCARDED`, da rifare. `gh pr merge`
a mano è bloccato dal hook. I minuti GitHub sono finiti (run morti in 4 s).

## Le decisioni dell'owner

`routing.only: ["alibaba"]`, `dataCollection: "deny"`; ADR-0074 (06/09, «si chiede solo
l'irreversibile, sempre, anche in privato»). Kernel (ADR-0071/0072): un link
citato non chiede, composto+non-owner nega, una ricerca non chiede mai.
Gruppi: senza il suo umano Muffin saluta, avvisa e esce (F4). Nucleo e
ingresso (05-06/09): `agent/loop.ts` è un barile di 54 righe su nove moduli;
il percorso in entrata vive una volta in `connectors/shared/ingress/`
(router a dieci stadi), Telegram e Discord sono porte, e
`parita.test.ts` diventa rosso se una porta salta il router.

**Azioni owner senza codice:** billing GitHub Actions · `npm run e2e:telegram`
con un bot vero (B11/B13/B2 datati) · la prima install vera su una VPS x86_64
(A11 è provata solo nel container arm64). `rot harden` è fatto (06/09, rot di
uid 0); ADR-0073 ha avuto il sì e ADR-0074 lo estende a ogni stanza.

## Aperto

**D13** resta BLOCKER con i numeri (`tool-use-2026-09-06.md`): dopo le
descrizioni riscritte 4 probe su 22 chiedono ancora la shell — servono un
approvatore finto nell'eval, due tool mancanti (porte aperte, SQLite in
lettura), tre giri di misura. **F7**: ADR-0073 riscritta il 06/09 dopo la
ricerca `harness-non-permessi-2026-09-06.md`; l'implementazione parte dopo il
sì. **Fase C** (fette 17-21 di `ingresso-unico-e-nucleo-2026-09-05.md`:
comandi e coda, approvazioni, transcript, consegna, provenienza su Discord)
non è DAY-1. `evals/e2e/telegram.ts:66` legge ancora l'owner da
`config.json`. Issue #378 tiene l'indice (#371-#377).

**Da Centria (`centrialabs/centria`, `origin/stage`, letto il 06/09).** DAY-1:
**D15** registro degli effetti (più autonomia ⇒ più sorveglianza). Il tetto di
spesa c'è già (E1/E2): resta solo la prenotazione fra turni concorrenti e
`pricing.ts`. Scartato: percorso riservato meccanico nella porta di merge.
Dopo la VPS: revoca dallo stesso porto di comando con test di parità
(T-028), giudice LLM come sensore versionato con calibrazione e holdout
(PRODUCTION-EVALS), verifica meccanica delle affermazioni negli ADR
(`verifica-claim.py`); auto-merge (T-027) quando saremo open source.

**Truth maintenance:** `day1/requirements-status.md` possiede lo stato,
critical-path.md#ordine-corrente l'ordine, le Issue il lavoro attribuibile.
