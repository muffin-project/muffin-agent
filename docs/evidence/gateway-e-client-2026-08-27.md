# Il gateway e i suoi client — dove sono andati i peer

**Data:** 2026-08-27 · **Domanda dell'owner:** «`muffin` apre un REPL interattivo
che si collega al gateway?» e «il gateway dovrebbe esistere sempre come concetto
no?»

**Risposta corta:** oggi no, il REPL non si collega a niente — si costruisce un
runtime tutto suo e legge una riga di lock nello stesso SQLite. E sì, il gateway
deve esistere sempre come concetto: è la conclusione a cui sono arrivati i peer
che stanno nella nostra stessa categoria, e uno di loro ha già fatto la
migrazione che ci serve e ha scritto il perché.

---

## 0. Qualità delle prove, prima di tutto

Le affermazioni qui sotto vengono da **listing di directory** via
`gh api repos/<r>/contents/<path>`, che sono positivi e autoritativi, e da
**citazioni dirette** di file e doc con la data di fetch.

**La ricerca codice di GitHub non è affidabile su questi repo e non va usata per
concludere che qualcosa non esiste.** Misurato oggi:
`gh api -X GET search/code -f q='repo:block/goose AgentManager'` risponde
`total_count: 0`, ma `AgentManager` era stato verificato *da codice* in
`b1-runtime-processo.md` il 2026-08-04 e il crate lo usa ancora per quanto ne
sappiamo. Tre query diverse sullo stesso repo hanno risposto tutte `0`: è
l'indice, non il codice. **Un `total_count: 0` qui non è una prova di assenza.**

## 1. I peer si sono divisi in due categorie, e non è la divisione che ci aspettavamo

### Le CLI di coding convergono su un protocollo, non su un daemon

