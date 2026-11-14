# Cosa può toccare l'agente: radici di lavoro dichiarate

Data: 2026-10-18 · HEAD `dae23668` · branch `fix/reliability-remediation`
Pass di ricerca/challenge richiesto da `docs/development/RESEARCH.md` §1
(cambia sicurezza e autorità). Commissionato dalla ricognizione del
2026-10-18: `docs/evidence/2026-10-18-forensic-findings-verification.md`.

> Status: evidenza datata, non autorità corrente. Non sostituisce
> `docs/architecture/SECURITY.md`, le ADR o il codice. La decisione, se presa,
> è una nuova ADR che emenda ADR-0059.

## La domanda

Le ADR-0030/0035/0059 hanno deciso **misurando** due cose vere:

1. la home di Muffin non è uno spazio di lavoro, e lasciarci scrivere un turno
   distrugge memoria, sigillo e sessioni (§ADR-0059, tabella misurata);
2. il workspace è un **fratello** della home, non un figlio, perché seatbelt
   (`deny [home]` + `allow [home/workspace]`) e bubblewrap (ordine dei bind)
   rendono il carve-out una directory che non funziona.

Su quella base è stato scelto anche qualcosa che **non** è stato misurato, ed è
ciò che questa nota mette in discussione: **esiste una sola radice, per
installazione, fissa**, e l'agente non può essere puntato sul lavoro reale del
proprietario.

### Fallimento misurato (una frase falsificabile)

Su un'installazione reale (gateway Telegram, questo HEAD), l'agente non può
leggere né lavorare in alcuna directory del proprietario all'infuori di
`~/muffin-workspace`: `fs_read`/`fs_list`/`fs_search` e `sys.shell` sono
confinati alla radice del workspace, la home è negata per costruzione, e il
tentativo dell'agente di leggere un progetto vero — il proprio sorgente — è
fallito **18 volte** su `~/dev/muffin-agent/core/memory/schema.ts` con
«outside the working directory», più ogni `send_file` su file fuori dal vault.

## Cosa fa il codice adesso (percorso reale, non il modulo)

- `agent/runtime.ts:439` `resolveWorkspace(home, cwd)` → **una** `workspace`.
  `:782` `scope = { root: workspace, ... }` → `fs.*`; `:933-934` `sys.shell*`
  con `root: workspace`.
- `core/config/workspace.ts:228` `resolveWorkspace` **onora già il `cwd`** del
  processo quando è una directory vera e non è dentro la home. Quindi sul CLI
  interattivo, `cd ~/dev/progetto && muffin` **già** dà quel progetto come
  workspace. Il caso rotto è il **gateway supervisionato**: la unit fissa
  `WorkingDirectory=${home}` (ADR-0035), quindi `cwd` cade nella home e
  `muffinWorkspace(home)` riporta al fratello di default. Una radice, sempre.
- `agent/tools/deliver.ts` — `send_file` è `root: vault`, per scelta dichiarata
  (vault condiviso fra tenant, egress non ancora scoperto).
- Le tre radici in gioco sono quindi disgiunte e tutte deliberate:
  `~/muffin-workspace` (fs/shell), `~/.muffin/vault` (send_file/ingest),
  e il checkout del proprietario (nessuno).

## Cosa fanno i peer (per problema, non per marca)

| Sistema | Radice | Lettura | Scrittura | Estensione | Rete |
|---|---|---|---|---|---|
| Claude Code | dir di lancio / progetto | **ampia di default** (tutta la macchina meno deny: `~/.ssh`, `~/.aws/…`); opt-in `blockReadsOutsideWorkingDirectories` | working dir + temp + dir aggiunte (deny-then-allow) | `--add-dir` / `additionalDirectories`, stesse regole | sandbox OS, proxy allow-only |
| Codex CLI | cwd + `/tmp` | nello scope del sandbox | `writable_roots` + `--add-dir`; path protetti `.git`/`.codex` | `sandbox_workspace_write.writable_roots`, profili `:workspace` | **off di default**, allow-list via proxy |
| OpenHands | progetto montato `/workspace` (rw) | nel container | nel mount rw; reference mount read-only | `SANDBOX_VOLUMES`, `--mount-cwd` | nel container |
| `@anthropic-ai/sandbox-runtime` (la dipendenza di Muffin) | — | **deny-then-allow** (allow ovunque di default) | **allow-only** (deny ovunque di default) | via config | allow-only via proxy |

