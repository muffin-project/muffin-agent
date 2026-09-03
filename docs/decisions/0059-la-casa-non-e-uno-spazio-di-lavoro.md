# ADR-0059 — La casa non è uno spazio di lavoro

**Stato:** accettato · 2026-09-03

## Contesto — misurato sul processo vivo, non letto nel codice

Il 2026-09-03, sul gateway in esecuzione sulla macchina dell'owner:

```text
$ lsof -p 45750 | awk '$4=="cwd"{print $9}'
/Users/…/.muffin
$ plutil -p ~/Library/LaunchAgents/ai.muffin.gateway.plist | grep -A1 WorkingDirectory
  "WorkingDirectory" => "/Users/…/.muffin"
```

La catena ha quattro anelli e **nessuno dei quattro è un difetto isolato**:

1. la unit scrive `WorkingDirectory=${home}` (`core/gateway/unit.ts:278` per
   systemd, `:376` per launchd) — **di proposito**: ADR-0035 lo richiede, perché
   una unit ancorata a un checkout che si sposta fallisce allo CHDIR *prima* che
   il runtime carichi, e `Restart=always` va in crash-loop su una directory
   morta;
2. `cli/gateway.ts` chiamava `buildRuntime(home)` senza cwd;
3. `agent/runtime.ts` faceva `cwd = process.cwd()`;
4. quel `cwd` diventava sia `FsScope.root` sia il `writeScope` della sandbox
   (`agent/tools/shell.ts:148`, `writeScope: [scope.root]`).

Quindi **il difetto non è la unit**. È che *«la directory in cui gira il
processo»* e *«la directory in cui un turno può scrivere»* erano la stessa
variabile, mentre sono due domande con due risposte diverse: il processo deve
stare dove non si sposta niente, il turno deve stare dove non c'è niente di
Muffin.

### Cosa costava, misurato

Contro il `SandboxExecutor` di produzione con i `mandatoryGuards` veri, con
`writeScope: [home]` — la configurazione esatta del gateway supervisionato:

| bersaglio | esito prima | conseguenza |
|---|---|---|
| `rot/egress.json` | negato | — |
| `config.json` | negato | — |
| `.rot-anchor` | **scritto** | `verify()` risponde `anchor_mismatch`: safe mode, o boot rifiutato se hardened |
| `muffin.db` | **sovrascritto** (20480 B → 6 B) | episodi, chunk, fatti, turni, job, spesa |
| `voice.md` | **sovrascritto** | la voce che l'agente propone di cambiare col cricchetto |
| `sessions/*.jsonl` | **sovrascritto** | l'intera storia conversazionale |

`.rot-anchor` è quello tagliente: vive **accanto** a `rot/`, non dentro — *«an
anchor inside what it anchors is decoration»* (`core/rot/verify.ts:49`) — quindi
la voce che proteggeva la directory sigillata non proteggeva il sigillo.

Tutto questo è raggiungibile da un turno il cui contenuto è arrivato in un
messaggio inoltrato, da una pagina web o da un PDF: `sys.shell` sta sulla riga
`host` (tetto 2), che un risultato tier-2 declassa ad `ask` e non a `deny`.

## Chi scrive legittimamente dentro la casa, e per quale strada

Verificato per grep sui produttori reali: vault (`agent/runtime.ts:436`), undo
journal (`:858`), traces (`JsonlExporter`), sessioni, `muffin.db` e i suoi
backup di migrazione, `defaults-manifest.json`, `prompt-nonce`, `mcp.json`,
`skills/`. **Tutti in-process, in Node.** Nessuno passa dai tool `fs_*` né dalla
sandbox. La casa era raggiungibile dai tool solo *per incidente* — perché il
`root` era la casa — mai per disegno.

Questo è ciò che rende la decisione economica: negare la casa non toglie una
strada a nessuno.

## Le alternative pesate

| candidato | verdetto |
|---|---|
| A. solo il gateway passa un workspace esplicito | scartato due volte: lascia intatta l'autorità-per-cwd di `muffin run` e della REPL lanciate da dentro `~/.muffin`, e — misurato in accettazione, punto 5 sotto — sovrascrive la cwd che l'owner sceglie quando lancia `muffin gateway run` da un terminale |
| A'. una porta sola in `buildRuntime` che rifiuta l'installazione | necessario, non sufficiente: vale per ogni superficie, ma se una superficie futura scavalcasse la porta non resterebbe niente sotto |
| B. `mandatoryGuards` nega tutta la casa | necessario, non sufficiente: senza un workspace vero il turno resta con `root` uguale a una directory interamente negata, cioè mani legate |
| C. togliere shell e fs al gateway | scartato: ADR-0018 è «brain **and** hands», e un agente continuo senza mani non è la stessa capacità con meno rischio |
| D. una sottodirectory `~/.muffin/workspace`, con la casa negata attorno | **misurato e scartato**, vedi sotto |
| E. A' e B insieme | **scelto** |

### Perché D è morta di misura, non di argomento

