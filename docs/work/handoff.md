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
API provavano il meccanismo, non la forma. Decisioni: **Telegram** una bolla
per segmento (nuovo messaggio solo quando il modello riparla dopo dei tool;
passi appesi e mai cancellati; mai testo tagliato; ASK intero; `description`
su `shell_run`). **CLI** scroll region DECSTBM, casella e stato in fondo, mai
in cima (costa lo scrollback). **ADR-0054**: messaggio a turno vivo → coda con
conferma; `/steer` al confine di giro; `/stop`; `/pause`/`/resume`; il poller
riceve sempre. **Test end-to-end veri**: corsia reale in locale con modello e
Bot API veri (chiave mai stampata), accanto al finto. Ordine:
critical-path.md#ordine-corrente punto 2 (a→d).

**Stato delle slice:** 2a Telegram (#298) e 2b CLI (#299) su `dev`; 2c+2d in
PR #300 (CRITICAL: **serve il giudice** prima del merge). **Il prossimo passo
è dell'owner:** `npm run e2e:telegram` con un bot di prova
(`evals/e2e/README.md`) — B11/B13/B2 restano BLOCKER finché quella corsa non è
verde e datata nelle righe. Poi `dev → main` e `muffin update`.

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
mergiare #296 (`dev → main`, check verdi) e `muffin update`.

## Aperto, non bloccante

**Prossimo grosso:** dichiarare i **permessi** nel prompt (Codex
`<permission_profile>`, OpenClaw `## Authorized Senders`).

**Harness:** il finto Bot API non serve `getFile` (B10, C8 senza scenario).
Accettazione ~5 min, tetto 10.

**Altro:** `gateway.err` non data le righe; `pricing.ts` sottostima 5
famiglie su 8; il `try` di `recall.ts` avvolge anche la provenienza.

**Truth maintenance:** `day1/requirements-status.md` possiede lo stato,
critical-path.md#ordine-corrente l'ordine.