Il filo comune: la radice è **il progetto**, non un contenitore fisso scelto
dall'installer; l'owner la **fida** e la **estende** (trust-on-first-use);
la **lettura è ampia, la scrittura è stretta**; la rete è chiusa; il confine lo
impone l'**OS**, non l'analisi del testo del comando.

## Cosa dice la SOTA 2026 sulla sicurezza

- Il rischio centrale non è l'esecuzione remota ma il **confused deputy / prompt
  injection indiretta**: contenuto che arriva al modello con l'autorità
  dell'operatore. L'incidente Cline (feb 2026) — un titolo di issue che fa
  installare un pacchetto a ~4.000 macchine — è il caso canonico.
- `Workspace Topology as an Attack Vector` (arXiv:2608.14876, CAMLIS 2026): il
  **workspace stesso è il vettore**; i punti d'ingresso sono `AGENTS.md`,
  `README.md`, il sorgente. Un workspace più modulare abbassa l'ASR.
- CSA (`Sandboxing Agentic AI`, `Confused Deputy…`, `GuardFall`): trattare
  l'esecuzione di tool come esecuzione di codice arbitrario; **least privilege**
  + capability scoping (fs/rete/syscall/tool) + identity binding + audit
  tamper-resistant; il filtro sull'**analisi del testo** del comando è bypassabile
  (GuardFall rompe 10/11 agenti) → il confine deve stare nel **sandbox**.
- Saltzer & Schroeder (1975): least privilege, **complete mediation**,
  psychological acceptability.
- I modelli frontier del 2026 resistono meglio all'IPI, ma le difese restano
  layered.

## La tensione, e perché Muffin può permettersi una scelta diversa

L'argomento standard per tenere l'agente su **una** radice è il confused deputy:
più il workspace è ampio, più superficie d'iniezione esiste. Ma è esattamente il
modello dei peer DI AMPIARE la lettura al progetto fidato — e per loro è
coerente, perché la loro unica difesa *è* lo scope. Muffin ha un livello in più
che i peer non hanno:

- `fenceDisk` (`agent/tools/fs.ts`) marca **ogni byte dal disco** come tier 2,
  esterno, non-osservante (SECURITY §4);
- il gate taint/egress (`core/policy/decide.ts`, `paramsMaxTaint`,
  `isForbiddenAddress`) governa cosa **esce**;
- il kernel decide l'effetto dalla **riga** e dall'irreversibilità, non dal
  testo del comando; la scrittura irreversibile **chiede** sempre.

Quindi **allargare l'insieme delle radici non indebolisce il modello di autorità
come lo indebolirebbe in un peer senza taint/fence/egress**. Ciò che va
allargato è la *dimensione radice* (quali directory), non l'*asse effetto*
(cosa lascia la macchina): restano negate home e segreti, resta la rete chiusa,
la scrittura resta `draft`+undo, l'irreversibile resta `ask`.

## Decision table (RESEARCH.md §E)

