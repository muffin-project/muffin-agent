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
fatto `sys.shell` chiede *sempre* conferma) e la **chiave Tavily**. C8 note
vocali: meccanismo su `dev`, macchina pronta, `doctor` verde.

## Il 03/09: il dogfood ha bocciato le superfici

Memo `docs/evidence/dogfood-superfici-2026-09-03.md` — **non ripensare quello
che c'è scritto.** B11/B13 tornano BLOCKER: il finto provider e il finto Bot
API provavano il meccanismo, non la forma. Le decisioni sono nel memo e
implementate: bolla per segmento su Telegram, scroll region in fondo sulla CLI,
ADR-0054 (coda a turno vivo, `/steer` `/stop` `/pause` `/resume`), corsia e2e
reale accanto al finto, e ADR-0055 — risposta ed episodio sono
`surface.reply`/`memory.write` dichiarate dal kernel, permessi invariati, ora
osservabili e stringibili.

**Stato:** 2a→2d e il punto 3 sono su `dev` e su `main`; due giudici hanno
chiuso ADR-0054, uno ADR-0055. **Il prossimo passo è dell'owner:**
`npm run e2e:telegram` con un bot di prova (`evals/e2e/README.md`) — B11/B13/B2
restano BLOCKER finché quella corsa non è verde e datata nelle righe.

**Librerie** (`npm outdated` 03/09): TS 7, vitest 4, better-sqlite3 13,
`@grammyjs/types` 5 — una major per PR, con l'accettazione Linux.
`string-width` è l'unica piccola che chiude un difetto (larghezza CJK).

## ADR-0053 chiuso, colonne aperte

Il soffitto viene dalla riga di effetto; `effect-rows.test.ts` asserisce ogni
cella. Resta se il taint **ambientale** sia il segnale giusto (`SECURITY.md`
§13): eval comparativo, adapter B + corpus avversariale in `evals/security/`.

## Bivio owner n. 2: un tool `jobs` per il modello

Un job creato da un turno tainted è un'iniezione differita: serve una forma
prima di costruirlo. Non DAY-1.

**Azioni owner senza codice:** chiave Tavily + `rot/egress.json` ·
`muffin rot harden` · togliere `discord` da `surfaces.enabled` finché flappa ·
`muffin update` (main è avanti).

## Aperto, non bloccante

**Prossimo grosso:** dichiarare i **permessi** nel prompt (Codex
`<permission_profile>`, OpenClaw `## Authorized Senders`).

**Harness:** il finto Bot API non serve `getFile` (B10, C8 senza scenario).
Accettazione ~5 min, tetto 10.

**Code dei giudici (03/09), non bloccanti:** un `/steer` in coda si perde se il
turno finisce `suspended` (la ripesca sta in `finish`, non in `suspendHere`), e
la conferma promette il contrario; un `sessions.append` fallito lì è silenzioso;
`gestiti` nel connettore Telegram non si svuota mai; l'esaustività della porta
della risposta la garantisce solo il type checker.

**Altro:** `gateway.err` non data le righe; `pricing.ts` sottostima 5
famiglie su 8; il `try` di `recall.ts` avvolge anche la provenienza.

**Truth maintenance:** `day1/requirements-status.md` possiede lo stato,
critical-path.md#ordine-corrente l'ordine.