**ACP — Agent Client Protocol** ([agentclientprotocol.com](https://agentclientprotocol.com/overview/introduction),
fetch 2026-08-27). Standardizza la comunicazione fra editor/IDE e agenti, come
LSP fece per i linguaggi. La forma locale è esplicita: *«Local agents run as
sub-processes of the code editor, communicating via JSON-RPC over stdio»*. Il
remoto (HTTP/WebSocket) è dichiarato *«a work in progress»*.

Quindi ACP **non** è un daemon always-on: è l'agente come **processo figlio del
client**. Chi lo implementa fra i peer: Goose (`crates/goose-acp-macros`,
`crates/goose/src/acp/`, `crates/goose/src/bin/generate_acp_schema.rs`) e Hermes
(`acp_adapter/` a livello top).

**Codex** ([github.com/openai/codex](https://github.com/openai/codex), listing di
`codex-rs/` 2026-08-27) ha una famiglia intera di crate dedicati:
`app-server`, `app-server-protocol`, `app-server-client`, `app-server-transport`,
`app-server-test-client`, `app-server-daemon`.

Il daemon però ha uno scopo dichiarato e stretto — dal suo README, citato:

> `codex-app-server-daemon` backs the machine-readable `codex app-server`
> lifecycle commands used by remote clients such as the desktop and mobile apps.
> It is intended for Codex instances launched over SSH, including fresh developer
> machines that should expose app-server with `remote_control` enabled.

E il meccanismo è la nostra stessa famiglia: *«pidfile-backed daemonization plus
Unix process and file-locking primitives»*, Unix-only, socket. Marcato
`experimental` nel README stesso. **Non è il percorso locale**: `codex` in un
terminale non ha bisogno di quel daemon.

### I sistemi di agente personale tengono il gateway, sempre

**Hermes** ([github.com/nousresearch/hermes-agent](https://github.com/nousresearch/hermes-agent),
listing 2026-08-27) ha `gateway/` come directory di **primo livello** — accanto a
`agent/`, `cron/`, `hermes_cli/`, `apps/`, `providers/`, `skills/`. Dentro:
`delivery.py`, `delivery_ledger.py`, `channel_directory.py`, `drain_control.py`,
`authz_mixin.py`, `control_socket.py`, `agent_cache_pressure.py`,
`cgroup_cleanup.py`.

E `hermes_cli/` contiene `active_sessions.py`, `approval_mode.py`,
**`approval_transport.py`**, `auth.py`. Cioè: la CLI è un **client**, e «come
faccio arrivare una richiesta di approvazione dal daemon all'umano che in questo
momento è attaccato» è un problema che hanno dovuto nominare e risolvere. È
esattamente il nostro `runtime.deps.approve`, che oggi funziona solo perché il
REPL esegue i turni da sé.

**Letta** resta server-first, ma la doc pubblica consultata oggi è più sfumata di
quanto ricordassimo — parla di SDK che si connette all'hosted service o a un
self-hosted, senza dichiarare esplicitamente se un agente possa girare in-process
in un client. **[NON VERIFICATO]** in questa passata: non l'ho letto dal codice.

## 2. Il ribaltamento: Goose sta diventando un agente personale

`a2-prior-art.md` §Goose dice, dal fetch del 2026-08-04:

> **Goose non è, nella sua forma dominante, un «agente personale che vive nelle
> chat app e parla per primo»** — è un harness di coding/task general-purpose […]
> invocato per sessione come un CLI tool, non un servizio always-on che notifica.

Il listing di oggi dice un'altra cosa. `crates/goose/src/` contiene:

```
acp/  agents/  execution/  gateway/  scheduler.rs  scheduler_trait.rs  session/  skills/  slash_commands/
```

e `crates/goose/src/gateway/` contiene:

```
handler.rs   manager.rs   mod.rs   pairing.rs   telegram.rs
```

**Un gateway, con un connettore Telegram e il pairing.** Cioè la forma di Muffin.
Il progetto che il nostro documento cita come «non un agente personale» ha, alla
data di oggi, il modulo che rende un agente personale.

Nello stesso listing **non c'è un crate `goose-server`**: `crates/` elenca
`goose`, `goose-agent`, `goose-cli`, `goose-mcp`, `goose-providers`, `goose-sdk`,
`goose-acp-macros`, `goose-roaming`, `goose-local-inference` e altri, e nessuno
di questi è il server. Il `goosed` descritto in `a2` e in `b1` **non compare più
come crate**. Quello che non posso dire, con le prove che ho, è che sia stato
*rimosso*: il binario potrebbe essersi spostato dentro un altro crate, e la
ricerca codice che direbbe di no è quella inaffidabile del §0.

**Correzione minima e onesta da portare in `a2-prior-art.md`:** la frase su
`goosed` va datata e affiancata dal listing di oggi, non cancellata.

## 3. Hermes ha già fatto la migrazione che ci serve, e ha scritto perché

Il docstring di `gateway/control_socket.py` (fetch 2026-08-27) descrive il
**nostro difetto di adesso**, prima ancora della loro soluzione:

> Migration step 1 of the #92091 design: every other process on the machine
> (the updater, `hermes serve`/dashboard, the Desktop app) currently discovers
> gateway identity/state by scanning the process table and string-matching argv
> or by reading `gateway_state.json` (which can outlive its writer). This module
> gives the gateway an OWNED contract instead: a local-only socket the gateway
> process creates at startup and removes on clean shutdown, answering versioned
> JSON verbs. **A connectable socket with a well-formed `identify` answer IS
> liveness — no PID-reuse heuristics.**

Noi facciamo la cosa da cui loro sono migrati. `core/gateway/lock.ts`
§`readGateway` legge una riga `gateway_lock` (pid, `taken_at`, status) e chiama
`pidAlive(pid)`: un record che può sopravvivere a chi l'ha scritto, più
euristica sul riuso dei pid. Che è, parola per parola, la frase sopra.

Il loro design, e le quattro decisioni che ci servono:

1. **Unix domain socket** in `$HERMES_HOME/gateway.sock`; named pipe su Windows
   (`\\.\pipe\hermes-gateway-<home-hash>`). **Mai una porta TCP** — *«Filesystem/pipe
   ACLs are the auth boundary»*. Stesso modello di fiducia del file che
   sostituisce, quindi la migrazione non apre una superficie nuova.
2. **v1 è sola osservazione**, e lo dichiara: *«v1 verbs (observation only — no
   behavior change for the gateway)»*. Due verbi: `identify` (pid, profilo, home,
   `code_sha`/`code_version`, tipo di supervisore, start time, versione del
   protocollo) e `status` (il payload di stato runtime, ma risposto dal processo
   stesso, *race-free*). **Nessun verbo che fa qualcosa.**
3. **Una richiesta per connessione**: una riga JSON in, una fuori, poi il server
   chiude. Contratto versionato.
4. Un dettaglio operativo che ci morderebbe: su macOS/BSD `sun_path` sta in ~104
   byte, quindi quando la home è troppo lunga bindano il socket in temp e
   lasciano un file puntatore `gateway.sock.path` che i client seguono. Un nostro
   test in `mkdtempSync` lo troverebbe al primo colpo.

## 4. Cosa ne concludiamo per Muffin

**Il gateway deve esistere sempre come concetto**, e non per estetica: la cosa
che ci mette nella seconda categoria — surface, scheduler, memoria durevole,
proattività — è la stessa che ha costretto Hermes e OpenClaw a tenerlo, ed è
quella verso cui Goose si sta muovendo mentre scriviamo.

Ma **la conclusione operativa non è «riscriviamo il REPL come client»**. È che
la liveness del gateway va presa da un contratto posseduto dal gateway, non
indovinata da una riga che gli sopravvive. Quello è un passo piccolo, non
richiede di decidere niente sul REPL, e va fatto per primo — è il `migration
step 1` che Hermes ha nominato così apposta.

**Ordine proposto:**

1. `control_socket` v1, sola osservazione: `identify` + `status`.
   `readGateway` smette di essere un'euristica sul pid. Nessun cambio di
   comportamento.
2. I fallback e i retry già in coda (embedder locale → API in testa), che sono
   indipendenti da tutto questo.
3. **Solo allora** l'ADR «il REPL è un client del gateway?», scritto sapendo
   che il canale c'è, che forma ha, e con dentro la domanda che decide tutto:
   *cosa fa il REPL quando il gateway non c'è.* La risposta di ACP a quella
   domanda — l'agente è un processo figlio del client — è una terza opzione
   reale che oggi non avevamo sul tavolo.

## Fonti

| Cosa | Dove | Fetch | Tipo |
|---|---|---|---|
| ACP, forma locale e transport | agentclientprotocol.com/overview/introduction | 2026-08-27 | citazione diretta |
| Codex, famiglia app-server | `gh api repos/openai/codex/contents/codex-rs` | 2026-08-27 | listing |
| Codex, scopo del daemon | `codex-rs/app-server-daemon/README.md` | 2026-08-27 | citazione diretta |
| Hermes, struttura gateway e CLI | `gh api repos/nousresearch/hermes-agent/contents{,/gateway,/hermes_cli}` | 2026-08-27 | listing |
| Hermes, control socket | `gateway/control_socket.py` | 2026-08-27 | citazione diretta |
| Goose, crate e moduli | `gh api repos/block/goose/contents/crates{,/goose/src,/goose/src/gateway}` | 2026-08-27 | listing |
| Letta, server e client | docs.letta.com/concepts/letta | 2026-08-27 | **[NON VERIFICATO]** da codice |
