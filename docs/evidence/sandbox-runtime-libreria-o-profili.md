# M3-A — `@anthropic-ai/sandbox-runtime` come dipendenza vs. profili in-house (2026-08-08)

> Report scout M3-A, consegnato inline e persistito dall'orchestratore. Mandato: estendere `a6-brain-hands-sandbox.md` (2026-08-04) sui 5 punti che decidono ADR-0026 — stato pacchetto, API da libreria, costi operativi, dimensione reale di un profilo in-house, Ubuntu 24.04. Metodo: npm registry interrogato direttamente; **repo clonato, compilato con tsc ed eseguito** per generare profili SBPL reali; issue tracker live via `gh` (82 issue aperte). Ambiente: macOS, Node v22.22.2 — la parte bubblewrap resta verifica di lettura sorgente (nessun host Linux disponibile allo scout).

## 1. Stato del pacchetto npm

**Versione e cadenza [VERIFICATO, npm registry 2026-08-08]**: ultima **0.0.71** pubblicata **2026-08-07** (ieri); prima 0.0.1 il 2025-10-20; **71 release in ~292 giorni**, mai uscito da `0.0.x` in 9+ mesi. Cadenza attiva (~1 release ogni 4 giorni, anche 3/giorno).

**Licenza [VERIFICATO]**: Apache-2.0 (npm + file LICENSE nel clone).

**Dipendenze [VERIFICATO, npm install reale in progetto vuoto]**: 4 dirette (`@pondwader/socks5-server ^1.0.10`, `commander ^12.1.0`, `node-forge ^1.4.0`, `zod ^3.24.1`), **zero transitive oltre queste** (`added 5 packages`). Peso 8.38MB unpacked, ma **~8MB sono binari nativi**: `srt-win.exe` x64+arm64 (69% del totale, inerte su macOS/Linux) + `apply-seccomp` x64+arm64 (helper Linux opzionale). **Nessuno script di lifecycle gira installandolo come dipendenza** (verificato empiricamente). **Conflitto reale con muffin-next**: noi zod `^4.4.3`, srt zod `^3.24.1` → due major coesistono nel tree (costo: duplicazione, nessuna interop diretta tra i loro schema Zod v3 e il nostro codice v4).

**Issue rilevanti [VERIFICATO, query live 2026-08-08]**:
- **Cluster PTY macOS** (trasversale Sequoia 15.x → Tahoe 26.x, non specifico di macOS 26): #290 (chiusa col workaround `allowPty: true`), **#419 APERTA** (tty ioctls TIOCSETA negati, `tcsetattr EPERM`, `allowWrite` sul device non risolve), #391 (escape sequences).
- **Node 22+**: zero segnalazioni; `engines >=20.11.0`; issue con Node 22/24 in ambiente senza che Node sia mai indicato come causa.
- **Cluster "fail silenzioso della policy dichiarata" — tutte aperte, tutte dell'ultima settimana**:
  - **#432** (2026-08-04): i **mandatory deny glob su macOS sono silenziosamente ancorati a `process.cwd()`** e non applicati fuori da esso — contraddice testualmente la garanzia del README ("always blocked... even if they fall within an allowed write path").
  - **#434** (2026-08-04): chiavi di config sconosciute o con typo (`denyWriteTypo`) **ignorate in silenzio**, nessun errore né warning.
  - **#446** (2026-08-05): su Linux un `allowWrite` annidato sotto carve-out di `allowRead` in regione `denyRead` diventa **silenziosamente read-only** (bug di ordine dei mount).

## 2. API da libreria

**Export [VERIFICATO, `src/index.ts` letto per intero]**: `SandboxManager` (**singleton di modulo**, non classe istanziabile — "Global sandbox manager... runs outside of the sandbox, on the host machine"), `SandboxViolationStore`, tipi (`SandboxRuntimeConfig`, `NetworkConfig`, `FilesystemConfig`, …), API Windows, funzioni CA per `tlsTerminate`.

**Ciclo di vita [VERIFICATO, source + esempio README "As a library"]**:
- `await SandboxManager.initialize(config, askCallback?, enableLogMonitor?)` — **una volta**: avvia proxy HTTP+SOCKS mux su `127.0.0.1` (porta dal SO); su Linux avvia anche il bridge `socat`. Chiamate ripetute → await della promise esistente, nessun secondo proxy.
- `await SandboxManager.wrapWithSandbox(command, binShell?, customConfig?, abortSignal?, options?)` → `Promise<string>`: **non spawna nulla** — restituisce la stringa avvolta (`sandbox-exec -p '…' --` o `bwrap … --`) che **l'embedder esegue col proprio spawn**. Esiste `wrapWithSandboxArgv(...)` → `{argv, env}` (niente shell-quoting).
- **Write-scope per-invocazione: confermato.** `customConfig?: Partial<SandboxRuntimeConfig>` sovrascrive `filesystem.*` e `network.allowedDomains` **solo per quella chiamata** (`customConfig?.filesystem?.allowWrite ?? config?.filesystem.allowWrite ?? []`).
- `updateConfig(newConfig)`: allow/deny di **rete** live-swap immediato (il proxy legge la config per-richiesta); il filesystem globale **non** è live (cotto nel profilo al wrap) — per-comando si usa `customConfig`.
- `reset()`: teardown esplicito (closeAllConnections → close; SIGTERM→1500ms→SIGKILL sui bridge). Auto-registrato su exit/SIGINT/SIGTERM alla prima initialize.
- **Pensato per processo Node long-running: sì, per design** (initialize-once/wrap-many esplicito).

**Nota di genericità [VERIFICATO]**: `getDefaultWritePaths()` include **incondizionatamente** `/tmp/claude`, `.claude/debug`, `.npm/_logs` in ogni allowWrite generato — lineage Claude Code non disattivabile via config (innocua ma non neutra).

