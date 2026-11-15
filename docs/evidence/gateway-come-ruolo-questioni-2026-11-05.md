# ADR-0106 — sette questioni chiuse per ricerca il 2026-11-05

**Data:** 2026-11-05 (ora di Roma). Note di ricerca, non la decisione.
L'autorità è ADR-0106, adottata dall'owner il 2026-11-14. Questo file resta
com'era il giorno in cui le sette questioni sono state chiuse: il GO ha
confermato sei di queste righe e ha **rovesciato** una riga che stava nella
bozza e non in queste sette (al risveglio si esce). Quella riga è in fondo,
marcata, e non è stata riscritta come se la ricerca l'avesse già scartata.

Fonti rilette quel giorno: Muffin `dev` @ `4ab49f2a`; Hermes `90c19e31`;
OpenClaw `9938e65a`; <https://code.claude.com/docs/en/headless>; talk Factory
`XIHZpZtYCzo`. Il dettaglio dei peer è in
`gateway-come-ruolo-peer-2026-11-05.md`.

## 1. Cessione: quanto si aspetta, e il turno in volo

**Chiusa così.** Il turno in volo non diventa `continuable`. Si aspetta
`H = 60 s` a tentativo, poll ogni 250 ms, `STATUS=` aggiornato, poi exit 75 e
il supervisore riprova. Lo stato di cessione sta nell'effimero: dopo la
richiesta non accetta clienti nuovi. Il tempo giù è al più i turni già in
volo più circa 65 s.

**I cinque minuti non reggono.** La unit è `Type=notify` e non imposta
`TimeoutStartSec` (default 90 s). `READY=1` parte dopo il claim. Un'attesa
più lunga farebbe arrivare SIGTERM, uscita 143, e 143 è in
`RestartPreventExitStatus`: lo stop volontario e il timeout d'avvio si
confonderebbero, e la unit resterebbe giù. OpenClaw aspetta cinque minuti e
poi fallisce senza rubare; la forma si prende, la durata no, perché il loro
avvio non manda `READY` dopo il lock.

**Contro il passaggio come continuable.** ADR-0086: `continuable` ha una
tassonomia chiusa e la lane non lo preleva da sola. ADR-0100: le attività
lunghe le copre il ciclo 75 → riprova. `claude -p` su SIGTERM non passa il
turno a nessuno.

**Si rovescia se** le cessioni con più di tre tentativi diventano la norma,
o se un 143 di `TimeoutStartSec` lascia la unit giù. Allora una classe nuova
in ADR-0086, non un `H` più lungo.

## 2. REPL senza persistente

**Chiusa così.** Il REPL rifiuta, come ADR-0103. Non è effimero e non è
cliente di un effimero. Il rimedio nomina il supervisore. L'effimero resta
vivo per le esecuzioni, non per le connessioni: è la correzione a una bozza
che faceva attaccare il REPL all'effimero.

**Perché.** OpenClaw `tui --local` tiene l'owner per tutta la TUI. Hermes,
se manca il gateway, ne avvia uno che accende adapter e cron. La direttiva
del 2026-11-04 (processo vivo, Telegram) sarebbe falsa per tutta la finestra
del REPL.

**Si rovescia se** serve un REPL e né il gateway in foreground né
`muffin run --session` bastano. Allora un flag esplicito, mai il default.

## 3. Uscita dell'effimero

**Chiusa così.** Esce subito dopo il drenaggio del lavoro del turno, senza
linger. `identify` risponde `draining`. Il cliente in corsa ri-risolve e può
diventare lui l'effimero.

**Perché.** `claude -p` esce a fine turno e aspetta solo il background che
ha avviato. OpenClaw ritira il `--local` dopo la risposta. Il linger di
Hermes esiste per un daemon staccato; da loro la corsa la chiude `draining`,
e quello sì si prende.

**Si rovescia se** l'avvio dell'effimero supera circa il 30% del tempo di
parete mediano dei run brevi. Allora `--keep-alive` esplicito, mai default.
La cache di prefisso misurata nell'audit del 2026-11-04 (migliaia di token
ancora in cache a un'ora di distanza, fra due processi) non dipende dal
tenere il processo.

