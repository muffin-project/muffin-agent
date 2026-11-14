# Il gateway come ruolo — cosa fanno i peer

**Data:** 2026-11-05 (ora di Roma). **Domanda:** un `muffin run` senza gateway
persistente può essere l'owner della Home, sullo stesso claim, senza un
secondo runtime e senza un daemon staccato?

**Osservato allora:** Muffin `dev` @ `4ab49f2a`. Hermes `90c19e31`. OpenClaw
`9938e65a`. Claude Code, docs headless rilette il 2026-11-05
(<https://code.claude.com/docs/en/headless>). Talk Factory, video `XIHZpZtYCzo`.
Audit token del 2026-11-04, citato dalle note di quella ricerca (non
rimisurato qui).

**Riletto il 2026-11-14** su Muffin `dev` @ `7064bec1` (merge #948, dopo #940)
solo per non citare un `dev` morto. Le osservazioni sui peer restano quelle
del 2026-11-05: non sono state riaperte sul sorgente. La decisione sta in
ADR-0106, non in questo file. Il GO del 2026-11-14 ha rovesciato la riga
«al risveglio si esce», che non era un fatto di peer: vedi
`gateway-come-ruolo-questioni-2026-11-05.md`.

Niente di questo file è autorità corrente.

## Muffin, al 2026-11-05 e ancora su `7064bec1`

- Senza gateway, `muffin run` e il REPL non eseguono in locale (ADR-0103).
  Il Falsificatore di quell'ADR chiede una decisione nuova per girare senza
  supervisore.
- Un solo owner quando il gateway è vivo (ADR-0081). Due terminali senza
  gateway erano fuori scope.
- `gateway_lock`: `holder_id` (ADR-0035, Emendamento №3) e incarnazione
  (ADR-0094). `refresh` fallisce quando `heldBy` giudica la riga scaduta,
  anche se pid e token coincidono. Il chiamante in `Gateway.tick` logga un
  furto e drena.
- Il 2026-11-04, ~19:26 ora di Roma: gateway lanciato a mano, sospensione
  dell'host, log «presa da un altro processo», riga in attesa con pid null,
  uscita 0, nessun riavvio. Nessun contenuto di conversazione in questa nota.
- Unit `Type=notify` senza `TimeoutStartSec` (default systemd 90 s). `READY=1`
  dopo il claim. 143 in `RestartPreventExitStatus`. `RestartSec=5`.
- Battito 30 s. Orizzonte ordinario 5 min, duro 6×. Watchdog 60 s, ed è ciò
  che vede un processo su ma fermo sotto systemd. launchd non ha watchdog.
- Immagine: tini è il pid 1, `MUFFIN_CONTAINER=1`, `restart: unless-stopped`,
  `stop_grace_period: 75s`. Nessuna healthcheck sul servizio gateway.
  `gateway.stopped` → `sleep infinity`. Il 78 sul percorso lungo no.
- Sessione di `muffin run`: `run-<data>-<hex>` se manca `--session`. L'id è
  già nel JSON (`session`) e nel piè di pagina. La usage non lo diceva.
- #948: la «deferred turn handoff» è lo scheduler che cede il token del modello
  alla turn lane. Non è un verbo del socket.
- #940: `ForwardHost.query` non riporta il testo di un checkpoint.
- #910, aperta: attach sullo stesso id. Il ramo non ha il confine di #940.

## OpenClaw @ `9938e65a`

- Il run locale prende lo stesso lock del gateway. Il gateway in avvio aspetta
  fino a cinque minuti che un altro processo rilasci, ogni 250 ms, poi
  `GatewayLockError`. Non ruba e non recinta (`docs/gateway/gateway-lock.md`,
  sezione Three layers, come citata il 2026-11-05).
- `tui` senza gateway si ferma e rimanda a `chat`. `chat` è `tui --local` e
  tiene l'owner per tutta la vita della TUI. È il caso da non copiare per il
  REPL.
- `--local` è one-shot: dopo la risposta non lascia socket né figli
  (`docs/cli/agent.md`, come citata).
- I comandi di automazione vogliono un gateway acceso (`docs/cli/cron.md`).
- Container: `init: true`, `restart: unless-stopped`, healthcheck, entrypoint
  `tini -s`. `OPENCLAW_SUPERVISOR_MODE=external` esiste. Il loro avvio non è
  legato a un `READY` prima del lock: i cinque minuti non si copiano.

## Hermes @ `90c19e31`

- Il one-shot passa dal gateway. Se manca, ne avvia uno staccato con idle-exit
  (600 s in `run_idle_exit.py`, `DEFAULT_IDLE_EXIT_SECONDS`): un daemon di
  circa 270 MB restava indietro a ogni home usa-e-getta. Pubblicano `draining`
  e il client che arriva in corsa aspetta e ne avvia uno nuovo.
- Quel gateway acceso dal CLI accende adapter e cron e non esce finché sono
  occupati. Sarebbe, da noi, un persistente non scelto.
- `session.create` a ogni avvio. Si continua con un flag esplicito.
- I job headless non partono col gateway giù: niente run registrata, l'istante
  dovuto non si muove (`cron/scheduler_gateway_gate.py`). Due ticker sono il
  bug #25517, già nel corollario di ADR-0022.
- s6-overlay perché nel container ci sono più processi (gateway, dashboard,
  profili). Prima usavano tini. ADR-0105 fa degli account dei profili di una
  Home, non dei gateway multipli. Muffin ha un processo per container.

## Claude Code, docs headless del 2026-11-05

- `claude -p` non esclude un secondo processo: non ha il nostro job né le
  nostre superfici. Ogni chiamata è una sessione nuova; si continua con
  `--continue` / `--resume`, e l'id si legge dal JSON.
- Su SIGTERM il turno resta incompiuto e non viene passato a nessuno.
- All'uscita aspetta il lavoro in background che lui ha avviato, con un tetto,
  non un linger da daemon.

## Talk Factory, `XIHZpZtYCzo`

Come citato nelle note del 2026-11-05: CLI, Slack e web sono client di un
daemon; le eval stanno su un ambiente di simulazione, non sulla produzione.
Non è stato riaperto il 2026-11-14. Non decide il lock: dice solo che il
one-shot e le superfici non sono due runtime.

## Cosa si prende e cosa no

Si prende: lo stesso lock per l'embedded e per il gateway (OpenClaw); l'attesa
a poll senza furto, con durata nostra; `draining` e la ri-risoluzione del
client (Hermes), senza i 600 s e senza il daemon; sessione nuova e `--session`
esplicito (`claude -p`, Hermes); job che non partono nell'effimero (Hermes,
OpenClaw, ADR-0103); tini e la restart policy, non s6.

Non si prende: cinque minuti di attesa; il REPL che tiene il lock; l'auto-spawn;
l'assenza di esclusione; il rifiuto del secondo run come stato finale.

## Cosa rovescerebbe il confronto

Un peer che esegue job e superfici dentro il one-shot senza un lock condiviso,
e non paga job doppi né 409, renderebbe l'invariante «un owner» un'ipotesi
nostra e non un fatto della categoria. Non è quello che le fonti del 2026-11-05
mostrano.