```text
Fallimento misurato   l'agente non può lavorare fuori da ~/muffin-workspace;
                      18 read negati su un progetto vero + ogni send_file fuori-vault
Meccanismo attuale    UNA radice, per installazione, fissa; home negata; vault separato;
Invariante            home ≠ workspace, disgiunta dall'installazione (misurato ADR-0059)
                       deny batte l'allow annidato (misurato: seatbelt / bwrap)
Candidato A           più piccola: la radice del gateway è un valore dichiarato
                      (una sola, scelta dall'owner) + messaggi d'errore che nominano la radice
Candidato B           radici multiple dichiarate (peer-inspired): un set
                      {read | write | deny} per radice, nel sigillo; read largo nel set,
                      write solo dove dichiarato, home/segreti sempre deny, rete off
Candidato C           togliere `fs.*` e lasciare solo `sys.shell`; o unificare vault e workspace
Evidenza A            risolve solo il caso gateway, una radice; non il multi-progetto;
                      costo minimo, nessun cambio di autorità
Evidenza B            è ciò che fanno Claude Code/Codex/OpenHands; sfrutta taint/fence già presenti;
                      richiede un cancello d'autorità (la radice è autorità → sigillo)
Evidenza C            semplifica ma fa perdere la scrittura strutturata con undo/checkpoint;
                      unifica pericolosamente la scrittura host col vault per-tenant (ADR-0073)
Contro A              il proprietario che usa Muffin su più progetti resta bloccato
Contro B              più superficie IPI (il workspace è il vettore, arXiv:2608.14876);
                      una radice larga in scrittura è una capability nuova → serve gate + eval
Contro C              regressione sulla parte già misurata e sicura (anno di lavoro)
Conseguenze           B: nuova autorità (radici) → deve stare nel sigillo, mai dal modello;
                      non-tenant (hostOnly resta); test live su seatbelt+bwrap come ADR-0059
Falsificatore         una scena d'attacco (corpus 0066/0071) che completa su un workspace
                      con radici dichiarate e NON completa su radice singola → B non è sicuro
                      come A, e si resta su A finché il taint/egress non tiene
Claim proposto        adottare B in forma minima e sigillata: l'owner DICHIARA le radici
                      (read/write/deny), l'agente legge largo dentro il set e scrive solo
                      dove dichiarato, home e segreti sempre negati
```

## Conclusione, incertezza, e cosa la ribalterebbe

La radice singola non è un invariante misurato: sono misurati «home ≠ workspace»
e «deny batte allow annidato». Il resto è una **scelta di prodotto** che i peer
hanno preso nell'altro verso, e che Muffin può prendere nell'altro verso ancora
perché ha un livello di provenienza/autorità che i peer non hanno.

Incertezza dichiarata, in ordine di importanza:

1. **Il workspace è il vettore d'iniezione** (arXiv:2608.14876). Aprire la
   lettura a un checkout vero aumenta la superficie. Va pesato contro il taint
   già presente: il rischio non è la *lettura* (già tier 2) ma l'*effetto* che
   l'iniezione ottiene. Da qui la forma minima: read largo, **write stretto**.
2. **La radice è autorità, non configurazione.** Come i `tenants` in
   `rot/policy.json` (SECURITY §5), dichiarare una radice in scrittura è un
   allargamento → deve stare **nel sigillo** (modifica file + `rot reseal`), mai
   impostabile dal modello o da un flag.
3. **`fs.*` resta `hostOnly`.** Radici per l'host, mai per una stanza: la stanza
   ha il suo vault, e `resolveWorkspace` conosce una radice per installazione
   (ADR-0059).

Cosa ribalterebbe la scelta (kill criteria): una scena del corpus d'attacco
stile `evals/security/attacks` che, con radici dichiarate, **completa** una
scrittura fuori dalle radici o un'egress che con la radice singola **non**
completa. In quel caso il taint/egress non basta e si resta su A.

Prossimo passo, se Giusto approva B: una **nuova ADR** che emenda ADR-0059
(radici dichiarate sigillate, `read`/`write`/`deny`, home e segreti sempre
negati), un cancello d'autorità in `rot/policy.json`, e un eval RED→GREEN
`core/config/workspace-roots.test.ts` + una scena d'attacco, con la stessa
disciplina live di `home-not-workspace.test.ts`.

## Fonti

- Muffin: `docs/architecture/SECURITY.md` §4/§5/§9; `docs/decisions/0059-*.md`;
  ADR-0030; `core/config/workspace.ts`; `agent/runtime.ts:439,782,933`;
  `docs/evidence/2026-10-18-forensic-findings-verification.md` (18 read negati).
- Peer: `code.claude.com/docs/en/permissions`, `/sandboxing`, `/permission-modes`;
  `developers.openai.com/codex/sandboxing`, `/config-reference`;
  `docs.openhands.dev/openhands/usage/sandboxes/docker`;
  `github.com/anthropics/sandbox-runtime` (npm `@anthropic-ai/sandbox-runtime`).
- SOTA: arXiv:2608.14876 (Workspace Topology, CAMLIS 2026); CSA research notes
  «Confused Deputy Attacks on Autonomous AI Agents» (2026-03),
  «Sandboxing Agentic AI: Least-Privilege Patterns» (2026-05),
  «GuardFall» (2026-07); arXiv:2605.25871; overview su Saltzer & Schroeder 1975.
