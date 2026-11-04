# Come i peer lasciano la shell invocante funzionante (survey per #808)

**Domanda che deve cambiare:** #808 — dopo l'install, la shell che ha lanciato
l'installer deve trovare `muffin`, senza dover sapere cos'è `~/.profile`.
Un figlio non può modificare l'environment del padre: la correzione è
detection + remedy.

**Fonti primarie lette il 2026-10-01** (script veri + docs ufficiali, niente
eseguito): `claude.ai/install.sh` → bootstrap (260 righe, release 2.1.286);
`openclaw.ai/install.sh` (4.170 righe); Hermes `scripts/install.sh`
(`eb8d21f4`, 868 righe); Codex `chatgpt.com/codex/install.sh` + npm
`@openai/codex@0.159.3`; rustup (`sh.rustup.rs`, `msg.rs`/`shell.rs` su main).
Muffin osservato al commit citato nel report (meccanica invariata da allora:
`install.sh` scrive la riga PATH in `~/.profile`, la remedy sta nel rumore
del build).

## Per peer (essenziale)

- **Claude Code**: script thin che delega al binario; la shell invocante NON
  viene sistemata — il remedy sta nei docs («open a new terminal… Fix your
  PATH»). Verifica utente (`claude --version`, `claude doctor`). Rifiuta
  sudo: «the 'claude' command would not work from your own shell».
- **OpenClaw**: detection + `warn_openclaw_not_found()` (headline su
  `hash -r`, export line presente ma non come schermata finale); persistenza
  PATH per-shell con guardie; `--verify` solo opt-in; `exec onboard` su
  `/dev/tty`.
- **Hermes**: l'analogo più vicino — `print_path_reload_hint()` in fondo, con
  il commento esplicito che l'inherited PATH è quello del padre (quindi dice
  se l'utente può lanciare subito); silenzioso se ok, una riga di remedy
  altrimenti. Debole: una riga di log, nessuna verifica.
- **Codex standalone**: il meccanismo più forte — `add_to_path()` + sempre
  `print_launch_instructions()` con righe Current-/Future-terminal che nominano
  il comando esatto, più `verify_visible_command()` per path assoluto (prova
  l'install indipendentemente dal PATH). Unico precedente di prompt di fine
  install (`Start Codex now?`, default No): lancia il programma, mai `exec`
  di una shell. Niente branch fish.
- **rustup**: il design di riferimento — modifica i profile + schermata finale
  con restart story E comando `source …/env` per-shell; `rustc --version`
  come self-check documentato. Corroborazione avversaria (Homebrew #721):
  «users don't read command line» — la remedy stampata può essere mancata.

## Tabella contro le opzioni di #808

Nessun peer implementa `exec` in una login shell né shim in directory
presunte-on-PATH — per ragioni di principio: `exec` sostituisce il processo
(semantica exit-code/trap, sorprende i parent scriptati), e niente di
user-local può assumere una dir già su PATH (è il bug stesso).

## Raccomandazione (la più piccola che chiude il failure misurato)

1. **Detection** (stile Hermes) a fine `install.sh`: inherited PATH dice se
   la shell invocante risolverà il comando — tre stati (risolve /
   installato-ma-irraggiungibile / install-rotto).
2. **Verifica per path assoluto** (stile Codex, nuova per Muffin):
   `"$MUFFIN" --version`/doctor comunque — separa «installato ma non su PATH»
   da «rotto», che oggi non distinguiamo.
3. **Blocco finale di remedy** (stile Codex, sempre stampato, contenuto
   condizionale): irraggiungibile → blocco delimitato con riga copia-incolla
   per la shell corrente + riga per le future (nominando gli rc scritti);
   raggiungibile → una riga quieta; la vecchia riga mid-install sparisce nel
   blocco. **Non implementare (b)/(c).**
4. Stampare condizionale (silenzioso-se-ok, forte-se-rotto) conta più del
   volume — Homebrew #721 docet.

## Falsificatori

- Un eval su shell fresca dove l'owner digita comunque un primo comando
  fallito nonostante il blocco → scalare a prompt opt-in esplicito, o
  footer incondizionato a due righe se `command -v` in `install.sh` non
  predice la risoluzione del padre nel percorso bootstrap.

## Nota root (#683, un paragrafo)

Nessun peer ha una lane root→utente-non-privilegiato: Claude rifiuta sudo,
Hermes installa *come* l'utente di servizio (+ linger), OpenClaw escala solo
per i pacchetti, Codex/rustup sono user-local. Il consenso peer (escalation
solo per pacchetti, mai per l'agente) supporta tenere stretta la lane #683 —
ma la promessa «il primo comando funziona» dovrà coprire anche PATH e linger
*dell'utente target*, problemi che nessun installer peer ha dovuto risolvere.
