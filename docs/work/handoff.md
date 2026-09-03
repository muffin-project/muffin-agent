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
"deny"`. Finché `rot harden` non è fatto, `sys.shell` chiede *sempre* conferma.

## Il 03/09: il dogfood ha bocciato le superfici

Memo `dogfood-superfici-2026-09-03.md` — **non ripensarlo**: implementato e
promosso. **Il prossimo passo è dell'owner:** `npm run e2e:telegram` con un bot di prova
(`evals/e2e/README.md`) — B11/B13/B2 restano BLOCKER finché quella corsa non è
verde e datata nelle righe.

## Il difetto di forma, misurato il 03/09

Guardare il `muffin.db` vivo ha trovato in dieci minuti ciò che una notte di PR
non aveva trovato: **zero documenti e zero media indicizzati da sempre** (il
filtro dei dotfile girava sul percorso assoluto e la home è `~/.muffin`), verde
in ogni test perché una home di test non ha punti. Regola scritta in
`ORCHESTRATION.md`: **un banco di prova finto non chiude una riga che l'owner
vede.** Leggere il database dell'owner viene **prima** di aprire una fetta.

**La divergenza fra superfici è il difetto strutturale aperto.** Su Discord non
esistono streaming, passi, **approvazioni**, consegna durevole, inoltri con
provenienza, note vocali, né coda/`/steer`/`/stop`: ~9300 righe di connettore
Telegram contro ~2700. Causa: il registro ha unificato l'**uscita** e l'ingresso
non ha mai avuto il gemello, quindi ogni funzione inbound ha una sola casa
naturale. ADR-0021 diceva già «il canale non è parte dell'identità» e, due
paragrafi sotto, il contrario: il codice ha seguito la seconda. Ordine deciso:
(1) evento tipizzato + percorso in entrata condiviso + coda/comandi fuori da
Telegram + **test di parità che fallisce se un comportamento vive su una sola
superficie**; (2) approvazioni, streaming e passi sullo stesso percorso.

## Le colonne: si misura, non si decide

Il taint ambientale resta un'ipotesi non falsificata (`SECURITY.md` §13) e
l'eval comparativo è in costruzione. Misura dal vivo: **tutte** le 35
approvazioni mai chieste sono `sys.shell` a taint 2, 32 sì e 3 no — un gate
concesso nove volte su dieci è un riflesso. Nessun soffitto si muove prima
del risultato.

**Azioni owner senza codice:** chiave Tavily + `rot/egress.json` ·
`muffin rot harden` · togliere `discord` da `surfaces.enabled` finché flappa ·
`muffin update` (main è avanti).

## Aperto, non bloccante

**Harness:** il finto Bot API non serve `getFile` (B10, C8 senza scenario);
accettazione ~5 min, tetto 10. Dopo l'ingresso unico: dichiarare i **permessi**
nel prompt (Codex `<permission_profile>`, OpenClaw `## Authorized Senders`).

**Code dei giudici (03/09), non bloccanti:** un `sessions.append` fallito nella
ripesca dello `/steer` è silenzioso; `gestiti` nel connettore Telegram non si
svuota mai; l'esaustività della porta della risposta la garantisce solo il type
checker; un turno **ripreso dalla corsia** non è in `vivi`, quindi uno `/steer`
mandato durante l'attesa risponde «nessun turno in corso».

**Altro:** `gateway.err` non data le righe; `pricing.ts` sottostima 5
famiglie su 8; il `try` di `recall.ts` avvolge anche la provenienza.

**Truth maintenance:** `day1/requirements-status.md` possiede lo stato,
critical-path.md#ordine-corrente l'ordine.
