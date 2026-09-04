# Handoff operativo

**Regola di stop.** Il prossimo lavoro nasce da un failure osservato usando
Muffin, da una requirement owner, da una migrazione costosa o da un rischio su
authority/data/effect — non da questa lista.

**Goal owner:** un agente *davvero usabile*, rivisto modulo per modulo, e tutto
ciò che manca prima della VPS.

**Come si trovano le cose.** REPL in **tmux**, tracce, log e il `muffin.db`
vero — mai `cp`: `sqlite3 <db> ".backup <dest>"`. **Il gate sono i check di
GitHub**, sulla *condizione*, mai su una stampa. Fermare un processo di prova
si fa **per PID**: `pkill -f "gateway run"` prende anche quello vivo dell'owner.

## Le decisioni dell'owner

**Instradamento: deciso** — `routing.only: ["alibaba"]`, `dataCollection:
"deny"`. Finché `rot harden` non è fatto, `sys.shell` chiede *sempre* conferma.

**Azioni owner senza codice:** `npm run e2e:telegram` con un bot di prova
(`evals/e2e/README.md`) — B11/B13/B2 restano BLOCKER finché quella corsa non è
verde e datata · chiave Tavily + `rot/egress.json` · `muffin rot harden` ·
`muffin update` · `muffin surface default telegram` (senza, i promemoria
scaduti finiscono nel journal di launchd e nessuno li legge).

## Il difetto di forma, misurato il 03/09

Guardare il `muffin.db` vivo ha trovato in dieci minuti ciò che una notte di PR
non aveva trovato: **zero documenti e zero media indicizzati da sempre**, verde
in ogni test perché una home di test non ha punti. **Un banco di prova finto non
chiude una riga che l'owner vede.** Leggere il database dell'owner viene
**prima** di aprire una fetta.

**La divergenza fra superfici è il difetto strutturale aperto.** Su Discord non
esistono streaming, passi, **approvazioni**, consegna durevole, inoltri con
provenienza, note vocali, né coda/`/steer`/`/stop`: ~9300 righe di connettore
Telegram contro ~2700. Causa: il registro ha unificato l'**uscita** e l'ingresso
non ha mai avuto il gemello. Ordine deciso: (1) evento tipizzato + percorso in
entrata condiviso + coda/comandi fuori da Telegram + **test di parità che
fallisce se un comportamento vive su una sola superficie**; (2) approvazioni,
streaming e passi sullo stesso percorso.

## Le colonne: si misura, non si decide

Il taint ambientale resta un'ipotesi non falsificata (`SECURITY.md` §13). Misura
dal vivo: **tutte** le 35 approvazioni mai chieste sono `sys.shell` a taint 2,
32 sì e 3 no — un gate concesso nove volte su dieci è un riflesso. Nessun
soffitto si muove prima del risultato del corpus (oggi 4/7).

## Aperto, non bloccante

Migrato su GitHub Issue (#378 tiene l'indice): #371 SendLock mancante sulla
corsia impegni, #372 superficie post-boot non registrata, #373 anno assente nel
messaggio in ritardo, #374 rotaia del taint limitata alla finestra di
reiniezione, #375 `sessions.append` silenzioso in `/steer`, #377 `pricing.ts`
sottostima 5/8 famiglie. B10/C8 (finto Bot API senza `getFile`) restano su #361.

**Truth maintenance:** `day1/requirements-status.md` possiede lo stato,
critical-path.md#ordine-corrente l'ordine, le Issue linkate sopra il lavoro
aperto attribuibile.
