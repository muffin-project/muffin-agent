# ADR-0095 — La delega consuma gli ask, mai i divieti

**Stato:** accettato · 2026-10-01 · issue #740.

## Contesto

Ogni azione irreversibile (`sys.shell`, `sys.shell.write`, egress fuori
allowlist, fetch con parametri composti…) produce un verdetto `ask` del kernel
e interrompe l'owner — su Telegram sospendendo il turno fino a sei ore. Per un
lavoro lungo delegato esplicitamente («sistema il modulo auth, ti chiamo solo
se serve») ogni ask è un'interruzione riflessa, e il proprietario ha chiesto
una postura di delega scelta da lui: `/manual`, `/auto`, `/yolo`.

Due rifiuti registrati vincolano la forma:

- `docs/evidence/hermes-documentazione.md` §1 (`approvals.mode: smart`): un LLM
  **dentro** la decisione di permesso è rifiutato — il kernel resta puro,
  sincrono e senza modello.
- Stesso documento §2 (`--yolo` / `/yolo` di sessione): un interruttore che
  aggira lo stack dei permessi è rifiutato — troppo largo, con una *hardline
  blocklist* aggiunta sotto proprio perché yolo era troppo largo.

La decisione esistente da proteggere è l'invariante #607: verità, policy e
autorità deterministiche sono sovrane; System One è un sensore semantico,
mai un'autorità.

## Decisione

1. **La delega cambia come l'ask viene consumato, mai cosa il kernel decide.**
   Il kernel gira per primo e invariato: `deny` resta `deny`, `allow` resta
   `allow`, `draft` resta `draft` (checkpoint/undo), `ask` si risolve secondo
   la modalità. Il punto di inserimento è il ramo `ask` di
   `agent/loop/tool-call.ts` — dopo il `take()` delle risposte già date, prima
   della superficie — mai `core/policy/decide.ts`, che resta puro e sincrono.
2. **Ambito: il lavoro.** La modalità vive nella tabella `delegation_modes`,
   chiave `turn_id`, in append (ogni riga è un `delegation_mode_changed` con
   chi, cosa, quando). Un lavoro nuovo è una riga nuova e non eredita niente;
   la continuazione (`continueTurn`, `resumeTurn`) è la stessa riga e la
   conserva. Mai un interruttore globale, mai una scadenza inventata: la
   delega muore con il lavoro a cui è stata data.
3. **`manual` è il comportamento di oggi, esattamente.** Senza riga, o con
   riga `manual`, il ramo ask è quello di prima.
4. **`yolo` è pre-approvazione dell'owner, dentro la busta del kernel.**
   Ogni ask del lavoro si registra e si consuma **attraverso lo stesso
   registro** (`ask` → `decide allow` → `take`, come la risposta immediata del
   terminale), con `decided_by: 'delegation'` a dire chi ha deciso. Nessun
   secondo store, nessun secondo motore. Un `deny` deterministico — `rot.write`,
   tetti di spesa, taint oltre il soffitto, sandbox, egress negato — non
   attraversa mai quel ramo: lo `switch` lo ritorna prima.
5. **`auto` senza calibrazione chiede.** Finché System One non giudica classi
   calibrate, la busta è vuota e ogni ask sale all'owner — che è il
   comportamento sicuro della modalità, non una sua imitazione («unknown
   classes escalate», #740 fase 3). Il giudice semantico si innesterà in quel
   ramo, e il suo giudizio non potrà mai allargare la busta: solo consumare
   ask che il kernel ha già detto approvabili.
6. **Solo l'owner scrive la delega, e solo con un comando.** `/manual`,
   `/auto`, `/yolo` vivono in `agent/comandi.ts` (intercettati prima del
   turno, mai passati dal kernel) e scrivono solo attraverso la leva
   `core/runtime/delega.ts`, che si lega all'ultimo lavoro attivo della
   conversazione. Nessuna capability, nessun tool, nessun modello scrive in
   `delegation_modes`: l'auto-attivazione è strutturalmente impossibile.
   La risposta già data dell'owner vince sempre sulla delega (`take` prima
   della lettura della modalità): un «no» esplicito resta un no.
7. **`/yolo` su un lavoro sospeso fa la strada del pulsante**: decide le
   domande aperte per delega, poi `wake` e spinta alla corsia — la ripresa
   rilegge la risposta dal registro come ha sempre fatto.
8. **Lettura fresca a ogni ask** (una `SELECT` su chiave, come `/pause`):
   `/manual` vale dall'ask dopo, in qualsiasi processo, anche dopo un riavvio.
9. **Visibile senza rumore.** Niente bolla per azione consumata: l'azione sta
   nel transcript e nella storia degli effetti come gli altri passi. La
   postura si legge in `sys.inspect` («Questo turno») e nelle risposte dei
   comandi; la storia dei cambi è la tabella.

## Alternative scartate

- **Modalità dentro il kernel** (`decide` che legge la delega e risponde
  `allow`): fonde busta deterministica e postura dell'owner, rompe il
  contratto puro/sincrono, e rende il `deny` negoziabile per costruzione.
- **Approver per superficie che decide da sé**: consumerebbe fuori dal
  registro (niente coda D12, niente monouso, niente barriera) e si
  comporterebbe diversamente dove non c'è approvatore.
- **`/auto` che consuma senza giudizio calibrato**: è il salto che la #740
  vieta esplicitamente («do not jump directly to probabilistic
  auto-approval»). La busta vuota è la calibrazione zero, non un bug.

## Conseguenze

- `approvals` guadagna `decided_by` (`owner` default; le righe decise prima
  della colonna leggono `owner` per costruzione) e `openRows(turnId)`.
- `turns` guadagna `latestActiveOfSession` (ultimo non-`done` della sessione).
- `LoopDeps` guadagna `delega` (opzionale; assente = `manual`).
- La promessa di sicurezza cambia su un punto: un `ask` può ora essere
  consumato senza interruzione quando l'owner ha delegato quel lavoro
  (`docs/architecture/SECURITY.md` §ask).
- Il giudizio semantico di System One (#607) e la calibrazione shadow
  (#740 fasi 1–2) restano lavoro futuro e si innestano nel ramo `auto`
  senza toccare kernel, registro o comandi.

## Falsificatori

- Un `deny` deterministico esegue sotto `yolo` (qualsiasi modalità) → rosso.
- `manual` chiede dove prima chiedeva, con lo stesso testo e la stessa
  sospensione → i test di `approvazione-differita` restano verdi invariati.
- Un ask nato dopo `/yolo` esegue senza toccare la superficie e lascia
  `allow` + `decided_by: 'delegation'` + riga consumata.
- `/manual` dopo `/yolo`: l'ask dopo chiede di nuovo.
- La delega su un lavoro non tocca un altro lavoro, un'altra sessione, un
  altro tenant; la continuazione dello stesso lavoro la conserva.
- Rimuovere il ramo di consumo in `tool-call.ts` fa fallire i test di
  `agent/delega.test.ts` (mutazione pinnata in PR).