## 4. Sessione

**Chiusa così.** Una sessione nuova per run. `--session` si documenta, con
la catena `id` dal JSON. Il default isola gli script. `claude -p` e Hermes
fanno lo stesso; OpenClaw chiede un selettore esplicito, e anche lì niente è
implicito.

L'audit del 2026-11-04: `session_id` è l'hash della sessione, quindi una
sessione nuova non dà stickiness sui router che ruotano. Non è stato
rimisurato il 2026-11-14.

**Si rovescia se** la maggioranza dei run degli script dell'owner passa lo
stesso `--session`. Allora il default si rivede con un ADR breve.

## 5. Job e impegni nell'effimero

**Chiusa così.** Non li esegue. Restano dovuti, senza run e senza slot, finché
non sale un persistente. `doctor` deve dirlo.

**Perché.** Hermes non fa partire i job headless col gateway giù e non sposta
l'istante. OpenClaw richiede il gateway per l'automazione. ADR-0103: senza
scheduler, retention e corsia impegni ritardano e il gateway le recupera.
Due ticker sono un job doppio (ADR-0022, Hermes #25517).

**Si rovescia se** un processo `mode=ephemeral` scrive una riga in
`job_fires` o chiama `getUpdates`.

## 6. Container

**Chiusa così.** tini, restart policy di Docker, supervisore `external`.
Niente s6. L'immagine ha già tini come pid 1: lo snippet non aggiunge
`init: true` per l'immagine ufficiale. `-s` (subreaper) se qualcuno lo
aggiunge da fuori. La healthcheck usa `muffin gateway status` ed esce 0 solo
per un owner persistente. Il 78, che Docker riavvierebbe, sul percorso lungo
diventa `sleep infinity`, come `gateway.stopped`.

**Perché.** OpenClaw usa tini `-s` e `init: true`. Hermes usa s6 perché
supervisiona più processi. `docs/evidence/muffin-in-container-2026-09-26.md`:
con `node` come pid 1 gli orfani restano zombie.

**Si rovescia se** serve un secondo processo nello stesso container. Allora
s6 torna in discussione.

Il 2026-11-05 questa questione non diceva come un supervisore senza
`WatchdogSec` vede un processo vivo ma fermo. Quella parte è del GO e sta in
ADR-0106 (uscita 2, si uccide solo quella). Non è un fatto osservato il
2026-11-05.

## 7. Forma del documento

**Chiusa così.** Un ADR nuovo, non un'appendice silenziosa. Nello stato:
amenda ADR-0103, ADR-0081, ADR-0035. Nella stessa PR, un rimando in coda a
ciascuno, senza riscrivere la decisione originale. Precedenti di rimando:
ADR-0001, ADR-0030, ADR-0032, ADR-0086. Precedenti di ADR nuovo che ne
emenda altri: ADR-0100, ADR-0103, ADR-0105.

Il 2026-11-05 `prossimo-numero.mjs` restituiva `0106`. Il 2026-11-14
restituisce `0108` perché `0107-un-identita-sigillata-nel-prompt.md` è già
sul ramo `cursor/prompt-prefix-shrink-e258` (PR #951) e non è ancora su
`dev`. 0106 non compare su nessun ramo: non è un numero ritirato. Il GO lo
tiene. Se un ramo remoto prendesse 0106 prima del merge, `adr.test.ts` al
merge sarebbe rosso e il numero andrebbe rinumerato.

## Riga rovesciata dal GO, non da queste sette

La bozza del 2026-11-05, nella tabella dei passaggi di stato, faceva uscire
il processo quando al risveglio `refresh` fallisce e nessun altro tiene la
riga, con `exit_reason` «scaduto». Era la frase già scritta nell'Emendamento
№3 di ADR-0035, scelta allora come direzione sicura rispetto a P21.

**GO del 2026-11-14:** non si esce. Si ri-acquisisce nello stesso processo
con un token nuovo, stile etcd/Chubby. Il token vecchio non si rinfresca.
ADR-0106 è quella frase. Questo file non la fa passare per una conclusione
del 2026-11-05.