Con `denyWrite: [home]` e `allowWrite: [home/workspace]`, una scrittura
**dentro** il workspace annidato torna `Operation not permitted` (seatbelt,
2026-09-03). Il deny batte l'allow annidato: il ritaglio non è un ritaglio, è un
workspace che non funziona. Su Linux la forma è diversa e non migliore — srt
emette i bind di deny **dopo** quelli di allow (`linux-sandbox-utils.js`:
*«denyWrite binds are buffered and emitted after denyRead processing»*), quindi
un `--ro-bind` sulla casa atterra sopra il `--bind` di ciò che le sta sotto — ma
la conclusione è la stessa.

Una regola la cui sicurezza dipende dall'ordine di emissione di due meccanismi
diversi è esattamente ciò che questo repository ha già spedito come no-op. Fuori
dalla casa non c'è niente da ordinare: deny e allow non si sovrappongono.

## Decisione

1. **Il workspace è un fratello della casa, mai un figlio.**
   `muffinWorkspace(home)` = `dirname(home)/<basename senza punto>-workspace`:
   `~/.muffin` → `~/muffin-workspace`; `/var/lib/muffin` →
   `/var/lib/muffin-workspace`. Derivato da `MUFFIN_HOME` e non cablato, così
   `--local` e la home di dev ne hanno uno ciascuno — la stessa manopola unica
   di ADR-0030 punto 3. Visibile e non puntato: è l'unica directory che l'owner
   deve poter aprire in un file manager.
2. **`MUFFIN_WORKSPACE` la sposta, ma non dentro l'installazione.** Un valore
   che nomina la casa o qualcosa sotto di essa viene ignorato, confrontato per
   realpath e non per stringa. Una variabile d'ambiente non è una capability.
3. **`resolveWorkspace(home, cwd)` è l'unica porta**, dentro `buildRuntime`.
   Onora la cwd quando l'owner l'ha scelta standoci dentro; la sostituisce
   quando *è* l'installazione, cioè esattamente quando a sceglierla è stato un
   supervisore. Quando sostituisce, lo **dice** in `bootLines`.
4. **`mandatoryGuards` nega la casa in scrittura**, come categoria 0 accanto
   alle cinque del threat model. È la cintura: le bretelle sono il punto 3, e
   nessuna delle due da sola sopravvive alla prossima superficie che dimentica.
5. **Una porta sola, anche per il gateway.** La prima stesura faceva nominare al
   gateway il proprio workspace — «è la superficie dove non guarda nessuno,
   quindi non dipenda dalla guardia». Era sbagliata, e l'ha detto
   l'accettazione: `muffin gateway run` gira **anche** in un terminale, in una
   directory che l'owner ha scelto standoci dentro, e nominare il workspace lì
   sovrascriveva quella scelta — `b-parita-superfici` e `b-una-conversazione`
   sono andate rosse perché il turno leggeva `dati.txt` dove il test non
   l'aveva messo. Una seconda scrittura della stessa regola è una seconda
   regola. La cintura (punto 4) è ciò che rende accettabile dipendere dalla
   porta.
6. **`makeJobRunner` non ha più un default `process.cwd()`**: senza uno scope
   dichiarato lo script non parte e il turno registra perché — la stessa scelta
   fail-closed che il parametro `exec` fa già accanto.

## Cosa questa ADR **non** decide

La casa resta **leggibile** da un comando contenuto. Il rischio residuo è reale
e nominato: `cat ~/.muffin/muffin.db` torna al modello a `DISK_TIER`, e da lì
l'uscita è governata dal taint e da `egress`, non da questa decisione. Chiuderlo
richiederebbe negare in lettura anche ciò che l'owner chiede legittimamente
(«leggimi il mio `voice.md`»), ed è una claim diversa con una prova diversa.

## Conseguenze

Più facile: un turno non può più danneggiare l'installazione, su nessuna
superficie e per nessuna cwd; il listato d'istanza nel contesto mostra il
workspace invece del contenuto di `~/.muffin`. Più difficile: chi era abituato a
lanciare `muffin` da dentro `~/.muffin` vede il lavoro atterrare altrove — e lo
legge in `bootLines` invece di scoprirlo.

**Cosa la falsificherebbe.** Se un produttore legittimo dovesse un giorno
scrivere nella casa *attraverso* i tool o la sandbox, il punto 4 lo romperebbe:
la risposta non è un'eccezione annidata (misurata morta, sopra) ma una porta
in-process come quelle che tutti gli altri produttori già usano.

Codice: `core/config/workspace.ts`, `core/rot/guards.ts`, `agent/runtime.ts`,
`agent/scheduler-run.ts` (e `cli/gateway.ts`, che ora non passa una cwd di
proposito). Prove:
`core/sandbox/home-not-workspace.test.ts` (comando reale, cintura e bretelle
falsificabili separatamente), `core/config/workspace.test.ts`,
`evals/system/acceptance.test.ts` («a runtime built with the home as its cwd»).