## 3. Costi operativi

- **Linux, per ogni `wrapWithSandbox`**: uno spawn di **ripgrep** per espandere i glob del mandatory-deny (bwrap non ha glob nativi). Commento sorgente: *"fast enough to run on each command without memoization"* — non cacheato per design.
- **Overhead startup [NON VERIFICATO]**: nessun numero pubblicato da nessuna fonte (README, issue). Resta il gap A6 §5.6 — lo misuriamo noi (dovuto da ADR-0018).
- **Ghost files su Linux [VERIFICATO]**: bwrap che protegge un deny-path inesistente crea un file vuoto reale che **persiste**; la libreria espone `cleanupAfterCommand()` ma è **responsabilità dell'embedder** chiamarla dopo ogni comando.
- **#213 (APERTA dal 2026-04-09)**: `TMPDIR` > 108 caratteri (limite `sun_path`) → socat fallisce con errore generico "Sandbox failed to initialize".

## 4. Alternativa in-house: misura diretta

Profili generati **eseguendo il codice vero** (clone + tsc + invocazione di `wrapCommandWithSandboxMacOS`):

| Caso | Byte | Righe |
|---|---|---|
| Write in 1 dir, rete libera | 11.173 | 225 |
| Write in 1 dir + rete solo verso 2 porte localhost | 13.087 | 230 |

- La restrizione di rete aggiunge ~1,9KB: quasi tutto env-var di proxy (16 variabili), il profilo SBPL cresce di 6 righe.
- **~150-160 righe su ~225-230 sono template fisso Chrome-derivato** (commento sorgente: `; Essential permissions - based on Chrome sandbox policy`): mach-lookup ~15 servizi, ~50 sysctl-read, iokit, ipc-posix. Un profilo a mano per "scrivi qui + rete a una porta" starebbe in 20-40 righe **ma** ricostruire la compatibilità con processi reali (node/git/npm) è il lavoro che il tracker documenta come ancora in corso (#430: manca `hw.optional.neon`, Qt crasha).
- **La dimensione scala col cwd** [misura diretta]: cwd 3 livelli → 9.758B; 7 livelli → 13.087B; 8 livelli con UUID → 19.246B. Causa nel sorgente: `getAncestorDirectories(cwd)` genera una deny-entry per OGNI antenato (anti-symlink).
- **ARG_MAX [VERIFICATO]**: profilo passato come argv (`ARG_MAX` 1MB macOS); test nel repo tiene 600 deny-path sotto 512KB; PR #448 (2026-08-05, in 0.0.71) ha compattato il profilo ~6-10x.
- **bwrap minimo [lettura sorgente]**: `--new-session --die-with-parent --unshare-net --bind <socket> … --setenv (×~15) --ro-bind / / --bind <writeDir> --ro-bind /dev/null <deny-esistenti> --dev /dev --unshare-pid --unshare-user --cap-drop ALL --proc /proc -- <shell> -c '<cmd>'` — ~15-25 flag anche nel caso più semplice, prima di `apply-seccomp` (opzionale).

## 5. Ubuntu 24.04 + AppArmor

**Raccomandazione ufficiale [VERIFICATO, README verbatim]**: *"Disable the restriction with `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` or add an AppArmor profile that grants `userns` to the relevant binaries"* — **nessun profilo pronto fornito** (correzione ad A6: il *bisogno* è documentato, la *soluzione* no).

**Il sysctl da solo non basta — tre cause di rottura indipendenti, verificate**:
- (a) il sysctl userns (già trovato sul campo da Muffin);
- (b) **#429 (APERTA, 2026-07-28)**: il profilo AppArmor **spedito da Ubuntu** (`/etc/apparmor.d/bwrap-userns-restrict`) nega le capability ai **figli** di bwrap (`audit deny capability` su `unpriv_bwrap`) — meccanismo diverso e aggiuntivo rispetto al sysctl; duplicati aperti contro Claude Code da aprile;
- (c) **#428 (APERTA, 2026-07-28)**: `bwrap` **0.9.0** (unica versione nei repo noble) azzera il capability bounding set dei figli → `EPERM` su `/proc/self/setgroups` anche con sysctl a 0.

Entrambe (b) e (c) colpiscono lo strato **opzionale** `apply-seccomp`: si aggira con `allowAllUnixSockets: true` (perdendo l'hardening Unix-socket — limite da dichiarare). Se questo copra anche il fallimento del VPS Muffin (`RTM_NEWADDR: Operation not permitted`) è **[NON VERIFICATO]** — plausibile stesso meccanismo AppArmor di (b), serve test sul VPS.

## Correzioni alla baseline A6

- "Documentato un profilo AppArmor dedicato" → impreciso: documentato il bisogno, non il profilo.
- "Nota AppArmor" come ostacolo singolo → incompleto: tre meccanismi indipendenti, tre issue separate, tutte aperte.
- "Problema macOS 26" → impreciso: cluster PTY trasversale a Sequoia e Tahoe.

## Aperto

- Overhead per-invocazione in ms (nessuna fonte; si misura in M3).
- Byte di un argv bwrap minimo (niente Linux disponibile allo scout).
- Nesso causale #429 ↔ fallimento RTM_NEWADDR del VPS (serve test sul VPS).

## Fonti

npm registry (query diretta); repo `anthropic-experimental/sandbox-runtime` (clone+build+run); PR #448; issue #290, #419, #391, #432, #434, #446, #430, #429, #428, #213; `package.json` di muffin-next. Baseline non ri-derivata: `research/a6-brain-hands-sandbox.md`, `adr/0018-brain-hands-sandbox.md`.
